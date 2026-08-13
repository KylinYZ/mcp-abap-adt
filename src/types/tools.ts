export interface ToolSchemaProperty {
  type: string;
  description?: string;
  optional?: boolean;
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
    type: string;
    properties: Record<string, ToolSchemaProperty>;
    required?: string[];
  };
}
