import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ApplicationLogHandlers } from '../handlers/ApplicationLogHandlers';
import type { ApplicationLogClient, ApplicationLogResult } from '../adt/ApplicationLogApi.js';

/**
 * ApplicationLogHandlers 工具层测试（mock 注入客户端，绝不连接真实 SAP）。
 * 覆盖：getTools 名称唯一性与只读元数据、supports 边界、参数校验（对象名/
 * 用户/外部 ID 长度与字符、ISO 时间窗、maxResults 边界）、分派与规范化输入、
 * 上游错误传播与响应脱敏、未知工具拒绝。
 */

const sampleResult: ApplicationLogResult = {
  entries: [
    {
      logNumber: '00000000000000001234',
      logHandle: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
      object: 'ZSALES',
      externalId: 'SO-4711',
      timestamp: '2026-09-01T10:15:30',
      user: 'YANGP',
      messageCount: 3
    }
  ],
  count: 1,
  truncated: false,
  appliedFilter: { object: 'ZSALES', dateWindow: { from: '20260901', to: '20260907' }, maxResults: 100 }
};

/** 构造 readApplicationLog 为 jest mock 的注入客户端。 */
function mockClient(): ApplicationLogClient {
  return { readApplicationLog: jest.fn().mockResolvedValue(sampleResult) };
}

describe('ApplicationLogHandlers tool catalog', () => {
  it('publishes one uniquely named read-only application log tool', () => {
    const tools = new ApplicationLogHandlers(mockClient()).getTools();
    const names = tools.map(tool => tool.name);

    // 名称唯一（与项目工具目录完整性基线同口径）
    expect(names).toEqual(['readApplicationLog']);
    expect(new Set(names).size).toBe(names.length);

    const tool = tools[0];
    // 只读：注解与 _meta 必须声明 read-only tenant、无需确认
    expect(tool.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
    });
    expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });

    // schema 边界：禁止额外属性；全部参数可选（required 缺省）
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toBeUndefined();
    expect(tool.inputSchema.properties.object).toMatchObject({ type: 'string', maxLength: 20, optional: true });
    expect(tool.inputSchema.properties.objectSubobject).toMatchObject({ maxLength: 20, optional: true });
    expect(tool.inputSchema.properties.externalId).toMatchObject({ maxLength: 100, optional: true });
    expect(tool.inputSchema.properties.userName).toMatchObject({ maxLength: 12, optional: true });
    expect(tool.inputSchema.properties.maxResults).toMatchObject({ minimum: 1, maximum: 500, optional: true });
    expect(tool.inputSchema.properties.timeFrom).toMatchObject({ type: 'string', optional: true });
    expect(tool.inputSchema.properties.timeTo).toMatchObject({ type: 'string', optional: true });
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new ApplicationLogHandlers(mockClient());
    expect(handlers.supports('readApplicationLog')).toBe(true);
    expect(handlers.supports('runQuery')).toBe(false);
    expect(handlers.supports('sm21Read')).toBe(false);
    expect(handlers.supports('sap')).toBe(false);
  });
});

describe('ApplicationLogHandlers dispatch and validation', () => {
  it('dispatches with a normalized filter (upper-cased names, trimmed bounds)', async () => {
    const client = mockClient();
    const handlers = new ApplicationLogHandlers(client);

    const response = await handlers.handle('readApplicationLog', {
      object: ' zsales ',
      objectSubobject: 'zorder',
      userName: 'yangp',
      externalId: 'SO-4711',
      timeFrom: '2026-09-01',
      timeTo: '2026-09-07',
      maxResults: 25
    });

    // 名称统一大写，其余字段原样传递给底层客户端
    expect(client.readApplicationLog).toHaveBeenCalledWith({
      object: 'ZSALES',
      objectSubobject: 'ZORDER',
      userName: 'YANGP',
      externalId: 'SO-4711',
      timeFrom: '2026-09-01',
      timeTo: '2026-09-07',
      maxResults: 25
    });
    expect(response.structuredContent).toEqual({ status: 'success', result: sampleResult });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('dispatches an empty filter when no arguments are provided', async () => {
    const client = mockClient();
    const handlers = new ApplicationLogHandlers(client);

    // 全部参数可选：无参调用合法，底层以默认上限兜底
    await handlers.handle('readApplicationLog');
    expect(client.readApplicationLog).toHaveBeenCalledWith({});
  });

  it.each([
    ['object over 20 characters', { object: 'Z'.repeat(21) }],
    ['object with whitespace', { object: 'Z SALES' }],
    ['object with control characters', { object: 'Z\tSALES' }],
    ['subobject over 20 characters', { objectSubobject: 'S'.repeat(21) }],
    ['userName over 12 characters', { userName: 'U'.repeat(13) }],
    ['externalId over 100 characters', { externalId: 'E'.repeat(101) }],
    ['externalId with control characters', { externalId: 'SO\u00004711' }],
    ['non-string object', { object: 42 }],
    ['non-string timeFrom', { timeFrom: 20260901 }],
    ['non-ISO timeFrom', { timeFrom: '20260901' }],
    ['impossible calendar date', { timeFrom: '2026-02-30' }],
    ['reversed time window', { timeFrom: '2026-09-07', timeTo: '2026-09-01' }],
    ['time window wider than 31 days', { timeFrom: '2026-01-01', timeTo: '2026-02-02' }],
    ['maxResults below 1', { maxResults: 0 }],
    ['maxResults above the cap', { maxResults: 501 }],
    ['non-integer maxResults', { maxResults: 10.5 }],
    ['non-number maxResults', { maxResults: '10' }]
  ])('rejects invalid input (%s) with InvalidParams', async (_label, args) => {
    const client = mockClient();
    const handlers = new ApplicationLogHandlers(client);

    await expect(handlers.handle('readApplicationLog', args as Record<string, unknown>))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 校验失败必须发生在进入底层客户端之前
    expect(client.readApplicationLog).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    // 上游（客户端/低层）抛出的 MCP 语义错误必须原样透传，不得吞成 500
    const requestError = new McpError(ErrorCode.InvalidParams, 'query rejected');
    const client = mockClient();
    (client.readApplicationLog as jest.Mock).mockRejectedValue(requestError);

    await expect(new ApplicationLogHandlers(client).handle('readApplicationLog', { object: 'Z_X' }))
      .rejects.toBe(requestError);
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = mockClient();
    (client.readApplicationLog as jest.Mock).mockRejectedValue(new Error('SECRET_REMOTE_BODY'));

    await expect(new ApplicationLogHandlers(client).handle('readApplicationLog', { object: 'Z_X' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.not.stringContaining('SECRET_REMOTE_BODY')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new ApplicationLogHandlers(mockClient());
    await expect(handlers.handle('writeApplicationLog', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
