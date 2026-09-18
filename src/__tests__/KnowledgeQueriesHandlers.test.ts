import { KnowledgeQueriesHandlers } from '../handlers/KnowledgeQueriesHandlers.js';
import type { KnowledgeQueriesClient } from '../adt/KnowledgeQueriesApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * KnowledgeQueriesHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化、错误脱敏与未知工具拒绝。
 */

function clientMock(): KnowledgeQueriesClient {
  return {
    getAbapDocumentation: jest.fn(async () => ({
      docClass: 'DE' as const, docObject: 'ZDE', language: 'EN', mode: 'content' as const, version: 1, lines: [], notes: []
    })),
    searchImgActivities: jest.fn(async () => ({
      text: 'x', language: 'EN', nodes: [], count: 0, notes: []
    })),
    getImgActivity: jest.fn(async () => ({
      activity: 'X1', language: 'EN', paths: [], notes: []
    }))
  };
}

describe('KnowledgeQueriesHandlers tool catalog', () => {
  it('publishes three uniquely named read-only tools', () => {
    const handlers = new KnowledgeQueriesHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['getAbapDocumentation', 'searchImgActivities', 'getImgActivity']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool names via supports()', () => {
    const handlers = new KnowledgeQueriesHandlers(clientMock());
    expect(handlers.supports('getAbapDocumentation')).toBe(true);
    expect(handlers.supports('searchImgActivities')).toBe(true);
    expect(handlers.supports('getImgActivity')).toBe(true);
    expect(handlers.supports('getMessages')).toBe(false);
  });
});

describe('KnowledgeQueriesHandlers dispatch and validation', () => {
  it('dispatches with normalized inputs', async () => {
    const client = clientMock();
    const handlers = new KnowledgeQueriesHandlers(client);
    await handlers.handle('getAbapDocumentation', {
      docClass: ' de ', docObject: ' zde ', language: 'en', mode: 'index', maxLines: 10
    });
    expect(client.getAbapDocumentation).toHaveBeenCalledWith({
      docClass: 'DE', docObject: 'ZDE', language: 'EN', mode: 'index', maxLines: 10
    });
    await handlers.handle('searchImgActivities', { text: ' anlage ', language: 'de', limit: 9999 });
    expect(client.searchImgActivities).toHaveBeenCalledWith({ text: 'anlage', language: 'DE', limit: 100 });
    await handlers.handle('getImgActivity', { activity: ' apoc_c_formv ', language: 'en', maxRefs: 5 });
    expect(client.getImgActivity).toHaveBeenCalledWith({ activity: 'APOC_C_FORMV', language: 'EN', maxRefs: 5 });
  });

  it('rejects missing/over-long docClass/docObject/text/activity and bad mode', async () => {
    const handlers = new KnowledgeQueriesHandlers(clientMock());
    await expect(handlers.handle('getAbapDocumentation', { docObject: 'ZDE' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getAbapDocumentation', { docClass: 'TOOLONG', docObject: 'ZDE' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getAbapDocumentation', { docClass: 'DE', docObject: "Z';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getAbapDocumentation', { docClass: 'DE', docObject: 'ZDE', mode: 'both' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('searchImgActivities', {}))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('searchImgActivities', { text: 'x'.repeat(61) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getImgActivity', {}))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getImgActivity', { activity: "Z';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.searchImgActivities as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new KnowledgeQueriesHandlers(client);
    await expect(handlers.handle('searchImgActivities', { text: 'x' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.getAbapDocumentation as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new KnowledgeQueriesHandlers(client);
    await expect(handlers.handle('getAbapDocumentation', { docClass: 'DE', docObject: 'ZDE' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('getAbapDocumentation failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new KnowledgeQueriesHandlers(clientMock());
    await expect(handlers.handle('getFmTestData', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
