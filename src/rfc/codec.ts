/**
 * RFC 基础类型编解码（rfc-transport-spike 阶段 0）。
 *
 * 本模块定义一套确定性的「内部规范字节布局」（canonical wire layout），
 * 用于阶段 0 的协议建模与测试；后续接入真实 SAP RFC 协议（RFC SDK /
 * open-rfc-go 网关）时，由传输适配器负责把该布局映射到实际线上格式。
 *
 * 布局约定（encode/decode 双向对称）：
 * - 所有多字节整数一律大端（与 SAP 网络字节序一致）。
 * - CHAR/NUMC/DATE/TIME：每字符 1 字节（latin-1）。
 *   - CHAR：左对齐，右侧用空格 0x20 填充到声明长度；解码时按 ABAP 语义
 *     去掉尾随空格（ABAP 中 CHAR 尾随空格不参与值语义）。
 *   - NUMC：右对齐，左侧用 '0' 填充到声明长度，仅允许数字；解码返回去
 *     前导零的规范化数字串（全零 → '0'）。
 *   - DATE：yyyymmdd（8 字节）；TIME：hhmmss（6 字节），解码保持原文本。
 * - INT：4 字节大端有符号；INT8：8 字节大端有符号（JS 侧 bigint 承载）。
 * - FLOAT：8 字节大端 IEEE-754 双精度。
 * - BCD(length, decimals)：每字节 2 个十进制位，最后一个半字节为符号
 *   （编码写 0xC/0xD；解码接受 0xA/0xC/0xD/0xE/0xF，仅 0xD 视为负）。
 *   值域以十进制字符串承载（如 '123.45'），避免二进制浮点精度损失。
 * - STRING：uint32 大端字节长度前缀 + UTF-8 字节。
 * - XSTRING：uint32 大端字节长度前缀 + 原始字节。
 * - STRUCTURE：字段按声明顺序字节串联。
 * - TABLE：uint32 大端行数前缀 + 逐行字节串联。
 */

import { RfcError } from './errors';
import { RfcBcdSpec, RfcTypeSpec, validateRfcTypeSpec } from './types';

/** 编解码递归深度上限：防御规格被运行期篡改形成环导致栈溢出。 */
const MAX_CODEC_DEPTH = 64;

/** 解码结果：value 为解码出的 JS 值；bytesRead 为实际消费的字节数。 */
export interface RfcDecodeResult {
  readonly value: unknown;
  readonly bytesRead: number;
}

/* ---------------------------------------------------------------------------
 * 入口 API
 * ------------------------------------------------------------------------- */

/**
 * 将 JS 值按类型规格编码为字节缓冲。
 *
 * 业务规则：
 * - 每次编码前做一次规格校验（含环引用检测），属保守策略，杜绝把非法
 *   规格带入递归编码。
 * - 任何不符合布局规则的输入（超长、非法字符、数值越界等）抛
 *   `RFC_CODEC_ERROR`，绝不静默截断（截断会掩盖数据错误）。
 */
export function encodeRfcValue(spec: RfcTypeSpec, value: unknown): Buffer {
  validateRfcTypeSpec(spec);
  const chunks: Buffer[] = [];
  encodeInto(spec, value, chunks, 0);
  return Buffer.concat(chunks);
}

/**
 * 从缓冲的 offset 处按类型规格解码一个值。
 *
 * 业务规则：
 * - 缓冲区剩余字节不足时抛 `RFC_CODEC_ERROR`（含期望/剩余字节数）。
 * - 定长类型允许缓冲尾部有多余字节，由 `bytesRead` 告知消费量；
 *   结构体/内表的解码据此推进游标。
 */
export function decodeRfcValue(spec: RfcTypeSpec, buffer: Buffer, offset = 0): RfcDecodeResult {
  validateRfcTypeSpec(spec);
  const reader: DecodeReader = { buffer, offset };
  const value = decodeFrom(spec, reader, 0);
  return { value, bytesRead: reader.offset - offset };
}

/* ---------------------------------------------------------------------------
 * 编码实现
 * ------------------------------------------------------------------------- */

/** 编码递归主体：chunks 采用 append-only 的分段缓冲，最后一次性 concat。 */
function encodeInto(spec: RfcTypeSpec, value: unknown, chunks: Buffer[], depth: number): void {
  if (depth > MAX_CODEC_DEPTH) {
    throw new RfcError('RFC_CODEC_ERROR', 'Encoding nesting exceeds the maximum supported depth.');
  }
  switch (spec.kind) {
    case 'CHAR':
      chunks.push(encodeFixedChar(value, spec.length));
      return;
    case 'NUMC':
      chunks.push(encodeNumc(value, spec.length));
      return;
    case 'INT':
      chunks.push(encodeInt(value));
      return;
    case 'INT8':
      chunks.push(encodeInt8(value));
      return;
    case 'FLOAT':
      chunks.push(encodeFloat(value));
      return;
    case 'DATE':
      chunks.push(encodeDate(value));
      return;
    case 'TIME':
      chunks.push(encodeTime(value));
      return;
    case 'STRING':
      chunks.push(encodeLengthPrefixed(Buffer.from(requireString(value, 'STRING'), 'utf8')));
      return;
    case 'XSTRING':
      chunks.push(encodeLengthPrefixed(requireBytes(value)));
      return;
    case 'BCD':
      chunks.push(encodeBcd(spec, value));
      return;
    case 'STRUCTURE':
      encodeStructure(spec.fields, value, chunks, depth);
      return;
    case 'TABLE': {
      if (!Array.isArray(value)) {
        throw codecError('TABLE value must be an array.', value);
      }
      // 布局：4 字节大端行数前缀 + 逐行字节（行数是自描述布局的一部分）。
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(value.length, 0);
      chunks.push(prefix);
      for (const row of value) {
        encodeInto(spec.rowType, row, chunks, depth + 1);
      }
      return;
    }
    default:
      throw codecError('Unknown type kind for encoding.', (spec as { kind?: unknown }).kind);
  }
}

/**
 * CHAR：字符串左对齐，右侧空格填充到声明长度。
 * 校验顺序：先拒非字符串，再逐字符拒绝 latin-1 之外码点（latin1 编码会
 * 对高位码点做静默截断，必须前置拦截），最后拒绝超长。
 */
function encodeFixedChar(value: unknown, length: number): Buffer {
  const text = requireString(value, 'CHAR');
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0xff) {
      throw codecError(`CHAR value contains a character outside latin-1: ${JSON.stringify(ch)}.`, text);
    }
  }
  if (Buffer.byteLength(text, 'latin1') > length) {
    throw codecError(`CHAR value is longer than ${length} characters.`, text);
  }
  const bytes = Buffer.alloc(length, 0x20); // 预填充空格（ABAP 字符型填充语义）
  Buffer.from(text, 'latin1').copy(bytes, 0);
  return bytes;
}

/** NUMC：仅数字，右对齐、左补 '0' 到声明长度；超长或含非数字即报错。 */
function encodeNumc(value: unknown, length: number): Buffer {
  const text = requireString(value, 'NUMC');
  if (!/^[0-9]*$/.test(text)) {
    throw codecError('NUMC value must contain digits only.', text);
  }
  if (text.length > length) {
    throw codecError(`NUMC value is longer than ${length} digits.`, text);
  }
  return Buffer.from(text.padStart(length, '0'), 'latin1');
}

/** INT：JS number 必须是落在 int32 范围内的整数。 */
function encodeInt(value: unknown): Buffer {
  const num = value;
  if (typeof num !== 'number' || !Number.isInteger(num) || num < -2147483648 || num > 2147483647) {
    throw codecError('INT value must be an integer within [-2147483648, 2147483647].', value);
  }
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(num, 0);
  return bytes;
}

/**
 * INT8：接受 bigint 或安全范围内的整数/十进制字符串，范围限制到 int64。
 * 注意：本仓库 tsconfig target 为 es2016，不允许 BigInt 字面量，
 * 因此一律通过 BigInt(...) 构造。
 */
function encodeInt8(value: unknown): Buffer {
  let big: bigint;
  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    // number 的安全整数范围（2^53）远小于 int64，超出则要求调用方传 bigint。
    if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
      throw codecError('INT8 number value exceeds the safe integer range; pass a bigint.', value);
    }
    big = BigInt(value);
  } else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    big = BigInt(value);
  } else {
    throw codecError('INT8 value must be a bigint, an integer number, or a decimal string.', value);
  }
  const int64Min = -BigInt('9223372036854775808');
  const int64Max = BigInt('9223372036854775807');
  if (big < int64Min || big > int64Max) {
    throw codecError('INT8 value must fit in a signed 64-bit integer.', value);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(big, 0);
  return bytes;
}

/** FLOAT：仅接受有限数值（ABAP FLOAT 不承载 NaN/Infinity）。 */
function encodeFloat(value: unknown): Buffer {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw codecError('FLOAT value must be a finite number.', value);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value, 0);
  return bytes;
}

/** DATE：yyyymmdd，且必须是真实存在的日历日期（含闰年规则）。 */
function encodeDate(value: unknown): Buffer {
  const text = requireString(value, 'DATE');
  if (!/^[0-9]{8}$/.test(text)) {
    throw codecError('DATE value must be exactly 8 digits in yyyymmdd layout.', text);
  }
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw codecError(`DATE value is not a real calendar date: ${text}.`, text);
  }
  return Buffer.from(text, 'latin1');
}

/** 指定年月的天数：4 月/6 月/9 月/11 月 30 天，2 月按闰年规则 28/29 天。 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** TIME：hhmmss，24 小时制，任一字段越界即报错。 */
function encodeTime(value: unknown): Buffer {
  const text = requireString(value, 'TIME');
  if (!/^[0-9]{6}$/.test(text)) {
    throw codecError('TIME value must be exactly 6 digits in hhmmss layout.', text);
  }
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2, 4));
  const second = Number(text.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59) {
    throw codecError(`TIME value is outside 00:00:00-23:59:59: ${text}.`, text);
  }
  return Buffer.from(text, 'latin1');
}

/**
 * BCD：十进制数字符串/数值 → packed 字节。
 *
 * 关键变量：
 * - `capacity`：可用十进制位总数 = length*2 - 1（预留半个字节给符号）。
 * - `digitText`：整数部分去前导零 + 小数部分补零到 decimals 的总位数。
 * 业务规则：小数位多于 decimals 或整数位溢出时直接报错，不做静默舍入
 * （金额/数量精度问题必须显式暴露给调用方）。
 */
function encodeBcd(spec: RfcBcdSpec, value: unknown): Buffer {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw codecError('BCD value must be finite.', value);
    text = value.toString();
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw codecError('BCD value must be a number or decimal string.', value);
  }
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(text)) {
    throw codecError(`BCD value must be a plain decimal number: ${JSON.stringify(value)}.`, value);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const intDigits = intPartRaw.replace(/^0+(?=\d)/, ''); // 去前导零但保留单个 0
  if (fracPartRaw.length > spec.decimals) {
    throw codecError(
      `BCD value has ${fracPartRaw.length} fraction digits, exceeding decimals=${spec.decimals}.`,
      value
    );
  }
  const capacity = spec.length * 2 - 1;
  const digitText = intDigits + fracPartRaw.padEnd(spec.decimals, '0');
  if (digitText.length > capacity) {
    throw codecError(`BCD value needs ${digitText.length} digits, exceeding capacity ${capacity}.`, value);
  }
  // 高位补零到满容量（capacity 为奇数），确保每个字节都来自确定数字。
  const padded = digitText.padStart(capacity, '0');
  const bytes = Buffer.alloc(spec.length, 0x00);
  for (let i = 0; i < spec.length; i++) {
    // 最后一个字节的低半字节留给符号位，此处只处理数字位。
    const high = i * 2 < capacity ? Number.parseInt(padded[i * 2], 10) : 0;
    const low = i * 2 + 1 < capacity ? Number.parseInt(padded[i * 2 + 1], 10) : 0;
    bytes[i] = (high << 4) | low;
  }
  // 最后半字节写符号：0xD = 负，0xC = 正（0 视为正）。
  const lastIndex = spec.length - 1;
  bytes[lastIndex] = negative ? (bytes[lastIndex] & 0xf0) | 0x0d : (bytes[lastIndex] & 0xf0) | 0x0c;
  return bytes;
}

/** 结构体：要求普通对象（非数组/null），字段必须齐全且不得含未知键。 */
function encodeStructure(
  fields: readonly { name: string; type: RfcTypeSpec }[],
  value: unknown,
  chunks: Buffer[],
  depth: number
): void {
  if (!isPlainObject(value)) {
    throw codecError('STRUCTURE value must be a plain object.', value);
  }
  const declared = new Set(fields.map(f => f.name));
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) {
      throw codecError(`STRUCTURE value has unknown field: ${key}.`, key);
    }
  }
  for (const field of fields) {
    const fieldValue = (value as Record<string, unknown>)[field.name];
    if (fieldValue === undefined) {
      throw codecError(`STRUCTURE value is missing field: ${field.name}.`, field.name);
    }
    encodeInto(field.type, fieldValue, chunks, depth + 1);
  }
}

/* ---------------------------------------------------------------------------
 * 解码实现
 * ------------------------------------------------------------------------- */

/** 解码游标：reader.offset 随消费推进；同一层级的子解码共享游标对象。 */
interface DecodeReader {
  buffer: Buffer;
  offset: number;
}

function decodeFrom(spec: RfcTypeSpec, reader: DecodeReader, depth: number): unknown {
  if (depth > MAX_CODEC_DEPTH) {
    throw new RfcError('RFC_CODEC_ERROR', 'Decoding nesting exceeds the maximum supported depth.');
  }
  switch (spec.kind) {
    case 'CHAR':
      // ABAP 语义：CHAR 尾随空格不属于值的一部分，解码时统一去掉。
      return decodeFixedText(reader, spec.length).replace(/ +$/, '');
    case 'NUMC':
      return decodeNumc(reader, spec.length);
    case 'INT': {
      readSized(reader, 4);
      return reader.buffer.readInt32BE(consume(reader, 4));
    }
    case 'INT8': {
      readSized(reader, 8);
      return reader.buffer.readBigInt64BE(consume(reader, 8));
    }
    case 'FLOAT': {
      readSized(reader, 8);
      return reader.buffer.readDoubleBE(consume(reader, 8));
    }
    case 'DATE':
      return decodeFixedText(reader, 8);
    case 'TIME':
      return decodeFixedText(reader, 6);
    case 'STRING':
    case 'XSTRING': {
      const payload = decodeLengthPrefixed(reader);
      // STRING 按 UTF-8 还原文本；XSTRING 保持原始字节。
      return spec.kind === 'STRING' ? payload.toString('utf8') : payload;
    }
    case 'BCD':
      return decodeBcd(spec, reader);
    case 'STRUCTURE': {
      const result: Record<string, unknown> = {};
      for (const field of spec.fields) {
        result[field.name] = decodeFrom(field.type, reader, depth + 1);
      }
      return result;
    }
    case 'TABLE': {
      const rowCount = readUInt32(reader);
      // 早期防御：任何合法行至少占 1 字节，行数大于剩余字节数必然越界；
      // 精确的越界检查仍由逐行解码的 buffer underflow 兜底。
      const remaining = reader.buffer.length - reader.offset;
      if (rowCount > remaining) {
        throw codecError(`TABLE row count ${rowCount} exceeds the remaining ${remaining} bytes.`, rowCount);
      }
      const rows: unknown[] = [];
      for (let i = 0; i < rowCount; i++) {
        rows.push(decodeFrom(spec.rowType, reader, depth + 1));
      }
      return rows;
    }
    default:
      throw codecError('Unknown type kind for decoding.', (spec as { kind?: unknown }).kind);
  }
}

/** 读取定长 latin-1 文本（CHAR/DATE/TIME/NUMC 共用），恰好消费 length 字节。 */
function decodeFixedText(reader: DecodeReader, length: number): string {
  readSized(reader, length);
  const start = consume(reader, length);
  // 注意必须显式给出 end：toString(encoding, start) 会一直读到缓冲区末尾。
  return reader.buffer.toString('latin1', start, start + length);
}

/** NUMC 解码：校验数字后返回去前导零的规范化值（'0042' → '42'，全零 → '0'）。 */
function decodeNumc(reader: DecodeReader, length: number): string {
  const text = decodeFixedText(reader, length);
  if (!/^[0-9]+$/.test(text)) {
    throw codecError(`NUMC bytes are not all digits: ${JSON.stringify(text)}.`, text);
  }
  return text.replace(/^0+(?=\d)/, '');
}

/**
 * BCD 解码：半字节拼数字 + 符号位判定，返回规范化十进制字符串。
 * 返回形态与 encodeBcd 的输入形态对称（如 '-123.45'），保证可回编。
 */
function decodeBcd(spec: RfcBcdSpec, reader: DecodeReader): string {
  readSized(reader, spec.length);
  const bytes = reader.buffer.subarray(consume(reader, spec.length));
  let digits = '';
  for (let i = 0; i < bytes.length; i++) {
    const high = bytes[i] >> 4;
    const low = bytes[i] & 0x0f;
    // 高半字节永远是数字位。
    if (high > 9) throw codecError(`BCD byte ${i} has a non-digit high nibble.`, bytes[i]);
    digits += String(high);
    if (i < bytes.length - 1) {
      // 非末字节的低半字节也是数字位。
      if (low > 9) throw codecError(`BCD byte ${i} has a non-digit low nibble.`, bytes[i]);
      digits += String(low);
    }
  }
  // 末字节低半字节为符号：SAP packed 约定 0xD 为负，0xA/0xC/0xE/0xF 按正数接受。
  const signNibble = bytes[bytes.length - 1] & 0x0f;
  if (signNibble !== 0x0d && signNibble !== 0x0a && signNibble !== 0x0c && signNibble !== 0x0e && signNibble !== 0x0f) {
    throw codecError(`BCD sign nibble is invalid: 0x${signNibble.toString(16)}.`, signNibble);
  }
  if (digits.length > spec.length * 2 - 1) {
    throw codecError('BCD digit nibbles exceed the declared byte length.', digits);
  }
  const negative = signNibble === 0x0d;
  // 组装规范化十进制文本：整数部分去前导零且至少一位（'0'），小数部分保留 decimals 位。
  const rawIntPart = digits.slice(0, digits.length - spec.decimals);
  const intPart = rawIntPart === '' ? '0' : rawIntPart.replace(/^0+(?=\d)/, '');
  const fracPart = spec.decimals > 0 ? digits.slice(digits.length - spec.decimals) : '';
  const normalized = `${intPart}${fracPart ? `.${fracPart}` : ''}`;
  const isZero = /^0*$/.test(intPart + fracPart);
  return negative && !isZero ? `-${normalized}` : normalized;
}

/* ---------------------------------------------------------------------------
 * 底层读写工具
 * ------------------------------------------------------------------------- */

/** 读取并消费 uint32 大端长度前缀，返回负载字节切片。 */
function decodeLengthPrefixed(reader: DecodeReader): Buffer {
  const length = readUInt32(reader);
  readSized(reader, length);
  const start = consume(reader, length);
  return reader.buffer.subarray(start, start + length);
}

/** 读取 uint32 大端并校验剩余缓冲充足。 */
function readUInt32(reader: DecodeReader): number {
  readSized(reader, 4);
  return reader.buffer.readUInt32BE(consume(reader, 4));
}

/** 校验剩余字节数足够；不足则抛 RFC_CODEC_ERROR（含期望/剩余）。 */
function readSized(reader: DecodeReader, size: number): void {
  if (reader.buffer.length - reader.offset < size) {
    throw new RfcError('RFC_CODEC_ERROR', 'Buffer underflow while decoding RFC value.', {
      needed: size,
      remaining: reader.buffer.length - reader.offset
    });
  }
}

/** 消费 n 字节并返回起点下标（供 Buffer 的带 offset 方法使用）。 */
function consume(reader: DecodeReader, size: number): number {
  const start = reader.offset;
  reader.offset += size;
  return start;
}

/** 变长负载编码：4 字节大端长度前缀 + 负载字节。 */
function encodeLengthPrefixed(payload: Buffer): Buffer {
  if (payload.length > 0xffffffff) {
    throw codecError('Variable-length payload exceeds the 4 GiB length prefix.', payload.length);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

/* ---------------------------------------------------------------------------
 * 通用工具
 * ------------------------------------------------------------------------- */

/** 要求值为字符串，否则抛 RFC_CODEC_ERROR。 */
function requireString(value: unknown, kind: string): string {
  if (typeof value !== 'string') {
    throw codecError(`${kind} value must be a string.`, value);
  }
  return value;
}

/** 要求值为字节序列（Buffer/Uint8Array），并复制为独立 Buffer。 */
function requireBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw codecError('XSTRING value must be a Buffer or Uint8Array.', value);
  }
  return Buffer.from(value);
}

/** 构造统一的编解码错误，附带出错值便于定位（字节序列只记长度不记内容）。 */
function codecError(message: string, offending: unknown): RfcError {
  return new RfcError('RFC_CODEC_ERROR', message, {
    offending: offending instanceof Uint8Array ? `Uint8Array(${offending.length})` : offending
  });
}

/** 判定是否为普通对象（排除数组与 null），用于结构体的类型约束。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
