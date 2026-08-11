import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { AbapChangeWorkflow } from './AbapChangeWorkflow.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { ChangePlanView, ConfirmationMode } from './types.js';

export interface AbapChangeConfirmationOptions {
  allowTextConfirmation: boolean;
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
  createTextCode?: () => string;
}

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
      result = await this.options.elicitInput(this.formRequest(plan));
    } catch (error) {
      throw new SafeAbapError(
        'POLICY_DENIED',
        'confirmation',
        `The client confirmation dialog failed: ${errorMessage(error)}`
      );
    }

    if (result.action !== 'accept' || result.content?.confirmApply !== true) {
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
    return this.workflow.apply({ changePlanId, confirmedByUser: true, confirmationMode });
  }

  private formRequest(plan: ChangePlanView): ElicitRequestFormParams {
    return {
      mode: 'form',
      message: [
        '确认应用 SAP ABAP 变更',
        `对象: ${plan.object.objectType} ${plan.object.objectName}`,
        `传输请求: ${plan.transportRequest}`,
        `计划 ID: ${plan.changePlanId}`,
        `原始哈希: ${plan.originalHash}`,
        `目标哈希: ${plan.targetHash}`,
        `Diff 摘要: +${plan.diffSummary.addedLines} / -${plan.diffSummary.removedLines}`
      ].join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          confirmApply: {
            type: 'boolean',
            title: '我已审阅完整 diff 并确认应用',
            description: '确认后将锁定、写入并激活该 SAP 对象。',
            default: false
          }
        },
        required: ['confirmApply']
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
}

function safeHashEquals(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
