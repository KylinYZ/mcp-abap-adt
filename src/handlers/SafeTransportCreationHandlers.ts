/**
 * 受控传输请求创建的 MCP 工具处理器（SafeTransportCreationHandlers）。
 *
 * 暴露 3 个工具（与受控激活三件套同构）：
 * - previewTransportCreation：只读 CTS 预检并冻结创建 plan（read-only）。
 * - applyTransportCreation：发起原生确认并单次执行冻结 plan（mutating）。
 * - getTransportCreationStatus：本地查询 plan 状态（local 语义）。
 *
 * 安全规则：
 * - 仅创建：apply 只调用 ADT 创建端点；释放、删除、改属主、改 E071/E071K
 *   不在本链路的任何工具中，也没有对应入参。
 * - apply 不接受调用方布尔确认，只走 TransportCreationConfirmation 的
 *   MCP form elicitation 原生确认；plan 之外的任何 URL/请求号一律不可传入。
 * - profile/role 门控由 ToolOperationPolicy 与 ToolProfiles 承担：
 *   三工具仅 DEV + development/development-workbench 可见可用。
 */
import { ErrorCode, McpError } from '../lib/McpErrorCompat.js';
import {
  TransportCreationConfirmation,
  type TransportCreationConfirmationOptions,
  type TransportCreationStatusReader
} from '../safe/TransportCreationConfirmation.js';
import type {
  PreviewTransportCreationInput,
  TransportCreationPlanView,
  TransportCreationPreviewResult
} from '../safe/transportCreationTypes.js';
import type { ToolDefinition } from '../types/tools.js';

/** handlers 依赖的工作流端口（便于测试 mock）。 */
export interface SafeTransportCreationWorkflowPort extends TransportCreationStatusReader {
  preview(input: PreviewTransportCreationInput): Promise<TransportCreationPreviewResult>;
}

/** 本 handlers 拥有的工具名集合（supports 判定用）。 */
const SAFE_TRANSPORT_CREATION_TOOL_NAMES = new Set([
  'previewTransportCreation',
  'applyTransportCreation',
  'getTransportCreationStatus'
]);

export class SafeTransportCreationHandlers {
  private readonly confirmation: TransportCreationConfirmation;

  constructor(
    private readonly workflow: SafeTransportCreationWorkflowPort,
    confirmationOptions: TransportCreationConfirmationOptions
  ) {
    this.confirmation = new TransportCreationConfirmation(workflow, confirmationOptions);
  }

  /** 是否由本 handlers 处理该工具。 */
  supports(toolName: string): boolean {
    return SAFE_TRANSPORT_CREATION_TOOL_NAMES.has(toolName);
  }

  /** 工具定义：preview/status 只读，apply 需原生确认。 */
  getTools(): ToolDefinition[] {
    return [
      creationTool(
        'previewTransportCreation',
        'Run a read-only CTS preflight for one package and freeze one bounded transport-request creation plan without creating anything.',
        previewSchema(),
        true,
        false
      ),
      creationTool(
        'applyTransportCreation',
        'Open one native confirmation and create the frozen workbench transport request exactly once; creation-only, unknown outcomes are never retried.',
        planIdSchema(),
        false,
        true
      ),
      creationTool(
        'getTransportCreationStatus',
        'Read the local status and bounded result summary of one transport-creation plan.',
        planIdSchema(),
        true,
        false
      )
    ];
  }

  /** 工具分发：apply 走原生确认链，preview/status 直接读工作流。 */
  async handle(toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'previewTransportCreation':
        return render(await this.workflow.preview(args as unknown as PreviewTransportCreationInput));
      case 'applyTransportCreation':
        return this.confirmation.confirmAndRun(String(args.transportCreationPlanId || ''));
      case 'getTransportCreationStatus':
        return render({
          status: 'success',
          plan: this.workflow.status(String(args.transportCreationPlanId || ''))
        });
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown transport creation tool: ${toolName}`);
    }
  }
}

/** 构造统一注解的工具定义（与 SafeActivationHandlers 同构）。 */
function creationTool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema'],
  readOnlyHint: boolean,
  approvalRequired: boolean
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { ...inputSchema, additionalProperties: false },
    annotations: {
      readOnlyHint,
      destructiveHint: !readOnlyHint,
      idempotentHint: readOnlyHint,
      openWorldHint: true
    },
    _meta: { operationClass: readOnlyHint ? 'read-only tenant' : 'mutating tenant', approvalRequired }
  };
}

/** preview 输入：仅请求描述、目标包与可选传输层；无任何 URL/请求号字段。 */
function previewSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      requestText: { type: 'string', minLength: 1, maxLength: 60 },
      devClass: { type: 'string', minLength: 1, maxLength: 40 },
      transportLayer: { type: 'string', minLength: 1, maxLength: 20, optional: true }
    },
    required: ['requestText', 'devClass']
  };
}

/** apply/status 输入：仅接受 server 生成的 plan id。 */
function planIdSchema(): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    properties: {
      transportCreationPlanId: { type: 'string', minLength: 1, maxLength: 128 }
    },
    required: ['transportCreationPlanId']
  };
}

/** 统一 MCP 响应：text + structuredContent 双通道。 */
function render(value: unknown): Record<string, unknown> {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}
