import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '../lib/McpErrorCompat.js';
import { ConfirmationRequiredError } from '../lib/MrtrElicitation.js';
import { SafeAbapError } from './errors.js';
import type { AdvancedOperationKind, AdvancedOperationPlanView } from './advancedTypes.js';

export type AdvancedOperationFamily = 'DDIC' | 'PACKAGE' | 'RAP';

export interface AdvancedOperationStatusReader {
  status(operationPlanId: string): AdvancedOperationPlanView;
}

export interface AdvancedOperationConfirmationOptions {
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  /**
   * 部署级自动确认开关（SAP_MCP_CONFIRMATION_MODE=auto 且 DEV 时由接线层注入）：
   * 返回 true 时跳过人工表单确认直接执行；确认事件由下游工作流自身审计记录。
   * 工具调用方永远无法通过参数触发此路径。
   */
  autoApprove?: () => boolean;
  /** 确认通过后的单次执行回调（由 executionGate 包裹的 workflow.apply）；confirmationMode 由确认层如实传入 */
  applyConfirmed: (operationPlanId: string, confirmationMode?: 'elicitation' | 'auto-config') => Promise<Record<string, unknown>>;
  now?: () => number;
}

const MAX_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export class AdvancedOperationConfirmation {
  constructor(
    private readonly statusReader: AdvancedOperationStatusReader,
    private readonly options: AdvancedOperationConfirmationOptions
  ) {}

  async confirmAndApply(operationPlanId: string, expectedFamily: AdvancedOperationFamily): Promise<Record<string, unknown>> {
    const plan = this.statusReader.status(operationPlanId);
    assertConfirmable(plan);
    if (familyFor(plan.operationKind) !== expectedFamily) {
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', `Use apply${familyToolName(plan.operationKind)} for this plan.`);
    }

    // 部署配置预授权：plan 状态与 family 校验通过后跳过人工表单确认（native 模式校验顺序不变）。
    // 必须先于 supportsFormElicitation 检查——auto 模式部署下客户端无需具备
    // elicitation 能力（与 AbapCreationConfirmation/TransportCreationConfirmation 的短路顺序保持同构）。
    if (this.options.autoApprove?.()) {
      return this.options.applyConfirmed(operationPlanId, 'auto-config');
    }

    if (!this.options.supportsFormElicitation()) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'Advanced operations require MCP form elicitation; text confirmation fallback is not supported.'
      );
    }

    const result = await this.elicit(confirmationForm(plan), confirmationTimeoutMs(plan, this.options.now?.() ?? Date.now()));
    if (result.action !== 'accept' || result.content?.decision !== 'apply') {
      return { status: 'confirmation_declined', operationPlanId, confirmationMode: 'elicitation' };
    }
    return this.options.applyConfirmed(operationPlanId, 'elicitation');
  }

  private async elicit(params: ElicitRequestFormParams, timeoutMs: number): Promise<ElicitResult> {
    try {
      return await this.options.elicitInput(params, timeoutMs);
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) throw error;
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { action: 'cancel' };
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'The client confirmation dialog failed.');
    }
  }
}

function confirmationForm(plan: AdvancedOperationPlanView): ElicitRequestFormParams {
  const transport = plan.transport ? ` · transport ${plan.transport}` : '';
  const rollback = plan.rollbackSupported
    ? '失败时仅在结果明确的情况下尝试一次受控恢复。'
    : '此操作不支持自动回滚，也不会自动重试。';
  return {
    mode: 'form',
    message: `${plan.inputSummary.title} · ${plan.systemHost}/${plan.client} · ${plan.target.objectType} ${plan.target.objectName}${transport} · ${rollback}`,
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: '请选择操作',
          oneOf: [
            { const: 'apply', title: '执行此计划' },
            { const: 'cancel', title: '取消' }
          ]
        }
      },
      required: ['decision']
    }
  };
}

function confirmationTimeoutMs(plan: AdvancedOperationPlanView, now: number): number {
  const remaining = Date.parse(plan.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'advanced-plan', 'Advanced operation plan has expired.');
  }
  return Math.min(remaining, MAX_CONFIRMATION_TIMEOUT_MS);
}

function assertConfirmable(plan: AdvancedOperationPlanView): void {
  if (plan.status === 'EXPIRED') throw new SafeAbapError('PLAN_EXPIRED', 'advanced-plan', 'Advanced operation plan has expired.');
  if (plan.status !== 'PREVIEWED') {
    throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'advanced-plan', `Advanced operation plan is already ${plan.status.toLowerCase()}.`);
  }
}

function familyFor(kind: AdvancedOperationKind): AdvancedOperationFamily {
  if (kind === 'CHANGE_PACKAGE') return 'PACKAGE';
  if (kind === 'RAP_GENERATE' || kind === 'RAP_PUBLISH_SERVICE') return 'RAP';
  return 'DDIC';
}

function familyToolName(kind: AdvancedOperationKind): 'DdicPropertyChange' | 'PackageChange' | 'RapOperation' {
  const family = familyFor(kind);
  if (family === 'PACKAGE') return 'PackageChange';
  if (family === 'RAP') return 'RapOperation';
  return 'DdicPropertyChange';
}
