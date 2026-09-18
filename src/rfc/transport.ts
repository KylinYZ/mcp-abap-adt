/**
 * RFC 传输层抽象（rfc-transport-spike 阶段 0）。
 *
 * 用途：把「如何与 SAP 通信」从协议模型中隔离出来。上层（pool.ts、call.ts）
 * 只依赖 `TransportAdapter` 接口；阶段 0 提供 `LoopbackTransport` 内存回环
 * 实现用于测试与接口验证，后续阶段以真实协议适配器（如 open-rfc-go 网关
 * 客户端）插拔替换，不改动上层代码。
 *
 * 硬边界：本模块及其实现绝不发起真实网络请求。
 */

import { FmCallResult } from './call';
import { RfcError, RfcTransportError } from './errors';

/** 传输层调用请求：FM 名 + 已通过接口校验的入参 + 取消信号。 */
export interface RfcTransportInvokeRequest {
  readonly functionName: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** 由 call.ts 绑定了超时与外部取消的组合信号；传输实现应尽量响应。 */
  readonly signal?: AbortSignal;
}

/** FM 参数的结构化最小视图（与具体 RFC 库解耦：仅参数名 + 方向类）。 */
export interface AdapterFunctionParameter {
  /** 参数名（大写，如 QUERY_TABLE / USE_ET_DATA_4_RETURN）。 */
  readonly parameterName: string
  /** 方向类：I=导入 E=导出 C=变更 T=表（RFC_GET_FUNCTION_INTERFACE 口径）。 */
  readonly parameterClass: string
}

/** FM 接口的结构化最小视图（供上层做按系统能力的载荷适配）。 */
export interface AdapterFunctionInterface {
  readonly parameters: readonly AdapterFunctionParameter[]
}

/**
 * 传输适配器接口（所有 RFC 通信的底层抽象）。
 *
 * 契约：
 * - `connect`：建立（或模拟建立）连接；同一实例只需成功 connect 一次。
 * - `invoke`：执行一次 FM 调用并返回结构化结果；传输级故障抛
 *   `RfcTransportError`（连接池据此剔除连接）。
 * - `close`：关闭连接；关闭后的 invoke 必须抛 code=RFC_TRANSPORT_CLOSED。
 * - `lastActivity`：最近一次成功活动的 epoch 毫秒；null 表示尚无活动，
 *   供连接池/诊断判断连接新鲜度。
 * - `getFunctionInterface`（可选）：查询 FM 接口元数据。未实现（如
 *   Loopback）表示元数据通道不可用，上层按保守经典路径处理。
 */
export interface TransportAdapter {
  connect(signal?: AbortSignal): Promise<void>;
  invoke(request: RfcTransportInvokeRequest): Promise<FmCallResult>;
  close(): Promise<void>;
  lastActivity(): number | null;
  getFunctionInterface?(functionName: string): Promise<AdapterFunctionInterface>;
}

/* ---------------------------------------------------------------------------
 * LoopbackTransport：内存回环实现（测试与协议开发用）
 * ------------------------------------------------------------------------- */

/** 响应工厂：根据请求动态生成结果（静态响应也可以直接给 FmCallResult）。 */
export type LoopbackResponder = FmCallResult | ((request: RfcTransportInvokeRequest) => FmCallResult);

export interface LoopbackTransportOptions {
  /** functionName → 预置响应或响应工厂；未注册的 FM 调用抛传输故障。 */
  readonly responses?: Readonly<Record<string, LoopbackResponder>>;
  /** functionName → 抛出的错误或错误工厂，用于模拟传输故障（ErrTransport 等价）。 */
  readonly faults?: Readonly<Record<string, Error | (() => Error)>>;
  /** 每次调用注入的延迟毫秒数，用于测试超时/取消路径；默认 0。 */
  readonly delayMs?: number;
  /** connect 注入的延迟毫秒数；默认 0。 */
  readonly connectDelayMs?: number;
  /** 可注入时钟（连接池与 Loopback 共用同一时钟保证时序断言稳定）。 */
  readonly now?: () => number;
}

/**
 * 内存回环传输：不产生任何 IO，直接回放预置响应。
 *
 * 用途：
 * - 单元测试中充当 TransportAdapter（超时、池剔除、复用等场景）。
 * - 后续真实协议适配器开发时的行为参照（invoke/close/lastActivity 语义）。
 *
 * 行为规则：
 * - close 之后再 invoke → 抛 RfcTransportError(RFC_TRANSPORT_CLOSED)。
 * - invoke 时信号已中止 → 抛 RfcError(RFC_TIMEOUT, reason='aborted')。
 *   （延迟途中的中止由 call.ts 的竞速逻辑统一处理，这里只覆盖入口状态。）
 * - faults 中注册的错误按原样抛出（供池测试注入 RfcTransportError）。
 * - 未注册响应的 FM → 抛 RfcTransportError（回环上的「协议不支持」语义）。
 */
export class LoopbackTransport implements TransportAdapter {
  private readonly responses: Readonly<Record<string, LoopbackResponder>>;
  private readonly faults: Readonly<Record<string, Error | (() => Error)>>;
  private readonly delayMs: number;
  private readonly connectDelayMs: number;
  private readonly clock: () => number;
  /** 是否已成功 connect；close 之后置为 false。 */
  private connected = false;
  private closed = false;
  /** 最近一次成功活动时间（connect 或 invoke 完成），null = 尚无活动。 */
  private lastActivityAt: number | null = null;
  /** 已收到的调用请求记录（按序），供测试断言「到底调了什么」。 */
  readonly invokedRequests: RfcTransportInvokeRequest[] = [];

  constructor(options: LoopbackTransportOptions = {}) {
    this.responses = options.responses ?? {};
    this.faults = options.faults ?? {};
    this.delayMs = options.delayMs ?? 0;
    this.connectDelayMs = options.connectDelayMs ?? 0;
    this.clock = options.now ?? Date.now;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new RfcTransportError('Loopback transport is closed.', undefined, 'RFC_TRANSPORT_CLOSED');
    }
    if (signal?.aborted) {
      throw new RfcError('RFC_TIMEOUT', 'Connect was aborted before it started.', { reason: 'aborted' });
    }
    if (this.connectDelayMs > 0) await sleep(this.connectDelayMs);
    this.connected = true;
    this.lastActivityAt = this.clock();
  }

  async invoke(request: RfcTransportInvokeRequest): Promise<FmCallResult> {
    // 入口状态检查：已关闭连接视为传输级故障（池会剔除）。
    if (!this.connected || this.closed) {
      throw new RfcTransportError('Loopback transport is not connected.', undefined, 'RFC_TRANSPORT_CLOSED');
    }
    if (request.signal?.aborted) {
      throw new RfcError('RFC_TIMEOUT', `Call to ${request.functionName} was aborted before it started.`, {
        reason: 'aborted',
        functionName: request.functionName
      });
    }
    this.invokedRequests.push(request);
    if (this.delayMs > 0) await sleep(this.delayMs);
    // 故障注入优先于响应回放：模拟「连接已损坏」的场景。
    const fault = this.faults[request.functionName];
    if (fault !== undefined) {
      throw typeof fault === 'function' ? fault() : fault;
    }
    const responder = this.responses[request.functionName];
    if (responder === undefined) {
      throw new RfcTransportError(`Loopback transport has no canned response for ${request.functionName}.`, {
        functionName: request.functionName
      });
    }
    const result = typeof responder === 'function' ? responder(request) : responder;
    this.lastActivityAt = this.clock();
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }

  lastActivity(): number | null {
    return this.lastActivityAt;
  }
}

/** 简单延时工具（仅用于内存回环的延迟模拟，不接触网络）。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
