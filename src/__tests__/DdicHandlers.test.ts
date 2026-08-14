import type { ADTClient } from '../adt/index.js';
import { DdicHandlers } from '../handlers/DdicHandlers';

describe('DdicHandlers raw ADT additions', () => {
  const readTools = ['getDomainProperties', 'getDataElementProperties', 'getTextElements'];
  const writeTools = ['setDomainProperties', 'setDataElementProperties', 'setTextElements'];

  it('publishes explicit read and high-risk write metadata', () => {
    const handlers = new DdicHandlers({} as ADTClient);
    const tools = handlers.getTools().filter(tool => [...readTools, ...writeTools].includes(tool.name));

    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required?.length).toBeGreaterThan(0);
      expect(tool._meta?.approvalRequired).toBe(false);
    }
    expect(tools.filter(tool => readTools.includes(tool.name)).every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.filter(tool => writeTools.includes(tool.name)).every(tool => (
      tool.annotations?.readOnlyHint === false
      && tool.annotations.destructiveHint === true
      && tool.annotations.idempotentHint === false
    ))).toBe(true);
  });

  it('passes each DDIC and text operation in the client signature order', async () => {
    const client = Object.fromEntries([...readTools, ...writeTools].map(name => [name, jest.fn().mockResolvedValue({ name })]));
    const handlers = new DdicHandlers(client as unknown as ADTClient);
    const properties = { value: 1 };
    const metaData = { name: 'ZDEMO' };
    const elements = [{ id: '001', text: 'Demo' }];

    await handlers.handle('getDomainProperties', { domainUrl: '/domain', version: 'active' });
    await handlers.handle('setDomainProperties', { domainUrl: '/domain', properties, metaData, lockHandle: 'lock-1', transport: 'DEVK900001' });
    await handlers.handle('getDataElementProperties', { dataElementUrl: '/data-element', version: 'inactive' });
    await handlers.handle('setDataElementProperties', { dataElementUrl: '/data-element', properties, metaData, lockHandle: 'lock-2', transport: 'DEVK900002' });
    await handlers.handle('getTextElements', { url: '/texts', category: 'symbols' });
    await handlers.handle('setTextElements', { url: '/texts', category: 'symbols', elements, lockHandle: 'lock-3', transport: 'DEVK900003' });

    expect(client.getDomainProperties).toHaveBeenCalledWith('/domain', 'active');
    expect(client.setDomainProperties).toHaveBeenCalledWith('/domain', properties, metaData, 'lock-1', 'DEVK900001');
    expect(client.getDataElementProperties).toHaveBeenCalledWith('/data-element', 'inactive');
    expect(client.setDataElementProperties).toHaveBeenCalledWith('/data-element', properties, metaData, 'lock-2', 'DEVK900002');
    expect(client.getTextElements).toHaveBeenCalledWith('/texts', 'symbols');
    expect(client.setTextElements).toHaveBeenCalledWith('/texts', 'symbols', elements, 'lock-3', 'DEVK900003');
    for (const call of Object.values(client)) expect(call).toHaveBeenCalledTimes(1);
  });

  it('sanitizes raw ADT errors instead of exposing headers or credentials', async () => {
    const secret = 'Basic user:password';
    const client = {
      getDomainProperties: jest.fn().mockRejectedValue({
        message: secret,
        response: { headers: { authorization: secret, cookie: 'SESSION=secret' } }
      })
    };
    const handlers = new DdicHandlers(client as unknown as ADTClient);

    await expect(handlers.handle('getDomainProperties', { domainUrl: '/domain' })).rejects.toMatchObject({
      message: expect.stringContaining('Domain property read failed.')
    });
    await expect(handlers.handle('getDomainProperties', { domainUrl: '/domain' })).rejects.not.toThrow(secret);
  });
});
