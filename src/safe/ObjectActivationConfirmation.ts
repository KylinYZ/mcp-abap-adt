/**
 * 受控对象激活的原生确认（ObjectActivationConfirmation）。
 *
 * 与 QualityCheckConfirmation 完全同构：
 * - 仅支持 MCP form elicitation 原生确认；不支持调用方布尔确认，
 *   也不支持文本 fallback（避免确认语义被客户端转述弱化）。
 * - 确认对话框展示目标系统、对象数量与单次执行语义；
 *   只有 action=accept 且 decision=activate 才会触发 apply。
 */
import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import { SafeAbapError } from './errors.js';
import type { ObjectActivationPlanView } from './objectActivationTypes.js';

/** 确认前用于读取 plan 状态的最小端口。 */
export interface ObjectActivationStatusReader {
  status(activationPlanId: string): ObjectActivationPlanView;
}

export interface ObjectActivationConfirmationOptions {
  /** 客户端是否支持 form elicitation；不支持则直接拒绝而不是降级 */
  supportsFormElicitation: () => boolean;
  /** 发起原生确认对话框 */
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  /** 确认通过后的单次执行回调（由 executionGate 包裹的 workflow.apply） */
  applyConfirmed: (activationPlanId: string) => Promise<Record<string, unknown>>;
  /** 可注入时钟，用于计算确认超时 */
  now?: () => number;
}

/** 确认对话框最长等待 15 分钟（与 QualityCheck 一致）。 */
const MAX_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export class ObjectActivationConfirmation {
  constructor(
    private readonly statusReader: ObjectActivationStatusReader,
    private readonly options: ObjectActivationConfirmationOptions
  ) {}

  /** 原生确认并单次执行激活 plan；拒绝时返回 confirmation_declined 而不执行。 */
  async confirmAndRun(activationPlanId: string): Promise<Record<string, unknown>> {
    if (!this.options.supportsFormElicitation()) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'Object activation requires MCP form elicitation; text confirmation fallback is not supported.'
      );
    }
    const plan = this.statusReader.status(activationPlanId);
    assertConfirmable(plan);
    const elicited = await this.elicit(
      confirmationForm(plan),
      confirmationTimeoutMs(plan, this.options.now?.() ?? Date.now())
    );
    if (elicited.action !== 'accept' || elicited.content?.decision !== 'activate') {
      return { status: 'confirmation_declined', activationPlanId, confirmationMode: 'elicitation' };
    }
    return this.options.applyConfirmed(activationPlanId);
  }

  /** 封装 elicitation 调用：客户端超时视为取消，其他失败视为确认通道故障。 */
  private async elicit(params: ElicitRequestFormParams, timeoutMs: number): Promise<ElicitResult> {
    try {
      return await this.options.elicitInput(params, timeoutMs);
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { action: 'cancel' };
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'The client confirmation dialog failed.');
    }
  }
}

/** 确认表单：展示系统上下文、对象数量与不可重试语义，要求显式选择。 */
function confirmationForm(plan: ObjectActivationPlanView): ElicitRequestFormParams {
  return {
    mode: 'form',
    message: `Activate ${plan.objects.length} inactive object(s) · ${plan.systemHost}/${plan.client} · ${plan.toolProfile} · Activation is a repository write. The server runs this plan once and never retries an unknown outcome.`,
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: '请选择操作',
          oneOf: [
            { const: 'activate', title: '激活一次此计划中的未激活对象' },
            { const: 'cancel', title: '取消' }
          ]
        }
      },
      required: ['decision']
    }
  };
}

/** 确认超时不超过 plan 剩余 TTL；plan 已过期直接拒绝确认。 */
function confirmationTimeoutMs(plan: ObjectActivationPlanView, now: number): number {
  const remaining = Date.parse(plan.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'activation-plan', 'Object activation plan has expired.');
  }
  return Math.min(remaining, MAX_CONFIRMATION_TIMEOUT_MS);
}

/** 只有 PREVIEWED 状态的 plan 可以进入确认；其余状态给出确定性错误。 */
function assertConfirmable(plan: ObjectActivationPlanView): void {
  if (plan.status === 'EXPIRED') throw new SafeAbapError('PLAN_EXPIRED', 'activation-plan', 'Object activation plan has expired.');
  if (plan.status !== 'PREVIEWED') {
    throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'activation-plan', `Object activation plan is already ${plan.status.toLowerCase()}.`);
  }
}
