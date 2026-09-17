/**
 * FM（函数模块）接口描述模型（rfc-transport-spike 阶段 0）。
 *
 * 用途：
 * - 以纯数据结构建模 FM 的参数方向（IMPORTING/EXPORTING/CHANGING/TABLES）
 *   与异常（EXCEPTIONS），对应 SE37 里看到的接口签名。
 * - 由接口描述生成 JSON Schema（支撑未来 rfc.remote-enabled.describe 能力，
 *   对齐 VSP `SAP(action=rfc, params={op:describe})` 的语义）。
 * - 提供调用入参 payload 校验器：允许字段、必填项、类型形状，作为 allowlist
 *   之外的第二道结构化防线（字节级校验由 codec 在编码时最终把关）。
 */

import { RfcError } from './errors';
import {
  ABAP_NAME_PATTERN,
  RfcBcdSpec,
  RfcCharSpec,
  RfcNumcSpec,
  RfcTableSpec,
  RfcTypeSpec,
  validateRfcTypeSpec
} from './types';

/** FM 参数方向。EXCEPTIONS 不是值参数，单独用 FmException 建模。 */
export type FmParameterDirection = 'IMPORTING' | 'EXPORTING' | 'CHANGING' | 'TABLES';

/** FM 参数：名称 + 方向 + 类型规格；optional 标记是否可省略。 */
export interface FmParameter {
  readonly name: string;
  readonly direction: FmParameterDirection;
  readonly type: RfcTypeSpec;
  readonly optional?: boolean;
}

/** FM 的 ABAP 异常（RAISE 关注的名字；number 为可选的消息编号）。 */
export interface FmException {
  readonly name: string;
  readonly number?: number;
}

/** FM 接口描述整体。 */
export interface FmInterfaceDescription {
  readonly name: string;
  readonly parameters: readonly FmParameter[];
  readonly exceptions: readonly FmException[];
}

/** 本阶段内部使用的最小 JSON Schema 结构（足够表达 describe 所需）。 */
export interface RfcJsonSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, RfcJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: RfcJsonSchema;
  readonly pattern?: string;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
  readonly description?: string;
  readonly contentEncoding?: string;
}

/** payload 校验结果：ok=true 时给出归一化副本；ok=false 时给出错误清单。 */
export type FmPayloadValidation =
  | { readonly ok: true; readonly normalized: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly errors: readonly string[] };

/** INT8（int64）在 JSON Schema 里以 format 标注（JSON number 无法完整表达 2^63）。 */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/* ---------------------------------------------------------------------------
 * 接口描述校验
 * ------------------------------------------------------------------------- */

/**
 * 校验 FM 接口描述本身：FM 名与参数/异常名符合 ABAP 命名、方向合法、
 * 参数不重名、类型规格通过 validateRfcTypeSpec（含环引用检测）。
 * 校验失败抛 `RFC_INVALID_INTERFACE`。
 */
export function validateFmInterface(description: FmInterfaceDescription): void {
  if (typeof description?.name !== 'string' || !isValidFmName(description.name)) {
    throw new RfcError('RFC_INVALID_INTERFACE', `Invalid FM name: ${JSON.stringify(description?.name)}.`);
  }
  if (!Array.isArray(description.parameters)) {
    throw new RfcError('RFC_INVALID_INTERFACE', 'FM parameters must be an array.');
  }
  const names = new Set<string>();
  for (const parameter of description.parameters) {
    if (typeof parameter?.name !== 'string' || !ABAP_NAME_PATTERN.test(parameter.name)) {
      throw new RfcError('RFC_INVALID_INTERFACE', `Invalid FM parameter name: ${JSON.stringify(parameter?.name)}.`);
    }
    if (names.has(parameter.name)) {
      throw new RfcError('RFC_INVALID_INTERFACE', `Duplicate FM parameter name: ${parameter.name}.`);
    }
    names.add(parameter.name);
    if (!isParameterDirection(parameter.direction)) {
      throw new RfcError('RFC_INVALID_INTERFACE', `Invalid FM parameter direction: ${String(parameter.direction)}.`);
    }
    validateRfcTypeSpec(parameter.type);
  }
  if (!Array.isArray(description.exceptions)) {
    throw new RfcError('RFC_INVALID_INTERFACE', 'FM exceptions must be an array.');
  }
  for (const exception of description.exceptions) {
    if (typeof exception?.name !== 'string' || exception.name.length === 0 || exception.name.length > 30) {
      throw new RfcError('RFC_INVALID_INTERFACE', `Invalid FM exception name: ${JSON.stringify(exception?.name)}.`);
    }
  }
}

/** FM 名规则（阶段 0）：字母或 '/' 开头，仅大写字母/数字/下划线/'/'，最长 60。 */
export function isValidFmName(name: string): boolean {
  return typeof name === 'string' && /^[A-Z/][A-Z0-9_/]{0,59}$/.test(name);
}

function isParameterDirection(value: unknown): value is FmParameterDirection {
  return value === 'IMPORTING' || value === 'EXPORTING' || value === 'CHANGING' || value === 'TABLES';
}

/* ---------------------------------------------------------------------------
 * JSON Schema 生成（供未来 describe 操作）
 * ------------------------------------------------------------------------- */

/**
 * 由接口描述生成 JSON Schema。
 *
 * 业务规则：
 * - `direction: 'input'`（默认）：属性覆盖 IMPORTING + CHANGING + TABLES；
 *   required 仅包含「非 optional 的 IMPORTING/CHANGING」——TABLES 允许
 *   整体缺省（等价空表），不进入 required。
 * - `direction: 'output'`：属性覆盖 EXPORTING + CHANGING + TABLES，
 *   required 为非 optional 的 EXPORTING（回传值视角）。
 * - 调用前会先 validateFmInterface，保证生成的 Schema 结构可信。
 */
export function fmInterfaceToJsonSchema(
  description: FmInterfaceDescription,
  direction: 'input' | 'output' = 'input'
): RfcJsonSchema {
  validateFmInterface(description);
  const wanted: FmParameterDirection[] = direction === 'input'
    ? ['IMPORTING', 'CHANGING', 'TABLES']
    : ['EXPORTING', 'CHANGING', 'TABLES'];
  const properties: Record<string, RfcJsonSchema> = {};
  const required: string[] = [];
  for (const parameter of description.parameters) {
    if (!wanted.includes(parameter.direction)) continue;
    properties[parameter.name] = rfcTypeSpecToJsonSchema(parameter.type);
    // required 规则：IMPORTING/EXPORTING/CHANGING 缺失即不完整；TABLES 可整体缺省（空表语义）。
    if (!parameter.optional && parameter.direction !== 'TABLES') {
      required.push(parameter.name);
    }
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    description: `${direction} schema for FM ${description.name}`
  };
}

/** 单个类型规格 → JSON Schema 片段（递归覆盖结构体/内表）。 */
export function rfcTypeSpecToJsonSchema(spec: RfcTypeSpec): RfcJsonSchema {
  switch (spec.kind) {
    case 'CHAR':
      return { type: 'string', maxLength: spec.length, description: 'CHAR (latin-1, left-aligned)' };
    case 'NUMC': {
      const numericChar = (spec as RfcNumcSpec).length;
      return { type: 'string', pattern: `^[0-9]{1,${numericChar}}$`, description: 'NUMC (digits)' };
    }
    case 'INT':
      return { type: 'integer', minimum: INT32_MIN, maximum: INT32_MAX };
    case 'INT8':
      return { type: 'integer', format: 'int64' };
    case 'FLOAT':
      return { type: 'number', description: 'FLOAT (IEEE-754 double)' };
    case 'DATE':
      return { type: 'string', pattern: '^[0-9]{8}$', description: 'DATE yyyymmdd' };
    case 'TIME':
      return { type: 'string', pattern: '^[0-9]{6}$', description: 'TIME hhmmss' };
    case 'STRING':
      return { type: 'string' };
    case 'XSTRING':
      return { type: 'string', contentEncoding: 'base64', description: 'raw bytes carried as base64 text' };
    case 'BCD': {
      const bcdSpec = spec as RfcBcdSpec;
      const fraction = bcdSpec.decimals > 0 ? `(\\.[0-9]{1,${bcdSpec.decimals}})?` : '';
      return { type: 'string', pattern: `^-?[0-9]+${fraction}$`, description: `BCD (decimals=${bcdSpec.decimals})` };
    }
    case 'STRUCTURE': {
      const properties: Record<string, RfcJsonSchema> = {};
      const required: string[] = [];
      for (const field of spec.fields) {
        properties[field.name] = rfcTypeSpecToJsonSchema(field.type);
        required.push(field.name); // 结构体字段在编解码层全部必填
      }
      return { type: 'object', properties, required };
    }
    case 'TABLE': {
      const tableSpec = spec as RfcTableSpec;
      return { type: 'array', items: rfcTypeSpecToJsonSchema(tableSpec.rowType) };
    }
    default:
      // 类型规格未经校验时的兜底：给出无约束 schema 而不是崩溃。
      return {};
  }
}

/* ---------------------------------------------------------------------------
 * 入参 payload 校验
 * ------------------------------------------------------------------------- */

/**
 * 校验调用入参 payload 是否匹配接口描述。
 *
 * 业务规则：
 * - payload 必须是普通对象；只允许出现输入方向（IMPORTING/CHANGING/TABLES）
 *   的字段——EXPORTING 是回传值，出现在调用 payload 中视为调用方错误；
 *   接口中不存在的字段同样直接判不通过（不静默忽略，与「禁止任意 FM
 *   调用入口」的收紧策略一致）。
 * - IMPORTING/CHANGING 非 optional 参数必须出现；TABLES 可缺省（空表语义）。
 * - 每个字段按类型规格做形状校验（字符串形态、数值范围、嵌套结构、
 *   表行数等）；这里不做字节编码，字节级最终校验由 codec 负责。
 */
export function validateFmCallPayload(description: FmInterfaceDescription, payload: unknown): FmPayloadValidation {
  validateFmInterface(description);
  const errors: string[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ['payload must be a plain object.'] };
  }
  const input = payload as Record<string, unknown>;
  const inputs = new Map(
    description.parameters
      .filter(p => p.direction !== 'EXPORTING')
      .map(p => [p.name, p])
  );
  const outputs = new Set(description.parameters.filter(p => p.direction === 'EXPORTING').map(p => p.name));
  for (const key of Object.keys(input)) {
    if (outputs.has(key)) {
      errors.push(`payload field ${key} is an EXPORTING parameter and cannot appear in the call payload.`);
    } else if (!inputs.has(key)) {
      errors.push(`payload has unknown field: ${key}.`);
    }
  }
  const normalized: Record<string, unknown> = {};
  for (const parameter of inputs.values()) {
    const present = input[parameter.name] !== undefined;
    if (!present) {
      // TABLES 可整体缺省（空表语义）；IMPORTING/CHANGING 的 optional 参数可缺省。
      if (parameter.direction !== 'TABLES' && !parameter.optional) {
        errors.push(`payload is missing required field: ${parameter.name}.`);
      }
      continue;
    }
    validateValueAgainstSpec(parameter.type, input[parameter.name], parameter.name, errors, 0);
    normalized[parameter.name] = input[parameter.name];
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, normalized };
}

/** 递归形状校验；出错信息以字段路径为前缀写入 errors，一次收集全部问题。 */
function validateValueAgainstSpec(spec: RfcTypeSpec, value: unknown, path: string, errors: string[], depth: number): void {
  if (depth > 64) {
    errors.push(`${path} exceeds the maximum nesting depth.`);
    return;
  }
  switch (spec.kind) {
    case 'CHAR':
      if (typeof value !== 'string' || value.length > spec.length) {
        errors.push(`${path} must be a string of at most ${spec.length} characters.`);
      }
      return;
    case 'NUMC':
      if (typeof value !== 'string' || !/^[0-9]{1,}$/.test(value) || value.length > spec.length) {
        errors.push(`${path} must be a digit string of at most ${spec.length} digits.`);
      }
      return;
    case 'INT':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
        errors.push(`${path} must be an integer within [${INT32_MIN}, ${INT32_MAX}].`);
      }
      return;
    case 'INT8':
      if (typeof value === 'bigint') {
        const int64Max = BigInt('9223372036854775807');
        const int64Min = -BigInt('9223372036854775808');
        if (value < int64Min || value > int64Max) errors.push(`${path} must fit in a signed 64-bit integer.`);
        return;
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
        return;
      }
      errors.push(`${path} must be a bigint or a safe integer number.`);
      return;
    case 'FLOAT':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} must be a finite number.`);
      }
      return;
    case 'DATE':
      if (typeof value !== 'string' || !/^[0-9]{8}$/.test(value)) {
        errors.push(`${path} must be an 8-digit yyyymmdd string.`);
      }
      return;
    case 'TIME':
      if (typeof value !== 'string' || !/^[0-9]{6}$/.test(value)) {
        errors.push(`${path} must be a 6-digit hhmmss string.`);
      }
      return;
    case 'STRING':
      if (typeof value !== 'string') {
        errors.push(`${path} must be a string.`);
      }
      return;
    case 'XSTRING':
      if (!(value instanceof Uint8Array)) {
        errors.push(`${path} must be a Buffer or Uint8Array.`);
      }
      return;
    case 'BCD': {
      const text = typeof value === 'number' && Number.isFinite(value) ? value.toString() : value;
      if (typeof text !== 'string' || !/^-?[0-9]+(\.[0-9]+)?$/.test(text)) {
        errors.push(`${path} must be a decimal number or string.`);
        return;
      }
      const unsigned = text.replace(/^-/, '');
      const [intPart, fracPart = ''] = unsigned.split('.');
      if (fracPart.length > (spec as RfcBcdSpec).decimals) {
        errors.push(`${path} has more fraction digits than decimals=${(spec as RfcBcdSpec).decimals}.`);
      }
      const capacity = (spec as RfcBcdSpec).length * 2 - 1;
      if (intPart.replace(/^0+(?=\d)/, '').length + Math.max(fracPart.length, (spec as RfcBcdSpec).decimals) > capacity) {
        errors.push(`${path} exceeds the BCD capacity of ${capacity} digits.`);
      }
      return;
    }
    case 'STRUCTURE': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be a plain object.`);
        return;
      }
      const record = value as Record<string, unknown>;
      const declared = new Set(spec.fields.map(f => f.name));
      for (const key of Object.keys(record)) {
        if (!declared.has(key)) errors.push(`${path} has unknown field: ${key}.`);
      }
      for (const field of spec.fields) {
        // 结构体字段在编解码层全部必填，校验口径保持一致。
        if (record[field.name] === undefined) {
          errors.push(`${path}.${field.name} is required.`);
          continue;
        }
        validateValueAgainstSpec(field.type, record[field.name], `${path}.${field.name}`, errors, depth + 1);
      }
      return;
    }
    case 'TABLE': {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array.`);
        return;
      }
      value.forEach((row, index) => validateValueAgainstSpec(spec.rowType, row, `${path}[${index}]`, errors, depth + 1));
      return;
    }
    default:
      errors.push(`${path} has an unsupported type kind.`);
  }
}
