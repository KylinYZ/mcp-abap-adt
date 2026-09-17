/**
 * RFC 连接池与 keep-alive 状态机测试（对应 src/rfc/pool.ts）。
 *
 * 覆盖：同参数连接复用、不同参数独立建连、空闲达到阈值后 RFC_PING 保活、
 * 未达阈值不 ping、保活失败剔除连接、传输级错误（ErrTransport 等价）剔除、
 * 非传输级错误保留连接、空闲上限裁剪、dispose 语义。
 * 全部使用可注入假时钟 + LoopbackTransport 内存回环，无真实网络 IO。
 */

import { RfcConnectionPool, RfcPoolEntry } from '../rfc/pool';
import { isTransportFailure, RfcError, RfcTransportError } from '../rfc/errors';
import { LoopbackTransport } from '../rfc/transport';

/** 基准连接参数（各用例共用，保证 key 一致性可比较）。 */
function baseParams(): Record<string, unknown> {
  return { ashost: 'pool.example.com', client: 100, user: 'POOL_USER', sysnr: '00' };
}

/** 测试夹具：假时钟 + 按调用创建 Loopback 的工厂。 */
function createFixture(options?: {
  keepAliveIntervalMs?: number;
  keepAliveTimeoutMs?: number;
  maxIdleConnections?: number;
}) {
  let nowMs = 1_000;
  const created: LoopbackTransport[] = [];
  const pool = new RfcConnectionPool({
    adapterFactory: params => {
      const transport = new LoopbackTransport({
        now: () => nowMs,
        // 每个回环传输都认识 RFC_PING（保活探测）与 RFC_READ_TABLE（模拟业务调用）。
        responses: {
          RFC_PING: { functionName: 'RFC_PING', values: {}, tables: {}, exceptions: [], durationMs: 0 },
          RFC_READ_TABLE: { functionName: 'RFC_READ_TABLE', values: {}, tables: {}, exceptions: [], durationMs: 0 }
        }
      });
      created.push(transport);
      return transport;
    },
    now: () => nowMs,
    keepAliveIntervalMs: options?.keepAliveIntervalMs ?? 500,
    keepAliveTimeoutMs: options?.keepAliveTimeoutMs ?? 100,
    maxIdleConnections: options?.maxIdleConnections
  });
  return {
    pool,
    created,
    advance: (deltaMs: number) => {
      nowMs += deltaMs;
    },
    now: () => nowMs
  };
}

describe('RfcPool connection reuse', () => {
  it('reuses the same connection for identical params', async () => {
    const fixture = createFixture();
    const first = await fixture.pool.acquire(baseParams());
    fixture.pool.release(first);
    const second = await fixture.pool.acquire(baseParams());
    // 同参数第二次 acquire 拿到同一条连接，工厂只被调用一次。
    expect(second).toBe(first);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.pool.stats()).toEqual({ total: 1, idle: 0, busy: 1 }); // 复用时状态转回 busy
    await fixture.pool.dispose();
  });

  it('creates independent connections for different params', async () => {
    const fixture = createFixture();
    const a = await fixture.pool.acquire(baseParams());
    const b = await fixture.pool.acquire({ ...baseParams(), client: 200 });
    expect(b).not.toBe(a);
    expect(fixture.created).toHaveLength(2);
    expect(fixture.pool.stats().total).toBe(2);
    await fixture.pool.dispose();
  });

  it('treats different passwords as the same pool key', async () => {
    // 凭据不参与 key：同目标同用户的两次借出复用同一条连接。
    const fixture = createFixture();
    const a = await fixture.pool.acquire({ ...baseParams(), password: 'one' });
    fixture.pool.release(a);
    const b = await fixture.pool.acquire({ ...baseParams(), password: 'two' });
    expect(b).toBe(a);
    await fixture.pool.dispose();
  });

  it('rejects malformed connection params', async () => {
    const fixture = createFixture();
    await expect(fixture.pool.acquire({ ashost: '' })).rejects.toMatchObject({
      code: 'RFC_INVALID_CONNECTION_PARAMS'
    });
    await fixture.pool.dispose();
  });
});

describe('RfcPool keep-alive', () => {
  it('pings idle connections once the idle interval is reached', async () => {
    const fixture = createFixture({ keepAliveIntervalMs: 500 });
    const entry = await fixture.pool.acquire(baseParams());
    fixture.pool.release(entry); // lastUsedAt = 1000

    // 空闲 200ms < 500ms：不应触发 ping。
    fixture.advance(200);
    await fixture.pool.runKeepAliveCycle();
    expect(fixture.created[0].invokedRequests).toHaveLength(0);
    expect(entry.lastPingAt).toBeNull();

    // 累计空闲 600ms ≥ 500ms：应发出 RFC_PING 并记录 lastPingAt。
    fixture.advance(400);
    await fixture.pool.runKeepAliveCycle();
    const pings = fixture.created[0].invokedRequests;
    expect(pings).toHaveLength(1);
    expect(pings[0].functionName).toBe('RFC_PING');
    expect(entry.lastPingAt).toBe(fixture.now());
    expect(entry.state).toBe('idle'); // 保活后仍是空闲可复用
    await fixture.pool.dispose();
  });

  it('keeps the connection alive across repeated cycles and reuses it afterwards', async () => {
    const fixture = createFixture({ keepAliveIntervalMs: 500 });
    const entry = await fixture.pool.acquire(baseParams());
    fixture.pool.release(entry);
    fixture.advance(600);
    await fixture.pool.runKeepAliveCycle();
    fixture.advance(600);
    await fixture.pool.runKeepAliveCycle();
    expect(fixture.created[0].invokedRequests.filter(r => r.functionName === 'RFC_PING')).toHaveLength(2);
    const again = await fixture.pool.acquire(baseParams());
    expect(again).toBe(entry); // 连接保活成功 → 下一次调用无需重新登录
    await fixture.pool.dispose();
  });

  it('drops the connection when the keep-alive ping fails', async () => {
    let nowMs = 1_000;
    const deadTransport = new LoopbackTransport({
      now: () => nowMs,
      faults: {
        // 保活 ping 命中故障注入：模拟网关侧连接已死。
        RFC_PING: () => new RfcTransportError('gateway dropped the conversation')
      }
    });
    const pool = new RfcConnectionPool({
      adapterFactory: () => deadTransport,
      now: () => nowMs,
      keepAliveIntervalMs: 500
    });
    const entry = await pool.acquire(baseParams());
    pool.release(entry);
    nowMs += 600;
    await pool.runKeepAliveCycle();
    // 保活失败 → 连接被剔除，池为空；下一次 acquire 需要重新建连。
    expect(pool.stats()).toEqual({ total: 0, idle: 0, busy: 0 });
    expect(pool.entriesFor(baseParams())).toHaveLength(0);
    expect(entry.state).toBe('closed');
    expect(deadTransport.lastActivity()).not.toBeNull(); // 曾成功 connect/close
    await pool.dispose();
  });
});

describe('RfcPool failure handling', () => {
  it('drops the connection after a transport-class error (ErrTransport equivalent)', async () => {
    const fixture = createFixture();
    const entry = await fixture.pool.acquire(baseParams());
    // 模拟业务调用遭遇传输级故障（openrfc.ErrTransport 语义等价）。
    const dropped = await fixture.pool.releaseAfterError(entry, new RfcTransportError('connection reset'));
    expect(dropped).toBe(true);
    expect(fixture.pool.stats().total).toBe(0);
    // 下一次 acquire 重新建连：工厂被第二次调用。
    const fresh = await fixture.pool.acquire(baseParams());
    expect(fresh).not.toBe(entry);
    expect(fixture.created).toHaveLength(2);
    await fixture.pool.dispose();
  });

  it('also drops closed-transport errors', async () => {
    const fixture = createFixture();
    const entry = await fixture.pool.acquire(baseParams());
    const closed = new RfcTransportError('transport already closed', undefined, 'RFC_TRANSPORT_CLOSED');
    expect(isTransportFailure(closed)).toBe(true);
    expect(await fixture.pool.releaseAfterError(entry, closed)).toBe(true);
    expect(fixture.pool.stats().total).toBe(0);
    await fixture.pool.dispose();
  });

  it('keeps the connection after non-transport errors (timeouts, business errors)', async () => {
    const fixture = createFixture();
    const entry = await fixture.pool.acquire(baseParams());
    // 超时错误不属于传输故障：连接保留并回到 idle。
    const dropped = await fixture.pool.releaseAfterError(entry, new RfcError('RFC_TIMEOUT', 'call timed out'));
    expect(dropped).toBe(false);
    expect(entry.state).toBe('idle');
    const reused = await fixture.pool.acquire(baseParams());
    expect(reused).toBe(entry);
    await fixture.pool.dispose();
  });

  it('throws when releasing a foreign entry', async () => {
    const fixture = createFixture();
    const foreign = {
      key: 'not-in-pool',
      params: { ashost: 'x', client: '000', user: 'u', language: 'en', sysnr: '00' },
      transport: new LoopbackTransport(),
      state: 'busy',
      lastUsedAt: 0,
      lastPingAt: null
    } as RfcPoolEntry;
    expect(() => fixture.pool.release(foreign)).toThrow(RfcError);
    await fixture.pool.dispose();
  });
});

describe('RfcPool lifecycle', () => {
  it('trims idle connections beyond the configured maximum', async () => {
    const fixture = createFixture({ maxIdleConnections: 1 });
    // 同 key 并发借出两条连接（a busy 期间 acquire 会新建第二条）。
    const a = await fixture.pool.acquire(baseParams());
    const b = await fixture.pool.acquire(baseParams());
    expect(b).not.toBe(a);
    // 依次归还 → 出现两条 idle，超过 maxIdle=1：lastUsedAt 更旧的 a 被裁剪关闭。
    fixture.pool.release(a);
    fixture.pool.release(b);
    const entries = fixture.pool.entriesFor(baseParams());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(b);
    expect(a.state).toBe('closed');
    await fixture.pool.dispose();
  });

  it('refuses usage after dispose', async () => {
    const fixture = createFixture();
    const entry = await fixture.pool.acquire(baseParams());
    await fixture.pool.dispose();
    expect(entry.state).toBe('closed');
    await expect(fixture.pool.acquire(baseParams())).rejects.toMatchObject({ code: 'RFC_TRANSPORT_CLOSED' });
  });

  it('exposes stats for diagnostics', async () => {
    const fixture = createFixture();
    expect(fixture.pool.stats()).toEqual({ total: 0, idle: 0, busy: 0 });
    const entry = await fixture.pool.acquire(baseParams());
    expect(fixture.pool.stats()).toEqual({ total: 1, idle: 0, busy: 1 });
    fixture.pool.release(entry);
    expect(fixture.pool.stats()).toEqual({ total: 1, idle: 1, busy: 0 });
    await fixture.pool.dispose();
  });
});
