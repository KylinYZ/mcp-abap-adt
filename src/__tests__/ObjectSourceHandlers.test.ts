import type { ADTClient } from '../adt/index.js';
import { ObjectSourceHandlers } from '../handlers/ObjectSourceHandlers';
import { sourceCache } from '../lib/sourceCache';

describe('ObjectSourceHandlers', () => {
  const client = {
    getObjectSource: jest.fn(), setObjectSource: jest.fn(), stateful: undefined
  };
  const handler = new ObjectSourceHandlers(client as unknown as ADTClient);

  beforeEach(() => {
    jest.clearAllMocks();
    sourceCache.configure({ maxEntries: 10, maxItemBytes: 1000, ttlMs: 1000 });
  });

  it('serves paged cache hits without calling SAP', async () => {
    sourceCache.set('/source', 'one\ntwo\nthree');
    const response = await handler.handleGetObjectSource({ objectSourceUrl: '/source', startLine: 2, maxLines: 1 });
    expect(client.getObjectSource).not.toHaveBeenCalled();
    expect(JSON.parse(response.content[0].text)).toMatchObject({ source: 'two', sourceOrigin: 'cache', returnedLines: 1 });
  });

  it('reads SAP on paged cache misses and caches the source', async () => {
    client.getObjectSource.mockResolvedValue('one\ntwo');
    const response = await handler.handleGetObjectSource({ objectSourceUrl: '/source', maxLines: 1 });
    expect(client.getObjectSource).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ source: 'one', sourceOrigin: 'sap' });
    expect(sourceCache.get('/source')).toBe('one\ntwo');
  });

  it('always refreshes full reads from SAP', async () => {
    sourceCache.set('/source', 'stale'); client.getObjectSource.mockResolvedValue('fresh');
    const response = await handler.handleGetObjectSource({ objectSourceUrl: '/source' });
    expect(client.getObjectSource).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ source: 'fresh', sourceOrigin: 'sap' });
  });

  it('returns zero lines when startLine exceeds the source', async () => {
    sourceCache.set('/source', 'one');
    const response = await handler.handleGetObjectSource({ objectSourceUrl: '/source', startLine: 10, maxLines: 2 });
    expect(JSON.parse(response.content[0].text)).toMatchObject({ source: '', returnedLines: 0, hasMore: false });
  });

  it('updates cache after a successful write', async () => {
    client.setObjectSource.mockResolvedValue(undefined);
    await handler.handleSetObjectSource({ objectSourceUrl: '/source', source: 'new', lockHandle: 'lock' });
    expect(sourceCache.get('/source')).toBe('new');
  });
});
