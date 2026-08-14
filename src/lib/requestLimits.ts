import { McpError } from '@modelcontextprotocol/sdk/types.js';

export interface RequestLimitGuardrails {
  queryDefaultRows: number;
  queryMaxRows: number;
  searchDefaultResults: number;
  searchMaxResults: number;
  maxArgumentBytes: number;
}

type ArgumentsValue = Record<string, unknown>;

export function applyToolArgumentLimits(
  toolName: string,
  argumentsValue: ArgumentsValue | undefined,
  guardrails: RequestLimitGuardrails
): ArgumentsValue {
  const result = { ...(argumentsValue || {}) };
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') > guardrails.maxArgumentBytes) {
    throw new McpError(413, `Tool arguments exceed the ${guardrails.maxArgumentBytes}-byte request limit.`);
  }
  if (toolName === 'tableContents' || toolName === 'runQuery') {
    assertReadOnlyQuery(toolName, result.sqlQuery);
    result.rowNumber = validatedLimit('rowNumber', result.rowNumber, guardrails.queryDefaultRows, guardrails.queryMaxRows);
  } else if (toolName === 'searchObject') {
    result.max = validatedLimit('max', result.max, guardrails.searchDefaultResults, guardrails.searchMaxResults);
  }
  assertSafeDebugArgumentShape(toolName, result);
  return result;
}

function assertSafeDebugArgumentShape(toolName: string, argumentsValue: ArgumentsValue): void {
  if (toolName === 'executeDebugCommand' && (
    !argumentsValue.command
    || typeof argumentsValue.command !== 'object'
    || Array.isArray(argumentsValue.command)
  )) {
    throw new McpError(400, 'executeDebugCommand.command must contain exactly one command object.');
  }
  if (toolName === 'previewDebugVariableChange' && Array.isArray(argumentsValue.parents) && argumentsValue.parents.length > 20) {
    throw new McpError(400, 'previewDebugVariableChange.parents cannot contain more than 20 scopes.');
  }
  const operation = argumentsValue.operation;
  if (toolName === 'previewDebugOperation' && isRecord(operation)) {
    if (operation.kind === 'SET_BREAKPOINTS' && Array.isArray(operation.breakpoints) && operation.breakpoints.length > 50) {
      throw new McpError(400, 'One debug operation cannot set more than 50 breakpoints.');
    }
  }
}

export function assertReadOnlyQuery(toolName: string, value: unknown): void {
  if (toolName === 'tableContents' && (value === undefined || String(value).trim() === '')) return;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpError(400, `${toolName}.sqlQuery must contain a read-only query.`);
  }

  const normalized = stripSqlLiteralsAndComments(value).trim();
  if (normalized.includes(';')) {
    throw new McpError(400, 'Only one read-only SQL statement is allowed.');
  }
  if (toolName === 'runQuery' && !/^(SELECT|WITH)\b/i.test(normalized)) {
    throw new McpError(400, 'runQuery only accepts SELECT or WITH read-only queries.');
  }
  if (/\b(INSERT|UPDATE|MODIFY|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|EXEC(?:UTE)?|CALL|COMMIT|ROLLBACK|GRANT|REVOKE)\b/i.test(normalized)) {
    throw new McpError(400, 'Only read-only SQL queries are allowed.');
  }
}

function stripSqlLiteralsAndComments(value: string): string {
  return value
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

export function assertToolResponseSize(toolResult: unknown, maxResponseBytes: number): void {
  if (!isRecord(toolResult) || !Array.isArray(toolResult.content)) return;
  let totalBytes = 0;
  for (const item of toolResult.content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      totalBytes += Buffer.byteLength(item.text, 'utf8');
      if (totalBytes > maxResponseBytes) {
        throw new McpError(413, `Tool text response exceeds the ${maxResponseBytes}-byte response limit. Narrow the request or retrieve fewer rows.`);
      }
    }
  }
  if (toolResult.structuredContent !== undefined) {
    // Structured output travels alongside visible content and must share the same response budget.
    totalBytes += Buffer.byteLength(JSON.stringify(toolResult.structuredContent), 'utf8');
    if (totalBytes > maxResponseBytes) {
      throw new McpError(413, `Tool response exceeds the ${maxResponseBytes}-byte response limit. Narrow the request or retrieve fewer rows.`);
    }
  }
}

function validatedLimit(field: string, value: unknown, defaultValue: number, maximum: number): number {
  const candidate = value === undefined ? defaultValue : value;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new McpError(400, `${field} must be a positive integer no greater than ${maximum}; received ${String(candidate)}.`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
