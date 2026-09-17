import { MessageClassReadHandlers } from '../handlers/MessageClassReadHandlers.js';
import type { MessageClassReadClient } from '../adt/MessageClassReadApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * MessageClassReadHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化、必填与长度预检、错误脱敏与未知工具拒绝。
 */

function clientMock(): MessageClassReadClient {
  return {
    getMessages: jest.fn(async () => ({
      messageClass: 'ZMC_TEST', messages: [{ number: '001', text: 'hi' }], count: 1
    }))
  };
}

describe('MessageClassReadHandlers tool catalog', () => {
  it('publishes one uniquely named read-only tool', () => {
    const handlers = new MessageClassReadHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['getMessages']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new MessageClassReadHandlers(clientMock());
    expect(handlers.supports('getMessages')).toBe(true);
    expect(handlers.supports('getCdsDependencies')).toBe(false);
  });
});

describe('MessageClassReadHandlers dispatch and validation', () => {
  it('dispatches with trimmed inputs and omits absent language', async () => {
    const client = clientMock();
    const handlers = new MessageClassReadHandlers(client);
    const result = await handlers.handle('getMessages', { messageClass: ' zmc_test ' });
    expect(client.getMessages).toHaveBeenCalledWith({ messageClass: 'zmc_test' });
    expect(result.structuredContent).toEqual({
      status: 'success',
      result: { messageClass: 'ZMC_TEST', messages: [{ number: '001', text: 'hi' }], count: 1 }
    });
  });

  it('passes the language override through', async () => {
    const client = clientMock();
    const handlers = new MessageClassReadHandlers(client);
    await handlers.handle('getMessages', { messageClass: 'ZMC_TEST', language: 'de' });
    expect(client.getMessages).toHaveBeenCalledWith({ messageClass: 'ZMC_TEST', language: 'de' });
  });

  it('rejects missing or over-long messageClass and malformed language', async () => {
    const handlers = new MessageClassReadHandlers(clientMock());
    await expect(handlers.handle('getMessages', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getMessages', { messageClass: 'x'.repeat(21) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getMessages', { messageClass: 'Z', language: 'CHN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects injection-style names at the parameter layer as InvalidParams', async () => {
    const client = clientMock();
    const handlers = new MessageClassReadHandlers(client);
    await expect(handlers.handle('getMessages', { messageClass: "A';--" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getMessages', { messageClass: 'A/B/C' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 零网络往返
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.getMessages as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new MessageClassReadHandlers(client);
    await expect(handlers.handle('getMessages', { messageClass: 'ZMC' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.getMessages as jest.Mock).mockRejectedValueOnce(new Error('secret-host 404'));
    const handlers = new MessageClassReadHandlers(client);
    await expect(handlers.handle('getMessages', { messageClass: 'ZMC' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('getMessages failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new MessageClassReadHandlers(clientMock());
    await expect(handlers.handle('putMessages', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
