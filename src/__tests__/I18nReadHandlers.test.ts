import { I18nReadHandlers } from '../handlers/I18nReadHandlers.js';
import type { I18nReadClient } from '../adt/I18nReadApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * I18nReadHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派与参数
 * 规范化（语言键/名字白名单/枚举）、错误脱敏与未知工具拒绝。
 */

function clientMock(): I18nReadClient {
  return {
    getObjectContentInLanguage: jest.fn(async () => ({ objectType: 'PROG' as const, objectName: 'ZP', language: 'EN', content: 'x', lines: 1 })),
    getDataElementLabels: jest.fn(async () => ({ dataElement: 'ZDE', language: 'EN', labels: { short: 's' } })),
    getTextPoolInLanguage: jest.fn(async () => ({ program: 'ZP', language: 'EN', entries: [], missing: [] })),
    compareObjectLanguages: jest.fn(async () => ({
      objectType: 'PROG' as const, objectName: 'ZP', sourceLanguage: 'EN', targetLanguage: 'DE', entries: [], totalLines: 1, differing: 0
    }))
  };
}

describe('I18nReadHandlers tool catalog', () => {
  it('publishes four uniquely named read-only tools', () => {
    const handlers = new I18nReadHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual([
      'getObjectContentInLanguage', 'getDataElementLabels', 'getTextPoolInLanguage', 'compareObjectLanguages'
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool names via supports()', () => {
    const handlers = new I18nReadHandlers(clientMock());
    expect(handlers.supports('getObjectContentInLanguage')).toBe(true);
    expect(handlers.supports('getDataElementLabels')).toBe(true);
    expect(handlers.supports('getTextPoolInLanguage')).toBe(true);
    expect(handlers.supports('compareObjectLanguages')).toBe(true);
    expect(handlers.supports('getMessages')).toBe(false);
  });
});

describe('I18nReadHandlers dispatch and validation', () => {
  it('dispatches with normalized kinds, names and language keys', async () => {
    const client = clientMock();
    const handlers = new I18nReadHandlers(client);
    await handlers.handle('getObjectContentInLanguage', { objectType: 'prog', objectName: ' zp ', language: 'en' });
    await handlers.handle('getDataElementLabels', { dataElement: ' zde ', language: 'de' });
    await handlers.handle('getTextPoolInLanguage', { program: ' zp ', language: 'EN' });
    await handlers.handle('compareObjectLanguages', {
      objectType: 'clas', objectName: 'zcl', sourceLanguage: 'en', targetLanguage: 'de'
    });
    expect(client.getObjectContentInLanguage).toHaveBeenCalledWith({ objectType: 'PROG', objectName: 'ZP', language: 'EN' });
    expect(client.getDataElementLabels).toHaveBeenCalledWith({ dataElement: 'ZDE', language: 'DE' });
    expect(client.getTextPoolInLanguage).toHaveBeenCalledWith({ program: 'ZP', language: 'EN' });
    expect(client.compareObjectLanguages).toHaveBeenCalledWith({
      objectType: 'CLAS', objectName: 'ZCL', sourceLanguage: 'EN', targetLanguage: 'DE'
    });
  });

  it('rejects bad kinds, names and language keys', async () => {
    const handlers = new I18nReadHandlers(clientMock());
    await expect(handlers.handle('getObjectContentInLanguage', { objectType: 'TABL', objectName: 'Z', language: 'EN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getObjectContentInLanguage', { objectType: 'PROG', objectName: "A';--", language: 'EN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getObjectContentInLanguage', { objectType: 'PROG', objectName: 'Z', language: 'CHN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getDataElementLabels', { dataElement: 'x'.repeat(31), language: 'EN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.getTextPoolInLanguage as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new I18nReadHandlers(client);
    await expect(handlers.handle('getTextPoolInLanguage', { program: 'Z', language: 'EN' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.compareObjectLanguages as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new I18nReadHandlers(client);
    await expect(handlers.handle('compareObjectLanguages', {
      objectType: 'PROG', objectName: 'Z', sourceLanguage: 'EN', targetLanguage: 'DE'
    })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('compareObjectLanguages failed.')
    });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new I18nReadHandlers(clientMock());
    await expect(handlers.handle('writeDataElementLabels', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
