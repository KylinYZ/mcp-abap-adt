import type { ADTClient } from 'abap-adt-api';
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
});
