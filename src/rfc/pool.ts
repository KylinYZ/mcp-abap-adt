/**
 * RFC 连接池与 keep-alive 状态机（rfc-transport-spike 阶段 0）。
 *
 * 语义参考（只读借鉴）：VSP vibing-steampunk `internal/mcp/handlers_rfc.go`
 * 的 `startRFCKeepAlive` / `dropSharedRFC`：
 * - 连接按参数复用：相同目标（主机/端口/client/用户/语言）共享连接，
 *   避免「每次调用都重新登录」的开销。
 * - keep-alive：空闲超过 rfcKeepAliveInterval（VSP 为 1 分钟）后用 RFC_PING
 *   保活——SAP 网关/工作进程会回收静默会话，几百字节的 ping 远比重新登录便宜。
 * - 剔除规则：只有传输级故障（ErrTransport / ErrClosed）才丢弃连接，让下一次
 *   调用重新登录；超时等其它错误不丢弃。
 *
 * 本模块为纯内存骨架：连接由外部注入的 adapterFactory 创建（测试注入
 * LoopbackTransport；后续阶段注入真实协议适配器），自身无任何网络 IO。
 */

import { connectionPoolKey, normalizeRfcConnectionParams, RfcConnectionParams } from './connection';
import { isTransportFailure, RfcError, RfcTransportError } from './errors';
import { invokeFmCall } from './call';
import { TransportAdapter } from './transport';

/** 连接条目状态机：idle（可复用）→ busy（借出）→ closed（已剔除/关闭）。 */
export type RfcPoolConnectionState = 'idle' | 'busy' | 'closed';

/** 池内单个连接条目。 */
export interface RfcPoolEntry {
  /** 池复用 key（见 connectionPoolKey）。 */
  readonly key: string;
  /** 归一化后的连接参数（不含 password 的日志安全形态由 formatConnectionTarget 提供）。 */
  readonly params: RfcConnectionParams;
  /** 底层传输适配器。 */
  readonly transport: TransportAdapter;
  /** 当前状态。 */
  state: RfcPoolConnectionState;
  /** 最近一次借出/归还/保活成功的时刻（池时钟，毫秒）。 */
  lastUsedAt: number;
  /** 最近一次 keep-alive ping 成功时刻；null = 尚未 ping 过。 */
  lastPingAt: number | null;
}

export interface RfcPoolOptions {
  /**
   * 传输适配器工厂：由调用方注入真实/模拟实现。
   * 池只负责生命周期，不负责「如何连上 SAP」。
   */
  readonly adapterFactory: (params: RfcConnectionParams) => TransportAdapter | Promise<TransportAdapter>;
  /** 空闲多久后发 keep-alive ping；默认 60_000ms（对齐 VSP rfcKeepAliveInterval）。 */
  readonly keepAliveIntervalMs?: number;
  /** keep-alive 使用的探测 FM；默认 'RFC_PING'（在默认只读白名单内）。 */
  readonly keepAliveFunction?: string;
  /** 单次 ping 的超时毫秒；默认 30_000ms（对齐 VSP 的 ping 超时）。 */
  readonly keepAliveTimeoutMs?: number;
  /** 空闲连接上限；归还时超出则关闭最旧的空闲连接。默认 4。 */
  readonly maxIdleConnections?: number;
  /** 可注入时钟（毫秒），测试用假时钟保证时序断言稳定。默认 Date.now。 */
  readonly now?: () => number;
  /** 自动 tick 间隔毫秒；提供正值时池会用 setInterval 周期执行保活巡检。 */
  readonly autoTickIntervalMs?: number;
}

export interface RfcPoolStats {
  readonly total: number;
  readonly idle: number;
  readonly busy: number;
}

/**
 * RFC 连接池。
 *
 * 并发规则：同一 key 已有 busy 连接时，新 acquire 会建立独立连接
 * （不排队等待）——阶段 0 保持链路最短，真实并发收敛策略留给后续阶段
 * （届时可与 SAP_MCP_MAX_CONCURRENT_TOOLS=1 的全局串行门协同）。
 */
export class RfcConnectionPool {
  /** 解析后的池配置：默认值在此固化，后续一律读 this.options。 */
  private readonly options: {
    readonly adapterFactory: (params: RfcConnectionParams) => TransportAdapter | Promise<TransportAdapter>;
    readonly keepAliveIntervalMs: number;
    readonly keepAliveFunction: string;
    readonly keepAliveTimeoutMs: number;
    readonly maxIdleConnections: number;
    readonly now: () => number;
    readonly autoTickIntervalMs?: number;
  };
  /** key → 该 key 下的全部条目（busy 与 idle 并存于同一列表）。 */
  private readonly entriesByKey = new Map<string, RfcPoolEntry[]>();
  private readonly clock: () => number;
  private autoTickTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: RfcPoolOptions) {
    if (typeof options?.adapterFactory !== 'function') {
      throw new RfcError('RFC_POOL_STATE', 'adapterFactory is required.');
    }
    this.clock = options.now ?? Date.now;
    this.options = {
      adapterFactory: options.adapterFactory,
      keepAliveIntervalMs: options.keepAliveIntervalMs ?? 60_000,
      keepAliveFunction: options.keepAliveFunction ?? 'RFC_PING',
      keepAliveTimeoutMs: options.keepAliveTimeoutMs ?? 30_000,
      maxIdleConnections: options.maxIdleConnections ?? 4,
      now: options.now ?? Date.now,
      ...(options.autoTickIntervalMs !== undefined ? { autoTickIntervalMs: options.autoTickIntervalMs } : {})
    };
    // 生产接入时由 server 层提供 autoTickIntervalMs；默认不启动定时器，
    // 保证骨架阶段的行为完全确定性（测试直接驱动 runKeepAliveCycle）。
    if (this.options.autoTickIntervalMs !== undefined && this.options.autoTickIntervalMs > 0) {
      this.autoTickTimer = setInterval(() => {
        void this.runKeepAliveCycle();
      }, this.options.autoTickIntervalMs);
      // 池不阻止进程退出：定时器不应让 Node 保持活跃。
      this.autoTickTimer.unref?.();
    }
  }

  /**
   * 获取（或建立）一条连接。
   *
   * 复用规则：同 key 存在 idle 条目 → 直接复用（state 置 busy 并刷新
   * lastUsedAt）；否则用工厂新建并 connect。connect 失败不留下任何条目。
   */
  async acquire(rawParams: unknown, request?: { signal?: AbortSignal }): Promise<RfcPoolEntry> {
    this.assertUsable();
    const params = normalizeRfcConnectionParams(rawParams);
    const key = connectionPoolKey(params);
    const list = this.entriesByKey.get(key) ?? [];
    const reusable = list.find(entry => entry.state === 'idle');
    if (reusable) {
      // 连接复用：状态 idle → busy，并刷新活跃时刻（keep-alive 依据该时刻判断空闲）。
      reusable.state = 'busy';
      reusable.lastUsedAt = this.clock();
      return reusable;
    }
    const transport = await this.options.adapterFactory(params);
    await transport.connect(request?.signal);
    const entry: RfcPoolEntry = {
      key,
      params,
      transport,
      state: 'busy',
      lastUsedAt: this.clock(),
      lastPingAt: null
    };
    list.push(entry);
    this.entriesByKey.set(key, list);
    return entry;
  }

  /**
   * 归还一条借出的连接（成功路径）。
   * busy → idle 并刷新 lastUsedAt；若条目已被剔除/关闭则不做任何事。
   * 归还后按 maxIdleConnections 裁剪最旧的空闲连接。
   */
  release(entry: RfcPoolEntry): void {
    this.assertUsable();
    const list = this.entriesByKey.get(entry.key);
    if (!list || !list.includes(entry)) {
      throw new RfcError('RFC_POOL_STATE', 'release() called with an entry that does not belong to this pool.');
    }
    if (entry.state === 'closed') return; // 已被剔除，无需复活
    entry.state = 'idle';
    entry.lastUsedAt = this.clock();
    this.trimIdleConnections(entry.key);
  }

  /**
   * 错误路径的归还：由调用方把 invoke 抛出的错误交给池判定。
   *
   * 业务规则（对齐 VSP）：只有传输级故障（isTransportFailure，等价
   * ErrTransport/ErrClosed）才剔除连接（关闭传输并从池中移除）；其余错误
   * （超时、业务错误等）按正常归还处理，连接继续复用。
   *
   * @returns 是否发生了剔除（供调用方记录诊断日志）。
   */
  async releaseAfterError(entry: RfcPoolEntry, error: unknown): Promise<boolean> {
    if (isTransportFailure(error)) {
      await this.discard(entry);
      return true;
    }
    this.release(entry);
    return false;
  }

  /**
   * 执行一轮 keep-alive 巡检（生产由定时器驱动，测试可手动驱动）。
   *
   * 规则（对齐 VSP startRFCKeepAlive）：
   * - 只处理 idle 条目；busy 连接刚有真实调用，无需保活。
   * - 空闲时长 = now - lastUsedAt，达到 keepAliveIntervalMs 才 ping。
   * - ping 成功 → 刷新 lastPingAt；ping 失败/超时 → 剔除该连接。
   */
  async runKeepAliveCycle(): Promise<void> {
    this.assertUsable();
    const now = this.clock();
    for (const list of [...this.entriesByKey.values()]) {
      for (const entry of [...list]) {
        if (entry.state !== 'idle') continue;
        if (now - entry.lastUsedAt < this.options.keepAliveIntervalMs) continue;
        try {
          await invokeFmCall(entry.transport, {
            functionName: this.options.keepAliveFunction,
            timeoutMs: this.options.keepAliveTimeoutMs
          });
          entry.lastPingAt = this.clock();
        } catch {
          // 保活失败说明连接已死：剔除，让下一次调用重新登录。
          await this.discard(entry);
        }
      }
    }
  }

  /** 立即剔除一条连接：关闭传输（尽力而为）并从池中移除。 */
  async discard(entry: RfcPoolEntry): Promise<void> {
    entry.state = 'closed';
    const list = this.entriesByKey.get(entry.key);
    if (list) {
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.entriesByKey.delete(entry.key);
    }
    try {
      await entry.transport.close();
    } catch (error) {
      // 关闭失败不阻塞剔除流程：池的状态已收敛，底层资源由适配器自清理。
      throw new RfcTransportError(
        `Failed to close discarded transport: ${error instanceof Error ? error.message : String(error)}`,
        { key: entry.key }
      );
    }
  }

  /** 池统计（total/idle/busy），供诊断与测试断言。 */
  stats(): RfcPoolStats {
    let idle = 0;
    let busy = 0;
    for (const list of this.entriesByKey.values()) {
      for (const entry of list) {
        if (entry.state === 'idle') idle++;
        else if (entry.state === 'busy') busy++;
      }
    }
    return { total: idle + busy, idle, busy };
  }

  /** 读取某 key 下的条目（测试/诊断用途）。 */
  entriesFor(rawParams: unknown): readonly RfcPoolEntry[] {
    const key = connectionPoolKey(normalizeRfcConnectionParams(rawParams));
    return [...(this.entriesByKey.get(key) ?? [])];
  }

  /** 关闭池：停掉自动 tick 并关闭全部连接；之后池不可再用。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.autoTickTimer !== undefined) {
      clearInterval(this.autoTickTimer);
      this.autoTickTimer = undefined;
    }
    const all = [...this.entriesByKey.values()].flat();
    this.entriesByKey.clear();
    for (const entry of all) {
      entry.state = 'closed';
      try {
        await entry.transport.close();
      } catch {
        // dispose 尽力而为：单个连接关闭失败不影响整体清理。
      }
    }
  }

  /** 按 maxIdleConnections 裁剪指定 key 下最旧的空闲连接（同步尽力关闭）。 */
  private trimIdleConnections(key: string): void {
    const list = this.entriesByKey.get(key);
    if (!list) return;
    const idleEntries = list.filter(entry => entry.state === 'idle');
    const excess = idleEntries.length - this.options.maxIdleConnections;
    if (excess <= 0) return;
    // lastUsedAt 最小者最旧，先关。
    idleEntries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const victim of idleEntries.slice(0, excess)) {
      victim.state = 'closed';
      const index = list.indexOf(victim);
      if (index >= 0) list.splice(index, 1);
      void victim.transport.close().catch(() => undefined);
    }
    if (list.length === 0) this.entriesByKey.delete(key);
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new RfcTransportError('RFC pool has been disposed.', undefined, 'RFC_TRANSPORT_CLOSED');
    }
  }
}
