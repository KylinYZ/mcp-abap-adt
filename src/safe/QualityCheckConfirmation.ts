import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import { SafeAbapError } from './errors.js';
import type { QualityCheckPlanView } from './qualityTypes.js';

export interface QualityCheckStatusReader {
  status(qualityPlanId: string): QualityCheckPlanView;
}

export interface QualityCheckConfirmationOptions {
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  runConfirmed: (qualityPlanId: string) => Promise<Record<string, unknown>>;
  now?: () => number;
}

const MAX_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export class QualityCheckConfirmation {
  constructor(
    private readonly statusReader: QualityCheckStatusReader,
    private readonly options: QualityCheckConfirmationOptions
  ) {}

  async confirmAndRun(qualityPlanId: string): Promise<Record<string, unknown>> {
    if (!this.options.supportsFormElicitation()) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'Quality checks require MCP form elicitation; text confirmation fallback is not supported.'
      );
    }
    const plan = this.statusReader.status(qualityPlanId);
    assertConfirmable(plan);
    const elicited = await this.elicit(
      confirmationForm(plan),
      confirmationTimeoutMs(plan, this.options.now?.() ?? Date.now())
    );
    if (elicited.action !== 'accept' || elicited.content?.decision !== 'run') {
      return { status: 'confirmation_declined', qualityPlanId, confirmationMode: 'elicitation' };
    }
    return this.options.runConfirmed(qualityPlanId);
  }

  private async elicit(params: ElicitRequestFormParams, timeoutMs: number): Promise<ElicitResult> {
    try {
      return await this.options.elicitInput(params, timeoutMs);
    } catch (error) {
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
