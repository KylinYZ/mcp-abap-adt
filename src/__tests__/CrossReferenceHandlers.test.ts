import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CrossReferenceHandlers } from '../handlers/CrossReferenceHandlers';
import type { CrossReferenceClient, GetCalleesResult } from '../adt/CrossReferenceApi.js';

/**
 * CrossReferenceHandlers 工具层测试（mock 注入客户端，绝不连接真实 SAP）。
 * 覆盖：getTools 名称唯一性与只读元数据、supports 边界、参数校验（含注入
 * 样本白名单拦截）、分派与规范化输入、maxResults 钳制、上游错误传播与响应
 * 脱敏、未知工具拒绝。
 */

const sampleResult: GetCalleesResult = {
  objectName: 'ZCL_FOO',
  objectType: 'CLAS',
  includePredicate: "INCLUDE LIKE 'ZCL_FOO%'",
  callees: [
    { name: 'ZCL_UTILS', kind: 'method', direct: true, calls: true, source: 'WBCROSSGT', component: 'DO_STUFF' },
    { name: 'IF_FOO_BAR', kind: 'type', direct: true, calls: false, source: 'WBCROSSGT' }
  ],
  truncated: false,
  sourcesSearched: ['WBCROSSGT', 'CROSS'],
  failedSources: []
};

/** 构造 getCallees 为 jest mock 的注入客户端。 */
function mockClient(): CrossReferenceClient {
  return {
    getCallees: jest.fn().mockResolvedValue(sampleResult)
  };
}

describe('CrossReferenceHandlers tool catalog', () => {
  it('publishes one uniquely named read-only callees tool', () => {
    const tools = new CrossReferenceHandlers(mockClient()).getTools();
    const names = tools.map(tool => tool.name);

    // 名称唯一（与项目工具目录完整性基线同口径）
    expect(names).toEqual(['getCallees']);
    expect(new Set(names).size).toBe(names.length);

    const tool = tools[0];
    // 只读元数据：注解与 _meta 必须声明 read-only tenant、无需确认
    expect(tool.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
    });
    expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });

    // schema 边界：禁止额外属性；objectType 枚举五类；objectName 必填有界；
    // maxResults 可选且声明 1..1000
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(['objectType', 'objectName']);
    expect(tool.inputSchema.properties.objectType).toMatchObject({
      enum: ['PROG', 'CLAS', 'INTF', 'FUGR', 'FUNC']
    });
    expect(tool.inputSchema.properties.objectName).toMatchObject({ minLength: 1, maxLength: 40 });
    expect(tool.inputSchema.properties.maxResults).toMatchObject({ minimum: 1, maximum: 1000 });
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new CrossReferenceHandlers(mockClient());
    expect(handlers.supports('getCallees')).toBe(true);
    expect(handlers.supports('getCallers')).toBe(false);
    expect(handlers.supports('runQuery')).toBe(false);
    expect(handlers.supports('sap')).toBe(false);
  });
});

describe('CrossReferenceHandlers dispatch and validation', () => {
  it('dispatches with a normalized query (uppercased name, clamped maxResults)', async () => {
    const client = mockClient();
    const handlers = new CrossReferenceHandlers(client);

    const response = await handlers.handle('getCallees', {
      objectType: 'clas',
      objectName: ' zcl_foo ',
      maxResults: 9999
    });

    // 小写/首尾空白在服务端规范化；超出硬上限的 maxResults 钳到 1000
    expect(client.getCallees).toHaveBeenCalledWith({
      objectType: 'CLAS',
      objectName: 'ZCL_FOO',
      maxResults: 1000
    });
    expect(response.structuredContent).toEqual({ status: 'success', result: sampleResult });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('clamps a below-range maxResults up to 1 and omits the field when absent', async () => {
    const client = mockClient();
    const handlers = new CrossReferenceHandlers(client);

    await handlers.handle('getCallees', { objectType: 'PROG', objectName: 'ZP', maxResults: 0 });
    expect(client.getCallees).toHaveBeenLastCalledWith({ objectType: 'PROG', objectName: 'ZP', maxResults: 1 });

    await handlers.handle('getCallees', { objectType: 'PROG', objectName: 'ZP' });
    expect(client.getCallees).toHaveBeenLastCalledWith({ objectType: 'PROG', objectName: 'ZP' });
  });

  it.each([
    ['objectType outside the allowlist', { objectType: 'TABL', objectName: 'ZCL_FOO' }],
    ['missing objectType', { objectName: 'ZCL_FOO' }],
    ['missing objectName', { objectType: 'CLAS' }],
    ["injection sample with quote and comment", { objectType: 'CLAS', objectName: "Z X'--" }],
    ['injection sample with statement separator', { objectType: 'CLAS', objectName: 'Z;DROP' }],
    ['injection sample with dash comment', { objectType: 'CLAS', objectName: 'Z--X' }],
    ['injection sample with double quote', { objectType: 'CLAS', objectName: 'Z"OR' }],
    ['injection sample with space', { objectType: 'CLAS', objectName: 'ZCL FOO' }],
    ['objectName over 40 characters', { objectType: 'CLAS', objectName: 'Z'.repeat(41) }],
    ['non-string objectName', { objectType: 'CLAS', objectName: 42 }],
    ['non-number maxResults', { objectType: 'CLAS', objectName: 'ZCL_FOO', maxResults: '200' }]
  ])('rejects invalid input (%s) with InvalidParams', async (_label, args) => {
    const client = mockClient();
    const handlers = new CrossReferenceHandlers(client);

    await expect(handlers.handle('getCallees', args as Record<string, unknown>))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 校验失败必须发生在进入底层客户端之前——SQL 永远不会拼装
    expect(client.getCallees).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    // 上游（客户端/低层）抛出的 MCP 语义错误必须原样透传，不得吞成 500
    const requestError = new McpError(ErrorCode.InvalidParams, 'query rejected');
    const client = mockClient();
    (client.getCallees as jest.Mock).mockRejectedValue(requestError);

    await expect(new CrossReferenceHandlers(client).handle('getCallees', { objectType: 'CLAS', objectName: 'ZCL_X' }))
      .rejects.toBe(requestError);
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = mockClient();
    (client.getCallees as jest.Mock).mockRejectedValue(new Error('SECRET_REMOTE_BODY'));

    await expect(new CrossReferenceHandlers(client).handle('getCallees', { objectType: 'CLAS', objectName: 'ZCL_X' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.not.stringContaining('SECRET_REMOTE_BODY')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new CrossReferenceHandlers(mockClient());
    await expect(handlers.handle('getCallers', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
