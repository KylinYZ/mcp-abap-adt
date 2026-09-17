import { RevisionSourceHandlers } from '../handlers/RevisionSourceHandlers.js';
import type { RevisionSourceClient } from '../adt/RevisionSourceApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * RevisionSourceHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化、必填与白名单预检、错误语义与未知工具拒绝。
 */

function clientMock(): RevisionSourceClient {
  return {
    getRevisionSource: jest.fn(async () => ({
      objectType: 'CLAS' as const, objectName: 'ZCL_FOO', version: 'ACTIVE', source: 'SOURCE', lines: 1
    })),
    compareRevisions: jest.fn(async () => ({
      objectType: 'CLAS' as const, objectName: 'ZCL_FOO', label1: 'CLAS:ZCL_FOO@ACTIVE',
      label2: 'CLAS:ZCL_FOO@current', identical: false, diff: '@@ -1,1 +1,1 @@', addedLines: 1, removedLines: 1
    })),
    compareSourceObjects: jest.fn(async () => ({
      objectType1: 'PROG' as const, objectName1: 'ZP1', objectType2: 'PROG' as const, objectName2: 'ZP2',
      label1: 'PROG:ZP1', label2: 'PROG:ZP2', identical: false, diff: '@@ -1,1 +1,1 @@',
      addedLines: 1, removedLines: 1, lines1: 1, lines2: 1
    }))
  };
}

describe('RevisionSourceHandlers tool catalog', () => {
  it('publishes three uniquely named read-only tools', () => {
    const handlers = new RevisionSourceHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['getRevisionSource', 'compareRevisions', 'compareSourceObjects']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool names via supports()', () => {
    const handlers = new RevisionSourceHandlers(clientMock());
    expect(handlers.supports('getRevisionSource')).toBe(true);
    expect(handlers.supports('compareRevisions')).toBe(true);
    expect(handlers.supports('compareSourceObjects')).toBe(true);
    expect(handlers.supports('revisions')).toBe(false);
  });
});

describe('RevisionSourceHandlers dispatch and validation', () => {
  it('dispatches with normalized kind/name and clamped index', async () => {
    const client = clientMock();
    const handlers = new RevisionSourceHandlers(client);
    const result = await handlers.handle('getRevisionSource', { objectType: 'clas', objectName: ' zcl_foo ', index: 5 });
    expect(client.getRevisionSource).toHaveBeenCalledWith({ objectType: 'CLAS', objectName: 'ZCL_FOO', index: 5 });
    expect(result.structuredContent).toEqual({
      status: 'success',
      result: { objectType: 'CLAS', objectName: 'ZCL_FOO', version: 'ACTIVE', source: 'SOURCE', lines: 1 }
    });
  });

  it('passes version selectors through and omits absent fields', async () => {
    const client = clientMock();
    const handlers = new RevisionSourceHandlers(client);
    await handlers.handle('getRevisionSource', { objectType: 'PROG', objectName: 'ZPROG', version: ' ACTIVE ' });
    expect(client.getRevisionSource).toHaveBeenCalledWith({ objectType: 'PROG', objectName: 'ZPROG', version: 'ACTIVE' });
  });

  it('rejects bad objectType, names, and non-numeric index', async () => {
    const handlers = new RevisionSourceHandlers(clientMock());
    await expect(handlers.handle('getRevisionSource', { objectName: 'Z_FOO' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getRevisionSource', { objectType: 'XSLT', objectName: 'Z_FOO' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getRevisionSource', { objectType: 'CLAS', objectName: "A';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getRevisionSource', { objectType: 'CLAS', objectName: 'Z_FOO', index: 'one' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.getRevisionSource as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new RevisionSourceHandlers(client);
    await expect(handlers.handle('getRevisionSource', { objectType: 'CLAS', objectName: 'Z' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.getRevisionSource as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new RevisionSourceHandlers(client);
    await expect(handlers.handle('getRevisionSource', { objectType: 'CLAS', objectName: 'Z' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('getRevisionSource failed.')
      });
  });

  it('dispatches compareSourceObjects with normalized inputs and rejects missing fields', async () => {
    const client = clientMock();
    const handlers = new RevisionSourceHandlers(client);
    await handlers.handle('compareSourceObjects', {
      objectType1: 'prog', objectName1: ' zp1 ', objectType2: 'CLAS', objectName2: 'zcl_two'
    });
    expect(client.compareSourceObjects).toHaveBeenCalledWith({
      objectType1: 'PROG', objectName1: 'ZP1', objectType2: 'CLAS', objectName2: 'ZCL_TWO'
    });
    await expect(handlers.handle('compareSourceObjects', { objectType1: 'PROG', objectName1: 'ZP1', objectType2: 'PROG' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('compareSourceObjects', {
      objectType1: 'TABL', objectName1: 'Z1', objectType2: 'PROG', objectName2: 'Z2'
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new RevisionSourceHandlers(clientMock());
    await expect(handlers.handle('renumberRevisions', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('dispatches compareRevisions with version2 defaulting to current', async () => {
    const client = clientMock();
    const handlers = new RevisionSourceHandlers(client);
    await handlers.handle('compareRevisions', { objectType: 'CLAS', objectName: 'ZCL_FOO', version1: '1' });
    expect(client.compareRevisions).toHaveBeenCalledWith({
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: '1'
    });
    await handlers.handle('compareRevisions', {
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: 'ACTIVE', version2: 'current'
    });
    expect(client.compareRevisions).toHaveBeenLastCalledWith({
      objectType: 'CLAS', objectName: 'ZCL_FOO', version1: 'ACTIVE', version2: 'current'
    });
  });

  it('requires version1 for compareRevisions and rejects over-long selectors', async () => {
    const client = clientMock();
    const handlers = new RevisionSourceHandlers(client);
    await expect(handlers.handle('compareRevisions', { objectType: 'CLAS', objectName: 'ZCL_FOO' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('compareRevisions', { objectType: 'CLAS', objectName: 'ZCL_FOO', version1: 'x'.repeat(61) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('compareRevisions', { objectType: 'CLAS', objectName: 'ZCL_FOO', version1: '1', version2: 'x'.repeat(61) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(client.compareRevisions).not.toHaveBeenCalled();
  });
});
