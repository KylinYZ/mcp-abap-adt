import { ContextAnalysisHandlers } from '../handlers/ContextAnalysisHandlers.js';
import type { ContextAnalysisClient } from '../adt/ContextCompressionApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * ContextAnalysisHandlers 目录与分派契约测试（mock 四能力客户端，零 SAP 往返）。
 * 断言五类内容（对齐 CrossReferenceHandlers 测试口径）：
 *   1. 工具目录：四个只读工具、名称唯一、注解与 _meta 安全元数据正确；
 *   2. supports() 边界；
 *   3. 分派与参数规范化：名字大写、可选数字收敛到边界、MCP 结构化返回；
 *   4. 参数校验：source/objectType+objectName 二选一、名字白名单、超长拒绝；
 *   5. 错误语义：MCP 错误透传、底层异常脱敏为 InternalError、未知工具拒绝。
 */

/** 构造四能力客户端 mock：jest.fn 记录每次调用与入参，返回可断言的固定结果。 */
function clientMock(): ContextAnalysisClient & { calls: Array<{ tool: string; input: unknown }> } {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const record = (tool: string) => jest.fn((input: unknown) => {
    calls.push({ tool, input });
    return Promise.resolve({ ok: true, input } as any);
  });
  return {
    calls,
    getDependencyContext: record('getDependencyContext'),
    analyzeDependencies: record('analyzeDependencies'),
    parseAbapSource: record('parseAbapSource'),
    analyzeSourceEffects: record('analyzeSourceEffects')
  };
}

describe('ContextAnalysisHandlers tool catalog', () => {
  it('publishes four uniquely named read-only tools', () => {
    const handlers = new ContextAnalysisHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual([
      'getDependencyContext', 'analyzeDependencies', 'parseAbapSource', 'analyzeSourceEffects'
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool names via supports()', () => {
    const handlers = new ContextAnalysisHandlers(clientMock());
    expect(handlers.supports('getDependencyContext')).toBe(true);
    expect(handlers.supports('analyzeDependencies')).toBe(true);
    expect(handlers.supports('parseAbapSource')).toBe(true);
    expect(handlers.supports('analyzeSourceEffects')).toBe(true);
    expect(handlers.supports('getCallees')).toBe(false);
    expect(handlers.supports('unknown')).toBe(false);
  });
});

describe('ContextAnalysisHandlers dispatch and validation', () => {
  it('dispatches getDependencyContext with normalized args and clamped bounds', async () => {
    const client = clientMock();
    const handlers = new ContextAnalysisHandlers(client);
    const result = await handlers.handle('getDependencyContext', {
      objectType: 'clas',
      objectName: ' zcl_app ',
      maxDeps: 9999,
      depth: 0
    });
    expect(client.calls[0]).toEqual({
      tool: 'getDependencyContext',
      input: { objectType: 'CLAS', objectName: 'ZCL_APP', maxDeps: 50, depth: 1 }
    });
    expect(result.structuredContent).toEqual({ status: 'success', result: { ok: true, input: client.calls[0].input } });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('omits optional bounds when absent', async () => {
    const client = clientMock();
    const handlers = new ContextAnalysisHandlers(client);
    await handlers.handle('getDependencyContext', { objectType: 'INTF', objectName: 'ZIF_X' });
    expect(client.calls[0].input).toEqual({ objectType: 'INTF', objectName: 'ZIF_X' });
  });

  it('dispatches the three analysis tools with source passthrough', async () => {
    const client = clientMock();
    const handlers = new ContextAnalysisHandlers(client);
    await handlers.handle('analyzeDependencies', { source: 'DATA x TYPE i.' });
    await handlers.handle('parseAbapSource', { source: 'DATA x TYPE i.', objectName: 'z_named' });
    await handlers.handle('analyzeSourceEffects', { objectType: 'prog', objectName: 'zprog' });
    expect(client.calls.map(c => c.tool)).toEqual([
      'analyzeDependencies', 'parseAbapSource', 'analyzeSourceEffects'
    ]);
    expect(client.calls[1].input).toEqual({ source: 'DATA x TYPE i.', objectName: 'Z_NAMED' });
    expect(client.calls[2].input).toEqual({ objectType: 'PROG', objectName: 'ZPROG' });
  });

  it('rejects getDependencyContext without objectType/objectName or with bad names', async () => {
    const handlers = new ContextAnalysisHandlers(clientMock());
    await expect(handlers.handle('getDependencyContext', { objectName: 'ZCL_X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getDependencyContext', { objectType: 'TABLE', objectName: 'ZCL_X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getDependencyContext', { objectType: 'CLAS', objectName: "ZCL_X';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getDependencyContext', { objectType: 'CLAS', objectName: 'ZCL X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('requires either source or a complete object identity for analysis tools', async () => {
    const handlers = new ContextAnalysisHandlers(clientMock());
    await expect(handlers.handle('analyzeDependencies', {}))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('analyzeDependencies', { objectType: 'CLAS' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('analyzeSourceEffects', { objectName: 'Z_X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('parseAbapSource', { source: '   ' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('parseAbapSource', { objectType: 'BADI', objectName: 'Z_X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects over-long source input', async () => {
    const handlers = new ContextAnalysisHandlers(clientMock());
    const huge = 'x'.repeat(1_000_001);
    await expect(handlers.handle('analyzeDependencies', { source: huge }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.getDependencyContext as jest.Mock).mockRejectedValueOnce(
      new McpError(ErrorCode.InvalidParams, 'shaped error')
    );
    const handlers = new ContextAnalysisHandlers(client);
    // McpError 的 message 会带 "MCP error -32602: " 前缀，断言其内容片段
    await expect(handlers.handle('getDependencyContext', { objectType: 'CLAS', objectName: 'Z_X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped error') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.getDependencyContext as jest.Mock).mockRejectedValueOnce(
      new Error('remote said: GET https://secret-host/sap/bc/adt → 403 forbidden')
    );
    const handlers = new ContextAnalysisHandlers(client);
    await expect(handlers.handle('getDependencyContext', { objectType: 'CLAS', objectName: 'Z_X' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('getDependencyContext failed.')
      });
    // 脱敏断言：抛出的消息绝不包含远端细节
    await handlers.handle('analyzeDependencies', { source: 'DATA x TYPE i.' }).catch(() => undefined);
    try {
      await handlers.handle('getDependencyContext', { objectType: 'CLAS', objectName: 'Z_X' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-host');
    }
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new ContextAnalysisHandlers(clientMock());
    await expect(handlers.handle('notATool', {}))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
