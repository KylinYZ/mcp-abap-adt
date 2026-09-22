import type { ADTClient, Dump } from '../adt/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUMMARY_LENGTH = 500;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SAFE_FILTER_VALUE = /^[A-Za-z0-9_/$@.+\-]+$/;

export interface RuntimeDumpInput {
  from: string;
  to: string;
  limit?: number;
  user?: string;
  objectName?: string;
  runtimeError?: string;
  exception?: string;
}

export interface RuntimeDumpSummary {
  id: string;
  author?: string;
  categories: Array<{ term: string; label: string }>;
  text: string;
  type: string;
  published?: Date;
  updated?: Date;
}

interface ParsedSapTimestamp {
  instant: number;
  offset: string;
  compactLocal: string;
}

export class RuntimeDumpReader {
  constructor(private readonly client: Pick<ADTClient, 'dumps'>) {}

  async read(input: RuntimeDumpInput): Promise<{
    feedUpdated: Date;
    returnedCount: number;
    feedCount: number;
    truncated: boolean;
    dumps: RuntimeDumpSummary[];
  }> {
    const limit = validateLimit(input.limit);
    // 服务端查询只带时间窗；其余过滤在客户端（先取窗口内最新 limit 条再筛，
    // 读取量有界；窗口内更早的匹配项不回溯——limit 语义即读取预算）
    const query = buildRuntimeDumpQuery(input);
    const feed = await this.client.dumps(query);
    const summaries = feed.dumps
      .slice(0, limit)
      .map(toSummary)
      .filter(summary => matchesClientFilters(summary, input));
    return {
      feedUpdated: feed.updated,
      returnedCount: summaries.length,
      feedCount: feed.dumps.length,
      truncated: feed.dumps.length > limit,
      dumps: summaries
    };
  }
}

export function buildRuntimeDumpQuery(input: RuntimeDumpInput): string {
  const from = parseSapTimestamp(input.from, 'from');
  const to = parseSapTimestamp(input.to, 'to');
  if (from.offset !== to.offset) {
    throw new McpError(ErrorCode.InvalidParams, 'from and to must use the same time-zone offset.');
  }
  if (to.instant <= from.instant) {
    throw new McpError(ErrorCode.InvalidParams, 'Runtime dump time window must be non-empty and ordered from earliest to latest.');
  }
  if (to.instant - from.instant > MAX_WINDOW_MS) {
    throw new McpError(ErrorCode.InvalidParams, 'Runtime dump time window cannot exceed seven days.');
  }

  // 服务端只接受时间窗谓词（对齐 VSP Dumps 的 from/to 口径）。user/objectName/
  // runtimeError/exception 的 search 谓词在该 ADT feed 协议下不被支持
  //（真机 2026-09-16 实测带 runtimeError 即 InternalError），改由 read() 在
  // 客户端过滤——过滤语义保持既有工具契约不变。
  return `and ( between ( datetime , ${from.compactLocal} , ${to.compactLocal} ) )`;
}

/**
 * 客户端过滤（对齐 VSP DumpFilter.matches 的大小写不敏感语义；objectName/
 * runtimeError/exception 保持本项目既有的 contains 契约）。
 */
function matchesClientFilters(summary: RuntimeDumpSummary, input: RuntimeDumpInput): boolean {
  const eq = (want: string | undefined, got: string | undefined) =>
    want === undefined || want.trim().toUpperCase() === (got ?? '').trim().toUpperCase();
  const contains = (want: string | undefined, got: string | undefined) =>
    want === undefined || (got ?? '').toUpperCase().includes(want.trim().toUpperCase());
  const errorType = summary.categories.find(c => c.label === 'ABAP runtime error')?.term ?? '';
  const program = summary.categories.find(c => c.label === 'Terminated ABAP program')?.term ?? '';
  return (
    eq(input.user, summary.author)
    && contains(input.objectName, program)
    && contains(input.runtimeError, errorType)
    && contains(input.exception, errorType)
  );
}

function parseSapTimestamp(value: unknown, field: 'from' | 'to'): ParsedSapTimestamp {
  if (typeof value !== 'string') throw new McpError(ErrorCode.InvalidParams, `${field} must be an ISO-8601 timestamp with an explicit offset.`);
  const match = ISO_WITH_OFFSET.exec(value);
  const instant = Date.parse(value);
  if (!match || !Number.isFinite(instant)) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be an ISO-8601 timestamp with an explicit offset.`);
  }
  return {
    instant,
    offset: match[7],
    // ST22 consumes the target system's local wall-clock fields, not a caller-supplied raw query.
    compactLocal: match.slice(1, 7).join('')
  };
}

function validateLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIMIT : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new McpError(ErrorCode.InvalidParams, 'limit must be an integer between 1 and 50.');
  }
  return limit;
}

function toSummary(dump: Dump): RuntimeDumpSummary {
  return {
    id: dump.id,
    author: dump.author,
    categories: dump.categories.map(category => ({ term: category.term, label: category.label })),
    text: dump.text.length > MAX_SUMMARY_LENGTH ? `${dump.text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : dump.text,
    type: dump.type,
    published: dump.published,
    updated: dump.updated
  };
}
