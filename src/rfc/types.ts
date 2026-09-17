/**
 * RFC 基础类型规格模型（rfc-transport-spike 阶段 0）。
 *
 * 用途：以纯数据结构描述 ABAP/DDIC 侧的数据类型（CHAR/NUMC/INT/INT8/FLOAT/
 * DATE/TIME/STRING/XSTRING/BCD，以及结构体与内表的嵌套组合），供
 * codec.ts 做按字节布局编解码、interface.ts 生成 JSON Schema。
 *
 * 业务规则：
 * - 类型规格是「不可变事实」：校验通过后不得再修改（尤其是嵌套结构），
 *   否则可能引入环引用导致编解码死循环；校验函数会显式拒绝环引用。
 * - 定长类型（CHAR/NUMC/DATE/TIME/INT/INT8/FLOAT/BCD）字节长度固定；
 *   变长类型（STRING/XSTRING/TABLE）采用「4 字节大端长度前缀 + 负载」布局。
 */

import { RfcError } from './errors';

/** 定长字符类型：CHAR（左对齐空格填充）。length 为字符数（=字节数，latin-1）。 */
export interface RfcCharSpec {
  readonly kind: 'CHAR';
  readonly length: number;
}

/** 定长数字字符类型：NUMC（右对齐零填充，仅数字）。length 为字符数。 */
export interface RfcNumcSpec {
  readonly kind: 'NUMC';
  readonly length: number;
}

/** 4 字节大端有符号整数（ABAP INT，-2^31 .. 2^31-1）。 */
export interface RfcIntSpec {
  readonly kind: 'INT';
}

/** 8 字节大端有符号整数（ABAP INT8，-2^63 .. 2^63-1，JS 侧用 bigint 承载）。 */
export interface RfcInt8Spec {
  readonly kind: 'INT8';
}

/** 8 字节 IEEE-754 双精度浮点（ABAP FLOAT 为 8 字节二进制浮点）。 */
export interface RfcFloatSpec {
  readonly kind: 'FLOAT';
}

/** 日期类型：定长 8 字符，布局 yyyymmdd。 */
export interface RfcDateSpec {
  readonly kind: 'DATE';
}

/** 时间类型：定长 6 字符，布局 hhmmss（24 小时制）。 */
export interface RfcTimeSpec {
  readonly kind: 'TIME';
}

/** 变长字符串：4 字节大端字节长度前缀 + UTF-8 字节。 */
export interface RfcStringSpec {
  readonly kind: 'STRING';
}

/** 变长字节串：4 字节大端字节长度前缀 + 原始字节。 */
export interface RfcXstringSpec {
  readonly kind: 'XSTRING';
}

/**
 * 压缩十进制（ABAP PACKED / CURR、QUAN 底层类型）。
 *
 * 布局规则（与 SAP packed field 一致）：
 * - 每字节承载 2 个十进制位（高半字节在前），最后一个半字节为符号位
 *   （0xD = 负，0xC = 正；解码时 0xA/0xE/0xF 也按正数接受）。
 * - `length` 为字节数，容量 = length*2 - 1 个十进制位（预留半个字节给符号）。
 * - `decimals` 为小数位数，必须满足 decimals < capacity。
 */
export interface RfcBcdSpec {
  readonly kind: 'BCD';
  readonly length: number;
  readonly decimals: number;
}

export type RfcPrimitiveSpec =
  | RfcCharSpec
  | RfcNumcSpec
  | RfcIntSpec
  | RfcInt8Spec
  | RfcFloatSpec
  | RfcDateSpec
  | RfcTimeSpec
  | RfcStringSpec
  | RfcXstringSpec
  | RfcBcdSpec;

/** 结构体字段：字段名 + 类型（可再嵌套结构体/内表）。 */
export interface RfcFieldSpec {
  readonly name: string;
  readonly type: RfcTypeSpec;
}

/** 结构体：字段按声明顺序做字节串联布局。 */
export interface RfcStructureSpec {
  readonly kind: 'STRUCTURE';
  readonly fields: readonly RfcFieldSpec[];
}

/**
 * 内表：行类型 + （可选的）声明行数上限。
 *
 * 关键变量：
 * - `rowType`：每行的类型（基元、结构体均可）。
 * - `length`：ABAP 侧 INITIAL/DEFAULT 行数上限，仅作为描述信息保留；
 *   实际编解码按「4 字节大端行数前缀 + 逐行字节」布局，行数以数据为准。
 */
export interface RfcTableSpec {
  readonly kind: 'TABLE';
  readonly rowType: RfcTypeSpec;
  readonly length?: number;
}

export type RfcTypeSpec = RfcPrimitiveSpec | RfcStructureSpec | RfcTableSpec;

/* ---------------------------------------------------------------------------
 * 便捷构造器：让调用方以简洁字面量构建类型规格，同时集中做基本形状校验。
 * ------------------------------------------------------------------------- */

/** 构造 CHAR(length)，length 必须 >= 1。 */
export function char(length: number): RfcCharSpec {
  assertPositiveInteger(length, 'CHAR.length');
  return { kind: 'CHAR', length };
}

/** 构造 NUMC(length)，length 必须 >= 1。 */
export function numc(length: number): RfcNumcSpec {
  assertPositiveInteger(length, 'NUMC.length');
  return { kind: 'NUMC', length };
}

/** 构造 BCD(length, decimals)：capacity = length*2-1，decimals 必须 < capacity。 */
export function bcd(length: number, decimals: number): RfcBcdSpec {
  assertPositiveInteger(length, 'BCD.length');
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RfcError('RFC_CODEC_ERROR', 'BCD.decimals must be a non-negative integer.', {
      field: 'BCD.decimals',
      value: decimals
    });
  }
  const capacity = length * 2 - 1;
  if (decimals >= capacity) {
    throw new RfcError(
      'RFC_CODEC_ERROR',
      `BCD decimals (${decimals}) must be smaller than the digit capacity (${capacity}).`,
      { field: 'BCD.decimals', capacity }
    );
  }
  return { kind: 'BCD', length, decimals };
}

/** 构造结构体；字段名合法性由 validateRfcTypeSpec 统一深校验。 */
export function structure(fields: readonly RfcFieldSpec[]): RfcStructureSpec {
  return { kind: 'STRUCTURE', fields: [...fields] };
}

/** 构造内表；可选声明行数上限 length（仅描述用途）。 */
export function table(rowType: RfcTypeSpec, length?: number): RfcTableSpec {
  if (length !== undefined) assertPositiveInteger(length, 'TABLE.length');
  return { kind: 'TABLE', rowType, length };
}

/** 单例式基础规格（无参数类型），集中定义避免重复分配。 */
export const RFC_INT: RfcIntSpec = { kind: 'INT' };
export const RFC_INT8: RfcInt8Spec = { kind: 'INT8' };
export const RFC_FLOAT: RfcFloatSpec = { kind: 'FLOAT' };
export const RFC_DATE: RfcDateSpec = { kind: 'DATE' };
export const RFC_TIME: RfcTimeSpec = { kind: 'TIME' };
export const RFC_STRING: RfcStringSpec = { kind: 'STRING' };
export const RFC_XSTRING: RfcXstringSpec = { kind: 'XSTRING' };

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RfcError('RFC_CODEC_ERROR', `${field} must be a positive integer.`, { field, value });
  }
}

/* ---------------------------------------------------------------------------
 * 校验与布局计算
 * ------------------------------------------------------------------------- */

/** 类型规格递归校验的最大深度，防御性限制（真实 ABAP 嵌套远浅于该值）。 */
const MAX_TYPE_DEPTH = 64;

/** ABAP 命名规则（本阶段保守版）：1-30 个字符，字母/数字/下划线，不以数字开头。 */
export const ABAP_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,29}$/;

/**
 * 深度校验一个类型规格：
 * - kind 必须是已知值；length/decimals 等数量字段必须为正整数；
 * - 结构体字段名必须符合 ABAP 命名且不重复；
 * - 通过 WeakSet 检测环引用（同一对象直接或间接包含自身）。
 *
 * 校验失败抛出 `RFC_CODEC_ERROR`（含 field/path 详情）。建议在构造接口
 * 描述时调用一次，之后把规格当作只读数据使用。
 */
export function validateRfcTypeSpec(spec: RfcTypeSpec, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > MAX_TYPE_DEPTH) {
    throw new RfcError('RFC_CODEC_ERROR', 'Type nesting exceeds the maximum supported depth.', {
      maxDepth: MAX_TYPE_DEPTH
    });
  }
  if (typeof spec !== 'object' || spec === null || !('kind' in spec)) {
    throw new RfcError('RFC_CODEC_ERROR', 'Type spec must be a non-null object with a kind tag.');
  }
  // 环引用检测：同一规格对象在递归栈上出现两次即视为环。
  if (seen.has(spec)) {
    throw new RfcError('RFC_CODEC_ERROR', 'Cyclic type spec is not allowed.');
  }
  seen.add(spec);
  try {
    switch (spec.kind) {
      case 'CHAR':
      case 'NUMC':
        assertPositiveInteger(spec.length, `${spec.kind}.length`);
        return;
      case 'INT':
      case 'INT8':
      case 'FLOAT':
      case 'DATE':
      case 'TIME':
      case 'STRING':
      case 'XSTRING':
        return;
      case 'BCD':
        bcd(spec.length, spec.decimals); // 复用构造器的容量规则
        return;
      case 'STRUCTURE': {
        if (!Array.isArray(spec.fields)) {
          throw new RfcError('RFC_CODEC_ERROR', 'STRUCTURE.fields must be an array.');
        }
        const names = new Set<string>();
        for (const field of spec.fields) {
          if (typeof field?.name !== 'string' || !ABAP_NAME_PATTERN.test(field.name)) {
            throw new RfcError('RFC_CODEC_ERROR', `Invalid structure field name: ${JSON.stringify(field?.name)}.`, {
              field: field?.name
            });
          }
          if (names.has(field.name)) {
            throw new RfcError('RFC_CODEC_ERROR', `Duplicate structure field name: ${field.name}.`, {
              field: field.name
            });
          }
          names.add(field.name);
          validateRfcTypeSpec(field.type, seen, depth + 1);
        }
        return;
      }
      case 'TABLE':
        if (spec.length !== undefined) assertPositiveInteger(spec.length, 'TABLE.length');
        validateRfcTypeSpec(spec.rowType, seen, depth + 1);
        return;
      default:
        throw new RfcError('RFC_CODEC_ERROR', `Unknown type kind: ${JSON.stringify((spec as { kind?: unknown }).kind)}.`);
    }
  } finally {
    // 递归返回后把当前节点移出「当前路径」集合：DAG 形状的共享子结构合法。
    seen.delete(spec);
  }
}

/**
 * 返回定长类型的字节数；变长类型（STRING/XSTRING/TABLE）返回 null。
 *
 * 用途：结构体含变长字段时整体布局仍是变长的；连接池/传输层可据此
 * 预估缓冲区。调用前应先通过 validateRfcTypeSpec 保证规格合法。
 */
export function fixedByteLength(spec: RfcTypeSpec): number | null {
  switch (spec.kind) {
    case 'CHAR':
    case 'NUMC':
      return spec.length;
    case 'DATE':
      return 8; // yyyymmdd
    case 'TIME':
      return 6; // hhmmss
    case 'INT':
      return 4;
    case 'INT8':
      return 8;
    case 'FLOAT':
      return 8; // IEEE-754 double
    case 'BCD':
      return spec.length;
    case 'STRING':
    case 'XSTRING':
    case 'TABLE':
      return null;
    case 'STRUCTURE': {
      // 任一字段变长 ⇒ 整个结构体变长；否则为各字段字节数之和。
      let total = 0;
      for (const field of spec.fields) {
        const nested = fixedByteLength(field.type);
        if (nested === null) return null;
        total += nested;
      }
      return total;
    }
    default:
      return null;
  }
}
