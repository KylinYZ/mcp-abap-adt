import { inflateRawSync } from 'node:zlib'

/**
 * Isolated, offline parser prototype for a deliberately narrow EUFUNC payload
 * subset. This is not wired to an ADT query, MCP handler, or public API.
 *
 * Scope: SAP cluster version 5, single-byte code page 1100, plain bodies and
 * SAP LZH (raw DEFLATE) compressed bodies; elementary values plus flat
 * structure/table descriptors using the explicitly supported type codes below.
 * Unknown versions, algorithms, markers and types fail closed.
 */
export interface EufuncV5PrototypeObject {
  name: string
  kind: 'elementary' | 'structure' | 'table'
  typeCode: number
  rowLength: number
  fields: Array<{ path: string; typeCode: number; length: number }>
  rows: unknown[][]
}

export interface EufuncV5PrototypeCluster {
  version: 5
  codepage: '1100'
  compressed: boolean
  algorithm?: 'LZH'
  objects: EufuncV5PrototypeObject[]
}

/**
 * One EUFUNC cluster-table row: the SRTF2 sequence number, the CLUSTR byte
 * count valid in this row, and the CLUSTD cell as delivered by the data
 * preview (real wire contract, 2026-09-28: continuous mixed-case hex, fixed
 * LRAW width, zero padding — see fm-test-data-clustd-real-dev-verified.md).
 * Callers extract these from parsed datapreview rows; this module never
 * queries SAP and never stores payload bytes.
 */
export interface EufuncClusterFragment {
  srtf2: number
  clustrBytes: number
  clustdHex: string
}

export interface EufuncClusterAssembly {
  bytes: Uint8Array
  fragmentCount: number
  /** Sequence numbers whose CLUSTR was unusable (≤0 or beyond the cell) and
   *  fell back to the full cell — VSP Join semantics; callers should treat a
   *  non-empty list as a signal the payload tail may carry padding. */
  lengthFallbackFragments: number[]
}

/**
 * Reassemble the fragments of one cluster key into the decoder's byte input.
 * Semantics mirror the VSP oracle (pkg/datacluster fragments.go Join): sort by
 * SRTF2, reject duplicates and gaps (sequences must run 0..n-1), trim each
 * row to the CLUSTR byte count it declares. Hex handling mirrors DecodeHex:
 * upper/lower case accepted, whitespace stripped, anything else rejected.
 * The assembly is fail-closed: gaps, duplicates, non-hex cells and over-budget
 * totals are errors, never silently truncated payloads.
 */
export function assembleEufuncV5ClusterFragments(input: EufuncClusterFragment[]): EufuncClusterAssembly {
  if (!Array.isArray(input) || input.length === 0) throw new Error('no fragments')
  const sorted = [...input].sort((a, b) => a.srtf2 - b.srtf2)
  const parts: Buffer[] = []
  let total = 0
  const lengthFallbackFragments: number[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    const f = sorted[i]!
    if (!Number.isInteger(f.srtf2) || f.srtf2 < 0) throw new Error(`fragment sequence ${f.srtf2} is not a non-negative integer`)
    if (i > 0 && f.srtf2 === sorted[i - 1]!.srtf2) throw new Error(`fragment ${f.srtf2} appears twice`)
    if (f.srtf2 !== i) throw new Error(`fragment ${i} is missing`)
    const hex = f.clustdHex.replace(/[\s]/g, '')
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error(`fragment ${f.srtf2} CLUSTD is not hex`)
    const cellBytes = hex.length / 2
    let n = f.clustrBytes
    if (!Number.isInteger(n) || n <= 0 || n > cellBytes) {
      // VSP Join fallback: an unusable length keeps the full cell; surfaced to
      // the caller instead of being silently absorbed.
      lengthFallbackFragments.push(f.srtf2)
      n = cellBytes
    }
    const bytes = Buffer.from(hex.slice(0, n * 2), 'hex')
    total += bytes.length
    if (total > MAX_CLUSTER_BYTES) throw new Error('assembled cluster exceeds byte limit')
    // Buffer 分段收集：spread 展开大数组会触发栈溢出，禁用
    parts.push(bytes)
  }
  if (total === 0) throw new Error('assembled cluster is empty')
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { merged.set(part, offset); offset += part.length }
  return { bytes: merged, fragmentCount: sorted.length, lengthFallbackFragments }
}


const HEADER_SIZE = 16
const MAX_CLUSTER_BYTES = 1024 * 1024
const MAX_OBJECTS = 64
const MAX_FIELDS = 128
const MAX_ROWS = 4096
const MAX_NAME_BYTES = 64
const MAX_ROW_BYTES = 64 * 1024
const MAX_DEPTH = 8
const MAX_NODES = 512
const MAX_EXPANSION_RATIO = 64
const MIN_RATIO_ALLOWANCE = 4096

type Node = { path: string; code: number; length: number; filler?: boolean; children?: Node[] }

class Cursor {
  position = 0
  constructor(readonly bytes: Uint8Array) {}
  need(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.position > this.bytes.length - count) {
      throw new Error('truncated or invalid length')
    }
  }
  u8(): number { this.need(1); return this.bytes[this.position++]! }
  u16(): number {
    this.need(2)
    const n = (this.bytes[this.position]! << 8) | this.bytes[this.position + 1]!
    this.position += 2
    return n
  }
  take(count: number): Uint8Array { this.need(count); const out = this.bytes.subarray(this.position, this.position + count); this.position += count; return out }
}

/** Decode one complete, bounded cluster. The input is never mutated. */
export function decodeEufuncV5Prototype(input: Uint8Array): EufuncV5PrototypeCluster {
  if (!(input instanceof Uint8Array) || input.byteLength < HEADER_SIZE || input.byteLength > MAX_CLUSTER_BYTES) {
    throw new Error('cluster size outside supported bounds')
  }
  if (input[0] !== 0xff || input[1] !== 5) throw new Error('only cluster version 5 is supported')
  const format = input[4]
  if (format !== 1 && format !== 2) throw new Error('unsupported cluster body format')
  if (ascii(input.subarray(8, 12)) !== '1100') throw new Error('only code page 1100 is supported')

  let body = input.subarray(HEADER_SIZE)
  let compressed = false
  if (format === 2) {
    body = inflateSapLzh(body)
    compressed = true
  }
  if (body.byteLength > MAX_CLUSTER_BYTES) throw new Error('expanded cluster exceeds byte limit')

  const cursor = new Cursor(body)
  const objects: EufuncV5PrototypeObject[] = []
  let nodes = 0
  while (cursor.position < body.length && body[cursor.position] !== 0x04) {
    if (objects.length >= MAX_OBJECTS) throw new Error('object limit exceeded')
    const header = cursor.take(15)
    const kindByte = header[0]!
    const typeCode = header[1]!
    const rowLength = (header[2]! << 8) | header[3]!
    const nameLength = header[6]!
    if (nameLength < 1 || nameLength > MAX_NAME_BYTES) throw new Error('object name length outside supported bounds')
    if (rowLength < 1 || rowLength > MAX_ROW_BYTES) throw new Error('row length outside supported bounds')
    const name = ascii(cursor.take(nameLength))
    if (!/^[\x20-\x7e]+$/.test(name)) throw new Error('object name contains unsupported bytes')

    let kind: EufuncV5PrototypeObject['kind']
    let root: Node
    // Kind is initialized from the raw byte into the VSP enum, where
    // Elementary itself is 1; VSP additionally normalizes legacy marker 7.
    // 02/03 are the flat structure/table forms and 05/06 the deep ones
    // (strings or nesting inside); the VSP oracle normalizes both pairs to
    // Structure/Table because only the descriptor carries the real layout,
    // and the descriptor markers are identical for flat and deep.
    if (kindByte === 1 || kindByte === 7) {
      kind = 'elementary'
      ensureSupportedType(typeCode, rowLength)
      root = { path: '1', code: typeCode, length: rowLength }
    } else if (kindByte === 2 || kindByte === 3 || kindByte === 5 || kindByte === 6) {
      kind = kindByte === 2 || kindByte === 5 ? 'structure' : 'table'
      const open = kind === 'structure' ? 0xab : 0xad
      const close = kind === 'structure' ? 0xac : 0xae
      const descriptor = cursor.take(4)
      if (descriptor[0] !== open) throw new Error('unexpected root descriptor marker')
      root = { path: '', code: descriptor[1]!, length: (descriptor[2]! << 8) | descriptor[3]!, children: [] }
      nodes += 1
      parseChildren(cursor, root, close, 0, () => { nodes += 1; if (nodes > MAX_NODES) throw new Error('descriptor node limit exceeded') })
      if (root.length !== rowLength) throw new Error('descriptor length does not match row length')
      const leaves: Node[] = []
      flatten(root, leaves)
      if (leaves.length > MAX_FIELDS) throw new Error('field limit exceeded')
      const total = leaves.reduce((sum, leaf) => sum + leaf.length, 0)
      if (total !== rowLength) throw new Error('descriptor field lengths do not match row length')
      for (const leaf of leaves) if (!leaf.filler) ensureSupportedType(leaf.code, leaf.length)
    } else {
      throw new Error(`unsupported object kind ${kindByte} at object ${objects.length + 1}, offset ${cursor.position - nameLength - 15}`)
    }

    const leaves: Node[] = []
    if (kind === 'elementary') leaves.push(root)
    else flatten(root, leaves)
    const fields = leaves.filter(leaf => !leaf.filler).map(leaf => ({ path: leaf.path, typeCode: leaf.code, length: leaf.length }))
    const rows: unknown[][] = []
    while (cursor.position < body.length && body[cursor.position] === 0xbb) {
      if (rows.length >= MAX_ROWS) throw new Error('row limit exceeded')
      cursor.position += 1
      const raw = cursor.take(rowLength)
      let offset = 0
      const values: unknown[] = []
      for (const leaf of leaves) {
        const bytes = raw.subarray(offset, offset + leaf.length)
        offset += leaf.length
        if (!leaf.filler) values.push(decodeValue(leaf.code, bytes))
      }
      rows.push(values)
      if (kind !== 'table') break
    }
    if (kind !== 'table' && rows.length !== 1) throw new Error('non-table object must contain exactly one row')
    objects.push({ name, kind, typeCode, rowLength, fields, rows })
  }
  if (cursor.position >= body.length || cursor.u8() !== 0x04) throw new Error('missing cluster end marker')
  if (cursor.position !== body.length) throw new Error('trailing bytes after cluster end marker')
  if (objects.length === 0) throw new Error('cluster has no objects')
  return { version: 5, codepage: '1100', compressed, ...(compressed ? { algorithm: 'LZH' as const } : {}), objects }
}

function parseChildren(cursor: Cursor, parent: Node, close: number, depth: number, countNode: () => void): void {
  if (depth >= MAX_DEPTH) throw new Error('descriptor nesting limit exceeded')
  while (true) {
    const entryStart = cursor.position
    const marker = cursor.u8()
    const code = cursor.u8()
    const length = cursor.u16()
    if (marker === close) {
      if (length !== parent.length) throw new Error(`descriptor close does not match its opening (0x${marker.toString(16).padStart(2, '0')} length ${length}, opened ${parent.length} at offset ${entryStart})`)
      return
    }
    countNode()
    if (marker === 0xaa || marker === 0xaf) {
      if (length < 1 || length > MAX_ROW_BYTES) throw new Error(`field length outside supported bounds (marker 0x${marker.toString(16).padStart(2, '0')} length ${length} at offset ${entryStart})`)
      parent.children!.push({ path: `${parent.path}${parent.path ? '.' : ''}${parent.children!.length + 1}`, code, length, filler: marker === 0xaf })
    } else if (marker === 0xa0 || marker === 0xab) {
      if (length < 1 || length > MAX_ROW_BYTES) throw new Error(`nested descriptor length outside supported bounds (marker 0x${marker.toString(16).padStart(2, '0')} length ${length} at offset ${entryStart})`)
      const child: Node = { path: `${parent.path}${parent.path ? '.' : ''}${parent.children!.length + 1}`, code, length, children: [] }
      parent.children!.push(child)
      parseChildren(cursor, child, marker === 0xab ? 0xac : 0xa1, depth + 1, countNode)
      if (child.children!.reduce((sum, n) => sum + n.length, 0) !== child.length) throw new Error('nested descriptor lengths do not match')
    } else {
      // 诊断上下文对齐 VSP（unknown descriptor marker %#02x at offset %d）：
      // marker/offset 是格式契约信息，不含业务数据
      throw new Error(`unsupported descriptor marker 0x${marker.toString(16).padStart(2, '0')} (code 0x${code.toString(16).padStart(2, '0')}, length ${length}) at offset ${entryStart}`)
    }
  }
}

function flatten(node: Node, out: Node[]): void {
  for (const child of node.children ?? []) {
    if (child.children) flatten(child, out)
    else out.push(child)
  }
}

function ensureSupportedType(code: number, length: number): void {
  const exact: Record<number, number> = { 8: 4, 9: 2, 10: 1 }
  if (code === 0 || code === 1 || code === 2 || code === 3 || code === 4 || code === 6) return
  if (exact[code] === length) return
  throw new Error(`unsupported type or invalid fixed width (type ${code}, length ${length})`)
}

function decodeValue(code: number, bytes: Uint8Array): unknown {
  if (code === 0) return ascii(bytes).replace(/ +$/, '')
  if (code === 1 || code === 3 || code === 6) return ascii(bytes)
  if (code === 4) return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()
  if (code === 10) return BigInt(bytes[0]!).toString()
  if (code === 9) return String(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(0, true))
  if (code === 8) {
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true)
    return String(value)
  }
  if (code === 2) return packedDecimal(bytes)
  throw new Error('unsupported type')
}

function packedDecimal(bytes: Uint8Array): string {
  const digits = [...bytes].map((value, index) => index === bytes.length - 1
    ? `${value >> 4}`
    : `${value >> 4}${value & 0x0f}`).join('')
  if (![...digits].every(ch => ch >= '0' && ch <= '9')) throw new Error('invalid packed decimal digits')
  const signNibble = bytes[bytes.length - 1]! & 0x0f
  if (signNibble !== 0x0c && signNibble !== 0x0d && signNibble !== 0x0f) throw new Error('invalid packed decimal sign')
  const normalized = digits.replace(/^0+(?=\d)/, '') || '0'
  return `${signNibble === 0x0d ? '-' : ''}${normalized}`
}

function inflateSapLzh(stream: Uint8Array): Uint8Array {
  if (stream.byteLength < 8) throw new Error('truncated SAP compression header')
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const expected = view.getUint32(0, true)
  const algVersion = stream[4]!
  if (stream[5] !== 0x1f || stream[6] !== 0x9d) throw new Error('invalid SAP compression signature')
  if ((algVersion & 0x0f) !== 2 || (algVersion >> 4) !== 1) throw new Error('only SAP LZH version 1 is supported')
  if (expected === 0 || expected > MAX_CLUSTER_BYTES) throw new Error('decompressed length outside supported bounds')
  const compressed = stream.subarray(8)
  if (compressed.byteLength === 0) throw new Error('empty SAP LZH stream')
  const ratioLimit = Math.max(MIN_RATIO_ALLOWANCE, compressed.byteLength * MAX_EXPANSION_RATIO)
  if (expected > ratioLimit) throw new Error('SAP LZH expansion ratio exceeds limit')

  // SAP prepends 2..5 non-DEFLATE bits. The low two bits encode how many
  // additional noise bits follow the mandatory two-bit prefix.
  const prefix = 2 + (compressed[0]! & 0x03)
  const shifted = new Uint8Array(compressed.length)
  for (let i = 0; i < compressed.length; i += 1) {
    shifted[i] = (compressed[i]! >>> prefix) | (i + 1 < compressed.length ? compressed[i + 1]! << (8 - prefix) : 0)
  }
  // @types/node in the repository's locked toolchain does not expose the
  // `info: true` overload consistently, although the runtime returns
  // { buffer, engine } for that option.
  const result = inflateRawSync(shifted, { maxOutputLength: expected + 1, info: true }) as unknown as {
    buffer: Buffer
    engine: { bytesWritten: number }
  }
  // Real SAP streams legitimately carry bytes after the DEFLATE end block
  // (termination/alignment); the VSP oracle (pkg/sapcompress inflate) ignores
  // them and holds the decoder only to the promised output length. Fidelity
  // is still enforced exactly: output must equal `expected` bytes, and
  // maxOutputLength bounds expansion.
  if (result.buffer.byteLength !== expected) throw new Error('SAP LZH length does not match its header')
  void result.engine
  return Uint8Array.from(result.buffer)
}

function ascii(bytes: Uint8Array): string {
  let result = ''
  for (const value of bytes) result += String.fromCharCode(value)
  return result
}
