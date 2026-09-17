/**
 * RFC 调用模型与传输层测试（对应 src/rfc/call.ts + transport.ts）。
 *
 * 覆盖：invokeFmCall 的成功路径、内部超时（RFC_TIMEOUT reason=timeout）、
 * 外部 AbortSignal 取消（reason=aborted）、预中止快速失败、参数校验；
 * LoopbackTransport 的回放/故障注入/关闭语义/活动时间记录。
 * 全部基于内存回环，无任何真实网络 IO。
 */

import { DEFAULT_FM_CALL_TIMEOUT_MS, FmCallResult, invokeFmCall } from '../rfc/call';
import { isTransportFailure, RfcError, RfcTransportError } from '../rfc/errors';
import { LoopbackTransport } from '../rfc/transport';

/** 构造一个标准 FM 结果对象（回环响应的固定模板）。 */
function cannedResult(functionName: string): FmCallResult {
  return { functionName, values: { EV_RC: 'OK' }, tables: {}, exceptions: [], durationMs: 0 };
}

describe('RfcCall invokeFmCall', () => {
  it('returns the transport result with a measured duration', async () => {
    const adapter = new LoopbackTransport({ responses: { RFC_PING: cannedResult('RFC_PING') } });
    await adapter.connect();
    const result = await invokeFmCall(adapter, { functionName: 'RFC_PING' });
    expect(result.functionName).toBe('RFC_PING');
    expect(result.values).toEqual({ EV_RC: 'OK' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await adapter.close();
  });

  it('uses the default 30s timeout constant', () => {
    // 防止默认值被无意改动（与 VSP keep-alive ping 超时保持一致）。
    expect(DEFAULT_FM_CALL_TIMEOUT_MS).toBe(30_000);
  });

  it('fails with RFC_TIMEOUT (reason=timeout) when the internal timeout fires first', async () => {
    // 传输延迟 200ms，超时 30ms → 内部超时先触发。
    const adapter = new LoopbackTransport({
      responses: { SLOW_FM: cannedResult('SLOW_FM') },
      delayMs: 200
    });
    await adapter.connect();
    await expect(invokeFmCall(adapter, { functionName: 'SLOW_FM', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'RFC_TIMEOUT',
      details: { reason: 'timeout', functionName: 'SLOW_FM' }
    });
    await adapter.close();
  });

  it('fails with RFC_TIMEOUT (reason=aborted) when the external AbortSignal fires first', async () => {
    // 外部信号 20ms 触发，超时 5s，传输延迟 300ms → 外部取消先到。
    const adapter = new LoopbackTransport({
      responses: { SLOW_FM: cannedResult('SLOW_FM') },
      delayMs: 300
    });
    await adapter.connect();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      invokeFmCall(adapter, { functionName: 'SLOW_FM', timeoutMs: 5_000, signal: controller.signal })
    ).rejects.toMatchObject({
      code: 'RFC_TIMEOUT',
      details: { reason: 'aborted' }
    });
    await adapter.close();
  });

  it('fails fast when the signal is already aborted', async () => {
    const adapter = new LoopbackTransport({ responses: { RFC_PING: cannedResult('RFC_PING') } });
    await adapter.connect();
    const controller = new AbortController();
    controller.abort();
    await expect(
      invokeFmCall(adapter, { functionName: 'RFC_PING', signal: controller.signal })
    ).rejects.toMatchObject({ code: 'RFC_TIMEOUT', details: { reason: 'aborted' } });
    // 预中止不应触达传输层。
    expect(adapter.invokedRequests).toHaveLength(0);
    await adapter.close();
  });

  it('propagates transport errors untouched', async () => {
    const adapter = new LoopbackTransport({
      faults: { BROKEN_FM: () => new RfcTransportError('gateway died') }
    });
    await adapter.connect();
    await expect(invokeFmCall(adapter, { functionName: 'BROKEN_FM' })).rejects.toMatchObject({
      code: 'RFC_TRANSPORT_FAILURE'
    });
    await adapter.close();
  });

  it('validates the request shape before touching the transport', async () => {
    const adapter = new LoopbackTransport({});
    await expect(invokeFmCall(adapter, { functionName: '' })).rejects.toMatchObject({ code: 'RFC_INVALID_PAYLOAD' });
    await expect(invokeFmCall(adapter, { functionName: 'RFC_PING', timeoutMs: 0 })).rejects.toMatchObject({
      code: 'RFC_INVALID_PAYLOAD'
    });
    await expect(invokeFmCall(adapter, { functionName: 'RFC_PING', timeoutMs: 1.5 })).rejects.toMatchObject({
      code: 'RFC_INVALID_PAYLOAD'
    });
  });

  it('still completes when a slow transport wins the race before timeout', async () => {
    // 边界：无延迟传输在超时前完成，结果应正常返回且监听器被清理。
    const adapter = new LoopbackTransport({ responses: { FAST_FM: cannedResult('FAST_FM') } });
    await adapter.connect();
    const result = await invokeFmCall(adapter, { functionName: 'FAST_FM', timeoutMs: 500 });
    expect(result.functionName).toBe('FAST_FM');
    await adapter.close();
  });
});

describe('RfcTransport LoopbackTransport', () => {
  it('records lastActivity only after connect/invoke', async () => {
    let nowMs = 1_000;
    const adapter = new LoopbackTransport({
      responses: { RFC_PING: cannedResult('RFC_PING') },
      now: () => nowMs
    });
    expect(adapter.lastActivity()).toBeNull();
    await adapter.connect();
    expect(adapter.lastActivity()).toBe(1_000);
    nowMs = 1_500;
    await adapter.invoke({ functionName: 'RFC_PING' });
    expect(adapter.lastActivity()).toBe(1_500);
  });

  it('refuses invocations after close with a transport-class error', async () => {
    const adapter = new LoopbackTransport({ responses: { RFC_PING: cannedResult('RFC_PING') } });
    await adapter.connect();
    await adapter.close();
    // 关闭后的调用必须抛 RFC_TRANSPORT_CLOSED（isTransportFailure=true，池会剔除）。
    const error = await adapter.invoke({ functionName: 'RFC_PING' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RfcTransportError);
    expect(isTransportFailure(error)).toBe(true);
  });

  it('replays canned responses and records the received requests', async () => {
    const adapter = new LoopbackTransport({
      responses: {
        RFC_READ_TABLE: request => ({
          functionName: request.functionName,
          values: { echoed: String(request.payload?.QUERY_TABLE ?? '') },
          tables: {},
          exceptions: [],
          durationMs: 0
        })
      }
    });
    await adapter.connect();
    const result = await adapter.invoke({ functionName: 'RFC_READ_TABLE', payload: { QUERY_TABLE: 'T001' } });
    expect(result.values).toEqual({ echoed: 'T001' });
    expect(adapter.invokedRequests).toHaveLength(1);
    expect(adapter.invokedRequests[0].payload).toEqual({ QUERY_TABLE: 'T001' });
  });

  it('throws a transport error when no canned response is registered', async () => {
    const adapter = new LoopbackTransport({});
    await adapter.connect();
    await expect(adapter.invoke({ functionName: 'UNKNOWN_FM' })).rejects.toBeInstanceOf(RfcTransportError);
  });

  it('replays injected faults verbatim', async () => {
    const boom = new RfcError('RFC_CODEC_ERROR', 'simulated middle-layer failure');
    const adapter = new LoopbackTransport({ faults: { RFC_PING: boom } });
    await adapter.connect();
    await expect(adapter.invoke({ functionName: 'RFC_PING' })).rejects.toBe(boom);
  });
});
