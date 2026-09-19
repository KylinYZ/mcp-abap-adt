import { inflateRawSync } from 'node:zlib';

/**
 * ============================================================================
 * 最小 ZIP 读取器（abapGit 离线包解析的地基，零第三方依赖）
 * ============================================================================
 *
 * 用途：读取 abapGit 离线序列化包（.zip，DEFLATE/STORED）为 文件名→内容
 * 映射。只实现读所需的最小面：EOCD 定位 → 中央目录遍历 → 本地头校验 →
 * 按压缩方法取内容（8=DEFLATE 用 zlib.inflateRawSync；0=STORED 原样切片）。
 *
 * 边界（如实声明）：
 * - 不支持 ZIP64（abapGit 离线包 ≤10MB，远离 4GB 边界；超出即报错）；
 * - 不支持加密与分卷；未知压缩方法（非 0/8）报错而非静默乱码；
 * - 不校验 CRC32（部署层有逐对象读回校验兜底，此处省去查表开销）；
 *   解压后的长度以中央目录 uncompressedSize 为准截断。
 */

/** 一个 ZIP 条目（文本内容——abapGit 序列化均为文本/UTF-8）。 */
export interface ZipTextEntry {
  /** 条目完整路径（ZIP 内相对路径，正斜杠分隔）。 */
  readonly path: string
  /** 解压后的文本内容（UTF-8 解码）。 */
  readonly text: string
}

/** ZIP 解析失败（结构/方法/截断）。 */
export class ZipParseError extends Error {
  constructor(message: string) {
    super(`zip parse: ${message}`)
    this.name = 'ZipParseError'
  }
}

/** u16/u32 小端读取（ZIP 为小端格式）。 */
function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset)
}

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset)
}

/** u16/u32 小端写入（仅测试写入器使用）。 */
function putU16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset)
}

function putU32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset)
}

/** 在缓冲区末尾 window 内向后扫描 EOCD 签名（0x06054b50）。 */
function locateEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD 最短 22 字节；注释最长 65535——扫描窗口取两者之和与缓冲区长的较小者
  const window = Math.min(buffer.length, 22 + 65_536)
  const start = buffer.length - window
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (u32(buffer, offset) === 0x06054b50) return offset
  }
  throw new ZipParseError('end-of-central-directory signature not found')
}

/**
 * 读取 ZIP（Buffer）为 文本条目清单。
 * 目录顺序即条目顺序（中央目录序），不做排序——保持包内自然序。
 */
export function readZipTextEntries(buffer: Buffer): ZipTextEntry[] {
  if (buffer.length < 22) throw new ZipParseError(`buffer too small (${buffer.length} bytes)`)
  const eocd = locateEndOfCentralDirectory(buffer)
  const entryCount = u16(buffer, eocd + 10)
  let offset = u32(buffer, eocd + 16) // 中央目录起始偏移
  const entries: ZipTextEntry[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) throw new ZipParseError(`central directory entry ${index} truncated`)
    if (u32(buffer, offset) !== 0x02014b50) throw new ZipParseError(`entry ${index}: bad central signature`)
    const method = u16(buffer, offset + 10)
    const compressedSize = u32(buffer, offset + 20)
    const uncompressedSize = u32(buffer, offset + 24)
    const nameLength = u16(buffer, offset + 28)
    const extraLength = u16(buffer, offset + 30)
    const commentLength = u16(buffer, offset + 32)
    const localHeaderOffset = u32(buffer, offset + 42)
    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    // 本地文件头：名称/额外字段长度可能与中央目录不同，须按本地头实际值定位数据
    if (localHeaderOffset + 30 > buffer.length) throw new ZipParseError(`${path}: local header out of range`)
    if (u32(buffer, localHeaderOffset) !== 0x04034b50) throw new ZipParseError(`${path}: bad local signature`)
    const localNameLength = u16(buffer, localHeaderOffset + 26)
    const localExtraLength = u16(buffer, localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > buffer.length) throw new ZipParseError(`${path}: data out of range`)
    const raw = buffer.subarray(dataOffset, dataOffset + compressedSize)

    let content: Buffer
    if (method === 0) {
      content = raw
    } else if (method === 8) {
      content = inflateRawSync(raw)
    } else {
      throw new ZipParseError(`${path}: unsupported compression method ${method}`)
    }
    entries.push({ path, text: content.subarray(0, uncompressedSize).toString('utf8') })
  }
  return entries
}

/**
 * 最小 ZIP 写入器（仅测试用：STORED 条目，无需 CRC——读取端不校验）。
 * 生产代码不得使用（生成的包缺 CRC32，仅供本模块离线单测构造样例）。
 */
export function writeZipStoredEntries(entries: ReadonlyArray<{ path: string; text: string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const data = Buffer.from(entry.text, 'utf8')
    const local = Buffer.alloc(30)
    putU32(local, 0, 0x04034b50)
    putU16(local, 4, 20) // version needed
    putU16(local, 8, 0) // method STORED
    // 本地头字段偏移：crc=14、compressed=18、uncompressed=22、namelen=26、extralen=28
    putU32(local, 14, 0) // crc32（读取端不校验）
    putU32(local, 18, data.length)
    putU32(local, 22, data.length)
    putU16(local, 26, name.length)
    chunks.push(local, name, data)
    const centralEntry = Buffer.alloc(46)
    putU32(centralEntry, 0, 0x02014b50)
    putU16(centralEntry, 4, 20)
    putU16(centralEntry, 10, 0)
    putU32(centralEntry, 20, data.length)
    putU32(centralEntry, 24, data.length)
    putU16(centralEntry, 28, name.length)
    putU32(centralEntry, 42, offset)
    central.push(centralEntry, name)
    offset += 30 + name.length + data.length
  }
  const centralOffset = offset
  let centralSize = 0
  for (const chunk of central) centralSize += chunk.length
  const eocd = Buffer.alloc(22)
  putU32(eocd, 0, 0x06054b50)
  putU16(eocd, 8, entries.length)
  putU16(eocd, 10, entries.length)
  putU32(eocd, 12, centralSize)
  putU32(eocd, 16, centralOffset)
  return Buffer.concat([...chunks, ...central, eocd])
}
