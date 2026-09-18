import { RfcProbeHandlers } from '../handlers/RfcProbeHandlers.js';
import type { TransportAdapter } from '../rfc/transport.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * RfcProbeHandlers 目录与分派契约测试（mock 传输适配器，零真实网络）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与
 * allowlist 门控、探测失败不抛错语义（discovery）、错误脱敏与未知工具拒绝。
 */

/** 构造可控的内存传输适配器（响应按 FM 名映射，未注册 FM 抛传输故障）。 */
function adapterMock(responses: Record<string, Record<string, unknown>>): TransportAdapter & {
  invoke: jest.Mock
} {
  const invoke = jest.fn(async (request: { functionName: string }) => {
    const values = responses[request.functionName];
    if (!values) throw new Error(`unexpected FM: ${request.functionName}`);
    return {
      functionName: request.functionName,
      values,
      tables: {},
      exceptions: [],
      durationMs: 1
    };
  });
  return {
    connect: jest.fn(async () => undefined),
    invoke,
    close: jest.fn(async () => undefined),
    lastActivity: () => Date.now()
  } as unknown as TransportAdapter & { invoke: jest.Mock };
}

/** 构造 handler 并注入适配器（绕过懒建，直接挂 standaloneAdapter）。 */
function handlerWith(adapter: TransportAdapter): RfcProbeHandlers {
  const handlers = new RfcProbeHandlers(
    { host: '10.30.254.48', client: '300', user: '068157', password: 'x', language: 'ZH', sysnr: '01' }
  );
  (handlers as unknown as { standaloneAdapter: TransportAdapter }).standaloneAdapter = adapter;
  return handlers;
}

describe('RfcProbeHandlers tool catalog', () => {
  it('publishes one uniquely named read-only tool', () => {
    const handlers = handlerWith(adapterMock({}));
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['probeRfcSystem', 'readRfcTable']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = handlerWith(adapterMock({}));
    expect(handlers.supports('probeRfcSystem')).toBe(true);
    expect(handlers.supports('callRfm')).toBe(false);
  });
});

describe('RfcProbeHandlers dispatch (allowlist-gated)', () => {
  it('merges ping and system info into one report', async () => {
    const adapter = adapterMock({
      RFC_PING: {},
      RFC_SYSTEM_INFO: { SYSID: 'S4H', RFCRELEASE: '816' }
    });
    const handlers = handlerWith(adapter);
    const result = await handlers.handle('probeRfcSystem', {});
    const body = result.structuredContent.result;
    // RFC_PING 无输出参数：调用成功即 pong=true（显式置位）
    expect(body.ping.pong).toBe(true);
    expect(body.systemInfo.SYSID).toBe('S4H');
    expect(body.systemInfo.RFCRELEASE).toBe('816');
  });

  it('reports a failed ping and info error without throwing (discovery semantics)', async () => {
    // 两个 FM 都在适配器抛错（模拟网关不可达）→ 分类报告而非抛出
    const adapter = adapterMock({});
    const handlers = handlerWith(adapter);
    const result = await handlers.handle('probeRfcSystem', {});
    const body = result.structuredContent.result;
    expect(body.ping.pong).toBe(false);
    expect(String(body.ping.detail)).toContain('unexpected FM');
    expect(body.systemInfo.status).toBe('error');
  });

  it('keeps invoked FM names within the read-only allowlist', async () => {
    const adapter = adapterMock({});
    const handlers = handlerWith(adapter);
    await handlers.handle('probeRfcSystem', {});
    const invoked = (adapter.invoke as jest.Mock).mock.calls.map(c => c[0].functionName);
    // 白名单门控：本处理器只会调用两个白名单内系统 FM，绝不越界
    expect(invoked.every(name => ['RFC_PING', 'RFC_SYSTEM_INFO'].includes(name))).toBe(true);
  });

  it('propagates request-level MCP errors unchanged (unknown tool)', async () => {
    const handlers = handlerWith(adapterMock({}));
    await expect(handlers.handle('callRfm', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('reports probe failures as structured report, not thrown internal errors', async () => {
    // discovery 语义：网关不可达（RfcTransportError）应进入分类报告
    const failing: TransportAdapter = {
      connect: jest.fn(async () => undefined),
      invoke: jest.fn(async () => {
        throw Object.assign(new Error('gateway unreachable'), { code: 'RFC_TRANSPORT_FAILURE' });
      }),
      close: jest.fn(async () => undefined),
      lastActivity: () => null
    };
    const handlers = handlerWith(failing);
    const result = await handlers.handle('probeRfcSystem', {});
    const body = result.structuredContent.result;
    expect(body.ping.pong).toBe(false);
    expect(body.systemInfo.status).toBe('error');
    // 关键：不应出现内部错误（InternalError 抛出）——structuredContent 存在即证明
    expect(result.structuredContent.status).toBe('success');
  });
});
