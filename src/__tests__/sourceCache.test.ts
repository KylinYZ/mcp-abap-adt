import { SourceCache } from '../lib/sourceCache';

describe('SourceCache', () => {
  let now = 0;
  const createCache = (overrides: Partial<ConstructorParameters<typeof SourceCache>[0]> = {}) =>
    new SourceCache({ maxEntries: 2, maxItemBytes: 10, ttlMs: 100, now: () => now, ...overrides });

  it('stores and retrieves source', () => {
    const cache = createCache(); cache.set('/a', 'source'); expect(cache.get('/a')).toBe('source');
  });

  it('deletes expired entries', () => {
    const cache = createCache(); cache.set('/a', 'source'); now = 100;
    expect(cache.get('/a')).toBeUndefined(); expect(cache.has('/a')).toBe(false);
  });

  it('updates LRU order on get', () => {
    const cache = createCache(); cache.set('/a', 'a'); now++; cache.set('/b', 'b'); now++; cache.get('/a'); now++; cache.set('/c', 'c');
    expect(cache.get('/a')).toBe('a'); expect(cache.get('/b')).toBeUndefined(); expect(cache.get('/c')).toBe('c');
  });

  it('updates LRU order on get even when time does not advance', () => {
    const cache = createCache();
    cache.set('/a', 'a');
    cache.set('/b', 'b');

    cache.get('/a');
    cache.set('/c', 'c');

    expect(cache.get('/a')).toBe('a');
    expect(cache.get('/b')).toBeUndefined();
    expect(cache.get('/c')).toBe('c');
  });

  it('does not cache oversized UTF-8 source', () => {
    const cache = createCache({ maxItemBytes: 3 });
    expect(cache.set('/a', '中文')).toBe(false); expect(cache.get('/a')).toBeUndefined();
  });

  it('can be disabled and cleared', () => {
    const disabled = createCache({ maxEntries: 0 });
    expect(disabled.set('/a', 'a')).toBe(false);
    const cache = createCache(); cache.set('/a', 'a'); cache.clear(); expect(cache.get('/a')).toBeUndefined();
  });

  it('supports explicit deletion', () => {
    const cache = createCache(); cache.set('/a', 'a'); cache.delete('/a'); expect(cache.has('/a')).toBe(false);
  });
});
