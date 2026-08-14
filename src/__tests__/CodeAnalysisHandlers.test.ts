import type { ADTClient } from '../adt/index.js';
import { CodeAnalysisHandlers } from '../handlers/CodeAnalysisHandlers';
import { sourceCache } from '../lib/sourceCache';

describe('CodeAnalysisHandlers source cache integration', () => {
  beforeEach(() => {
    sourceCache.configure({ maxEntries: 10, maxItemBytes: 1_000, ttlMs: 1_000 });
  });

  it('reuses cached source for syntaxCheckCode when code is omitted', async () => {
    const client = { syntaxCheck: jest.fn().mockResolvedValue([]) };
    sourceCache.set('/source', 'REPORT ztest.');
    const handlers = new CodeAnalysisHandlers(client as unknown as ADTClient);

    const result = await handlers.handleSyntaxCheckCode({ url: '/source' });

    expect(client.syntaxCheck).toHaveBeenCalledWith('/source', undefined, 'REPORT ztest.', undefined, undefined);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'success', usedCachedSource: true });
  });

  it('rejects omitted source when the cache has no entry', async () => {
    const client = { syntaxCheck: jest.fn() };
    const handlers = new CodeAnalysisHandlers(client as unknown as ADTClient);

    await expect(handlers.handleSyntaxCheckCode({ url: '/missing' })).rejects.toMatchObject({ code: -32602 });
    expect(client.syntaxCheck).not.toHaveBeenCalled();
  });

  it('maps type hierarchy and enhancement reads to their exact ADT calls', async () => {
    const client = {
      typeHierarchy: jest.fn().mockResolvedValue({ types: [] }),
      objectEnhancements: jest.fn().mockResolvedValue({ enhancements: [] })
    };
    const handlers = new CodeAnalysisHandlers(client as unknown as ADTClient);
    const tools = handlers.getTools().filter(tool => ['typeHierarchy', 'objectEnhancements'].includes(tool.name));

    expect(tools).toHaveLength(2);
    expect(tools.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    await handlers.handle('typeHierarchy', { url: '/source', body: 'CLASS zcl DEFINITION.', line: 2, offset: 7, superTypes: true });
    await handlers.handle('objectEnhancements', { sourceMainPath: '/source/main', contextUri: '/program', includeSource: true });

    expect(client.typeHierarchy).toHaveBeenCalledWith('/source', 'CLASS zcl DEFINITION.', 2, 7, true);
    expect(client.objectEnhancements).toHaveBeenCalledWith('/source/main', '/program', true);
  });
});
