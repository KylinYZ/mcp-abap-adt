import { TransactionReadHandlers } from '../handlers/TransactionReadHandlers.js';
import type { TransactionReadClient } from '../adt/TransactionReadApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * TransactionReadHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化、"事务码不存在"InvalidParams 透出、错误脱敏与未知工具拒绝。
 */

function clientMock(): TransactionReadClient {
  return {
    getTransaction: jest.fn(async () => ({
      transaction: 'SE38', description: 'ABAP Editor', program: 'SAPMS38M', language: 'EN'
    }))
  };
}

describe('TransactionReadHandlers tool catalog', () => {
  it('publishes one uniquely named read-only tool', () => {
    const handlers = new TransactionReadHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['getTransaction']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new TransactionReadHandlers(clientMock());
    expect(handlers.supports('getTransaction')).toBe(true);
    expect(handlers.supports('createTransaction')).toBe(false);
  });
});

describe('TransactionReadHandlers dispatch and validation', () => {
  it('dispatches with trimmed transaction and optional language', async () => {
    const client = clientMock();
    const handlers = new TransactionReadHandlers(client);
    const result = await handlers.handle('getTransaction', { transaction: ' se38 ', language: 'de' });
    expect(client.getTransaction).toHaveBeenCalledWith({ transaction: 'se38', language: 'de' });
    expect(result.structuredContent.status).toBe('success');
  });

  it('rejects missing/over-long transaction and malformed language', async () => {
    const handlers = new TransactionReadHandlers(clientMock());
    await expect(handlers.handle('getTransaction', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getTransaction', { transaction: 'x'.repeat(21) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getTransaction', { transaction: "Z';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getTransaction', { transaction: 'SE38', language: 'CHN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.getTransaction as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new TransactionReadHandlers(client);
    await expect(handlers.handle('getTransaction', { transaction: 'SE38' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.getTransaction as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new TransactionReadHandlers(client);
    await expect(handlers.handle('getTransaction', { transaction: 'SE38' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('getTransaction failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new TransactionReadHandlers(clientMock());
    await expect(handlers.handle('runTransaction', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
