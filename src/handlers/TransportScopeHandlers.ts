import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../types/tools.js';
import type { TransportHistoryQueryRunner } from '../adt/TransportHistoryApi.js';
import { collectTransportScope, TransportScopeInputError } from '../adt/TransportScope.js';
import { collectTransportLoadBoundaries, type TransportLoadBoundaryInput } from '../adt/TransportLoadBoundaries.js';

export class TransportScopeHandlers {
  constructor(private readonly runQuery: TransportHistoryQueryRunner) {}

  supports(name: string): boolean { return name === 'getTransportScope'; }

  getTools(): ToolDefinition[] {
    return [{
      name: 'getTransportScope',
      description: 'Read a bounded R3TR member union for 1–10 explicit transport IDs. Tasks expand to their whole parent request and sibling tasks via at most four serial E070/E071 SELECTs. Optional includeLoadBoundaries adds direct outgoing D010INC reads and boundary classification (at most 10 extra reads total); LOADS are not CALLS/all dependencies. Inspect collection and membership.collection for partial coverage, unsupported types, LIMU, errors and truncation. No E070A grouping, writes or release-readiness claim.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['transports'],
        properties: { transports: { type: 'array', minItems: 1, maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 20 }, description: 'Explicit request/task IDs; selecting a task includes its whole parent request.' },
          includeLoadBoundaries: { type: 'boolean', description: 'Default false. Collect direct outgoing LOADS for supported members and classify boundaries.' },
          maxDependencyQueries: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5, total additional queries. Requires includeLoadBoundaries=true.' },
          maxEntries: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 200 boundary details. Requires includeLoadBoundaries=true.' }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { operationClass: 'read-only tenant', approvalRequired: false }
    }];
  }

  async handle(name: string, args: Record<string, unknown> = {}) {
    if (!this.supports(name)) throw new McpError(ErrorCode.MethodNotFound, 'Unknown transport scope tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['transports', 'includeLoadBoundaries', 'maxDependencyQueries', 'maxEntries'].includes(key))
      || (args.includeLoadBoundaries !== undefined && typeof args.includeLoadBoundaries !== 'boolean')
      || (args.includeLoadBoundaries !== true && (args.maxDependencyQueries !== undefined || args.maxEntries !== undefined))) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid transport scope arguments; boundary budgets require includeLoadBoundaries=true.');
    }
    try {
      const result = args.includeLoadBoundaries === true
        ? await collectTransportLoadBoundaries(this.runQuery, args as unknown as TransportLoadBoundaryInput)
        : await collectTransportScope(this.runQuery, args as unknown as { transports: string[] });
      const structuredContent = { status: 'success', result };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) {
      if (error instanceof TransportScopeInputError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw new McpError(ErrorCode.InternalError, 'Transport scope collection failed.');
    }
  }
}
