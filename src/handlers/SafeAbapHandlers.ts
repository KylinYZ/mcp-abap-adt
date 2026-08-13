import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../types/tools.js';
import { AbapChangeWorkflow } from '../safe/AbapChangeWorkflow.js';
import { AbapChangeConfirmation, type AbapChangeConfirmationOptions } from '../safe/AbapChangeConfirmation.js';
import { AbapCreationConfirmation, type AbapCreationConfirmationOptions } from '../safe/AbapCreationConfirmation.js';
import { AbapObjectCreationWorkflow } from '../safe/AbapObjectCreationWorkflow.js';
import type { CreationObjectInput } from '../safe/creationTypes.js';
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
  'getAbapChangeStatus',
  'previewAbapObjectCreation',
  'applyAbapObjectCreation',
  'getAbapObjectCreationStatus'
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
  private readonly creationConfirmation?: AbapCreationConfirmation;

  constructor(
    private readonly workflow: AbapChangeWorkflow,
    confirmationOptions: AbapChangeConfirmationOptions = {
      allowTextConfirmation: false,
      supportsFormElicitation: () => false,
      elicitInput: async () => { throw new Error('Form elicitation is unavailable.'); }
    },
    private readonly creationWorkflow?: AbapObjectCreationWorkflow,
    creationConfirmationOptions: AbapCreationConfirmationOptions = {
      allowTextConfirmation: false,
      supportsFormElicitation: () => false,
      elicitInput: async () => { throw new Error('Form elicitation is unavailable.'); }
    }
  ) {
    this.confirmation = new AbapChangeConfirmation(workflow, confirmationOptions);
    if (creationWorkflow) {
      this.creationConfirmation = new AbapCreationConfirmation(creationWorkflow, creationConfirmationOptions);
    }
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
      },
      {
        name: 'previewAbapObjectCreation',
        description: 'Validate and preview creation of a PROGRAM, FUNCTION_GROUP, or FUNCTION_MODULE. Does not mutate SAP.',
        inputSchema: {
          type: 'object',
          properties: {
            objects: {
              type: 'array',
              description: 'One object, or one new function group followed by its first function module',
              minItems: 1,
              maxItems: 2,
              items: {
                type: 'object',
                properties: {
                  objectType: { type: 'string', description: 'PROGRAM, FUNCTION_GROUP, or FUNCTION_MODULE' },
                  objectName: { type: 'string', description: 'Exact ABAP object name' },
                  description: { type: 'string', description: 'Short object description' },
                  packageName: { type: 'string', description: 'Transportable package; forbidden for FUNCTION_MODULE' },
                  parentFunctionGroup: { type: 'string', description: 'Required only for FUNCTION_MODULE' },
                  source: { type: 'string', description: 'Complete source; required for PROGRAM and FUNCTION_MODULE, forbidden for FUNCTION_GROUP' }
                },
                required: ['objectType', 'objectName', 'description']
              }
            },
            transportRequest: { type: 'string', description: 'Existing unreleased ten-character transport request' }
          },
          required: ['objects', 'transportRequest']
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
        name: 'applyAbapObjectCreation',
        description: 'Apply one previously previewed object-creation plan. Mutates SAP and requires explicit user confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            creationPlanId: { type: 'string', description: 'Short-lived plan identifier returned by previewAbapObjectCreation' },
            textConfirmation: { type: 'string', description: 'Exact one-time text phrase, only when form elicitation is unavailable and fallback is enabled' }
          },
          required: ['creationPlanId']
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
        name: 'getAbapObjectCreationStatus',
        description: 'Read local status, created-object inventory, and compensation results for one creation plan without returning source code.',
        inputSchema: {
          type: 'object',
          properties: {
            creationPlanId: { type: 'string', description: 'Creation plan identifier' }
          },
          required: ['creationPlanId']
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
      case 'previewAbapObjectCreation':
        return this.requireCreationWorkflow().preview({
          objects: Array.isArray(args.objects) ? args.objects as CreationObjectInput[] : [],
          transportRequest: String(args.transportRequest || '')
        });
      case 'applyAbapObjectCreation':
        return this.requireCreationConfirmation().confirmAndApply(
          String(args.creationPlanId || ''),
          typeof args.textConfirmation === 'string' ? args.textConfirmation : undefined
        );
      case 'getAbapObjectCreationStatus':
        return {
          status: 'success',
          plan: this.requireCreationWorkflow().status(String(args.creationPlanId || ''))
        };
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown safe ABAP tool: ${toolName}`);
    }
  }

  private requireCreationWorkflow(): AbapObjectCreationWorkflow {
    if (!this.creationWorkflow) {
      throw new McpError(ErrorCode.InternalError, 'ABAP object creation workflow is unavailable.');
    }
    return this.creationWorkflow;
  }

  private requireCreationConfirmation(): AbapCreationConfirmation {
    if (!this.creationConfirmation) {
      throw new McpError(ErrorCode.InternalError, 'ABAP object creation confirmation is unavailable.');
    }
    return this.creationConfirmation;
  }
}
