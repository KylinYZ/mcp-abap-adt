import { BoundaryCheckHandlers } from '../handlers/BoundaryCheckHandlers.js';
import type { BoundaryCheckClient } from '../adt/BoundaryCheckApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * BoundaryCheckHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化（包名白名单/白名单数组/枚举/限额）、错误脱敏与未知工具拒绝。
 */

function clientMock(): BoundaryCheckClient {
  return {
    checkPackageBoundaries: jest.fn(async () => ({
      rootPackage: 'Z001', whitelist: [], analyzedObjects: 0, totalDeps: 0, entries: [],
      standard: 0, samePackage: 0, allowed: 0, violations: 0, dynamic: 0, unknown: 0,
      crossedPackages: {}, violatingObjects: [], notes: []
    }))
  };
}

describe('BoundaryCheckHandlers tool catalog', () => {
  it('publishes one uniquely named read-only tool', () => {
    const handlers = new BoundaryCheckHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['checkPackageBoundaries']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new BoundaryCheckHandlers(clientMock());
    expect(handlers.supports('checkPackageBoundaries')).toBe(true);
    expect(handlers.supports('grepPackage')).toBe(false);
  });
});

describe('BoundaryCheckHandlers dispatch and validation', () => {
  it('dispatches with normalized package name, whitelist and clamped limit', async () => {
    const client = clientMock();
    const handlers = new BoundaryCheckHandlers(client);
    const result = await handlers.handle('checkPackageBoundaries', {
      packageName: ' z001 ', whitelist: ['z*_common'], objectKinds: ['PROG', 'CLAS'], namePattern: 'zv', objectLimit: 9999
    });
    expect(client.checkPackageBoundaries).toHaveBeenCalledWith({
      packageName: 'Z001', whitelist: ['Z*_COMMON'], objectKinds: ['PROG', 'CLAS'], namePattern: 'ZV', objectLimit: 30
    });
    expect(result.structuredContent.status).toBe('success');
  });

  it('omits optional fields when absent', async () => {
    const client = clientMock();
    const handlers = new BoundaryCheckHandlers(client);
    await handlers.handle('checkPackageBoundaries', { packageName: 'Z001' });
    expect(client.checkPackageBoundaries).toHaveBeenCalledWith({ packageName: 'Z001' });
  });

  it('rejects bad package names, whitelist shapes, kinds and limits', async () => {
    const handlers = new BoundaryCheckHandlers(clientMock());
    await expect(handlers.handle('checkPackageBoundaries', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('checkPackageBoundaries', { packageName: "Z';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('checkPackageBoundaries', { packageName: 'Z001', whitelist: ['ok', 42] }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('checkPackageBoundaries', { packageName: 'Z001', objectKinds: ['TABL'] }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('checkPackageBoundaries', { packageName: 'Z001', objectLimit: 'ten' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.checkPackageBoundaries as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new BoundaryCheckHandlers(client);
    await expect(handlers.handle('checkPackageBoundaries', { packageName: 'Z001' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.checkPackageBoundaries as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new BoundaryCheckHandlers(client);
    await expect(handlers.handle('checkPackageBoundaries', { packageName: 'Z001' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('checkPackageBoundaries failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new BoundaryCheckHandlers(clientMock());
    await expect(handlers.handle('fixBoundaries', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
