import { deflateRawSync } from 'node:zlib'
import { decodeEufuncV5Prototype } from '../adt/EufuncV5DecoderPrototype'

function u16(value: number): number[] { return [(value >>> 8) & 0xff, value & 0xff] }

function header(kind: number, type: number, rowLength: number, name: string): number[] {
  const nameBytes = [...Buffer.from(name, 'ascii')]
  return [kind, type, ...u16(rowLength), 0, 0, nameBytes.length, ...new Array<number>(8).fill(0), ...nameBytes]
}

function syntheticPlainBody(): Uint8Array {
  const elementary = [
    ...header(7, 0, 4, '%_I'),
    0xbb, ...Buffer.from('ABC ', 'ascii')
  ]
  const structure = [
    ...header(2, 0x0e, 2, 'PAIR'),
    0xab, 0x0e, ...u16(2),
    0xaa, 0x00, ...u16(1),
    0xaa, 0x00, ...u16(1),
    0xac, 0x0e, ...u16(2),
    0xbb, 0x31, 0x32
  ]
  const table = [
    ...header(3, 0x0e, 1, 'TABLE'),
    0xad, 0x0e, ...u16(1),
    0xaa, 0x00, ...u16(1),
    0xae, 0x0e, ...u16(1),
    0xbb, 0x41,
    0xbb, 0x42
  ]
  return Uint8Array.from([...elementary, ...structure, ...table, 0x04])
}

function cluster(body: Uint8Array, format: 1 | 2): Uint8Array {
  const out = new Uint8Array(16 + body.length)
  out[0] = 0xff
  out[1] = 5
  out[4] = format
  out.set(Buffer.from('1100', 'ascii'), 8)
  out.set(body, 16)
  return out
}

function sapLzh(plain: Uint8Array, prefix = 2): Uint8Array {
  const deflated = deflateRawSync(plain)
  const shifted = new Uint8Array(deflated.length + 1)
  for (let i = 0; i < deflated.length; i += 1) {
    shifted[i] = ((deflated[i]! << prefix) & 0xff) | (i > 0 ? deflated[i - 1]! >>> (8 - prefix) : 0)
  }
  shifted[0] = shifted[0]! | (prefix - 2)
  const headerBytes = new Uint8Array(8)
  new DataView(headerBytes.buffer).setUint32(0, plain.length, true)
  headerBytes[4] = 0x12
  headerBytes[5] = 0x1f
  headerBytes[6] = 0x9d
  return Uint8Array.from([...headerBytes, ...shifted])
}

describe('isolated EUFUNC version 5 decoder prototype', () => {
  test('parses a generated synthetic plain cluster with elementary, structure and table values', () => {
    const parsed = decodeEufuncV5Prototype(cluster(syntheticPlainBody(), 1))
    expect(parsed).toMatchObject({ version: 5, codepage: '1100', compressed: false })
    expect(parsed.objects).toHaveLength(3)
    expect(parsed.objects[0]).toMatchObject({ name: '%_I', kind: 'elementary', rows: [['ABC']] })
    expect(parsed.objects[1]).toMatchObject({ name: 'PAIR', kind: 'structure', rows: [['1', '2']] })
    expect(parsed.objects[2]).toMatchObject({ name: 'TABLE', kind: 'table', rows: [['A'], ['B']] })
  })

  test('parses the same generated synthetic vector through SAP LZH compression', () => {
    const body = syntheticPlainBody()
    const parsed = decodeEufuncV5Prototype(cluster(sapLzh(body), 2))
    expect(parsed.compressed).toBe(true)
    expect(parsed.algorithm).toBe('LZH')
    expect(parsed.objects).toEqual(decodeEufuncV5Prototype(cluster(body, 1)).objects)
  })

  test('accepts both raw version-5 elementary kind values used by the reference parser', () => {
    const kindOne = syntheticPlainBody()
    kindOne[0] = 1
    const parsed = decodeEufuncV5Prototype(cluster(kindOne, 1))
    expect(parsed.objects[0]).toMatchObject({ kind: 'elementary', rows: [['ABC']] })
  })

  test.each([2, 3, 4, 5])('accepts SAP LZH prefix width %i using a generated vector', prefix => {
    const parsed = decodeEufuncV5Prototype(cluster(sapLzh(syntheticPlainBody(), prefix), 2))
    expect(parsed.compressed).toBe(true)
    expect(parsed.objects).toHaveLength(3)
  })

  test.each([
    ['short header', new Uint8Array(15)],
    ['unsupported version', (() => { const b = cluster(syntheticPlainBody(), 1); b[1] = 6; return b })()],
    ['unsupported code page', (() => { const b = cluster(syntheticPlainBody(), 1); b[8] = 0x34; return b })()],
    ['unknown body format', (() => { const b = cluster(syntheticPlainBody(), 1); b[4] = 3; return b })()],
    ['missing end marker', cluster(syntheticPlainBody().subarray(0, syntheticPlainBody().length - 1), 1)],
    ['trailing body bytes', cluster(Uint8Array.from([...syntheticPlainBody(), 0]), 1)],
    ['unknown object kind', (() => { const b = cluster(syntheticPlainBody(), 1); b[16] = 9; return b })()]
  ])('rejects %s', (_name, value) => {
    expect(() => decodeEufuncV5Prototype(value as Uint8Array)).toThrow()
  })

  test('rejects truncated row data and unknown legacy type codes', () => {
    const truncated = syntheticPlainBody().slice(0, 16 + 1)
    const row = cluster(truncated, 1)
    expect(() => decodeEufuncV5Prototype(row)).toThrow(/truncated/)

    const unsupportedType = cluster(Uint8Array.from([...header(7, 0x13, 1, 'S'), 0xbb, 0x41, 0x04]), 1)
    expect(() => decodeEufuncV5Prototype(unsupportedType)).toThrow(/unsupported type/)
  })

  test('rejects SAP LZH truncation, length mismatch, high expansion ratio and bad signatures', () => {
    const body = syntheticPlainBody()
    const compressed = sapLzh(body)
    expect(() => decodeEufuncV5Prototype(cluster(compressed.slice(0, compressed.length - 2), 2))).toThrow()

    const wrongLength = compressed.slice()
    new DataView(wrongLength.buffer).setUint32(0, body.length + 1, true)
    expect(() => decodeEufuncV5Prototype(cluster(wrongLength, 2))).toThrow(/length/)

    const highRatioPlain = new Uint8Array(9000).fill(0x41)
    const highRatio = sapLzh(highRatioPlain)
    expect(() => decodeEufuncV5Prototype(cluster(highRatio, 2))).toThrow(/ratio/)

    const badSignature = compressed.slice()
    badSignature[5] = 0
    expect(() => decodeEufuncV5Prototype(cluster(badSignature, 2))).toThrow(/signature/)
  })

  test('rejects inputs over the one MiB cluster budget', () => {
    expect(() => decodeEufuncV5Prototype(new Uint8Array(1024 * 1024 + 1))).toThrow(/bounds/)
  })

  test('enforces hard object, descriptor-field and table-row counts', () => {
    const oneObject = [...header(7, 0, 1, 'X'), 0xbb, 0x41]
    const tooManyObjects = Uint8Array.from([...new Array(65).fill(oneObject).flat(), 0x04])
    expect(() => decodeEufuncV5Prototype(cluster(tooManyObjects, 1))).toThrow(/object limit/)

    const fieldCount = 129
    const manyFields = [
      ...header(2, 0x0e, fieldCount, 'WIDE'),
      0xab, 0x0e, ...u16(fieldCount),
      ...new Array(fieldCount).fill([0xaa, 0x00, 0x00, 0x01]).flat(),
      0xac, 0x0e, ...u16(fieldCount)
    ]
    expect(() => decodeEufuncV5Prototype(cluster(Uint8Array.from([...manyFields, 0x04]), 1))).toThrow(/field limit/)

    const rows = [
      ...header(3, 0x0e, 1, 'ROWS'),
      0xad, 0x0e, 0x00, 0x01,
      0xaa, 0x00, 0x00, 0x01,
      0xae, 0x0e, 0x00, 0x01,
      ...new Array(4097).fill([0xbb, 0x41]).flat(),
      0x04
    ]
    expect(() => decodeEufuncV5Prototype(cluster(Uint8Array.from(rows), 1))).toThrow(/row limit/)
  })

  it('accepts kind 6 (deep table) with a flat line type — VSP normalizes 05/06 to Structure/Table', () => {
    // 真机实证（2026-09-28，fm-test-data-clustd-real-dev-verified）：V5 集群
    // 存在 kind 6 对象；VSP legacy 枚举值本身 Table=6，与 kind 3 同路处理。
    const deepTable = [
      ...header(6, 0x0e, 1, 'DEEP'),
      0xad, 0x0e, ...u16(1),
      0xaa, 0x00, ...u16(1),
      0xae, 0x0e, ...u16(1),
      0xbb, 0x43,
      0x04
    ]
    const result = decodeEufuncV5Prototype(cluster(Uint8Array.from(deepTable), 1))
    expect(result.objects).toHaveLength(1)
    expect(result.objects[0]).toMatchObject({ name: 'DEEP', kind: 'table', rows: [['C']] })
  })

  it('rejects a nested table descriptor (0xAD inside a line type) — 真机 deep 形态，VSP 上游同样 fail-closed', () => {
    // 真机发现（2026-09-28）：C162 999 集群第 3 对象（kind 6）的 line type 内
    // 嵌套子表 descriptor（0xAD...0xAE）。VSP legacyChildren 对 0xAD 走 default
    // 拒绝，V5 legacy 亦声明 "not expected to hold tables"——上游与本项目共同
    // 能力边界。此处锁定 fail-closed，防止未来静默放行未审形态。
    const nested = [
      ...header(6, 0x0e, 2, 'NEST'),
      0xad, 0x0e, ...u16(2),
      0xaa, 0x00, ...u16(1),
      0xad, 0x0e, ...u16(1),   // line type 内嵌套的子表 descriptor open
      0xaa, 0x00, ...u16(1),
      0xae, 0x0e, ...u16(1),
      0xae, 0x0e, ...u16(2),
      0x04
    ]
    expect(() => decodeEufuncV5Prototype(cluster(Uint8Array.from(nested), 1)))
      .toThrow(/unsupported descriptor marker 0xad/)
  })
})
