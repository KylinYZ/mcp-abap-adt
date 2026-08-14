import type { ADTClient } from '../adt/index.js';
import { RapGeneratorHandlers } from '../handlers/RapGeneratorHandlers';

describe('RapGeneratorHandlers', () => {
  const methodNames = [
    'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent', 'rapGenGetUiConfig',
    'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable', 'rapGenGenerate',
    'rapGenPublishService'
  ] as const;

  it('publishes nine unique, bounded tools with accurate operation metadata', () => {
    const handlers = new RapGeneratorHandlers({} as ADTClient);
    const tools = handlers.getTools();

    expect(tools.map(tool => tool.name)).toEqual(methodNames);
    expect(new Set(tools.map(tool => tool.name))).toHaveProperty('size', 9);
    expect(tools.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(tools.every(tool => (tool.inputSchema.required?.length ?? 0) > 0 || tool.name === 'rapGenIsAvailable')).toBe(true);
    expect(tools.filter(tool => !['rapGenGenerate', 'rapGenPublishService'].includes(tool.name))
      .every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.filter(tool => ['rapGenGenerate', 'rapGenPublishService'].includes(tool.name))
      .every(tool => tool.annotations?.destructiveHint === true && tool.annotations?.idempotentHint === false)).toBe(true);
  });

  it('maps all nine tools to exactly one matching ADT method', async () => {
    const client = Object.fromEntries(methodNames.map(name => [name, jest.fn().mockResolvedValue({ name })]));
    const handlers = new RapGeneratorHandlers(client as unknown as ADTClient);
    const content = { general: { description: 'Demo' } };

    await handlers.handle('rapGenValidateInitial', { genId: 'uiservice', refObjectUri: '/ref', packageName: 'ZPKG', checks: ['AUTH'] });
    await handlers.handle('rapGenGetSchema', { genId: 'uiservice', refObjectUri: '/ref', packageName: 'ZPKG' });
    await handlers.handle('rapGenGetContent', { genId: 'uiservice', refObjectUri: '/ref', packageName: 'ZPKG' });
    await handlers.handle('rapGenGetUiConfig', { genId: 'uiservice', refObjectUri: '/ref', packageName: 'ZPKG' });
    await handlers.handle('rapGenValidateContent', { genId: 'uiservice', refObjectUri: '/ref', content });
    await handlers.handle('rapGenPreview', { genId: 'uiservice', refObjectUri: '/ref', content });

    expect(client.rapGenGenerate).not.toHaveBeenCalled();
    expect(client.rapGenPublishService).not.toHaveBeenCalled();
    await handlers.handle('rapGenGenerate', { genId: 'uiservice', refObjectUri: '/ref', transport: 'DEVK900001', content });
    await handlers.handle('rapGenIsAvailable', { genId: 'uiservice' });
    await handlers.handle('rapGenPublishService', { srvbName: 'ZUI_DEMO' });

    expect(client.rapGenValidateInitial).toHaveBeenCalledWith('uiservice', '/ref', 'ZPKG', ['AUTH']);
    expect(client.rapGenGetSchema).toHaveBeenCalledWith('uiservice', '/ref', 'ZPKG');
    expect(client.rapGenGetContent).toHaveBeenCalledWith('uiservice', '/ref', 'ZPKG');
    expect(client.rapGenGetUiConfig).toHaveBeenCalledWith('uiservice', '/ref', 'ZPKG');
    expect(client.rapGenValidateContent).toHaveBeenCalledWith('uiservice', '/ref', content);
    expect(client.rapGenPreview).toHaveBeenCalledWith('uiservice', '/ref', content);
    expect(client.rapGenGenerate).toHaveBeenCalledWith('uiservice', '/ref', 'DEVK900001', content);
    expect(client.rapGenIsAvailable).toHaveBeenCalledWith('uiservice');
    expect(client.rapGenPublishService).toHaveBeenCalledWith('ZUI_DEMO');
    for (const call of Object.values(client)) expect(call).toHaveBeenCalledTimes(1);
  });
});
