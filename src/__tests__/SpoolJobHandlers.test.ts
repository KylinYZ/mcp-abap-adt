import { SpoolJobHandlers } from '../handlers/SpoolJobHandlers.js';
import type { SpoolJobClient } from '../adt/SpoolJobApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * SpoolJobHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化、长度与类型预检、错误脱敏与未知工具拒绝。
 */

function clientMock(): SpoolJobClient {
  return {
    listSpoolRequests: jest.fn(async () => ({ requests: [], count: 0, notes: ['note'] })),
    listJobs: jest.fn(async () => ({ jobs: [], count: 0, notes: ['note'] })),
    readSpoolContent: jest.fn(async () => ({ request: { number: 1 }, contentType: 'LIST', text: 'ok' }))
  };
}

describe('SpoolJobHandlers tool catalog', () => {
  it('publishes three uniquely named read-only tools', () => {
    const handlers = new SpoolJobHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['listSpoolRequests', 'listJobs', 'readSpoolContent']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool names via supports()', () => {
    const handlers = new SpoolJobHandlers(clientMock());
    expect(handlers.supports('listSpoolRequests')).toBe(true);
    expect(handlers.supports('listJobs')).toBe(true);
    expect(handlers.supports('getDump')).toBe(false);
  });
});

describe('SpoolJobHandlers dispatch and validation', () => {
  it('dispatches with trimmed filters and clamped limit', async () => {
    const client = clientMock();
    const handlers = new SpoolJobHandlers(client);
    await handlers.handle('listSpoolRequests', { owner: ' devuser ', limit: 9999 });
    expect(client.listSpoolRequests).toHaveBeenCalledWith({ owner: 'DEVUSER', limit: 500 });
    await handlers.handle('listJobs', { name: 'N*', status: 'F,R', from: '2026-09-01' });
    expect(client.listJobs).toHaveBeenCalledWith({ name: 'N*', status: 'F,R', from: '2026-09-01' });
  });

  it('omits optional fields when absent', async () => {
    const client = clientMock();
    const handlers = new SpoolJobHandlers(client);
    await handlers.handle('listSpoolRequests', {});
    expect(client.listSpoolRequests).toHaveBeenCalledWith({});
  });

  it('rejects non-string filters and over-long values', async () => {
    const handlers = new SpoolJobHandlers(clientMock());
    await expect(handlers.handle('listSpoolRequests', { owner: 42 }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('listJobs', { name: 'x'.repeat(61) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('listJobs', { from: '2026-09-01T00:00' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('listSpoolRequests', { limit: 'ten' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects injection-style names at the parameter layer as InvalidParams', async () => {
    const client = clientMock();
    const handlers = new SpoolJobHandlers(client);
    await expect(handlers.handle('listJobs', { name: 'A\nDROP TABLE tbtco' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('listSpoolRequests', { owner: "A';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 零网络往返
    expect(client.listJobs).not.toHaveBeenCalled();
    expect(client.listSpoolRequests).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.listJobs as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new SpoolJobHandlers(client);
    await expect(handlers.handle('listJobs', {}))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.listSpoolRequests as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new SpoolJobHandlers(client);
    await expect(handlers.handle('listSpoolRequests', {}))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('listSpoolRequests failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new SpoolJobHandlers(clientMock());
    await expect(handlers.handle('readJobLog', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
