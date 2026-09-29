/**
 * 受控传输请求创建的原生确认（TransportCreationConfirmation）。
 *
 * 与 ObjectActivationConfirmation 完全同构：
 * - 仅支持 MCP form elicitation 原生确认；不支持调用方布尔确认，
 *   也不支持文本 fallback（避免确认语义被客户端转述弱化）。
 * - "用户明确要求由 AI 创建请求"这一授权语义就落在这个原生确认上：
 *   确认对话框展示目标系统、包名、请求描述与创建即写入的语义；
 *   只有 action=accept 且 decision=create_transport 才会触发 apply。
 */
import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '../lib/McpErrorCompat.js';
import { ConfirmationRequiredError } from '../lib/MrtrElicitation.js';
import { SafeAbapError } from './errors.js';
import type { TransportCreationPlanView } from './transportCreationTypes.js';

/** 确认前用于读取 plan 状态的最小端口。 */
export interface TransportCreationStatusReader {
  status(transportCreationPlanId: string): TransportCreationPlanView;
}

export interface TransportCreationConfirmationOptions {
  /** 客户端是否支持 form elicitation；不支持则直接拒绝而不是降级 */
  supportsFormElicitation: () => boolean;
  /** 发起原生确认对话框 */
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  /** 确认通过后的单次执行回调（由 executionGate 包裹的 workflow.apply） */
  applyConfirmed: (transportCreationPlanId: string) => Promise<Record<string, unknown>>;
  /** 可注入时钟，用于计算确认超时 */
  now?: () => number;
}

/** 确认对话框最长等待 15 分钟（与激活链一致）。 */
const MAX_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export class TransportCreationConfirmation {
  constructor(
    private readonly statusReader: TransportCreationStatusReader,
    private readonly options: TransportCreationConfirmationOptions
  ) {}

  /** 原生确认并单次执行创建 plan；拒绝时返回 confirmation_declined 而不执行。 */
  async confirmAndRun(transportCreationPlanId: string): Promise<Record<string, unknown>> {
    if (!this.options.supportsFormElicitation()) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'Transport creation requires MCP form elicitation; text confirmation fallback is not supported.'
      );
    }
    const plan = this.statusReader.status(transportCreationPlanId);
    assertConfirmable(plan);
    const elicited = await this.elicit(
      confirmationForm(plan),
      confirmationTimeoutMs(plan, this.options.now?.() ?? Date.now())
    );
    if (elicited.action !== 'accept' || elicited.content?.decision !== 'create_transport') {
      return { status: 'confirmation_declined', transportCreationPlanId, confirmationMode: 'elicitation' };
    }
    return this.options.applyConfirmed(transportCreationPlanId);
  }

  /** 封装 elicitation 调用：客户端超时视为取消，其他失败视为确认通道故障。 */
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

/** 确认表单：展示系统上下文、包名与请求描述，并说明仅创建、不释放不删除。 */
function confirmationForm(plan: TransportCreationPlanView): ElicitRequestFormParams {
  return {
    mode: 'form',
    message: `Create workbench transport request · ${plan.systemHost}/${plan.client} · package `
      + `${plan.target.devClass} · "${plan.target.requestText}" · owner ${plan.sapUser} `
      + '· Creation is a CTS repository write. The server runs this plan once and never retries an '
      + 'unknown outcome; release and delete remain out of scope.',
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: '请选择操作',
          oneOf: [
            { const: 'create_transport', title: '创建一次此计划中的传输请求' },
            { const: 'cancel', title: '取消' }
          ]
        }
      },
      required: ['decision']
    }
  };
}

/** 确认超时不超过 plan 剩余 TTL；plan 已过期直接拒绝确认。 */
function confirmationTimeoutMs(plan: TransportCreationPlanView, now: number): number {
  const remaining = Date.parse(plan.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'transport-creation-plan', 'Transport creation plan has expired.');
  }
  return Math.min(remaining, MAX_CONFIRMATION_TIMEOUT_MS);
}

/** 只有 PREVIEWED 状态的 plan 可以进入确认；其余状态给出确定性错误。 */
function assertConfirmable(plan: TransportCreationPlanView): void {
  if (plan.status === 'EXPIRED') {
    throw new SafeAbapError('PLAN_EXPIRED', 'transport-creation-plan', 'Transport creation plan has expired.');
  }
  if (plan.status !== 'PREVIEWED') {
    throw new SafeAbapError(
      'PLAN_ALREADY_CONSUMED',
      'transport-creation-plan',
      `Transport creation plan is already ${plan.status.toLowerCase()}.`
    );
  }
}
