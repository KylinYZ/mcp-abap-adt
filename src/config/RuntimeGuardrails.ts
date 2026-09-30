export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface RuntimeGuardrailValues {
  adtTimeoutMs: number;
  maxConcurrentTools: number;
  maxReadConcurrentTools: number;
  maxQueuedTools: number;
  queryDefaultRows: number;
  queryMaxRows: number;
  searchDefaultResults: number;
  searchMaxResults: number;
  maxArgumentBytes: number;
  maxResponseBytes: number;
  sourceCacheMaxEntries: number;
  sourceCacheMaxItemBytes: number;
  sourceCacheTtlMs: number;
  changePlanMaxEntries: number;
  rollbackFailedRetentionMs: number;
  logLevel: LogLevel;
}

type Environment = Record<string, string | undefined>;

function integer(environment: Environment, name: string, defaultValue: number, minimum: number, maximum: number): number {
  const raw = environment[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} received '${raw}'; expected an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export class RuntimeGuardrails {
  static fromEnvironment(environment: Environment = process.env): RuntimeGuardrailValues {
    const values: RuntimeGuardrailValues = {
      adtTimeoutMs: integer(environment, 'SAP_MCP_ADT_TIMEOUT_MS', 60_000, 5_000, 600_000),
      // 写槽并发：SAP 写路径（stateful 会话/锁链）必须串行，默认 1。
      maxConcurrentTools: integer(environment, 'SAP_MCP_MAX_CONCURRENT_TOOLS', 1, 1, 8),
      // 读槽并发：read-only 类工具走独立读域会话（永远 stateless），
      // 可安全并发。默认 2——零配置即获得"多个只读工具同时发"的收益
      //（此前全局串行门会把并行只读调用排队进各自的 30s 客户端计时，
      // 偶发慢请求即放大成双超时）。写槽语义不受本值影响。
      maxReadConcurrentTools: integer(environment, 'SAP_MCP_MAX_READ_CONCURRENT_TOOLS', 2, 1, 8),
      maxQueuedTools: integer(environment, 'SAP_MCP_MAX_QUEUED_TOOLS', 50, 0, 1_000),
      queryDefaultRows: integer(environment, 'SAP_MCP_QUERY_DEFAULT_ROWS', 200, 1, 100_000),
      queryMaxRows: integer(environment, 'SAP_MCP_QUERY_MAX_ROWS', 5_000, 1, 100_000),
      searchDefaultResults: integer(environment, 'SAP_MCP_SEARCH_DEFAULT_RESULTS', 50, 1, 10_000),
      searchMaxResults: integer(environment, 'SAP_MCP_SEARCH_MAX_RESULTS', 500, 1, 10_000),
      maxArgumentBytes: integer(environment, 'SAP_MCP_MAX_ARGUMENT_BYTES', 5_242_880, 65_536, 52_428_800),
      maxResponseBytes: integer(environment, 'SAP_MCP_MAX_RESPONSE_BYTES', 10_485_760, 1_048_576, 104_857_600),
      sourceCacheMaxEntries: integer(environment, 'SAP_MCP_SOURCE_CACHE_MAX_ENTRIES', 20, 0, 1_000),
      sourceCacheMaxItemBytes: integer(environment, 'SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES', 2_097_152, 65_536, 20_971_520),
      sourceCacheTtlMs: integer(environment, 'SAP_MCP_SOURCE_CACHE_TTL_SECONDS', 900, 60, 3_600) * 1_000,
      changePlanMaxEntries: integer(environment, 'SAP_MCP_CHANGE_PLAN_MAX_ENTRIES', 100, 1, 1_000),
      rollbackFailedRetentionMs: integer(environment, 'SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS', 86_400, 3_600, 604_800) * 1_000,
      logLevel: parseLogLevel(environment.SAP_MCP_LOG_LEVEL)
    };
    if (values.queryDefaultRows > values.queryMaxRows) {
      throw new Error('SAP_MCP_QUERY_DEFAULT_ROWS cannot exceed SAP_MCP_QUERY_MAX_ROWS.');
    }
    if (values.searchDefaultResults > values.searchMaxResults) {
      throw new Error('SAP_MCP_SEARCH_DEFAULT_RESULTS cannot exceed SAP_MCP_SEARCH_MAX_RESULTS.');
    }
    return values;
  }
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw || 'warn';
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') return value;
  throw new Error(`SAP_MCP_LOG_LEVEL received '${value}'; expected error, warn, info, or debug.`);
}
