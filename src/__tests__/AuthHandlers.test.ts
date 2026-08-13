import type { ADTClient } from 'abap-adt-api';
import { AuthHandlers } from '../handlers/AuthHandlers';
import { sourceCache } from '../lib/sourceCache';

describe('AuthHandlers source cache lifecycle', () => {
  beforeEach(() => {
    sourceCache.configure({ maxEntries: 10, maxItemBytes: 1_000, ttlMs: 1_000 });
  });

  it.each(['logout', 'dropSession'] as const)('clears cached source after successful %s', async toolName => {
    const client = {
      logout: jest.fn().mockResolvedValue(undefined),
      dropSession: jest.fn().mockResolvedValue(undefined)
    };
    sourceCache.set('/source', 'REPORT ztest.');
    const handlers = new AuthHandlers(client as unknown as ADTClient);

    await handlers.handle(toolName, {});

    expect(sourceCache.get('/source')).toBeUndefined();
  });

  it('retains cached source when logout fails', async () => {
    const client = {
      logout: jest.fn().mockRejectedValue(new Error('SAP unavailable')),
      dropSession: jest.fn()
    };
    sourceCache.set('/source', 'REPORT ztest.');
    const handlers = new AuthHandlers(client as unknown as ADTClient);

    await expect(handlers.handle('logout', {})).rejects.toThrow('Logout failed');

    expect(sourceCache.get('/source')).toBe('REPORT ztest.');
  });
});
