/**
 * ExecuteAbapHandlers 测试（devtools.execute-abap 的 MCP 面）。
 * ExecuteAbapClient 全 mock——本文件只验证 handler 的 schema 契约、
 * 参数校验与错误分层，不触网。
 */
import { ExecuteAbapHandlers } from '../handlers/ExecuteAbapHandlers';
import { ErrorCode } from '../lib/McpErrorCompat';
import type { ExecuteAbapClient, ExecuteAbapResult } from '../adt/ExecuteAbapApi';

/** 构造一个最小 ExecuteAbapResult（测试断言用）。 */
function fakeResult(overrides: Partial<ExecuteAbapResult> = {}): ExecuteAbapResult {
  return {
    success: true,
    programName: 'ZTEMP_EXEC_0001',
    output: ['42'],
    rawAlerts: [],
    executionTime: 1,
    message: 'Executed successfully, 1 output(s) returned',
    cleanedUp: true,
    cleanupWarnings: [],
    ...overrides
  };
}

/** mock 客户端：记录最近一次入参并按注册表返回/抛错。 */
function makeClient(impl: {
  result?: ExecuteAbapResult
  error?: Error
} = {}): { client: ExecuteAbapClient; calls: Array<{ code: string; opts: any }> } {
  const calls: Array<{ code: string; opts: any }> = [];
  const client: ExecuteAbapClient = {
    executeAbap: async (code, opts) => {
      calls.push({ code, opts });
      if (impl.error) throw impl.error;
      return impl.result ?? fakeResult();
    }
  };
  return { client, calls };
}

describe('ExecuteAbapHandlers', () => {
  it('exposes exactly one executing tool with strict schema and execution metadata', () => {
    const { client } = makeClient();
    const tools = new ExecuteAbapHandlers(client).getTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('executeAbap');
    expect(tool.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true
    });
    expect(tool._meta).toEqual({ operationClass: 'mutating tenant', approvalRequired: false });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(['code']);
    // 风险档位枚举与长度边界（schema 即契约，与 handler 校验同源）
    expect((tool.inputSchema.properties as any).riskLevel.enum).toEqual(['harmless', 'dangerous', 'critical']);
    expect((tool.inputSchema.properties as any).code.maxLength).toBe(100_000);
  });

  it('supports only executeAbap', () => {
    const { client } = makeClient();
    const handlers = new ExecuteAbapHandlers(client);
    expect(handlers.supports('executeAbap')).toBe(true);
    expect(handlers.supports('runClass')).toBe(false);
  });

  it('dispatches to the client with normalized options', async () => {
    const { client, calls } = makeClient({ result: fakeResult() });
    const handlers = new ExecuteAbapHandlers(client);
    const response = await handlers.handle('executeAbap', {
      code: "lv_result = 42.",
      riskLevel: 'dangerous',
      returnVariable: 'rv_out',
      keepProgram: true
    });
    expect(calls).toEqual([{
      code: "lv_result = 42.",
      opts: { riskLevel: 'dangerous', returnVariable: 'rv_out', keepProgram: true }
    }]);
    expect(response.structuredContent.status).toBe('success');
    expect(response.structuredContent.result.success).toBe(true);
    expect(response.content[0].text).toBe(JSON.stringify(response.structuredContent));
  });

  it('omits unset optional fields (server-side defaults apply)', async () => {
    const { client, calls } = makeClient();
    await new ExecuteAbapHandlers(client).handle('executeAbap', { code: 'lv_result = 1.' });
    expect(calls[0].opts).toEqual({});
  });

  it('propagates soft failures (success=false) instead of masking them', async () => {
    const softFailure = fakeResult({
      success: false,
      output: [],
      cleanedUp: false,
      failure: { kind: 'syntaxError', title: 'Field "LV_X" is unknown' },
      message: 'The code did not compile: Field "LV_X" is unknown'
    });
    const { client } = makeClient({ result: softFailure });
    const response = await new ExecuteAbapHandlers(client).handle('executeAbap', { code: 'lv_x = 1.' });
    expect(response.structuredContent.result.failure.kind).toBe('syntaxError');
  });

  it.each([
    [undefined, 'missing code'],
    ['', 'empty code'],
    ['   ', 'whitespace-only code'],
    [{}, 'non-string code']
  ])('rejects invalid code (%s)', async (code, _label) => {
    const { client, calls } = makeClient();
    await expect(new ExecuteAbapHandlers(client).handle('executeAbap', { code }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(calls).toHaveLength(0); // 参数未过校验不得触达客户端
  });

  it('rejects unknown riskLevel values without size coercion', async () => {
    const { client, calls } = makeClient();
    await expect(new ExecuteAbapHandlers(client).handle('executeAbap', {
      code: 'lv_result = 1.', riskLevel: 'DANGEROUS'
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['1bad', 'digit-first'],
    ['has space', 'space'],
    ['x'.repeat(31), 'over 30 chars']
  ])('rejects invalid returnVariable (%s)', async (returnVariable, _label) => {
    const { client, calls } = makeClient();
    await expect(new ExecuteAbapHandlers(client).handle('executeAbap', {
      code: 'lv_result = 1.', returnVariable
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(calls).toHaveLength(0);
  });

  it('rejects non-boolean keepProgram', async () => {
    const { client } = makeClient();
    await expect(new ExecuteAbapHandlers(client).handle('executeAbap', {
      code: 'lv_result = 1.', keepProgram: 'yes'
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('sanitizes infrastructure errors into InternalError without remote details', async () => {
    const { client } = makeClient({ error: new Error('HTTP 500: https://secret.host/sap/bc/adt ...') });
    await expect(new ExecuteAbapHandlers(client).handle('executeAbap', { code: 'lv_result = 1.' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.not.stringContaining('secret.host')
      });
  });

  it('rejects unknown tool names', async () => {
    const { client } = makeClient();
    await expect(new ExecuteAbapHandlers(client).handle('executeAbapX', {}))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
