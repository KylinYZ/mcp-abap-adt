import { McpError } from '@modelcontextprotocol/sdk/types.js';

export interface RequestLimitGuardrails {
  queryDefaultRows: number;
  queryMaxRows: number;
  searchDefaultResults: number;
  searchMaxResults: number;
  maxArgumentBytes: number;
}

type ArgumentsValue = Record<string, unknown>;

const ADVANCED_TOOL_FIELDS: Record<string, readonly string[]> = {
  objectStructureElements: ['objectUrl', 'version'],
  typeHierarchy: ['url', 'body', 'line', 'offset', 'superTypes'],
  objectEnhancements: ['sourceMainPath', 'contextUri', 'includeSource'],
  getDomainProperties: ['domainUrl', 'version'],
  setDomainProperties: ['domainUrl', 'properties', 'metaData', 'lockHandle', 'transport'],
  getDataElementProperties: ['dataElementUrl', 'version'],
  setDataElementProperties: ['dataElementUrl', 'properties', 'metaData', 'lockHandle', 'transport'],
  getTextElements: ['url', 'category'],
  setTextElements: ['url', 'category', 'elements', 'lockHandle', 'transport'],
  atcDocumentation: ['docUri'],
  changePackagePreview: ['refactoring', 'transport'],
  changePackageExecute: ['refactoring'],
  rapGenValidateInitial: ['genId', 'refObjectUri', 'packageName', 'checks'],
  rapGenGetSchema: ['genId', 'refObjectUri', 'packageName'],
  rapGenGetContent: ['genId', 'refObjectUri', 'packageName'],
  rapGenGetUiConfig: ['genId', 'refObjectUri', 'packageName'],
  rapGenValidateContent: ['genId', 'refObjectUri', 'content'],
  rapGenPreview: ['genId', 'refObjectUri', 'content'],
  rapGenGenerate: ['genId', 'refObjectUri', 'transport', 'content'],
  rapGenIsAvailable: ['genId'],
  rapGenPublishService: ['srvbName']
};

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
  assertAdvancedToolArgumentShape(toolName, result);
  assertSafeDebugArgumentShape(toolName, result);
  return result;
}

function assertAdvancedToolArgumentShape(toolName: string, argumentsValue: ArgumentsValue): void {
  const allowedFields = ADVANCED_TOOL_FIELDS[toolName];
  if (!allowedFields) return;

  const unexpected = Object.keys(argumentsValue).filter(field => !allowedFields.includes(field));
  if (unexpected.length > 0) {
    throw new McpError(400, `${toolName} does not accept fields: ${unexpected.join(', ')}.`);
  }

  for (const field of ['objectUrl', 'url', 'domainUrl', 'dataElementUrl', 'docUri', 'sourceMainPath', 'contextUri', 'refObjectUri']) {
    assertBoundedIdentifier(argumentsValue[field], field, 2048);
  }
  for (const field of ['packageName', 'srvbName', 'transport', 'lockHandle', 'genId', 'category', 'version']) {
    assertBoundedIdentifier(argumentsValue[field], field, field === 'lockHandle' ? 512 : 255);
  }

  if (argumentsValue.checks !== undefined) {
    assertBoundedStringArray(argumentsValue.checks, 'checks', 16, 64);
  }
  if (argumentsValue.elements !== undefined && (!Array.isArray(argumentsValue.elements) || argumentsValue.elements.length > 500)) {
    throw new McpError(400, 'elements must be an array with no more than 500 entries.');
  }

  for (const field of ['properties', 'metaData', 'elements', 'refactoring', 'content']) {
    if (argumentsValue[field] !== undefined) assertBoundedJson(argumentsValue[field], field);
  }
}

function assertBoundedIdentifier(value: unknown, field: string, maximum: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new McpError(400, `${field} must be a string of at most ${maximum} characters without control characters.`);
  }
}

function assertBoundedStringArray(value: unknown, field: string, maximumItems: number, maximumLength: number): void {
  if (!Array.isArray(value) || value.length > maximumItems || value.some(item => (
    typeof item !== 'string' || item.length > maximumLength || /[\u0000-\u001f\u007f]/.test(item)
  ))) {
    throw new McpError(400, `${field} exceeds its bounded string-array shape.`);
  }
}

function assertBoundedJson(value: unknown, field: string): void {
  let keyCount = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > 8) throw new McpError(400, `${field} cannot exceed eight nested levels.`);
    if (Array.isArray(current)) {
      if (current.length > 500) throw new McpError(400, `${field} arrays cannot contain more than 500 entries.`);
      current.forEach(item => visit(item, depth + 1));
      return;
    }
    if (isRecord(current)) {
      const entries = Object.entries(current);
      keyCount += entries.length;
      if (keyCount > 500) throw new McpError(400, `${field} cannot contain more than 500 keys.`);
      entries.forEach(([, nested]) => visit(nested, depth + 1));
    }
  };
  visit(value, 0);
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
