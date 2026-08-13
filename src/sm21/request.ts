import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Sm21ReadRequest, Sm21RuntimeConfig, Sm21Severity } from './types.js';

const MAX_FILTER_VALUES = 20;

export function parseSm21Request(argumentsValue: Record<string, unknown>, config: Sm21RuntimeConfig): Sm21ReadRequest {
  const from = parseDateTime(argumentsValue.fromDateTime, 'fromDateTime');
  const to = parseDateTime(argumentsValue.toDateTime, 'toDateTime');
  const windowMs = to.getTime() - from.getTime();
  if (windowMs < 0 || windowMs > config.maxWindowHours * 60 * 60 * 1000) {
    throw new McpError(ErrorCode.InvalidParams, `SM21 time range must be between 0 and ${config.maxWindowHours} hours.`);
  }

  const pageSize = parseInteger(argumentsValue.pageSize, 'pageSize', config.defaultPageSize, 1, config.maxPageSize);
  const offset = parseInteger(argumentsValue.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    from: sapTimestamp(from, config.timeZone),
    to: sapTimestamp(to, config.timeZone),
    instances: parseStringList(argumentsValue.instances, 'instances'),
    users: parseStringList(argumentsValue.users, 'users'),
    programs: parseStringList(argumentsValue.programs, 'programs'),
    tcodes: parseStringList(argumentsValue.tcodes, 'tcodes'),
    messageIds: parseStringList(argumentsValue.messageIds, 'messageIds'),
    severity: parseSeverity(argumentsValue.severity),
    offset,
    pageSize
  };
}

function parseDateTime(value: unknown, name: string): Date {
  if (typeof value !== 'string' || !value.trim()) throw new McpError(ErrorCode.InvalidParams, `${name} must be an ISO 8601 timestamp.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new McpError(ErrorCode.InvalidParams, `${name} must be an ISO 8601 timestamp.`);
  return date;
}

function parseInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < minimum || result > maximum) {
    throw new McpError(ErrorCode.InvalidParams, `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return result;
}

function parseStringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILTER_VALUES || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 80)) {
    throw new McpError(ErrorCode.InvalidParams, `${name} must contain at most ${MAX_FILTER_VALUES} non-empty strings of up to 80 characters.`);
  }
  return [...new Set(value.map(item => item.trim().toUpperCase()))];
}

function parseSeverity(value: unknown): Sm21Severity {
  if (value === undefined) return 'ALL';
  if (value === 'ALL' || value === 'ERROR' || value === 'WARNING' || value === 'ERROR_WARNING') return value;
  throw new McpError(ErrorCode.InvalidParams, 'severity must be ALL, ERROR, WARNING, or ERROR_WARNING.');
}

function sapTimestamp(value: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(value);
    const values = parts.reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
  } catch {
    throw new McpError(ErrorCode.InvalidParams, 'SAP_MCP_SM21_TIMEZONE must be a valid IANA time-zone name.');
  }
}
