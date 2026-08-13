import { createHash, randomInt, timingSafeEqual } from 'crypto';
import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import { AbapObjectCreationWorkflow } from './AbapObjectCreationWorkflow.js';
import type { ApplyCreationInput, CreationPlanView } from './creationTypes.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { ConfirmationMode } from './types.js';

export interface AbapCreationConfirmationOptions {
  allowTextConfirmation: boolean;
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  applyConfirmed?: (input: ApplyCreationInput) => Promise<Record<string, unknown>>;
  createTextCode?: () => string;
}

const MAX_FORM_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

interface TextChallenge {
  expectedHash: string;
  expiresAt: number;
}

export class AbapCreationConfirmation {
  private readonly textChallenges = new Map<string, TextChallenge>();

  constructor(
    private readonly workflow: AbapObjectCreationWorkflow,
    private readonly options: AbapCreationConfirmationOptions
  ) {}

  async confirmAndApply(creationPlanId: string, textConfirmation?: string): Promise<Record<string, unknown>> {
    this.cleanupExpiredChallenges();
    const plan = this.assertConfirmable(this.workflow.status(creationPlanId));

    if (this.options.supportsFormElicitation()) {
      this.textChallenges.delete(creationPlanId);
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

  private async confirmWithForm(plan: CreationPlanView): Promise<Record<string, unknown>> {
    let result: ElicitResult;
    try {
      result = await this.options.elicitInput(this.formRequest(plan), confirmationTimeoutMs(plan));
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        return {
          status: 'confirmation_declined',
          creationPlanId: plan.creationPlanId,
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
        creationPlanId: plan.creationPlanId,
        confirmationMode: 'elicitation'
      };
    }

    return this.applyConfirmed(plan.creationPlanId, 'elicitation');
  }

  private confirmWithText(
    plan: CreationPlanView,
    textConfirmation?: string
  ): Promise<Record<string, unknown>> | Record<string, unknown> {
    const existing = this.textChallenges.get(plan.creationPlanId);
    if (existing && textConfirmation) {
      const candidateHash = this.challengeHash(plan, textConfirmation.trim());
      if (safeHashEquals(existing.expectedHash, candidateHash) && Date.now() < existing.expiresAt) {
        this.textChallenges.delete(plan.creationPlanId);
        return this.applyConfirmed(plan.creationPlanId, 'text-fallback');
      }
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'The text confirmation phrase did not match this creation plan.');
    }

    const code = this.options.createTextCode?.() || randomInt(0, 1_000_000).toString().padStart(6, '0');
    const confirmationText = `确认创建 ${plan.creationPlanId} 验证码 ${code}`;
    this.textChallenges.set(plan.creationPlanId, {
      expectedHash: this.challengeHash(plan, confirmationText),
      expiresAt: Date.parse(plan.expiresAt)
    });

    return {
      status: 'confirmation_required',
      confirmationRequired: true,
      creationPlanId: plan.creationPlanId,
      confirmationMode: 'text-fallback',
      confirmationText,
      expiresAt: plan.expiresAt,
      warning: 'Text confirmation is weaker than native MCP elicitation because the server cannot prove who authored the chat message.'
    };
  }

  private applyConfirmed(creationPlanId: string, confirmationMode: ConfirmationMode): Promise<Record<string, unknown>> {
    const input: ApplyCreationInput = { creationPlanId, confirmedByUser: true, confirmationMode };
    return this.options.applyConfirmed ? this.options.applyConfirmed(input) : this.workflow.apply(input);
  }

  private formRequest(plan: CreationPlanView): ElicitRequestFormParams {
    const objects = plan.objects.map(object => `${object.objectType} ${object.objectName}`).join('、');
    return {
      mode: 'form',
      message: `创建 ${objects} · 传输 ${plan.transportRequest}`,
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            title: '请选择操作',
            oneOf: [
              { const: 'apply', title: '创建对象' },
              { const: 'cancel', title: '取消' }
            ]
          }
        },
        required: ['decision']
      }
    };
  }

  private challengeHash(plan: CreationPlanView, confirmationText: string): string {
    const objectFingerprint = plan.objects.map(object => ({
      objectType: object.objectType,
      objectName: object.objectName,
      packageName: object.packageName,
      parentFunctionGroup: object.parentFunctionGroup,
      sourceHash: object.sourceHash
    }));
    return createHash('sha256')
      .update(`${plan.creationPlanId}\n${plan.transportRequest}\n${JSON.stringify(objectFingerprint)}\n${confirmationText}`, 'utf8')
      .digest('hex');
  }

  private assertConfirmable(plan: CreationPlanView): CreationPlanView {
    if (plan.status === 'EXPIRED') {
      this.textChallenges.delete(plan.creationPlanId);
      throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Creation plan has expired. Create a new preview.');
    }
    if (plan.status !== 'PREVIEWED') {
      this.textChallenges.delete(plan.creationPlanId);
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'plan', `Creation plan is already ${plan.status.toLowerCase()}.`);
    }
    return plan;
  }

  private cleanupExpiredChallenges(): void {
    const timestamp = Date.now();
    for (const [creationPlanId, challenge] of this.textChallenges) {
      if (timestamp >= challenge.expiresAt) this.textChallenges.delete(creationPlanId);
    }
  }
}

function confirmationTimeoutMs(plan: CreationPlanView): number {
  const remainingPlanMs = Date.parse(plan.expiresAt) - Date.now();
  if (!Number.isFinite(remainingPlanMs) || remainingPlanMs <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Creation plan has expired. Create a new preview.');
  }
  return Math.min(remainingPlanMs, MAX_FORM_CONFIRMATION_TIMEOUT_MS);
}

function safeHashEquals(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
