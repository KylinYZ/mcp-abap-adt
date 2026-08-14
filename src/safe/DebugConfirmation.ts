import {
  ErrorCode,
  McpError,
  type ElicitRequestFormParams,
  type ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import { DebugControlWorkflow, type ApplyDebugOperationInput } from './DebugControlWorkflow.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { DebugOperationPlanView } from './debugTypes.js';

export interface DebugConfirmationOptions {
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  applyConfirmed?: (input: ApplyDebugOperationInput) => Promise<Record<string, unknown>>;
  authorizeConfirmed?: (targetUser: string, debuggeeId: string) => Promise<Record<string, unknown>>;
}

const MAX_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export class DebugConfirmation {
  constructor(
    private readonly workflow: DebugControlWorkflow,
    private readonly options: DebugConfirmationOptions
  ) {}

  async confirmAndApply(
    debugOperationPlanId: string,
    expectedKind: 'VARIABLE' | 'OPERATION'
  ): Promise<Record<string, unknown>> {
    this.assertFormSupported();
    const plan = this.workflow.status(debugOperationPlanId);
    this.assertConfirmable(plan);
    const isVariable = plan.operation.kind === 'SET_VARIABLE';
    if ((expectedKind === 'VARIABLE') !== isVariable) {
      throw new SafeAbapError(
        'POLICY_DENIED',
        'confirmation',
        isVariable ? 'Use applyDebugVariableChange for this plan.' : 'Use applyDebugOperation for this plan.'
      );
    }

    const result = await this.elicit(this.operationForm(plan), confirmationTimeoutMs(plan));
    if (result.action !== 'accept' || result.content?.decision !== 'apply') {
      return {
        status: 'confirmation_declined',
        debugOperationPlanId,
        confirmationMode: 'elicitation'
      };
    }
    const input = { debugOperationPlanId, confirmedByUser: true };
    return this.options.applyConfirmed ? this.options.applyConfirmed(input) : this.workflow.applyOperation(input);
  }

  async confirmAndAuthorize(targetUser: string, debuggeeId: string): Promise<Record<string, unknown>> {
    this.assertFormSupported();
    const attach = this.workflow.currentAttach(targetUser, debuggeeId);
    const result = await this.elicit({
      mode: 'form',
      message: `授权 DEV 调试控制 · 用户 ${targetUser} · debuggee ${debuggeeId} · 进程 ${attach.processId}`,
      requestedSchema: confirmationSchema('授权 15 分钟调试控制')
    }, MAX_CONFIRMATION_TIMEOUT_MS);
    if (result.action !== 'accept' || result.content?.decision !== 'apply') {
      return { status: 'confirmation_declined', confirmationMode: 'elicitation', targetUser, debuggeeId };
    }
    return this.options.authorizeConfirmed
      ? this.options.authorizeConfirmed(targetUser, debuggeeId)
      : this.workflow.authorizeConfirmed(targetUser, debuggeeId);
  }

  private async elicit(params: ElicitRequestFormParams, timeoutMs: number): Promise<ElicitResult> {
    try {
      return await this.options.elicitInput(params, timeoutMs);
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        return { action: 'cancel' };
      }
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', `The client confirmation dialog failed: ${errorMessage(error)}`);
    }
  }

  private operationForm(plan: DebugOperationPlanView): ElicitRequestFormParams {
    return {
      mode: 'form',
      message: `${plan.summary} · ${plan.systemHost}/${plan.client} · 用户 ${plan.targetUser} · 风险：${plan.risk}`,
      requestedSchema: confirmationSchema(plan.operation.kind === 'SET_VARIABLE' ? '修改运行时变量' : '执行调试操作')
    };
  }

  private assertFormSupported(): void {
    if (!this.options.supportsFormElicitation()) {
      throw new SafeAbapError(
        'CONFIRMATION_UNSUPPORTED',
        'confirmation',
        'Safe debug control requires MCP form elicitation; text confirmation fallback is not supported.'
      );
    }
  }

  private assertConfirmable(plan: DebugOperationPlanView): void {
    if (plan.status === 'EXPIRED') throw new SafeAbapError('PLAN_EXPIRED', 'debug-plan', 'Debug operation plan has expired.');
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'debug-plan', `Debug operation plan is already ${plan.status.toLowerCase()}.`);
    }
  }
}

function confirmationSchema(applyTitle: string): ElicitRequestFormParams['requestedSchema'] {
  return {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        title: '请选择操作',
        oneOf: [
          { const: 'apply', title: applyTitle },
          { const: 'cancel', title: '取消' }
        ]
      }
    },
    required: ['decision']
  };
}

function confirmationTimeoutMs(plan: DebugOperationPlanView): number {
  const remaining = Date.parse(plan.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new SafeAbapError('PLAN_EXPIRED', 'debug-plan', 'Debug operation plan has expired.');
  }
  return Math.min(remaining, MAX_CONFIRMATION_TIMEOUT_MS);
}
