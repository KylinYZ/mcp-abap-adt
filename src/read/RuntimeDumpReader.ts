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
    const query = buildRuntimeDumpQuery(input);
    const feed = await this.client.dumps(query);
    const summaries = feed.dumps.slice(0, limit).map(toSummary);
    return {
      feedUpdated: feed.updated,
      returnedCount: summaries.length,
      feedCount: feed.dumps.length,
      truncated: feed.dumps.length > summaries.length,
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

  const predicates = [
    `and ( between ( datetime , ${from.compactLocal} , ${to.compactLocal} ) )`
  ];
  addFilter(predicates, 'user', input.user, 'equals', 40);
  addFilter(predicates, 'objectName', input.objectName, 'contains', 128);
  addFilter(predicates, 'runtimeError', input.runtimeError, 'contains', 128);
  addFilter(predicates, 'exception', input.exception, 'contains', 128);
  return predicates.join(' ');
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

function addFilter(
  predicates: string[],
  field: 'user' | 'objectName' | 'runtimeError' | 'exception',
  value: unknown,
  operator: 'equals' | 'contains',
  maximumLength: number
): void {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new McpError(ErrorCode.InvalidParams, `${field} must be a string.`);
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > maximumLength || !SAFE_FILTER_VALUE.test(normalized)) {
    throw new McpError(ErrorCode.InvalidParams, `${field} contains unsupported characters or exceeds ${maximumLength} characters.`);
  }
  predicates.push(`and ( ${operator} ( ${field} , ${normalized} ) )`);
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
