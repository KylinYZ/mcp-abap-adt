import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../types/tools.js';
import { AbapChangeWorkflow } from '../safe/AbapChangeWorkflow.js';
import { AbapChangeConfirmation, type AbapChangeConfirmationOptions } from '../safe/AbapChangeConfirmation.js';
import type { ToolProfile } from '../safe/types.js';

type SafeToolDefinition = ToolDefinition & {
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  _meta: {
    operationClass: 'local-only' | 'read-only tenant' | 'mutating tenant';
    approvalRequired: boolean;
  };
};

const SAFE_TOOL_NAMES = new Set([
  'inspectAbapObject',
  'previewAbapChange',
  'applyAbapChange',
  'getAbapChangeStatus'
]);

export function selectProfileTools(
  profile: ToolProfile,
  safeTools: ToolDefinition[],
  legacyTools: ToolDefinition[]
): ToolDefinition[] {
  return profile === 'safe' ? safeTools : [...safeTools, ...legacyTools];
}

export class SafeAbapHandlers {
  private readonly confirmation: AbapChangeConfirmation;

  constructor(
    private readonly workflow: AbapChangeWorkflow,
    confirmationOptions: AbapChangeConfirmationOptions = {
      allowTextConfirmation: false,
      supportsFormElicitation: () => false,
      elicitInput: async () => { throw new Error('Form elicitation is unavailable.'); }
    }
  ) {
    this.confirmation = new AbapChangeConfirmation(workflow, confirmationOptions);
  }

  supports(toolName: string): boolean {
    return SAFE_TOOL_NAMES.has(toolName);
  }

  getTools(): SafeToolDefinition[] {
    return [
      {
        name: 'inspectAbapObject',
        description: 'Read the complete source and metadata of one allow-listed PROGRAM, INCLUDE, CLASS, or FUNCTION_MODULE object.',
        inputSchema: {
          type: 'object',
          properties: {
            objectType: { type: 'string', description: 'PROGRAM, INCLUDE, CLASS, or FUNCTION_MODULE' },
            objectName: { type: 'string', description: 'Exact ABAP object name' }
          },
          required: ['objectType', 'objectName']
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        },
        _meta: { operationClass: 'read-only tenant', approvalRequired: false }
      },
      {
        name: 'previewAbapChange',
        description: 'Validate and preview a complete ABAP source change. Does not lock, write, or activate SAP objects.',
        inputSchema: {
          type: 'object',
          properties: {
            objectType: { type: 'string', description: 'PROGRAM, INCLUDE, CLASS, or FUNCTION_MODULE' },
            objectName: { type: 'string', description: 'Exact ABAP object name' },
            newSource: { type: 'string', description: 'Complete proposed source for the resolved ADT source resource' },
            transportRequest: { type: 'string', description: 'Existing unreleased ten-character transport request' }
          },
          required: ['objectType', 'objectName', 'newSource', 'transportRequest']
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true
        },
        _meta: { operationClass: 'read-only tenant', approvalRequired: false }
      },
      {
        name: 'applyAbapChange',
        description: 'Apply one previously previewed change plan. Mutates SAP and requires explicit user confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            changePlanId: { type: 'string', description: 'Short-lived plan identifier returned by previewAbapChange' },
            textConfirmation: { type: 'string', description: 'Exact one-time text phrase, only when form elicitation is unavailable and fallback is enabled' }
          },
          required: ['changePlanId']
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true
        },
        _meta: { operationClass: 'mutating tenant', approvalRequired: true }
      },
      {
        name: 'getAbapChangeStatus',
        description: 'Read local status and stage results for one ABAP change plan without returning source code.',
        inputSchema: {
          type: 'object',
          properties: {
            changePlanId: { type: 'string', description: 'Change plan identifier' }
          },
          required: ['changePlanId']
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: { operationClass: 'local-only', approvalRequired: false }
      }
    ];
  }

  async handle(toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'inspectAbapObject':
        return this.workflow.inspect(String(args.objectType || ''), String(args.objectName || ''));
      case 'previewAbapChange':
        return this.workflow.preview({
          objectType: String(args.objectType || ''),
          objectName: String(args.objectName || ''),
          newSource: typeof args.newSource === 'string' ? args.newSource : '',
          transportRequest: String(args.transportRequest || '')
        });
      case 'applyAbapChange':
        return this.confirmation.confirmAndApply(
          String(args.changePlanId || ''),
          typeof args.textConfirmation === 'string' ? args.textConfirmation : undefined
        );
      case 'getAbapChangeStatus':
        return {
          status: 'success',
          plan: this.workflow.status(String(args.changePlanId || ''))
        };
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown safe ABAP tool: ${toolName}`);
    }
  }
}
