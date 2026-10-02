import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '../lib/McpErrorCompat.js';
import { ConfirmationRequiredError } from '../lib/MrtrElicitation.js';
import { SafeAbapError } from './errors.js';
import type { QualityCheckPlanView } from './qualityTypes.js';

export interface QualityCheckStatusReader {
  status(qualityPlanId: string): QualityCheckPlanView;
}

export interface QualityCheckConfirmationOptions {
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  /**
   * 部署级自动确认开关（SAP_MCP_CONFIRMATION_MODE=auto 且 DEV 时由接线层注入）：
   * 返回 true 时跳过人工表单确认直接执行。工具调用方永远无法通过参数触发此路径。
   */
  autoApprove?: () => boolean;
  /** 确认通过后的单次执行回调（由 executionGate 包裹）；confirmationMode 由确认层如实传入 */
  runConfirmed: (qualityPlanId: string, confirmationMode?: 'elicitation' | 'auto-config') => Promise<Record<string, unknown>>;
  now?: () => number;
}

const MAX_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export class QualityCheckConfirmation {
  constructor(
    private readonly statusReader: QualityCheckStatusReader,
    private readonly options: QualityCheckConfirmationOptions
  ) {}

  async confirmAndRun(qualityPlanId: string): Promise<Record<string, unknown>> {
    const plan = this.statusReader.status(qualityPlanId);
    assertConfirmable(plan);
    // 部署配置预授权：plan 状态校验通过后跳过人工表单确认（native 模式校验顺序不变）。
    // 必须先于 supportsFormElicitation 检查——auto 模式部署下客户端无需具备
    // elicitation 能力（与 AbapCreationConfirmation/TransportCreationConfirmation 的短路顺序保持同构）。
    if (this.options.autoApprove?.()) {
      return this.options.runConfirmed(qualityPlanId, 'auto-config');
    }
    if (!this.options.supportsFormElicitation()) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'Quality checks require MCP form elicitation; text confirmation fallback is not supported.'
      );
    }
    const elicited = await this.elicit(
      confirmationForm(plan),
      confirmationTimeoutMs(plan, this.options.now?.() ?? Date.now())
    );
    if (elicited.action !== 'accept' || elicited.content?.decision !== 'run') {
      return { status: 'confirmation_declined', qualityPlanId, confirmationMode: 'elicitation' };
    }
    return this.options.runConfirmed(qualityPlanId, 'elicitation');
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

function confirmationForm(plan: QualityCheckPlanView): ElicitRequestFormParams {
  const variant = plan.variant ? ` · variant ${plan.variant}` : '';
  return {
    mode: 'form',
    message: `${plan.kind}${variant} · ${plan.systemHost}/${plan.client} · ${plan.objects.length} object(s) · ${plan.riskLevel}/${plan.duration} · Test code may have side effects. The server runs this plan once and never retries an unknown outcome.`,
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: '请选择操作',
          oneOf: [
            { const: 'run', title: '执行一次此质量检查计划' },
            { const: 'cancel', title: '取消' }
          ]
        }
      },
      required: ['decision']
    }
  };
}

function confirmationTimeoutMs(plan: QualityCheckPlanView, now: number): number {
  const remaining = Date.parse(plan.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'quality-plan', 'Quality check plan has expired.');
  }
  return Math.min(remaining, MAX_CONFIRMATION_TIMEOUT_MS);
}

function assertConfirmable(plan: QualityCheckPlanView): void {
  if (plan.status === 'EXPIRED') throw new SafeAbapError('PLAN_EXPIRED', 'quality-plan', 'Quality check plan has expired.');
  if (plan.status !== 'PREVIEWED') {
    throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'quality-plan', `Quality check plan is already ${plan.status.toLowerCase()}.`);
  }
}
