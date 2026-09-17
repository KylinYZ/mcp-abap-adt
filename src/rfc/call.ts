/**
 * RFC 调用请求/响应模型与超时取消（rfc-transport-spike 阶段 0）。
 *
 * 用途：定义上层语义的调用请求（RfcCallRequest）与结果（FmCallResult），
 * 并提供 `invokeFmCall`：把超时（timeoutMs）与外部取消（AbortSignal）合并
 * 为单一竞速信号贯穿到传输适配器，超时/中止统一以 `RFC_TIMEOUT` 错误码失败。
 *
 * 业务规则：
 * - 门控（allowlist）不在本层：调用前必须已完成 allowlist 校验，本模块
 *   假设收到的是「允许调用」的 FM 名。
 * - 超时与外部中止都映射为 RFC_TIMEOUT，details.reason 区分
 *   'timeout'（内部超时）与 'aborted'（外部 AbortSignal 触发）。
 * - 中止发生后必须清理定时器与监听器，杜绝悬挂句柄。
 */

import { RfcError } from './errors';
import { TransportAdapter } from './transport';

/** 默认调用超时：30 秒。与 VSP keep-alive ping 的 30 秒超时保持一致。 */
export const DEFAULT_FM_CALL_TIMEOUT_MS = 30_000;

/** 一次 FM 调用请求。 */
export interface RfcCallRequest {
  /** 目标 FM 名（必须已通过 allowlist 门控与接口校验）。 */
  readonly functionName: string;
  /** 入参（IMPORTING/CHANGING/TABLES 的合并视图），已通过 payload 校验器。 */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** 超时毫秒数；缺省 DEFAULT_FM_CALL_TIMEOUT_MS，必须为正整数。 */
  readonly timeoutMs?: number;
  /** 外部取消信号（例如 MCP 客户端断开时触发），全链路贯穿到传输层。 */
  readonly signal?: AbortSignal;
}

/** 一次 FM 调用的结构化结果。 */
export interface FmCallResult {
  readonly functionName: string;
  /** EXPORTING/CHANGING 回传值（字段名 → 解码后的 JS 值）。 */
  readonly values: Readonly<Record<string, unknown>>;
  /** TABLES 回传行集（表名 → 行数组）。 */
  readonly tables: Readonly<Record<string, readonly unknown[]>>;
  /** FM 侧 RAISE 的异常名列表（按发生顺序）。 */
  readonly exceptions: readonly string[];
  /** 调用总耗时毫秒（由 invokeFmCall 实测并回填）。 */
  readonly durationMs: number;
}

/**
 * 经超时/取消保护的 FM 调用入口。
 *
 * 时序规则：竞速「传输调用」与「中止信号」；先到者胜——传输先完成则正常
 * 返回结果，中止先触发则抛 RFC_TIMEOUT。durationMs 以实测耗时回填。
 * 关键变量：
 * - `controller`：内部组合信号，把超时与外部取消统一传播给传输适配器。
 * - `abortSource`：记录中止来源（'timeout' 内部超时 / 'aborted' 外部取消），
 *   用于 details.reason，保证第一个触发的来源胜出、后续触发被忽略。
 * - `abortPromise`：仅在中止路径 reject 的竞速分支；正常完成路径靠 finally
 *   清理定时器与监听器使其保持 pending，随后可被 GC 回收。
 */
export async function invokeFmCall(adapter: TransportAdapter, request: RfcCallRequest): Promise<FmCallResult> {
  if (typeof request?.functionName !== 'string' || request.functionName.length === 0) {
    throw new RfcError('RFC_INVALID_PAYLOAD', 'functionName must be a non-empty string.');
  }
  // timeoutMs 校验：正整数；缺省用 30 秒。
  const timeoutMs = request.timeoutMs ?? DEFAULT_FM_CALL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RfcError('RFC_INVALID_PAYLOAD', 'timeoutMs must be a positive integer.', { timeoutMs });
  }

  const functionName = request.functionName;
  const startedAt = Date.now();
  // 已提前中止的信号直接快速失败，不再进入传输层。
  if (request.signal?.aborted) {
    throw timeoutError(functionName, 'aborted');
  }

  const controller = new AbortController();
  let abortSource: 'timeout' | 'aborted' | undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: RfcError) => void) | undefined;

  // 外部信号触发的中止：以 'aborted' 为来源，并联动内部信号通知传输层。
  const onExternalAbort = () => {
    if (abortSource === undefined) abortSource = 'aborted';
    controller.abort();
    rejectAbort?.(timeoutError(functionName, 'aborted'));
  };
  // 内部定时器触发的超时：以 'timeout' 为来源。
  const onInternalTimeout = () => {
    if (abortSource === undefined) abortSource = 'timeout';
    controller.abort();
    rejectAbort?.(timeoutError(functionName, 'timeout'));
  };

  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  request.signal?.addEventListener('abort', onExternalAbort, { once: true });
  timer = setTimeout(onInternalTimeout, timeoutMs);

  try {
    const result = await Promise.race([
      adapter.invoke({ functionName, payload: request.payload, signal: controller.signal }),
      abortPromise
    ]);
    // 实测耗时回填：调用方（未来的 handler/审计）需要与日志对齐的真实时长。
    return { ...result, durationMs: Date.now() - startedAt };
  } finally {
    // 无论成败都清理定时器与外部监听，避免悬挂句柄与内存泄漏；
    // 同时 abort 内部信号，终止传输适配器可能仍在进行的等待。
    if (timer !== undefined) clearTimeout(timer);
    request.signal?.removeEventListener('abort', onExternalAbort);
    controller.abort();
  }
}

/** 构造统一的中止/超时错误：code=RFC_TIMEOUT，details.reason 区分来源。 */
function timeoutError(functionName: string, reason: 'timeout' | 'aborted'): RfcError {
  return new RfcError('RFC_TIMEOUT', `RFC call to ${functionName} did not complete (${reason}).`, {
    reason,
    functionName
  });
}
