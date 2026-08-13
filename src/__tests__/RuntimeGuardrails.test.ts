import { RuntimeGuardrails } from '../config/RuntimeGuardrails';

describe('RuntimeGuardrails', () => {
  it('uses the approved defaults for an empty environment', () => {
    expect(RuntimeGuardrails.fromEnvironment({})).toEqual({
      adtTimeoutMs: 60_000,
      maxConcurrentTools: 1,
      maxQueuedTools: 50,
      queryDefaultRows: 200,
      queryMaxRows: 5_000,
      searchDefaultResults: 50,
      searchMaxResults: 500,
      maxResponseBytes: 10_485_760,
      sourceCacheMaxEntries: 20,
      sourceCacheMaxItemBytes: 2_097_152,
      sourceCacheTtlMs: 900_000,
      changePlanMaxEntries: 100,
      rollbackFailedRetentionMs: 86_400_000,
      logLevel: 'warn'
    });
  });

  it.each([
    ['SAP_MCP_ADT_TIMEOUT_MS', '5000', 5_000],
    ['SAP_MCP_ADT_TIMEOUT_MS', '600000', 600_000],
    ['SAP_MCP_MAX_CONCURRENT_TOOLS', '8', 8],
    ['SAP_MCP_MAX_QUEUED_TOOLS', '0', 0],
    ['SAP_MCP_SOURCE_CACHE_MAX_ENTRIES', '0', 0],
    ['SAP_MCP_SOURCE_CACHE_TTL_SECONDS', '3600', 3_600_000]
  ])('accepts %s=%s', (name, value, expected) => {
    const parsed = RuntimeGuardrails.fromEnvironment({ [name]: value });
    expect(Object.values(parsed)).toContain(expected);
  });

  it.each(['abc', '1.5', 'Infinity', '0', '-1'])('rejects invalid integer %s', value => {
    expect(() => RuntimeGuardrails.fromEnvironment({ SAP_MCP_QUERY_MAX_ROWS: value }))
      .toThrow('SAP_MCP_QUERY_MAX_ROWS');
  });

  it('rejects defaults above their maximums', () => {
    expect(() => RuntimeGuardrails.fromEnvironment({
      SAP_MCP_QUERY_DEFAULT_ROWS: '501', SAP_MCP_QUERY_MAX_ROWS: '500'
    })).toThrow('SAP_MCP_QUERY_DEFAULT_ROWS');
    expect(() => RuntimeGuardrails.fromEnvironment({
      SAP_MCP_SEARCH_DEFAULT_RESULTS: '51', SAP_MCP_SEARCH_MAX_RESULTS: '50'
    })).toThrow('SAP_MCP_SEARCH_DEFAULT_RESULTS');
  });

  it.each(['error', 'warn', 'info', 'debug'] as const)('accepts log level %s', logLevel => {
    expect(RuntimeGuardrails.fromEnvironment({ SAP_MCP_LOG_LEVEL: logLevel }).logLevel).toBe(logLevel);
  });

  it('rejects unsupported log levels', () => {
    expect(() => RuntimeGuardrails.fromEnvironment({ SAP_MCP_LOG_LEVEL: 'trace' })).toThrow('SAP_MCP_LOG_LEVEL');
  });
});
