import { inflateRawSync } from 'node:zlib'

/**
 * ============================================================================
 * ABAP 数据集群解码器（EXPORT ... TO DATABASE 写入 INDX 型表 CLUSTD 列的
 * 字节流还原；矩阵行 diagnostics.knowledge-queries 的 fm_test_data 内容层
 * 与 cluster_read 前置）。
 * ============================================================================
 *
 * VSP 语义移植来源（MIT，固定审计版本 9886d272，attribution 见
 * third-party/vibing-steampunk/）：pkg/datacluster/cluster.go（流解析 V5/V6）、
 * legacy.go（V5 老内核形态）、values.go（类型值解码）、decfloat.go（DF16/DF34）、
 * fragments.go（SRTF2 续块 Join）；pkg/sapcompress/sapcompress.go + lzc.go
 * （LZH=raw DEFLATE 带 SAP 前缀、LZC=compress(1) LZW 变体）。
 *
 * 集群格式（SAP 未公开文档，语义按真实集群逆向固化）：16 字节头（0xFF 标记 +
 * 版本字节 + 体格式 + 码页）+ 可压缩体；体内每个 EXPORT 对象 = 对象头 + 类型
 * 描述符树 + 数据。VSP 核心注释："内核写的是类型不是 DDIC——字段按位置编号，
 * 知道结构的调用方自行把名字覆盖上去"，因此本解码器不猜字段名。
 *
 * 与 VSP 的有意差异（全部 fail-closed，不放宽）：
 * - 资源硬上限（远端字节不可信任）：集群/解压输出 1MB、对象 64、叶字段 128、
 *   行 4096、单行 64KB、描述符深度 8、节点 512、LZC/LZH 膨胀比率 64——超限
 *   返回明确错误（partial/limit exceeded），绝不静默截断后声称完整。
 * - packed BCD 数字与符号 nibble 严格校验（继承 EufuncV5DecoderPrototype 的
 *   真机验证语义；VSP 直接拼接不校验）。
 * - 错误信息只含 marker/offset/长度等格式契约字段，不回显 payload 原文。
 * 本模块为纯函数：无网络、无 SAP 往返、无文件系统副作用；失败抛错不降级。
 */

/* ==========================================================================
 * 资源上限（远端不可信任输入的 DoS 防线）
 * ========================================================================== */
const HEADER_SIZE = 16
const MAX_CLUSTER_BYTES = 1024 * 1024
const MAX_OBJECTS = 64
/** 叶字段/节点上限：真实系统集群（BALDAT 等宽表）描述符远大于 EUFUNC 样本，
 *  上限按 64KB 行长预算放宽——字节（1MB）与行数（4096）才是资源主防线。 */
const MAX_FIELDS = 512
const MAX_ROWS = 4096
const MAX_NAME_CHARS = 128
const MAX_ROW_BYTES = 64 * 1024
const MAX_DEPTH = 8
const MAX_NODES = 4096
/** 压缩膨胀比率仅作异常信号——资源主防线是 MAX_CLUSTER_BYTES 对解压输出的
 *  绝对上限（inflate maxOutputLength 硬裁剪）；合法高压缩流（全零块等）比率
 *  可达数百，64 会误伤（sapcompress fixtures zeros/big 实测），取 1024。 */
const MAX_EXPANSION_RATIO = 1024
const MIN_RATIO_ALLOWANCE = 4096

/* ==========================================================================
 * SAP 压缩（pkg/sapcompress 移植）
 * ========================================================================== */

/** SAP 压缩头固定 8 字节：[0..3] 解压后长度 LE、[4] 低 nibble 算法/高 nibble
 *  版本、[5..6] 0x1F9D 魔数、[7] 附加字节（LZC 存 block mode 与宽度上限）。 */
const SAP_HEADER_SIZE = 8
const SAP_LZC = 1 // compress(1) 样式 LZW（头算法字节 0x10）
const SAP_LZH = 2 // raw DEFLATE（头算法字节 0x12）

export interface SapCompressHeader {
  /** 声明的解压后字节数——解码器对它精确对账。 */
  length: number
  algorithm: 'LZC' | 'LZH'
  version: number
  /** 第 8 字节：LZC 的 block-mode 位与码宽上限；LZH 不使用。 */
  extra: number
}

/** 只读头不解压（对应 VSP ParseHeader；缺魔数抛 ErrNotCompressed 同义错误）。 */
export function parseSapCompressHeader(data: Uint8Array): SapCompressHeader {
  if (data.byteLength < SAP_HEADER_SIZE) {
    throw new Error(`sapcompress: ${data.byteLength} bytes is shorter than the ${SAP_HEADER_SIZE}-byte header`)
  }
  if (data[5] !== 0x1f || data[6] !== 0x9d) throw new Error('sapcompress: no SAP compression signature')
  const algorithmNibble = data[4]! & 0x0f
  return {
    length: readUint32LE(data, 0),
    algorithm: algorithmNibble === SAP_LZC ? 'LZC' : algorithmNibble === SAP_LZH ? 'LZH' : `algorithm ${algorithmNibble}` as never,
    version: data[4]! >> 4,
    extra: data[7]!
  }
}

/** 解码完整 SAP 压缩流（含头），输出严格等于头声明长度（VSP Decompress 语义）。 */
export function sapDecompress(data: Uint8Array): Uint8Array {
  const h = parseSapCompressHeader(data)
  let out: Uint8Array
  if (h.algorithm === 'LZH') {
    out = inflateSapLzh(data.subarray(SAP_HEADER_SIZE), h.length)
  } else if (h.algorithm === 'LZC') {
    out = lzcDecode(data.subarray(SAP_HEADER_SIZE), h)
  } else {
    throw new Error(`sapcompress: unknown ${h.algorithm}`)
  }
  if (out.byteLength !== h.length) {
    throw new Error(`sapcompress: ${h.algorithm}: header promised ${h.length} bytes, stream held ${out.byteLength}`)
  }
  return out
}

/**
 * LZH 体：2..5 位噪声前缀（低两位声明额外噪声位数）后就是 raw DEFLATE。
 * DEFLATE 逐位 LSB-first，整体右移前缀位数即可交给标准 inflate（VSP
 * sapcompress.go inflate：SAP 不产生 stored blocks，字节对齐无需关心）。
 */
function inflateSapLzh(body: Uint8Array, length: number): Uint8Array {
  if (body.byteLength === 0) throw new Error('sapcompress: LZH: empty body')
  if (length <= 0 || length > MAX_CLUSTER_BYTES) throw new Error('sapcompress: LZH: declared length outside supported bounds')
  const ratioLimit = Math.max(MIN_RATIO_ALLOWANCE, body.byteLength * MAX_EXPANSION_RATIO)
  if (length > ratioLimit) throw new Error('sapcompress: LZH expansion ratio exceeds limit')
  const prefix = 2 + (body[0]! & 0x03)
  const shifted = new Uint8Array(body.byteLength)
  for (let i = 0; i < body.byteLength; i += 1) {
    shifted[i] = ((body[i]! >>> prefix) | (i + 1 < body.byteLength ? body[i + 1]! << (8 - prefix) : 0)) & 0xff
  }
  // @types/node 锁定工具链不完整暴露 info 重载（运行时返回 { buffer, engine }）
  const result = inflateRawSync(shifted, { maxOutputLength: length + 1, info: true }) as unknown as {
    buffer: Buffer
    engine: { bytesWritten: number }
  }
  // SAP 流在 DEFLATE 结束块之后可合法携带收尾/对齐字节——VSP 忽略之，仅对
  // 声明长度精确对账（多一字节即上游漂移信号，fail-closed）
  if (result.buffer.byteLength !== length) {
    throw new Error(`sapcompress: LZH: header promised ${length} bytes, stream held ${result.buffer.byteLength}`)
  }
  void result.engine
  return Uint8Array.from(result.buffer)
}

/* ---- LZC：compress(1) 的 LZW 变体（pkg/sapcompress/lzc.go 移植）----
 * 码宽 9 位起步按需加宽到头声明上限；block mode 有 256 清除码；特有怪癖是
 * 码按"码宽整数字节"的块读取——宽度变化或清除都从块边界开始，上一块尾部
 * 丢弃。字典即前缀码+字节表；码指向正在定义的表项即 LZW 的 KwKwK 情形。 */
const LZC_MIN_WIDTH = 9
const LZC_MAX_WIDTH = 16
const LZC_LITERALS = 256
const LZC_CLEAR_CODE = 256

interface LzcEntry {
  /** 该表项扩展的前缀码（-1 = 单字面量）。 */
  prefix: number
  /** 前缀串后追加的字节。 */
  last: number
  /** 展开后的字节串长度。 */
  length: number
}

function lzcDecode(body: Uint8Array, h: SapCompressHeader): Uint8Array {
  const blockMode = (h.extra & 0x80) !== 0
  const limit = h.extra & 0x1f
  if (limit < LZC_MIN_WIDTH || limit > LZC_MAX_WIDTH) {
    throw new Error(`sapcompress: LZC: code width limit ${limit} outside ${LZC_MIN_WIDTH}..${LZC_MAX_WIDTH}`)
  }
  if (h.length <= 0 || h.length > MAX_CLUSTER_BYTES) throw new Error('sapcompress: LZC: declared length outside supported bounds')
  const ratioLimit = Math.max(MIN_RATIO_ALLOWANCE, body.byteLength * MAX_EXPANSION_RATIO)
  if (h.length > ratioLimit) throw new Error('sapcompress: LZC expansion ratio exceeds limit')

  const firstFree = blockMode ? LZC_LITERALS + 1 : LZC_LITERALS
  const table: LzcEntry[] = new Array(1 << limit)
  for (let i = 0; i < LZC_LITERALS; i += 1) table[i] = { prefix: -1, last: i, length: 1 }

  // 位读取游标：chunk 是"当前码宽整数字节"的输入切片
  let pos = 0
  let chunk = new Uint8Array(0)
  let cpos = 0
  const nextChunk = (width: number): void => {
    const n = Math.min(width, body.byteLength - pos)
    chunk = body.subarray(pos, pos + n)
    pos += n
    cpos = 0
  }
  const bitsLeft = (): number => chunk.byteLength * 8 - cpos
  const readBits = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i += 1) {
      v |= ((chunk[(cpos / 8) | 0]! >> (cpos % 8)) & 1) << i
      cpos += 1
    }
    return v
  }

  let width = LZC_MIN_WIDTH
  let maxCode = (1 << width) - 1
  // VSP setWidth：到上限时 maxCode 取满 1<<limit（让最后一个码可用），否则留
  // 一个作扩宽信号
  const setWidth = (w: number): void => {
    width = w
    maxCode = w === limit ? 1 << limit : (1 << w) - 1
  }
  let nextFree = firstFree
  nextChunk(width)

  const readCode = (): number | undefined => {
    if (bitsLeft() < width || nextFree > maxCode) {
      if (nextFree > maxCode) setWidth(width + 1)
      nextChunk(width)
    }
    if (bitsLeft() < width) return undefined
    return readBits(width)
  }

  const out: number[] = []
  const scratch = new Uint8Array(1 << limit)
  // 前缀链回溯展开（倒序填 last 字节）
  const expand = (code: number): { bytes: Uint8Array; first: number } => {
    const len = table[code]!.length
    for (let i = len - 1; i >= 0; i -= 1) {
      const e = table[code]!
      scratch[i] = e.last
      code = e.prefix
    }
    return { bytes: scratch.subarray(0, len), first: scratch[0]! }
  }

  let prev = -1
  while (out.length < h.length) {
    const code = readCode()
    if (code === undefined) break // 流提前结束：由 Decompress 的长度对账报错
    if (blockMode && code === LZC_CLEAR_CODE) {
      nextFree = firstFree
      setWidth(LZC_MIN_WIDTH)
      nextChunk(width)
      prev = -1
      continue
    }
    let chain: Uint8Array
    let chainFirst: number
    if (code < nextFree && (code < LZC_LITERALS || table[code]!.length > 0)) {
      const e = expand(code)
      chain = e.bytes
      chainFirst = e.first
    } else if (code === nextFree && prev >= 0) {
      // KwKwK：串 = 前一串 + 其首字节
      const p = expand(prev)
      const kw = new Uint8Array(p.bytes.byteLength + 1)
      kw.set(p.bytes)
      kw[p.bytes.byteLength] = p.first
      chain = kw
      chainFirst = p.first
    } else {
      throw new Error(`sapcompress: LZC: unknown code ${code}`)
    }
    for (const b of chain) {
      if (out.length >= h.length) break
      out.push(b)
    }
    if (prev >= 0 && nextFree < table.length) {
      table[nextFree] = { prefix: prev, last: chainFirst, length: table[prev]!.length + 1 }
      nextFree += 1
    }
    prev = code
  }
  if (out.length > h.length) throw new Error('sapcompress: LZC: stream expanded past the header\'s length')
  return Uint8Array.from(out)
}

/* ==========================================================================
 * ABAP 类型码（pkg/datacluster/values.go；前十个对齐经典 RFC 类型号）
 * ========================================================================== */
const TYPE_CHAR = 0x00
const TYPE_DATE = 0x01
const TYPE_PACKED = 0x02
const TYPE_TIME = 0x03
const TYPE_RAW = 0x04
const TYPE_NUMC = 0x06
const TYPE_FLOAT = 0x07
const TYPE_INT = 0x08
const TYPE_INT2 = 0x09
const TYPE_INT1 = 0x0a
const TYPE_STRUCTURE = 0x0e // 平结构
const TYPE_DEEP = 0x0f // 含串或嵌套的结构
const TYPE_STRING = 0x13
const TYPE_XSTRING = 0x14
const TYPE_DECFLOAT16 = 0x17
const TYPE_DECFLOAT34 = 0x18
const TYPE_INT8 = 0x1b

const TYPE_NAMES: Record<number, string> = {
  [TYPE_CHAR]: 'CHAR', [TYPE_DATE]: 'DATS', [TYPE_PACKED]: 'DEC', [TYPE_TIME]: 'TIMS',
  [TYPE_RAW]: 'RAW', [TYPE_NUMC]: 'NUMC', [TYPE_FLOAT]: 'FLTP', [TYPE_INT]: 'INT4',
  [TYPE_INT2]: 'INT2', [TYPE_INT1]: 'INT1', [TYPE_STRUCTURE]: 'STRUCT', [TYPE_DEEP]: 'STRUCT',
  [TYPE_STRING]: 'STRING', [TYPE_XSTRING]: 'XSTRING', [TYPE_DECFLOAT16]: 'DF16',
  [TYPE_DECFLOAT34]: 'DF34', [TYPE_INT8]: 'INT8'
}

/** 类型码按 DDIC 习惯渲染（未知码 TYPE%02X，不猜名）。 */
export function typeName(code: number): string {
  return TYPE_NAMES[code] ?? `TYPE${code.toString(16).padStart(2, '0').toUpperCase()}`
}

function isStringType(code: number): boolean {
  return code === TYPE_STRING || code === TYPE_XSTRING
}

/* ==========================================================================
 * 数据模型（VSP Cluster/Object/Node/Field 同构）
 * ========================================================================== */

/** 描述符树节点：Path 按位置编号（"3" 是对象第 3 个字段，"3.2" 是其中第 2 个）。 */
export interface ClusterNode {
  path: string
  typeCode: number
  length: number
  decimals: number
  /** 内核对齐填充（无值）。 */
  filler: boolean
  /** 以 include 形态写入的子结构（内核区分，解码无差）。 */
  include: boolean
  /** 表型组件：children 是行类型，length 是行长；本组件在所属行占 8 字节引用。 */
  table: boolean
  children: ClusterNode[]
}

/** 叶字段：描述符中真正有值的叶子（名称留给知道结构的调用方覆盖）。 */
export interface ClusterField {
  path: string
  type: string
  typeCode: number
  length: number
  decimals?: number
  /** 表型组件的行字段（其值即一组行）。 */
  fields?: ClusterField[]
}

export type ClusterObjectKind = 'elementary' | 'structure' | 'table'

/** 一个具名导出对象：elementary 字段 / 结构 / 内表。 */
export interface ClusterObject {
  name: string
  kind: ClusterObjectKind
  /** 对象整体（或行）的 ABAP 类型码：elementary 是元素码，结构/表行是 0x0E/0x0F。 */
  typeCode: number
  /** 一行（或结构）的字节长，含对齐填充与 string/table 的 8 字节引用槽。 */
  rowLength: number
  /** 对象在明文体中的总长——未压缩集群内核会写，压缩集群恒 0。 */
  size: number
  type: ClusterNode
  fields: ClusterField[]
  /** 解码值：elementary/structure 一行，table 每行一条。 */
  rows: unknown[][]
}

/** 一个解析出的集群。 */
export interface ClusterData {
  /** 头标记后的格式版本：Unicode 内核 6，更早 5（存量旧行）。 */
  version: number
  /** 字符数据所在 SAP 码页：4103=UTF-16LE、4102=UTF-16BE、其余按单字节页。 */
  codepage: string
  compressed: boolean
  algorithm?: 'LZC' | 'LZH'
  objects: ClusterObject[]
  /** 容错模式（tolerant）下单对象解析失败的诊断（格式契约字段，无业务数据）；
   *  非容错模式恒空。部分成功必须显式可见，绝不冒充完整。 */
  partialErrors: string[]
  /** 对象按名取回（VSP Cluster.Object 语义），不存在返回 undefined。 */
  object: (name: string) => ClusterObject | undefined
}

/* ==========================================================================
 * 字符解码（values.go decoder）
 * ========================================================================== */

class CharDecoder {
  constructor(readonly utf16: boolean, readonly bigEndian: boolean) {}

  static forCodepage(codepage: string): CharDecoder {
    if (codepage === '4103') return new CharDecoder(true, false)
    if (codepage === '4102') return new CharDecoder(true, true)
    if (codepage.length !== 4) throw new Error(`datacluster: unreadable code page "${codepage}" in header`)
    // 单字节页按字节原样取（Latin-1 近似：ASCII 区间正确，其余至少一字符一字节）
    return new CharDecoder(false, false)
  }

  text(raw: Uint8Array): string {
    if (this.utf16) {
      try {
        return decodeUtf16(raw, this.bigEndian)
      } catch {
        /* 落到单字节近似（VSP text() 同款容错） */
      }
    }
    let out = ''
    for (const b of raw) out += String.fromCharCode(b)
    return out
  }
}

function decodeUtf16(raw: Uint8Array, bigEndian: boolean): string {
  if (raw.byteLength % 2 !== 0) throw new Error(`${raw.byteLength} bytes is not a whole number of UTF-16 units`)
  let out = ''
  for (let i = 0; i + 1 < raw.byteLength; i += 2) {
    const unit = bigEndian ? (raw[i]! << 8) | raw[i + 1]! : raw[i]! | (raw[i + 1]! << 8)
    out += String.fromCharCode(unit) // 代理对由 JS 字符串语义自然成对
  }
  return out
}

/* ==========================================================================
 * 值解码（values.go value/stringValue + decfloat.go）
 * ========================================================================== */

/** 定长字段值：字符型去尾随空格成串、数字成 number/十进制串、RAW 成大写 hex。 */
function decodeFieldValue(dec: CharDecoder, node: ClusterNode, raw: Uint8Array): unknown {
  switch (node.typeCode) {
    case TYPE_CHAR:
      return dec.text(raw).replace(/ +$/, '')
    case TYPE_NUMC:
    case TYPE_DATE:
    case TYPE_TIME:
      return dec.text(raw)
    case TYPE_RAW:
      return toUpperHex(raw)
    case TYPE_INT:
      if (raw.byteLength === 4) return readInt32LE(raw)
      break
    case TYPE_INT2:
      if (raw.byteLength === 2) return readInt16LE(raw)
      break
    case TYPE_INT1:
      if (raw.byteLength === 1) return raw[0]!
      break
    case TYPE_INT8:
      if (raw.byteLength === 8) return readInt64LEAsString(raw)
      break
    case TYPE_FLOAT:
      if (raw.byteLength === 8) {
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
        return view.getFloat64(0, true)
      }
      break
    case TYPE_PACKED:
      return decodePacked(raw, node.decimals)
    case TYPE_DECFLOAT16:
    case TYPE_DECFLOAT34: {
      const s = decodeDecfloat(raw)
      if (s !== undefined) return s
      break
    }
  }
  return toUpperHex(raw)
}

function decodeStringValue(dec: CharDecoder, node: ClusterNode, raw: Uint8Array): unknown {
  if (node.typeCode === TYPE_XSTRING) return toUpperHex(raw)
  return dec.text(raw)
}

function toUpperHex(raw: Uint8Array): string {
  let out = ''
  for (const b of raw) out += b.toString(16).padStart(2, '0')
  return out.toUpperCase()
}

/** BCD packed 数：每字节两位数字、末 nibble 是符号（C/F 正、D 负）。 */
function decodePacked(raw: Uint8Array, decimals: number): string {
  if (raw.byteLength === 0) return ''
  let digits = ''
  for (let i = 0; i < raw.byteLength; i += 1) {
    const b = raw[i]!
    digits += String(b >> 4)
    if (i < raw.byteLength - 1) digits += String(b & 0x0f)
    // fail-closed：数字 nibble 越界或符号 nibble 非法都是内核契约破坏
    if ((b >> 4) > 9 || (i < raw.byteLength - 1 && (b & 0x0f) > 9)) throw new Error('datacluster: invalid packed decimal digits')
  }
  const signNibble = raw[raw.byteLength - 1]! & 0x0f
  if (signNibble !== 0x0c && signNibble !== 0x0d && signNibble !== 0x0f) throw new Error('datacluster: invalid packed decimal sign')
  const sign = signNibble === 0x0d ? '-' : ''
  return sign + placeDecimal(digits, decimals)
}

/** 数字串从小数点右起 placement（VSP placeDecimal：去前导零，空/点首补 0）。 */
function placeDecimal(digits: string, decimals: number): string {
  let d = digits
  if (decimals > 0) {
    while (d.length <= decimals) d = `0${d}`
    d = `${d.slice(0, d.length - decimals)}.${d.slice(d.length - decimals)}`
  }
  let trimmed = d.replace(/^0+/, '')
  if (trimmed === '' || trimmed.startsWith('.')) trimmed = `0${trimmed}`
  return trimmed
}

/* ---- decfloat：IEEE 754-2008 decimal64/128 的密集打包十进制编码（LE）----
 * 值 = 系数 × 10^指数；系数首位在组合域，其余在三位一组的 10 位 declet。 */
function decodeDecfloat(raw: Uint8Array): string | undefined {
  let expBits: number, declets: number, bias: number
  if (raw.byteLength === 8) {
    expBits = 8; declets = 5; bias = 398
  } else if (raw.byteLength === 16) {
    expBits = 12; declets = 11; bias = 6176
  } else {
    return undefined
  }
  const bits = new Uint8Array(16) // 大端工作副本（16 字节足够 DF34）
  for (let i = 0; i < raw.byteLength; i += 1) bits[raw.byteLength - 1 - i] = raw[i]!
  const bit = (i: number): number => (bits[(i / 8) | 0]! >> (7 - (i % 8))) & 1
  const field = (from: number, n: number): number => {
    let v = 0
    for (let i = 0; i < n; i += 1) v = (v << 1) | bit(from + i)
    return v
  }
  const sign = bit(0)
  const comb = field(1, 5)
  let msd: number, expHigh: number
  if ((comb >> 3) === 0b11) {
    if (comb === 0b11110) return signed(sign, 'Inf')
    if (comb === 0b11111) return 'NaN'
    expHigh = (comb >> 1) & 0b11
    msd = 8 + (comb & 1)
  } else {
    expHigh = comb >> 3
    msd = comb & 0b111
  }
  const exponent = (expHigh << expBits | field(6, expBits)) - bias

  let coeff = String(msd)
  let pos = 6 + expBits
  for (let i = 0; i < declets; i += 1) {
    const d = field(pos, 10)
    pos += 10
    const [a, b, c] = decletDigits(d)
    coeff += `${a}${b}${c}`
  }
  if (exponent >= 0) return signed(sign, (BigInt(coeff) * BigInt(10) ** BigInt(exponent)).toString())
  return signed(sign, placeDecimal(coeff, -exponent))
}

function signed(sign: number, s: string): string {
  return sign === 1 ? `-${s}` : s
}

/** 十位密集位 → 三位十进制数字（Cowlishaw 表）。 */
function decletDigits(d: number): [number, number, number] {
  const p = (d >> 9) & 1, q = (d >> 8) & 1, r = (d >> 7) & 1
  const s = (d >> 6) & 1, t = (d >> 5) & 1, u = (d >> 4) & 1
  const v = (d >> 3) & 1, w = (d >> 2) & 1, x = (d >> 1) & 1, y = d & 1
  const three = (a: number, b: number, c: number): number => (a << 2) | (b << 1) | c
  if (v === 0) return [three(p, q, r), three(s, t, u), three(w, x, y)]
  switch ((w << 1) | x) {
    case 0b00: return [three(p, q, r), three(s, t, u), 8 + y]
    case 0b01: return [three(p, q, r), 8 + u, three(s, t, y)]
    case 0b10: return [8 + r, three(s, t, u), three(p, q, y)]
  }
  // w x == 11：s t 位说明哪两位是大数字
  switch ((s << 1) | t) {
    case 0b00: return [8 + r, 8 + u, three(p, q, y)]
    case 0b01: return [8 + r, three(p, q, u), 8 + y]
    case 0b10: return [three(p, q, r), 8 + u, 8 + y]
  }
  return [8 + r, 8 + u, 8 + y]
}

/* ==========================================================================
 * 字节序小工具
 * ========================================================================== */

function readUint32LE(bytes: Uint8Array, off: number): number {
  return (bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24)) >>> 0
}

function readUint32BE(bytes: Uint8Array, off: number): number {
  return ((bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!) >>> 0
}

function readUint16BE(bytes: Uint8Array, off: number): number {
  return (bytes[off]! << 8) | bytes[off + 1]!
}

function readInt32LE(bytes: Uint8Array): number {
  return readUint32LE(bytes, 0) | 0
}

function readInt16LE(bytes: Uint8Array): number {
  const v = bytes[0]! | (bytes[1]! << 8)
  return (v & 0x8000) !== 0 ? v - 0x10000 : v
}

/** INT8：JS number 精度不足以表达全部 int64——按 VSP int64 语义输出字符串。 */
function readInt64LEAsString(bytes: Uint8Array): string {
  const ZERO = BigInt(0), ONE = BigInt(1), SIXTY_FOUR = BigInt(64), SIXTY_THREE = BigInt(63)
  let v = ZERO
  for (let i = 7; i >= 0; i -= 1) v = (v << BigInt(8)) | BigInt(bytes[i]!)
  // 二补数：>= 2^63 视为负
  if (v >= ONE << SIXTY_THREE) v -= ONE << SIXTY_FOUR
  return v.toString()
}

/* ==========================================================================
 * 流解析（cluster.go + legacy.go 移植）
 * ========================================================================== */

// 流标记：描述符标记成对出现；数据标记框住表、行、定长字节串与离行存储的串
const MARK_OBJ_STRUCT_BEGIN = 0xab // 结构对象描述符（含行类型内的 include——同字节）
const MARK_OBJ_STRUCT_END = 0xac
const MARK_OBJ_TABLE_BEGIN = 0xad // 表行类型描述符
const MARK_OBJ_TABLE_END = 0xae
const MARK_STRUCT_BEGIN = 0xa0 // 嵌套子结构
const MARK_STRUCT_END = 0xa1
const MARK_INCLUDE_END = 0xac
const MARK_LEAF = 0xaa
const MARK_FILLER = 0xaf
const MARK_ROW = 0xbc // 一行的定长字节段
const MARK_ROW_END = 0xbd
const MARK_TABLE = 0xbe // 行长 + 行数
const MARK_TABLE_END = 0xbf
const MARK_STRING = 0xca // 离行存储的 string/xstring 值
const MARK_STRING_END = 0xcb
const MARK_END = 0x04
const DESCRIPTOR_ENTRY_SIZE = 7 // V6：marker/code/decimals/u32 length
const LEGACY_DESCRIPTOR_SIZE = 4 // V5：marker/code/u16 length（无 decimals）
const LEGACY_ROW = 0xbb

class Cursor {
  position = 0
  constructor(readonly data: Uint8Array) {}

  need(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || this.position > this.data.byteLength - n) {
      throw new Error(`datacluster: truncated: need ${n} bytes at offset ${this.position}, have ${this.data.byteLength - this.position}`)
    }
  }

  u8(): number { this.need(1); return this.data[this.position++]! }

  u32be(): number {
    this.need(4)
    const v = readUint32BE(this.data, this.position)
    this.position += 4
    return v
  }
}

/** 节点在所属行占用的字节数：串与表恒 8 字节引用，其余为自身长度。 */
function slotOf(n: ClusterNode): number {
  return n.table || isStringType(n.typeCode) ? 8 : n.length
}

interface ParserState {
  dec: CharDecoder
  nodes: number
}

/**
 * 解析一个完整集群（对应 VSP Parse）：解压（如压缩）后逐对象解析到结束标记。
 *
 * tolerant=true 为对象级容错：单个对象解析失败记入 partialErrors 并继续
 * （其余对象照常解出——集群内对象边界独立，部分成功显式可见）；默认
 * fail-closed（任何对象失败即整流失败，VSP Parse 同款）。
 */
export function parseCluster(blob: Uint8Array, options?: { tolerant?: boolean }): ClusterData {
  if (blob.byteLength < HEADER_SIZE) {
    throw new Error(`datacluster: ${blob.byteLength} bytes is shorter than the ${HEADER_SIZE}-byte header`)
  }
  if (blob[0] !== 0xff) throw new Error(`datacluster: no cluster marker (first byte 0x${blob[0]!.toString(16).padStart(2, '0')}, want 0xFF)`)
  const version = blob[1]!
  const codepage = String.fromCharCode(blob[8]!, blob[9]!, blob[10]!, blob[11]!)
  let body = blob.subarray(HEADER_SIZE)
  let compressed = false
  let algorithm: 'LZC' | 'LZH' | undefined
  switch (blob[4]) {
    case 1:
      break
    case 2: {
      const h = parseSapCompressHeader(body)
      compressed = true
      algorithm = h.algorithm
      body = sapDecompress(body)
      break
    }
    default:
      throw new Error(`datacluster: unknown body format 0x${blob[4]!.toString(16).padStart(2, '0')}`)
  }
  if (body.byteLength > MAX_CLUSTER_BYTES) throw new Error('datacluster: expanded cluster exceeds byte limit')

  if (version !== 5 && version !== 6) {
    throw new Error(`datacluster: cluster format version ${version} is not one this reader knows (5 and 6 are)`)
  }
  const dec = CharDecoder.forCodepage(codepage)
  const state: ParserState = { dec, nodes: 0 }
  const cursor = new Cursor(body)
  const objects: ClusterObject[] = []
  const partialErrors: string[] = []
  for (;;) {
    if (cursor.position >= body.byteLength) throw new Error('datacluster: stream ends without the end marker')
    if (body[cursor.position] === MARK_END) break
    if (objects.length >= MAX_OBJECTS) throw new Error('datacluster: object limit exceeded')
    const objectStart = cursor.position
    let obj: ClusterObject
    try {
      // V6 = Unicode 内核形态（32 字节对象头 + UTF-16 名 + 7 字节描述符项）；
      // V5 = 老内核形态（15 字节头 + 单字节名 + 4 字节描述符项 + BB 行）
      obj = version === 5 ? legacyObject(cursor, state) : version === 6 ? objectV6(cursor, state) : undefined as never
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const diagnostic = `object ${objects.length + 1} at offset ${objectStart}: ${message}`
      if (options?.tolerant === true) {
        // 容错：跳过该对象继续。cursor 已推进到失败点——流的字节消费位置
        // 不可信（嵌套结构边界未知），此后无法安全续读，容错到此为止并如实
        // 记录（成功的对象已收集，失败的对象及其后不明）。
        partialErrors.push(diagnostic)
        break
      }
      throw new Error(`datacluster: ${diagnostic}`)
    }
    if (obj === undefined) {
      throw new Error(`datacluster: cluster format version ${version} is not one this reader knows (5 and 6 are)`)
    }
    objects.push(obj)
  }
  if (objects.length === 0 && partialErrors.length === 0) throw new Error('datacluster: cluster has no objects')

  const byName = new Map(objects.map(o => [o.name, o]))
  return {
    version,
    codepage,
    compressed,
    ...(algorithm ? { algorithm } : {}),
    objects,
    partialErrors,
    object: (name: string) => byName.get(name)
  }
}

/* ---- V6 对象（cluster.go object()）----
 * 头 32 字节 + 名：
 *   0     对象 kind：01 elementary / 07 elementary string / 02 平·05 深结构 /
 *         03 平·06 深表（内核用 kind 区分平深，下游只认描述符）
 *   1     元素或（行）结构类型码
 *   2     elementary packed 数的小数位，否则 0
 *   3-6   行长（BE）
 *   7-10  对象在明文体中的总长（BE；压缩时为 0）
 *   11    名长（字符数）
 *   12-31 0
 *   32-   名（UTF-16LE） */
function objectV6(p: Cursor, state: ParserState): ClusterObject {
  p.need(32)
  const base = p.position
  const kindByte = p.data[p.position]!
  const typeCode = p.data[p.position + 1]!
  const decimals = p.data[p.position + 2]!
  const rowLength = readUint32BE(p.data, p.position + 3)
  const size = readUint32BE(p.data, p.position + 7)
  const nameLen = p.data[p.position + 11]!
  p.position += 32
  p.need(nameLen * 2)
  const name = decodeUtf16(p.data.subarray(p.position, p.position + nameLen * 2), false)
  p.position += nameLen * 2
  if (nameLen < 1 || nameLen > MAX_NAME_CHARS) throw new Error('datacluster: object name length outside supported bounds')

  let kind: ClusterObjectKind
  switch (kindByte) {
    case 1:
    case 7:
      kind = 'elementary'
      break
    case 2:
    case 5:
      kind = 'structure'
      break
    case 3:
    case 6:
      kind = 'table'
      break
    default:
      throw new Error(`datacluster: unknown object kind 0x${kindByte.toString(16).padStart(2, '0')}`)
  }
  if (rowLength < 1 || rowLength > MAX_ROW_BYTES) throw new Error('datacluster: row length outside supported bounds')

  let type: ClusterNode
  if (kind === 'elementary') {
    type = { path: '1', typeCode, decimals, length: rowLength, filler: false, include: false, table: false, children: [] }
  } else {
    type = descriptorV6(p, state, kind)
    if (type.length !== rowLength) throw new Error(`datacluster: descriptor length ${type.length} does not match row length ${rowLength}`)
  }

  // 行叶子扁平化 + 字节对账（引用槽计入——串/表组件每行占 8 字节）
  const leaves: ClusterNode[] = []
  collectLeaves(type, leaves)
  if (leaves.length > MAX_FIELDS) throw new Error('datacluster: field limit exceeded')
  const sum = leaves.reduce((acc, n) => acc + slotOf(n), 0)
  if (sum !== rowLength) throw new Error(`datacluster: fields sum to ${sum} bytes, row is ${rowLength}`)
  const fields = leaves.filter(n => !n.filler).map(fieldOf)

  const rows: unknown[][] = []
  if (kind === 'table') {
    p.need(1)
    if (p.data[p.position] !== MARK_TABLE) {
      throw new Error(`datacluster: expected table data marker at offset ${p.position}, found 0x${p.data[p.position]!.toString(16).padStart(2, '0')}`)
    }
    p.position += 1
    const lineNode: ClusterNode = { path: '', typeCode, decimals: 0, length: rowLength, filler: false, include: false, table: true, children: type.children }
    rows.push(...tableRows(p, state, lineNode))
  } else {
    rows.push(rowV6(p, state, leaves))
  }
  void base
  void size
  return { name, kind, typeCode, rowLength, size, type, fields, rows }
}

/** V6 描述符树：7 字节项（marker/类型码/小数位/BE 长度），标记成对闭合。 */
function descriptorV6(p: Cursor, state: ParserState, kind: ClusterObjectKind): ClusterNode {
  p.need(DESCRIPTOR_ENTRY_SIZE)
  const open = kind === 'table' ? MARK_OBJ_TABLE_BEGIN : MARK_OBJ_STRUCT_BEGIN
  const close = kind === 'table' ? MARK_OBJ_TABLE_END : MARK_OBJ_STRUCT_END
  if (p.data[p.position] !== open) {
    throw new Error(`datacluster: expected descriptor marker 0x${open.toString(16).padStart(2, '0')} at offset ${p.position}, found 0x${p.data[p.position]!.toString(16).padStart(2, '0')}`)
  }
  const root: ClusterNode = {
    path: '',
    typeCode: p.data[p.position + 1]!,
    decimals: p.data[p.position + 2]!,
    length: readUint32BE(p.data, p.position + 3),
    filler: false, include: false, table: false, children: []
  }
  p.position += DESCRIPTOR_ENTRY_SIZE
  state.nodes += 1
  childrenV6(p, state, root, close, '', 0)
  return root
}

function childrenV6(p: Cursor, state: ParserState, parent: ClusterNode, close: number, prefix: string, depth: number): void {
  if (depth >= MAX_DEPTH) throw new Error('datacluster: descriptor nesting limit exceeded')
  for (;;) {
    const entryStart = p.position
    p.need(DESCRIPTOR_ENTRY_SIZE)
    const marker = p.data[p.position]!
    const code = p.data[p.position + 1]!
    const dec = p.data[p.position + 2]!
    const length = readUint32BE(p.data, p.position + 3)
    p.position += DESCRIPTOR_ENTRY_SIZE
    if (marker === close) {
      if (length !== parent.length) {
        throw new Error(`datacluster: descriptor closes with length ${length}, opened with ${parent.length}`)
      }
      return
    }
    state.nodes += 1
    if (state.nodes > MAX_NODES) throw new Error('datacluster: descriptor node limit exceeded')
    if (length > MAX_ROW_BYTES) {
      throw new Error(`datacluster: descriptor entry length ${length} outside supported bounds at offset ${entryStart}`)
    }
    const path = `${prefix}${countValues(parent) + 1}`
    switch (marker) {
      case MARK_LEAF:
        parent.children.push({ path, typeCode: code, decimals: dec, length, filler: false, include: false, table: false, children: [] })
        break
      case MARK_FILLER:
        parent.children.push({ path: '', typeCode: code, decimals: 0, length, filler: true, include: false, table: false, children: [] })
        break
      case MARK_STRUCT_BEGIN:
      case MARK_OBJ_STRUCT_BEGIN: { // 行类型内的 include（与对象结构同字节）
        const child: ClusterNode = { path, typeCode: code, decimals: dec, length, filler: false, include: marker === MARK_OBJ_STRUCT_BEGIN, table: false, children: [] }
        childrenV6(p, state, child, marker === MARK_OBJ_STRUCT_BEGIN ? MARK_INCLUDE_END : MARK_STRUCT_END, `${path}.`, depth + 1)
        parent.children.push(child)
        break
      }
      case MARK_OBJ_TABLE_BEGIN:
        // 表型组件：嵌套描述符是它的行类型，此处 length 是行长的而非槽位
        {
          const child: ClusterNode = { path, typeCode: code, decimals: dec, length, filler: false, include: false, table: true, children: [] }
          childrenV6(p, state, child, MARK_OBJ_TABLE_END, `${path}.`, depth + 1)
          parent.children.push(child)
        }
        break
      default:
        throw new Error(`datacluster: unknown descriptor marker 0x${marker.toString(16).padStart(2, '0')} at offset ${entryStart}`)
    }
  }
}

function countValues(n: ClusterNode): number {
  return n.children.filter(ch => !ch.filler).length
}

/** 把描述符扁平化成一行要供值的叶子：字段、填充、表组件（表组件虽带行类型，
 *  对所属行而言是一个叶子）。 */
function collectLeaves(n: ClusterNode, out: ClusterNode[]): void {
  if (n.children.length === 0 || n.table) {
    out.push(n)
    return
  }
  for (const ch of n.children) collectLeaves(ch, out)
}

function fieldOf(n: ClusterNode): ClusterField {
  const f: ClusterField = {
    path: n.path,
    type: n.table ? 'TABLE' : typeName(n.typeCode),
    typeCode: n.typeCode,
    length: n.length,
    ...(n.decimals ? { decimals: n.decimals } : {})
  }
  if (n.table) {
    const lineLeaves: ClusterNode[] = []
    for (const ch of n.children) collectLeaves(ch, lineLeaves)
    f.fields = lineLeaves.filter(l => !l.filler).map(fieldOf)
  }
  return f
}

/**
 * V6 行数据（cluster.go row()）：定长字段按 BC..BD 框出的段到达，每个串字段
 * 之前一段；串值在段间以 CA..CB 框出；行内串/表的 8 字节引用槽完全不写。
 * 行没有结束标记——最后一个 BC 段闭合即行完成（每个叶子都有值了）。
 */
function rowV6(p: Cursor, state: ParserState, leaves: ClusterNode[]): unknown[] {
  const values: unknown[] = []
  let i = 0 // 下一个待填叶子
  while (i < leaves.length) {
    p.need(1)
    const marker = p.data[p.position]!
    p.position += 1
    if (marker === MARK_ROW) {
      const n = p.u32be()
      p.need(n + 1)
      let run = p.data.subarray(p.position, p.position + n)
      p.position += n
      if (p.data[p.position] !== MARK_ROW_END) {
        throw new Error(`datacluster: fixed run not closed at offset ${p.position} (found 0x${p.data[p.position]!.toString(16).padStart(2, '0')})`)
      }
      p.position += 1
      while (run.byteLength > 0) {
        if (i >= leaves.length) throw new Error(`datacluster: ${run.byteLength} bytes of row data left after the last field`)
        const leaf = leaves[i]!
        if (isStringType(leaf.typeCode) || leaf.table) {
          throw new Error(`datacluster: field ${leaf.path} is a ${typeName(leaf.typeCode)} but the row supplies fixed bytes for it`)
        }
        if (run.byteLength < leaf.length) {
          throw new Error(`datacluster: field ${leaf.path} needs ${leaf.length} bytes, run has ${run.byteLength}`)
        }
        if (!leaf.filler) values.push(decodeFieldValue(state.dec, leaf, run.subarray(0, leaf.length)))
        run = run.subarray(leaf.length)
        i += 1
      }
    } else if (marker === MARK_STRING) {
      const n = p.u32be()
      p.need(n + 1)
      const raw = p.data.subarray(p.position, p.position + n)
      p.position += n
      if (p.data[p.position] !== MARK_STRING_END) throw new Error(`datacluster: string value not closed at offset ${p.position}`)
      p.position += 1
      while (i < leaves.length && leaves[i]!.filler) i += 1
      if (i >= leaves.length || !isStringType(leaves[i]!.typeCode)) {
        throw new Error(`datacluster: string value at offset ${p.position} has no string field to land in`)
      }
      values.push(decodeStringValue(state.dec, leaves[i]!, raw))
      i += 1
    } else if (marker === MARK_TABLE) {
      while (i < leaves.length && leaves[i]!.filler) i += 1
      if (i >= leaves.length || !leaves[i]!.table) {
        throw new Error(`datacluster: table data at offset ${p.position - 1} has no table field to land in`)
      }
      values.push(tableRows(p, state, leaves[i]!))
      i += 1
    } else {
      throw new Error(`datacluster: unexpected marker 0x${marker.toString(16).padStart(2, '0')} in row data at offset ${p.position - 1}`)
    }
  }
  return values
}

/** 嵌套表块（BE 已消费）：行长、行数、各行、闭合 BF。 */
function tableRows(p: Cursor, state: ParserState, table: ClusterNode): unknown[][] {
  p.need(8)
  const lineLen = p.u32be()
  const count = p.u32be()
  if (lineLen !== table.length) {
    throw new Error(`datacluster: nested table data has line length ${lineLen}, its descriptor ${table.length}`)
  }
  if (count > MAX_ROWS) throw new Error('datacluster: row limit exceeded')
  const leaves: ClusterNode[] = []
  for (const ch of table.children) collectLeaves(ch, leaves)
  const rows: unknown[][] = []
  for (let r = 0; r < count; r += 1) {
    try {
      rows.push(rowV6(p, state, leaves))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`datacluster: row ${r + 1}: ${message}`)
    }
  }
  p.need(1)
  if (p.data[p.position] !== MARK_TABLE_END) {
    throw new Error(`datacluster: nested table not closed at offset ${p.position} (found 0x${p.data[p.position]!.toString(16).padStart(2, '0')})`)
  }
  p.position += 1
  return rows
}

/* ---- V5 老内核形态（legacy.go）----
 * 头 15 字节 + 名：0 kind / 1 类型码 / 2-3 行长 BE / 4-5 对象长 BE / 6 名长 /
 * 7-14 逐对象不同且无需读取的 8 字节 / 15- 名（单字节每字符）。
 * 行由 BB 标记引出、无框——V5 没有串可框；描述符 4 字节项无小数位。 */
function legacyObject(p: Cursor, state: ParserState): ClusterObject {
  p.need(15)
  const kindByte = p.data[p.position]!
  const typeCode = p.data[p.position + 1]!
  const rowLength = readUint16BE(p.data, p.position + 2)
  const size = readUint16BE(p.data, p.position + 4)
  const nameLen = p.data[p.position + 6]!
  p.position += 15
  p.need(nameLen)
  const name = state.dec.text(p.data.subarray(p.position, p.position + nameLen))
  p.position += nameLen
  if (nameLen < 1 || nameLen > MAX_NAME_CHARS) throw new Error('datacluster: object name length outside supported bounds')
  if (rowLength < 1 || rowLength > MAX_ROW_BYTES) throw new Error('datacluster: row length outside supported bounds')

  let kind: ClusterObjectKind
  switch (kindByte) {
    case 1:
    case 7:
      kind = 'elementary'
      break
    case 2:
    case 5:
      kind = 'structure'
      break
    case 3:
    case 6:
      kind = 'table'
      break
    default:
      throw new Error(`datacluster: unknown object kind 0x${kindByte.toString(16).padStart(2, '0')}`)
  }

  let type: ClusterNode
  if (kind === 'elementary') {
    type = { path: '1', typeCode, decimals: 0, length: rowLength, filler: false, include: false, table: false, children: [] }
  } else {
    type = legacyDescriptor(p, state, kind)
    if (type.length !== rowLength) throw new Error(`datacluster: descriptor length ${type.length} does not match row length ${rowLength}`)
  }

  const leaves: ClusterNode[] = []
  collectLeaves(type, leaves)
  if (leaves.length > MAX_FIELDS) throw new Error('datacluster: field limit exceeded')
  const sum = leaves.reduce((acc, n) => acc + slotOf(n), 0)
  if (sum !== rowLength) throw new Error(`datacluster: fields sum to ${sum} bytes, row is ${rowLength}`)
  for (const n of leaves) {
    // V5 集群声明不支持串/表组件（VSP legacyObject 同款拒绝——0xAD 嵌套即在此
    // fail-closed；V6 路径才支持 deep 嵌套）
    if (isStringType(n.typeCode) || n.table) {
      throw new Error(`datacluster: field ${n.path} is a ${typeName(n.typeCode)}, which a version 5 cluster was not expected to hold`)
    }
  }
  const fields = leaves.filter(n => !n.filler).map(fieldOf)

  // 行：BB + 行字节，反复出现；空表没有行
  const rows: unknown[][] = []
  for (;;) {
    if (p.position >= p.data.byteLength || p.data[p.position] !== LEGACY_ROW) break
    if (rows.length >= MAX_ROWS) throw new Error('datacluster: row limit exceeded')
    p.position += 1
    p.need(rowLength)
    let run = p.data.subarray(p.position, p.position + rowLength)
    p.position += rowLength
    const row: unknown[] = []
    for (const leaf of leaves) {
      if (!leaf.filler) row.push(decodeFieldValue(state.dec, leaf, run.subarray(0, leaf.length)))
      run = run.subarray(leaf.length)
    }
    rows.push(row)
    if (kind !== 'table') break
  }
  if (kind !== 'table' && rows.length === 0) throw new Error(`datacluster: ${kind} object has no data row`)
  return { name, kind, typeCode, rowLength, size, type, fields, rows }
}

/** V5 描述符：4 字节项（marker/类型码/BE u16 长度），无小数位。 */
function legacyDescriptor(p: Cursor, state: ParserState, kind: ClusterObjectKind): ClusterNode {
  p.need(LEGACY_DESCRIPTOR_SIZE)
  const open = kind === 'table' ? MARK_OBJ_TABLE_BEGIN : MARK_OBJ_STRUCT_BEGIN
  const close = kind === 'table' ? MARK_OBJ_TABLE_END : MARK_OBJ_STRUCT_END
  if (p.data[p.position] !== open) {
    throw new Error(`datacluster: expected descriptor marker 0x${open.toString(16).padStart(2, '0')} at offset ${p.position}, found 0x${p.data[p.position]!.toString(16).padStart(2, '0')}`)
  }
  const root: ClusterNode = {
    path: '',
    typeCode: p.data[p.position + 1]!,
    decimals: 0,
    length: readUint16BE(p.data, p.position + 2),
    filler: false, include: false, table: false, children: []
  }
  p.position += LEGACY_DESCRIPTOR_SIZE
  state.nodes += 1
  legacyChildren(p, state, root, close, '')
  return root
}

function legacyChildren(p: Cursor, state: ParserState, parent: ClusterNode, close: number, prefix: string): void {
  for (;;) {
    const entryStart = p.position
    p.need(LEGACY_DESCRIPTOR_SIZE)
    const marker = p.data[p.position]!
    const code = p.data[p.position + 1]!
    const length = readUint16BE(p.data, p.position + 2)
    p.position += LEGACY_DESCRIPTOR_SIZE
    if (marker === close) {
      if (length !== parent.length) {
        throw new Error(`datacluster: descriptor closes with length ${length}, opened with ${parent.length}`)
      }
      return
    }
    state.nodes += 1
    if (state.nodes > MAX_NODES) throw new Error('datacluster: descriptor node limit exceeded')
    if (length > MAX_ROW_BYTES) {
      throw new Error(`datacluster: descriptor entry length ${length} outside supported bounds at offset ${entryStart}`)
    }
    const path = `${prefix}${countValues(parent) + 1}`
    switch (marker) {
      case MARK_LEAF:
        parent.children.push({ path, typeCode: code, decimals: 0, length, filler: false, include: false, table: false, children: [] })
        break
      case MARK_FILLER:
        parent.children.push({ path: '', typeCode: code, decimals: 0, length, filler: true, include: false, table: false, children: [] })
        break
      case MARK_STRUCT_BEGIN:
      case MARK_OBJ_STRUCT_BEGIN: {
        const child: ClusterNode = { path, typeCode: code, decimals: 0, length, filler: false, include: marker === MARK_OBJ_STRUCT_BEGIN, table: false, children: [] }
        legacyChildren(p, state, child, marker === MARK_OBJ_STRUCT_BEGIN ? MARK_INCLUDE_END : MARK_STRUCT_END, `${path}.`)
        parent.children.push(child)
        break
      }
      default:
        // V5 无 0xAD 嵌套表组件（deep 边界与上游 legacy 路径一致）
        throw new Error(`datacluster: unknown descriptor marker 0x${marker.toString(16).padStart(2, '0')} at offset ${entryStart}`)
    }
  }
}

/* ==========================================================================
 * 片段组装（fragments.go Join + DecodeHex 移植）
 * ========================================================================== */

/** 集群表的一行 = 一个片段：SRTF2 序号、该行有效的 CLUSTR 字节数、CLUSTD 字节。 */
export interface ClusterFragment {
  seq: number
  length: number
  data: Uint8Array
}

/**
 * 把一个集群键的片段拼回完整流：按序号排序、各按声明长度裁剪（VSP Join）。
 * 序列必须 0..n-1 无缺无重；末行通常短于列宽，其余行补零必须裁掉。
 * fail-closed：缺片/重复/空输入都是错误。
 */
export function joinFragments(fragments: ClusterFragment[]): Uint8Array {
  if (fragments.length === 0) throw new Error('datacluster: no fragments')
  const sorted = [...fragments].sort((a, b) => a.seq - b.seq)
  const parts: Uint8Array[] = []
  let total = 0
  for (let i = 0; i < sorted.length; i += 1) {
    const f = sorted[i]!
    if (i > 0 && f.seq === sorted[i - 1]!.seq) throw new Error(`datacluster: fragment ${f.seq} appears twice`)
    if (f.seq !== i) throw new Error(`datacluster: fragment ${i} is missing`)
    let n = f.length
    if (!Number.isSafeInteger(n) || n <= 0 || n > f.data.byteLength) n = f.data.byteLength
    const part = f.data.subarray(0, n)
    total += part.byteLength
    if (total > MAX_CLUSTER_BYTES) throw new Error('datacluster: assembled cluster exceeds byte limit')
    parts.push(part)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/**
 * 接受 datapreview/SE16 形态交付的 CLUSTD 列文本：大小写 hex、可含空白
 * （VSP DecodeHex；真机 wire 形态 2026-09-28 取证：连续混合大小写 hex）。
 */
export function decodeClusterHex(s: string): Uint8Array {
  const cleaned = s.replace(/[\s]/g, '')
  if (!/^[0-9a-fA-F]*$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error('datacluster: CLUSTD is not hex')
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'))
}
