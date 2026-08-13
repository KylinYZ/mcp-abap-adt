import { McpError } from '@modelcontextprotocol/sdk/types.js';

export interface RequestLimitGuardrails {
  queryDefaultRows: number;
  queryMaxRows: number;
  searchDefaultResults: number;
  searchMaxResults: number;
}

type ArgumentsValue = Record<string, unknown>;

export function applyToolArgumentLimits(
  toolName: string,
  argumentsValue: ArgumentsValue | undefined,
  guardrails: RequestLimitGuardrails
): ArgumentsValue {
  const result = { ...(argumentsValue || {}) };
  if (toolName === 'tableContents' || toolName === 'runQuery') {
    result.rowNumber = validatedLimit('rowNumber', result.rowNumber, guardrails.queryDefaultRows, guardrails.queryMaxRows);
  } else if (toolName === 'searchObject') {
    result.max = validatedLimit('max', result.max, guardrails.searchDefaultResults, guardrails.searchMaxResults);
  }
  return result;
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
