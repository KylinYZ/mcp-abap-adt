/**
 * ============================================================================
 * RFC_REMOTE_ENABLED_DESCRIBE_ENABLED——FM 接口描述纯映射（rfc.remote-enabled.describe）
 * ============================================================================
 *
 * 用途：把传输适配器返回的 FM 接口元数据（AdapterFunctionInterface）映射为
 * 结构化描述：参数清单（方向/类型/关联类型/长度/可选性）+ 仅导入与变更参数
 * 构造的调用入参 JSON Schema（callRfm 组参的输入面）。
 *
 * 与 VSP 的对齐与差异（如实声明）：
 * - VSP 的 rfc.describe 走 RFC_METADATA_GET 返回 FM 接口；本实现复用
 *   TransportAdapter.getFunctionInterface（OpenRfcTransport 委托 open-rfc
 *   Client.getFunctionInterface，同源元数据通道），输出为参数级结构化描述
 *   + inputSchema，不构造完整 JSON Schema Draft 文档。
 * - 表/结构参数（exid h/u/v）的行结构不在本层展开（避免深度元数据递归）；
 *   调用方按 associatedType 经 DDIC 元数据工具（read.ddic-metadata 面）另查。
 *
 * 类型映射口径（exid → JSON Schema type）：
 *   I/b/s → integer；P/F/e → number；h → array；u/v → object；
 *   其余（C/N/D/T/x/y/g 等）→ string（N 为数字文本、D/T 为日期时间文本、
 *   x/y 为字节十六进制文本，均按字符串承载）。
 */

import { RfcError } from './errors';
import { isValidFmName } from './interface';
import type { AdapterFunctionInterface } from './transport';

/** 单个 FM 参数的描述。 */
export interface RfmParameterDescription {
  /** 参数名（大写）。 */
  readonly name: string
  /** 方向类：I=导入 E=导出 C=变更 T=表。 */
  readonly direction: 'I' | 'E' | 'C' | 'T'
  /** ABAP 基本类型码（exid）；元数据缺失时为 'unknown'。 */
  readonly type: string
  /** 关联 DDIC 类型名（标量类型为域/数据元素名，表/结构为行类型名）。 */
  readonly associatedType: string
  /** 内部长度（字节）；变长/深层类型可为 0；元数据缺失时为 null。 */
  readonly length: number | null
  /** 是否可选。 */
  readonly optional: boolean
}

/** FM 接口的结构化描述（describeRfm 的返回体）。 */
export interface RfmDescription {
  readonly functionName: string
  readonly parameterCount: number
  readonly parameters: readonly RfmParameterDescription[]
  /**
   * 仅由导入（I）与变更（C）参数构造的调用入参 JSON Schema（轻量口径：
   * property 类型 + 方向/类型说明；required 收录 optional=false 的 I 参数）。
   * 表/结构参数以 array/object 占位，行结构按 associatedType 另查。
   */
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>
    readonly required: readonly string[]
  }
  /** 该 FM 是否在当前只读 allowlist 内（callRfm 能否直接调用的提示）。 */
  readonly allowlisted: boolean
}

/** exid → JSON Schema type 映射（见模块头注释口径表）。 */
function jsonTypeOfExid(exid: string): string {
  switch (exid) {
    case 'I':
    case 'b':
    case 's':
      return 'integer'
    case 'P':
    case 'F':
    case 'e':
      return 'number'
    case 'h':
      return 'array'
    case 'u':
    case 'v':
      return 'object'
    default:
      return 'string'
  }
}

/**
 * 构造 FM 结构化描述。
 *
 * @param functionName 目标 FM 名（必须通过 FM 命名校验）
 * @param iface 传输适配器返回的接口元数据（参数顺序保持元数据原序）
 * @param allowlisted 该 FM 是否在只读 allowlist 内（透传给调用方做组参提示）
 */
export function buildRfmDescription(
  functionName: string,
  iface: AdapterFunctionInterface,
  allowlisted: boolean
): RfmDescription {
  if (!isValidFmName(functionName)) {
    throw new RfcError(
      'RFC_INVALID_INTERFACE',
      `describeRfm: FM name "${String(functionName)}" is invalid (A-Z 0-9 _ /, at most 60 characters).`
    );
  }
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  const parameters: RfmParameterDescription[] = (iface.parameters ?? []).map(parameter => {
    const exid = parameter.parameterExid ?? 'unknown';
    const direction = (['I', 'E', 'C', 'T'] as const).includes(parameter.parameterClass as 'I')
      ? (parameter.parameterClass as 'I' | 'E' | 'C' | 'T')
      : 'I';
    const optional = parameter.optional ?? false;
    const description: RfmParameterDescription = {
      name: parameter.parameterName,
      direction,
      type: exid,
      associatedType: parameter.associatedType ?? '',
      length: typeof parameter.internalLength === 'number' ? parameter.internalLength : null,
      optional
    };
    // inputSchema 只收导入与变更参数（导出/表参数属于输出面）
    if (direction === 'I' || direction === 'C') {
      properties[description.name] = {
        type: jsonTypeOfExid(exid),
        description: `direction ${direction}; ABAP type ${exid}` +
          (description.associatedType ? ` (${description.associatedType})` : '')
      };
      // ABAP optional 语义只对导入参数构成 required（变更参数回传值可缺省）
      if (direction === 'I' && !optional) required.push(description.name);
    }
    return description;
  });
  return {
    functionName,
    parameterCount: parameters.length,
    parameters,
    inputSchema: { type: 'object', properties, required },
    allowlisted
  };
}
