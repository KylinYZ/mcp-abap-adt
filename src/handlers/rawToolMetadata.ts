import type { ToolDefinition } from '../types/tools.js';

export function readOnlyRawTool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema']
): ToolDefinition {
  return annotatedTool(name, description, inputSchema, true, false, true);
}

export function mutatingRawTool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema']
): ToolDefinition {
  return annotatedTool(name, description, inputSchema, false, true, false);
}

function annotatedTool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema'],
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { ...inputSchema, additionalProperties: false },
    annotations: {
      readOnlyHint,
      destructiveHint,
      idempotentHint,
      openWorldHint: true
    },
    _meta: {
      operationClass: readOnlyHint ? 'read-only tenant' : 'mutating tenant',
      approvalRequired: false
    }
  };
}
