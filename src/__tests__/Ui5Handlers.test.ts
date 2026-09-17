import { Ui5Handlers } from '../handlers/Ui5Handlers.js';
import type { Ui5FilestoreClient } from '../adt/Ui5FilestoreApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * Ui5Handlers 目录与分派契约测试（mock filestore 客户端，零 SAP 往返）。
 * 断言与 ContextAnalysisHandlers 测试同口径：
 *   1. 工具目录：三个只读工具、注解与 _meta 安全元数据正确；
 *   2. supports() 边界；
 *   3. 分派与参数规范化；
 *   4. 参数校验（appName/filePath 必填与上限）；
 *   5. 错误语义：MCP 错误透传、底层异常脱敏、未知工具拒绝。
 */

/** 构造 filestore 客户端 mock：jest.fn 记录每次调用与入参。 */
function clientMock(): Ui5FilestoreClient {
  const record = (result: unknown) => jest.fn(() => Promise.resolve(result as any));
  return {
    ui5ListApps: record({ apps: [{ name: 'ZAPP' }], feedEntries: 1, truncated: false, query: '' }),
    ui5GetApp: record({ appName: 'ZAPP', files: [], feedEntries: 0 }),
    ui5GetFileContent: record({ appName: 'ZAPP', filePath: 'a.html', content: 'x', size: 1 })
  };
}

describe('Ui5Handlers tool catalog', () => {
  it('publishes three uniquely named read-only tools', () => {
    const handlers = new Ui5Handlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['ui5ListApps', 'ui5GetApp', 'ui5GetFileContent']);
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
    const handlers = new Ui5Handlers(clientMock());
    expect(handlers.supports('ui5ListApps')).toBe(true);
    expect(handlers.supports('ui5GetApp')).toBe(true);
    expect(handlers.supports('ui5GetFileContent')).toBe(true);
    expect(handlers.supports('ui5UploadFile')).toBe(false);
    expect(handlers.supports('getCallees')).toBe(false);
  });
});

describe('Ui5Handlers dispatch and validation', () => {
  it('dispatches ui5ListApps with clamped maxResults and trimmed query', async () => {
    const client = clientMock();
    const handlers = new Ui5Handlers(client);
    const result = await handlers.handle('ui5ListApps', { query: ' Z* ', maxResults: 9999 });
    expect(client.ui5ListApps).toHaveBeenCalledWith({ query: 'Z*', maxResults: 500 });
    expect(result.structuredContent).toEqual({
      status: 'success',
      result: { apps: [{ name: 'ZAPP' }], feedEntries: 1, truncated: false, query: '' }
    });
  });

  it('omits optional fields when absent', async () => {
    const client = clientMock();
    const handlers = new Ui5Handlers(client);
    await handlers.handle('ui5ListApps', {});
    expect(client.ui5ListApps).toHaveBeenCalledWith({});
  });

  it('dispatches app/file reads with trimmed inputs', async () => {
    const client = clientMock();
    const handlers = new Ui5Handlers(client);
    await handlers.handle('ui5GetApp', { appName: ' zapp ' });
    await handlers.handle('ui5GetFileContent', { appName: 'zapp', filePath: ' /a/b.html ' });
    expect(client.ui5GetApp).toHaveBeenCalledWith({ appName: 'zapp' });
    expect(client.ui5GetFileContent).toHaveBeenCalledWith({ appName: 'zapp', filePath: '/a/b.html' });
  });

  it('rejects missing or over-long appName/filePath', async () => {
    const handlers = new Ui5Handlers(clientMock());
    await expect(handlers.handle('ui5GetApp', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5GetFileContent', { appName: 'Z' })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5GetFileContent', { filePath: 'a' })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5GetApp', { appName: 'x'.repeat(41) })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5GetFileContent', { appName: 'Z', filePath: 'x'.repeat(241) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5ListApps', { query: 'x'.repeat(61) })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects path traversal at the parameter layer as InvalidParams', async () => {
    const client = clientMock();
    const handlers = new Ui5Handlers(client);
    // 穿越与元字符是参数错误：InvalidParams 且零网络往返
    await expect(handlers.handle('ui5GetFileContent', { appName: 'ZAPP', filePath: '../../etc/passwd' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5GetFileContent', { appName: 'ZAPP', filePath: 'a?b=c' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('ui5GetFileContent', { appName: 'ZAPP', filePath: 'a\\b' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(client.ui5GetFileContent).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.ui5GetApp as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped error'));
    const handlers = new Ui5Handlers(client);
    await expect(handlers.handle('ui5GetApp', { appName: 'ZAPP' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped error') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.ui5ListApps as jest.Mock).mockRejectedValueOnce(new Error('https://secret-host/sap 403'));
    const handlers = new Ui5Handlers(client);
    await expect(handlers.handle('ui5ListApps', {}))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('ui5ListApps failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new Ui5Handlers(clientMock());
    await expect(handlers.handle('ui5CreateApp', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
