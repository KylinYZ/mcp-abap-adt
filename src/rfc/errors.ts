/**
 * RFC 子项目（rfc-transport-spike 阶段 0）统一错误模型。
 *
 * 设计要点：
 * - 所有 RFC 协议层错误统一抛出 `RfcError`，用机器可读的 `code` 区分门控拒绝、
 *   参数非法、编解码失败、超时取消、传输故障等类别；`message` 供人类阅读。
 * - `RfcTransportError` 是 `RfcError` 的语义子类，对应 VSP（vibing-steampunk）
 *   中 `openrfc.ErrTransport` / `openrfc.ErrClosed` 的判定语义：连接池据此决定
 *   是否剔除并重建底层连接（见 src/rfc/pool.ts）。
 * - 本模块为纯协议层模型，不发起任何网络 IO。
 */

/** RFC 协议层统一错误码（对外可观测的稳定标识，不得随意改名）。 */
export type RfcErrorCode =
  /** 连接参数缺失/非法（host、sysnr/port、client、route 等）。 */
  | 'RFC_INVALID_CONNECTION_PARAMS'
  /** FM 接口描述本身不合法（参数方向、重名、类型规格错误等）。 */
  | 'RFC_INVALID_INTERFACE'
  /** 调用入参 payload 未通过接口校验（缺必填、未知字段、类型不符）。 */
  | 'RFC_INVALID_PAYLOAD'
  /** 按字节布局编解码失败（超长、非法字符、缓冲区不足、BCD 溢出等）。 */
  | 'RFC_CODEC_ERROR'
  /** 超时或外部 AbortSignal 触发导致的调用中止。 */
  | 'RFC_TIMEOUT'
  /** 传输层故障（等价 VSP openrfc.ErrTransport）：连接池会剔除该连接。 */
  | 'RFC_TRANSPORT_FAILURE'
  /** 传输层已关闭（等价 VSP openrfc.ErrClosed）：连接池会剔除该连接。 */
  | 'RFC_TRANSPORT_CLOSED'
  /** 目标 FM 不在只读 allowlist 内，调用被门控拒绝。 */
  | 'RF_CALL_NOT_ALLOWED'
  /** 连接池状态错误（例如释放一个不属于池的连接条目）。 */
  | 'RFC_POOL_STATE';

/** RFC 错误携带的附加结构化信息（如出错字段名、FM 名、拒绝原因等）。 */
export type RfcErrorDetails = Readonly<Record<string, unknown>>;

/**
 * RFC 协议层统一错误。
 *
 * 关键变量：
 * - `code`：稳定错误码，调用方（未来的 MCP handler）据此映射为对外的结构化拒绝。
 * - `details`：附加上下文，便于诊断与测试断言；不得包含密码等敏感信息。
 */
export class RfcError extends Error {
  readonly code: RfcErrorCode;
  readonly details?: RfcErrorDetails;

  constructor(code: RfcErrorCode, message: string, details?: RfcErrorDetails) {
    super(message);
    this.name = 'RfcError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 传输层故障错误（`RFC_TRANSPORT_FAILURE` / `RFC_TRANSPORT_CLOSED`）。
 *
 * 业务规则：连接池在捕获到本类错误时必须剔除并丢弃底层连接，让下一次调用
 * 重新建立连接（对齐 VSP `dropSharedRFC` 只在 ErrTransport/ErrClosed 时丢弃
 * 的语义；超时与业务错误不会剔除连接）。
 */
export class RfcTransportError extends RfcError {
  constructor(
    message: string,
    details?: RfcErrorDetails,
    code: 'RFC_TRANSPORT_FAILURE' | 'RFC_TRANSPORT_CLOSED' = 'RFC_TRANSPORT_FAILURE'
  ) {
    super(code, message, details);
    this.name = 'RfcTransportError';
  }
}

/** 类型守卫：判断未知抛出值是否为 RfcError。 */
export function isRfcError(error: unknown): error is RfcError {
  return error instanceof RfcError;
}

/**
 * 判断错误是否属于「传输已损坏」类别（ErrTransport / ErrClosed 等价物）。
 *
 * 业务规则：只有本函数返回 true 时，连接池才允许剔除连接；超时
 * （RFC_TIMEOUT）与门控拒绝（RF_CALL_NOT_ALLOWED）等不得触发剔除。
 */
export function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof RfcError)) return false;
  return error.code === 'RFC_TRANSPORT_FAILURE' || error.code === 'RFC_TRANSPORT_CLOSED';
}
