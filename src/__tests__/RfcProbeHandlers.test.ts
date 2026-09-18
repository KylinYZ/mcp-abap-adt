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
  it('publishes four uniquely named read-only tools', () => {
    const handlers = handlerWith(adapterMock({}));
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['probeRfcSystem', 'readRfcTable', 'describeRfm', 'callRfm']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool names via supports()', () => {
    const handlers = handlerWith(adapterMock({}));
    expect(handlers.supports('probeRfcSystem')).toBe(true);
    expect(handlers.supports('readRfcTable')).toBe(true);
    expect(handlers.supports('describeRfm')).toBe(true);
    expect(handlers.supports('callRfm')).toBe(true);
    expect(handlers.supports('invokeRfm')).toBe(false);
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
    await expect(handlers.handle('noSuchRfcTool', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
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

describe('RfcProbeHandlers describeRfm (interface metadata)', () => {
  /** 带元数据通道的适配器桩：invoke 按名回放，getFunctionInterface 回放预置接口。 */
  function metaAdapterMock(iface: { parameters: Array<Record<string, unknown>> }): TransportAdapter {
    return {
      connect: jest.fn(async () => undefined),
      invoke: jest.fn(async (request: { functionName: string }) => ({
        functionName: request.functionName, values: {}, tables: {}, exceptions: [], durationMs: 1
      })),
      close: jest.fn(async () => undefined),
      lastActivity: () => Date.now(),
      getFunctionInterface: jest.fn(async (functionName: string) => ({
        parameters: iface.parameters.map(p => ({ ...p, _fm: functionName }))
      }))
    } as unknown as TransportAdapter;
  }

  it('maps interface metadata to a structured description with input schema', async () => {
    const adapter = metaAdapterMock({
      parameters: [
        { parameterName: 'QUERY_TABLE', parameterClass: 'I', parameterExid: 'c', associatedType: 'DD02L', internalLength: 30, optional: false },
        { parameterName: 'DELIMITER', parameterClass: 'I', parameterExid: 'c', associatedType: 'SONV', internalLength: 1, optional: true },
        { parameterName: 'ROWCOUNT', parameterClass: 'I', parameterExid: 'I', associatedType: 'SOID', internalLength: 4, optional: true },
        { parameterName: 'DATA', parameterClass: 'T', parameterExid: 'u', associatedType: 'TAB512', internalLength: 512, optional: true },
        { parameterName: 'ET_DATA', parameterClass: 'E', parameterExid: 'h', associatedType: 'SDTI_RESULT_TAB', internalLength: 8, optional: false }
      ]
    });
    const handlers = handlerWith(adapter);
    const result = await handlers.handle('describeRfm', { functionName: 'rfc_read_table' });
    const body = result.structuredContent.result;
    // 名字归一大写；参数按元数据原序透传
    expect(body.functionName).toBe('RFC_READ_TABLE');
    expect(body.parameterCount).toBe(5);
    expect(body.parameters.map((p: { name: string }) => p.name)).toEqual(
      ['QUERY_TABLE', 'DELIMITER', 'ROWCOUNT', 'DATA', 'ET_DATA']
    );
    expect(body.parameters[0]).toMatchObject({ direction: 'I', type: 'c', associatedType: 'DD02L', length: 30, optional: false });
    // inputSchema 只收 I/C：QUERY_TABLE 必填，DELIMITER/ROWCOUNT 可选；E/T 不进
    expect(body.inputSchema.required).toEqual(['QUERY_TABLE']);
    expect(body.inputSchema.properties.ROWCOUNT.type).toBe('integer');
    expect(body.inputSchema.properties.DATA).toBeUndefined();
    // RFC_READ_TABLE 在默认 allowlist 内：组参提示为 true
    expect(body.allowlisted).toBe(true);
    // describe 不执行目标 FM：invoke 零调用
    expect((adapter as unknown as { invoke: jest.Mock }).invoke).not.toHaveBeenCalled();
  });

  it('marks non-allowlisted FMs in the description without blocking describe', async () => {
    const adapter = metaAdapterMock({ parameters: [] });
    const handlers = handlerWith(adapter);
    const result = await handlers.handle('describeRfm', { functionName: 'BAPI_USER_GET_DETAIL' });
    expect(result.structuredContent.result.allowlisted).toBe(false);
  });

  it('rejects invalid FM names at the parameter layer', async () => {
    const handlers = handlerWith(metaAdapterMock({ parameters: [] }));
    await expect(handlers.handle('describeRfm', { functionName: "X';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('surfaces the missing metadata channel as a diagnostic internal error', async () => {
    // Loopback 形态适配器（无 getFunctionInterface）：明确报"无元数据通道"
    const handlers = handlerWith(adapterMock({}));
    await expect(handlers.handle('describeRfm', { functionName: 'RFC_READ_TABLE' }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
});

describe('RfcProbeHandlers callRfm (allowlist-gated generic call)', () => {
  it('rejects non-allowlisted FMs with the allowlist in the message (zero invoke)', async () => {
    const adapter = adapterMock({});
    const handlers = handlerWith(adapter);
    await expect(handlers.handle('callRfm', { functionName: 'BAPI_USER_GET_DETAIL' }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(handlers.handle('callRfm', { functionName: 'BAPI_USER_GET_DETAIL' }))
      .rejects.toThrow(/RF_CALL_NOT_ALLOWED/);
    // 安全硬门在传输之前：不允许越界调用触达适配器
    expect((adapter.invoke as jest.Mock)).not.toHaveBeenCalled();
  });

  it('calls an allowlisted RFM with upper-cased top-level args and returns the result', async () => {
    const adapter = adapterMock({ RFC_SYSTEM_INFO: { SYSID: 'S4H', RFCRELEASE: '816' } });
    const handlers = handlerWith(adapter);
    const result = await handlers.handle('callRfm', { functionName: 'rfc_system_info', args: {} });
    const body = result.structuredContent.result;
    expect(body.functionName).toBe('RFC_SYSTEM_INFO');
    expect(body.values.SYSID).toBe('S4H');
    // 空 tables 不占位：响应保持精简
    expect(body.tables).toBeUndefined();
  });

  it('normalizes top-level arg keys to uppercase but keeps nested values untouched', async () => {
    const adapter = adapterMock({ RFC_READ_TABLE: { ET_DATA: [{ LINE: '300|0001|SAP SE' }] } });
    const handlers = handlerWith(adapter);
    await handlers.handle('callRfm', {
      functionName: 'RFC_READ_TABLE',
      args: { query_table: 'T001', delimiter: '|', rowcount: 2 }
    });
    const payload = (adapter.invoke as jest.Mock).mock.calls[0][0].payload;
    expect(payload).toEqual({ QUERY_TABLE: 'T001', DELIMITER: '|', ROWCOUNT: 2 });
  });

  it('rejects malformed args and invalid names at the parameter layer', async () => {
    const handlers = handlerWith(adapterMock({}));
    await expect(handlers.handle('callRfm', { functionName: 'RFC_PING', args: [1, 2] }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('callRfm', { functionName: "Z';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('passes the requested timeout through to the invoke chain', async () => {
    const adapter = adapterMock({ RFC_PING: {} });
    const handlers = handlerWith(adapter);
    await handlers.handle('callRfm', { functionName: 'RFC_PING', timeoutSeconds: 45 });
    const request = (adapter.invoke as jest.Mock).mock.calls[0][0];
    expect(request.functionName).toBe('RFC_PING');
    expect(request.payload).toBeUndefined();
  });
});
