export interface SourceCacheOptions {
  maxEntries: number;
  maxItemBytes: number;
  ttlMs: number;
  now?: () => number;
}

interface SourceCacheEntry {
  source: string;
  writtenAt: number;
}

export class SourceCache {
  private readonly entries = new Map<string, SourceCacheEntry>();
  private readonly now: () => number;

  constructor(private readonly options: SourceCacheOptions) {
    this.now = options.now || (() => Date.now());
  }

  set(url: string, source: string): boolean {
    if (!url || this.options.maxEntries === 0 || Buffer.byteLength(source, 'utf8') > this.options.maxItemBytes) {
      this.entries.delete(url);
      return false;
    }
    const timestamp = this.now();
    this.entries.delete(url);
    this.entries.set(url, { source, writtenAt: timestamp });
    this.evictLeastRecentlyUsed();
    return true;
  }

  get(url: string): string | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (this.now() - entry.writtenAt >= this.options.ttlMs) {
      this.entries.delete(url);
      return undefined;
    }
    // Map insertion order is monotonic even when multiple accesses share one millisecond.
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry.source;
  }

  has(url: string): boolean {
    return this.get(url) !== undefined;
  }

  delete(url: string): void {
    this.entries.delete(url);
  }

  clear(): void {
    this.entries.clear();
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }
}

let activeCache = new SourceCache({ maxEntries: 20, maxItemBytes: 2_097_152, ttlMs: 900_000 });

export const sourceCache = {
  configure(options: SourceCacheOptions): void { activeCache = new SourceCache(options); },
  set(url: string, source: string): boolean { return activeCache.set(url, source); },
  get(url: string): string | undefined { return activeCache.get(url); },
  has(url: string): boolean { return activeCache.has(url); },
  delete(url: string): void { activeCache.delete(url); },
  clear(): void { activeCache.clear(); }
};
