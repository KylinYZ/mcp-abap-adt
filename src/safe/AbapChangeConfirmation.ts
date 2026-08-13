import { createHash, randomInt, timingSafeEqual } from 'crypto';
import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import { AbapChangeWorkflow } from './AbapChangeWorkflow.js';
import type { ApplyChangeInput } from './AbapChangeWorkflow.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { ChangePlanView, ConfirmationMode } from './types.js';

export interface AbapChangeConfirmationOptions {
  allowTextConfirmation: boolean;
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  applyConfirmed?: (input: ApplyChangeInput) => Promise<Record<string, unknown>>;
  createTextCode?: () => string;
}

const MAX_FORM_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

interface TextChallenge {
  expectedHash: string;
  expiresAt: number;
}

export class AbapChangeConfirmation {
  private readonly textChallenges = new Map<string, TextChallenge>();

  constructor(
    private readonly workflow: AbapChangeWorkflow,
    private readonly options: AbapChangeConfirmationOptions
  ) {}

  async confirmAndApply(changePlanId: string, textConfirmation?: string): Promise<Record<string, unknown>> {
    this.cleanupExpiredChallenges();
    const plan = this.assertConfirmable(this.workflow.status(changePlanId));

    if (this.options.supportsFormElicitation()) {
      this.textChallenges.delete(changePlanId);
      return this.confirmWithForm(plan);
    }

    if (!this.options.allowTextConfirmation) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'This MCP client does not support form elicitation and text confirmation fallback is disabled.'
      );
    }

    return this.confirmWithText(plan, textConfirmation);
  }

  private async confirmWithForm(plan: ChangePlanView): Promise<Record<string, unknown>> {
    let result: ElicitResult;
    try {
      result = await this.options.elicitInput(this.formRequest(plan), confirmationTimeoutMs(plan));
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        return {
          status: 'confirmation_declined',
          changePlanId: plan.changePlanId,
          confirmationMode: 'elicitation',
          reason: 'timeout'
        };
      }
      throw new SafeAbapError(
        'POLICY_DENIED',
        'confirmation',
        `The client confirmation dialog failed: ${errorMessage(error)}`
      );
    }

    if (result.action !== 'accept' || result.content?.decision !== 'apply') {
      return {
        status: 'confirmation_declined',
        changePlanId: plan.changePlanId,
        confirmationMode: 'elicitation'
      };
    }

    return this.applyConfirmed(plan.changePlanId, 'elicitation');
  }

  private confirmWithText(plan: ChangePlanView, textConfirmation?: string): Promise<Record<string, unknown>> | Record<string, unknown> {
    const existing = this.textChallenges.get(plan.changePlanId);
    if (existing && textConfirmation) {
      const candidateHash = this.challengeHash(plan, textConfirmation.trim());
      if (safeHashEquals(existing.expectedHash, candidateHash) && Date.now() < existing.expiresAt) {
        this.textChallenges.delete(plan.changePlanId);
        return this.applyConfirmed(plan.changePlanId, 'text-fallback');
      }
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'The text confirmation phrase did not match this change plan.');
    }

    const code = this.options.createTextCode?.() || randomInt(0, 1_000_000).toString().padStart(6, '0');
    const confirmationText = `确认应用 ${plan.changePlanId} 验证码 ${code}`;
    this.textChallenges.set(plan.changePlanId, {
      expectedHash: this.challengeHash(plan, confirmationText),
      expiresAt: Date.parse(plan.expiresAt)
    });

    return {
      status: 'confirmation_required',
      confirmationRequired: true,
      changePlanId: plan.changePlanId,
      confirmationMode: 'text-fallback',
      confirmationText,
      expiresAt: plan.expiresAt,
      warning: 'Text confirmation is weaker than native MCP elicitation because the server cannot prove who authored the chat message.'
    };
  }

  private applyConfirmed(changePlanId: string, confirmationMode: ConfirmationMode): Promise<Record<string, unknown>> {
    const input: ApplyChangeInput = { changePlanId, confirmedByUser: true, confirmationMode };
    return this.options.applyConfirmed ? this.options.applyConfirmed(input) : this.workflow.apply(input);
  }

  private formRequest(plan: ChangePlanView): ElicitRequestFormParams {
    return {
      mode: 'form',
      message: `应用 ${plan.object.objectName} · 传输 ${plan.transportRequest} · +${plan.diffSummary.addedLines}/-${plan.diffSummary.removedLines}`,
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            title: '请选择操作',
            oneOf: [
              { const: 'apply', title: '应用变更' },
              { const: 'cancel', title: '取消' }
            ]
          }
        },
        required: ['decision']
      }
    };
  }

  private challengeHash(plan: ChangePlanView, confirmationText: string): string {
    return createHash('sha256')
      .update(`${plan.changePlanId}\n${plan.targetHash}\n${confirmationText}`, 'utf8')
      .digest('hex');
  }

  private assertConfirmable(plan: ChangePlanView): ChangePlanView {
    if (plan.status === 'EXPIRED') {
      this.textChallenges.delete(plan.changePlanId);
      throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Change plan has expired. Create a new preview.');
    }
    if (plan.status !== 'PREVIEWED') {
      this.textChallenges.delete(plan.changePlanId);
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'plan', `Change plan is already ${plan.status.toLowerCase()}.`);
    }
    return plan;
  }

  private cleanupExpiredChallenges(): void {
    const timestamp = Date.now();
    for (const [changePlanId, challenge] of this.textChallenges) {
      if (timestamp >= challenge.expiresAt) this.textChallenges.delete(changePlanId);
    }
  }
}

function confirmationTimeoutMs(plan: ChangePlanView): number {
  const remainingPlanMs = Date.parse(plan.expiresAt) - Date.now();
  if (!Number.isFinite(remainingPlanMs) || remainingPlanMs <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Change plan has expired. Create a new preview.');
  }
  return Math.min(remainingPlanMs, MAX_FORM_CONFIRMATION_TIMEOUT_MS);
}

function safeHashEquals(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
