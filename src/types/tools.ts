export interface ToolSchemaProperty {
  type: string;
  description?: string;
  optional?: boolean;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  maxProperties?: number;
  properties?: Record<string, ToolSchemaProperty>;
  required?: string[];
  items?: ToolSchemaProperty;
  minItems?: number;
  maxItems?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    // MCP 工具输入 schema 恒为 JSON Schema object 根；v2 SDK 按字面量 'object' 校验
    type: 'object';
    properties: Record<string, ToolSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: {
    operationClass?: 'local-only' | 'read-only tenant' | 'mutating tenant';
    approvalRequired?: boolean;
  };
}
