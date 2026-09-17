import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CdsAnalysisHandlers } from '../handlers/CdsAnalysisHandlers';
import type { CdsAnalysisClient } from '../adt/CdsDependencyApi.js';

/**
 * CdsAnalysisHandlers 工具层测试（mock 注入客户端，绝不连接真实 SAP）。
 * 覆盖：getTools 名称唯一性与只读元数据、supports 边界、参数校验、
 * 分派与规范化输入、上游错误传播与响应脱敏、未知工具拒绝。
 */

const sampleDependencyResult = {
  objectName: 'ZC_TRAVEL_U',
  direction: 'upstream' as const,
  root: { name: 'ZC_TRAVEL_U', type: 'CDS_VIEW' },
  dependencies: [{ name: '/DMO/I_TRAVEL', type: 'TABLE', relation: 'FROM' }],
  statistics: { total: 1, tableCount: 1, depth: 2, byType: { TABLE: 1 } }
};

/** 构造三个方法均为 jest mock 的注入客户端。 */
function mockClient(): CdsAnalysisClient {
  return {
    getCdsDependencies: jest.fn().mockResolvedValue(sampleDependencyResult),
    getCdsImpactAnalysis: jest.fn().mockResolvedValue({
      objectName: 'ZC_TRAVEL_U', direction: 'downstream', impactedObjects: [], totalCount: 0
    }),
    getCdsElementInfo: jest.fn().mockResolvedValue({
      objectName: 'ZC_TRAVEL_U', viewName: 'ZC_TRAVEL_U', elements: []
    })
  };
}

describe('CdsAnalysisHandlers tool catalog', () => {
  it('publishes three uniquely named read-only CDS analysis tools', () => {
    const tools = new CdsAnalysisHandlers(mockClient()).getTools();
    const names = tools.map(tool => tool.name);

    // 名称唯一（与项目工具目录完整性基线同口径）
    expect(names).toEqual(['getCdsDependencies', 'getCdsImpactAnalysis', 'getCdsElementInfo']);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of tools) {
      // 全部只读：注解与 _meta 必须声明 read-only tenant、无需确认
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
      // schema 边界：禁止额外属性，objectName 有长度限制且必填
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toEqual(['objectName']);
      expect(tool.inputSchema.properties.objectName).toMatchObject({ minLength: 1, maxLength: 40 });
      expect(tool.inputSchema.properties.objectType).toMatchObject({ enum: ['DDLS'] });
    }
  });

  it('claims exactly its three tool names via supports()', () => {
    const handlers = new CdsAnalysisHandlers(mockClient());
    expect(handlers.supports('getCdsDependencies')).toBe(true);
    expect(handlers.supports('getCdsImpactAnalysis')).toBe(true);
    expect(handlers.supports('getCdsElementInfo')).toBe(true);
    expect(handlers.supports('getCdsSource')).toBe(false);
    expect(handlers.supports('sap')).toBe(false);
  });
});

describe('CdsAnalysisHandlers dispatch and validation', () => {
  it('dispatches dependencies with a normalized DDLS query', async () => {
    const client = mockClient();
    const handlers = new CdsAnalysisHandlers(client);

    const response = await handlers.handle('getCdsDependencies', { objectName: ' zc_travel_u ' });

    // 小写与首尾空白在服务端规范化，objectType 缺省补 DDLS
    expect(client.getCdsDependencies).toHaveBeenCalledWith({ objectName: 'ZC_TRAVEL_U', objectType: 'DDLS' });
    expect(response.structuredContent).toEqual({ status: 'success', result: sampleDependencyResult });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('dispatches impact and element tools through the same validation', async () => {
    const client = mockClient();
    const handlers = new CdsAnalysisHandlers(client);

    await handlers.handle('getCdsImpactAnalysis', { objectName: 'ZC_TRAVEL_U', objectType: 'DDLS' });
    await handlers.handle('getCdsElementInfo', { objectType: 'DDLS', objectName: 'zc_travel_u' });

    expect(client.getCdsImpactAnalysis).toHaveBeenCalledWith({ objectName: 'ZC_TRAVEL_U', objectType: 'DDLS' });
    expect(client.getCdsElementInfo).toHaveBeenCalledWith({ objectName: 'ZC_TRAVEL_U', objectType: 'DDLS' });
  });

  it.each([
    ['objectType outside the DDLS allowlist', { objectName: 'ZC_TRAVEL_U', objectType: 'TABL' }],
    ['missing objectName', { objectType: 'DDLS' }],
    ['blank objectName', { objectName: '   ' }],
    ['objectName over 40 characters', { objectName: 'Z'.repeat(41) }],
    ['objectName with control characters', { objectName: 'ZC\tTRAVEL' }],
    ['non-string objectName', { objectName: 42 }]
  ])('rejects invalid input (%s) with InvalidParams', async (_label, args) => {
    const client = mockClient();
    const handlers = new CdsAnalysisHandlers(client);

    await expect(handlers.handle('getCdsDependencies', args as Record<string, unknown>))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 校验失败必须发生在进入底层客户端之前
    expect(client.getCdsDependencies).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    // 上游（客户端/低层）抛出的 MCP 语义错误必须原样透传，不得吞成 500
    const requestError = new McpError(ErrorCode.InvalidParams, 'query rejected');
    const client = mockClient();
    (client.getCdsDependencies as jest.Mock).mockRejectedValue(requestError);

    await expect(new CdsAnalysisHandlers(client).handle('getCdsDependencies', { objectName: 'ZC_X' }))
      .rejects.toBe(requestError);
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = mockClient();
    (client.getCdsImpactAnalysis as jest.Mock).mockRejectedValue(new Error('SECRET_REMOTE_BODY'));

    await expect(new CdsAnalysisHandlers(client).handle('getCdsImpactAnalysis', { objectName: 'ZC_X' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.not.stringContaining('SECRET_REMOTE_BODY')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new CdsAnalysisHandlers(mockClient());
    await expect(handlers.handle('getCdsSource', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
