import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { DebugConfirmation, type DebugConfirmationOptions } from '../safe/DebugConfirmation.js';
import { DebugControlWorkflow } from '../safe/DebugControlWorkflow.js';
import type { SafeDebugCommand } from '../safe/debugTypes.js';
import type { ToolDefinition } from '../types/tools.js';

type SafeDebugToolDefinition = ToolDefinition & {
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

const SAFE_DEBUG_TOOL_NAMES = new Set([
  'previewDebugOperation',
  'applyDebugOperation',
  'getDebugOperationStatus',
  'authorizeDebugSession',
  'executeDebugCommand',
  'previewDebugVariableChange',
  'applyDebugVariableChange',
  'revokeDebugSession'
]);

export class SafeDebugHandlers {
  private readonly confirmation: DebugConfirmation;

  constructor(
    private readonly workflow: DebugControlWorkflow,
    confirmationOptions: DebugConfirmationOptions = {
      supportsFormElicitation: () => false,
      elicitInput: async () => { throw new Error('Form elicitation is unavailable.'); }
    }
  ) {
    this.confirmation = new DebugConfirmation(workflow, confirmationOptions);
  }

  supports(toolName: string): boolean {
    return SAFE_DEBUG_TOOL_NAMES.has(toolName);
  }

  getTools(): SafeDebugToolDefinition[] {
    return [
      tool('previewDebugOperation', 'Freeze one DEV listener, breakpoint, Attach, settings, jump-to-line, or terminate operation for native confirmation.', operationSchema(), true, false, false, 'read-only tenant', false),
      tool('applyDebugOperation', 'Open native confirmation and apply one frozen DEV debug operation. Text confirmation is never accepted.', idSchema('debugOperationPlanId'), false, true, false, 'mutating tenant', true),
      tool('getDebugOperationStatus', 'Read local status for one debug operation plan.', idSchema('debugOperationPlanId'), true, false, true, 'local-only', false),
      tool('authorizeDebugSession', 'Open native confirmation for a 15-minute authorization bound to the current safe Attach context.', {
        type: 'object',
        properties: {
          targetUser: { type: 'string', description: 'Allow-listed SAP debug user' },
          debuggeeId: { type: 'string', description: 'Exact debuggee identifier from the safe Attach operation' }
        },
        required: ['targetUser', 'debuggeeId']
      }, false, true, false, 'mutating tenant', true),
      tool('executeDebugCommand', 'Execute exactly one authorized Step, Continue, run-to-line, or stack-navigation command and then reread the stack.', {
        type: 'object',
        properties: {
          authorizationId: { type: 'string', description: 'Active debug session authorization' },
          targetUser: { type: 'string', description: 'Allow-listed SAP debug user' },
          command: {
            type: 'object',
            description: 'One command only: stepInto, stepOver, stepReturn, stepContinue, stepRunToLine, or goToStack',
            properties: {
              command: { type: 'string', description: 'Single command name' },
              url: { type: 'string', description: 'Required only for stepRunToLine' },
              urlOrPosition: { type: 'string', description: 'Required only for goToStack' }
            },
            required: ['command']
          }
        },
        required: ['authorizationId', 'targetUser', 'command']
      }, false, true, false, 'mutating tenant', false),
      tool('previewDebugVariableChange', 'Read and freeze one variable old/new value pair in the current authorized stack frame.', {
        type: 'object',
        properties: {
          authorizationId: { type: 'string', description: 'Active debug session authorization' },
          targetUser: { type: 'string', description: 'Allow-listed SAP debug user' },
          variableName: { type: 'string', description: 'Exact debugger variable name or ID' },
          newValue: { type: 'string', description: 'Planned new value; returned views and audit records are redacted' },
          parents: { type: 'array', description: 'Debugger variable scopes; defaults to @ROOT', items: { type: 'string' } }
        },
        required: ['authorizationId', 'targetUser', 'variableName', 'newValue']
      }, true, false, false, 'read-only tenant', false),
      tool('applyDebugVariableChange', 'Open a separate native confirmation, reject stack/value drift, then modify exactly one frozen variable.', idSchema('debugOperationPlanId'), false, true, false, 'mutating tenant', true),
      tool('revokeDebugSession', 'Revoke one local debug session authorization without changing SAP state.', idSchema('authorizationId'), true, false, true, 'local-only', false)
    ];
  }

  async handle(toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'previewDebugOperation':
        return this.renderPreview(await this.workflow.previewOperation({ operation: args.operation }));
      case 'applyDebugOperation':
        return this.confirmation.confirmAndApply(String(args.debugOperationPlanId || ''), 'OPERATION');
      case 'getDebugOperationStatus':
        return { status: 'success', plan: this.workflow.status(String(args.debugOperationPlanId || '')) };
      case 'authorizeDebugSession':
        return this.confirmation.confirmAndAuthorize(String(args.targetUser || ''), String(args.debuggeeId || ''));
      case 'executeDebugCommand':
        return this.workflow.executeCommand({
          authorizationId: String(args.authorizationId || ''),
          targetUser: String(args.targetUser || ''),
          command: args.command as SafeDebugCommand
        });
      case 'previewDebugVariableChange':
        return this.renderPreview(await this.workflow.previewVariableChange({
          authorizationId: String(args.authorizationId || ''),
          targetUser: String(args.targetUser || ''),
          variableName: String(args.variableName || ''),
          newValue: typeof args.newValue === 'string' ? args.newValue : args.newValue as never,
          parents: Array.isArray(args.parents) ? args.parents as string[] : undefined
        }));
      case 'applyDebugVariableChange':
        return this.confirmation.confirmAndApply(String(args.debugOperationPlanId || ''), 'VARIABLE');
      case 'revokeDebugSession':
        return this.workflow.revokeSession(String(args.authorizationId || ''));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown safe debug tool: ${toolName}`);
    }
  }

  private renderPreview(preview: Record<string, unknown>): Record<string, unknown> {
    const plan = preview.plan as Record<string, unknown>;
    return {
      content: [{
        type: 'text',
        text: [
          '## DEV 调试操作预览',
          '',
          `- 操作：${String((plan.operation as Record<string, unknown>)?.kind || '')}`,
          `- 用户：${String(plan.targetUser || '')}`,
          `- 摘要：${String(plan.summary || '')}`,
          `- 风险：${String(plan.risk || '')}`,
          `- 计划：${String(plan.debugOperationPlanId || '')}`,
          '',
          '下一步调用对应的 apply 工具打开服务器原生确认；无需聊天文字确认。'
        ].join('\n')
      }],
      structuredContent: preview
    };
  }
}

function tool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema'],
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  operationClass: SafeDebugToolDefinition['_meta']['operationClass'],
  approvalRequired: boolean
): SafeDebugToolDefinition {
  return {
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: operationClass !== 'local-only' },
    _meta: { operationClass, approvalRequired }
  };
}

function idSchema(field: string): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: { [field]: { type: 'string', description: `${field} identifier` } },
    required: [field]
  };
}

function operationSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      operation: {
        type: 'object',
        description: 'One frozen operation. SET_VARIABLE is forbidden here.',
        properties: {
          kind: { type: 'string', description: 'CREATE_LISTENER, DELETE_LISTENER, SET_BREAKPOINTS, DELETE_BREAKPOINT, ATTACH, SAVE_SETTINGS, JUMP_TO_LINE, or TERMINATE_DEBUGGEE' },
          targetUser: { type: 'string' },
          debuggingMode: { type: 'string' },
          terminalId: { type: 'string' },
          ideId: { type: 'string' },
          clientId: { type: 'string' },
          debuggeeId: { type: 'string' },
          authorizationId: { type: 'string' },
          url: { type: 'string' },
          breakpoints: { type: 'array', items: { type: 'object' } },
          breakpoint: { type: 'object' },
          settings: { type: 'object' }
        },
        required: ['kind', 'targetUser']
      }
    },
    required: ['operation']
  };
}
