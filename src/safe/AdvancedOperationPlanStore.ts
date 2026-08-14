import { createHash, randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type {
  AdvancedOperationError,
  AdvancedOperationPlan,
  AdvancedOperationPlanView,
  AdvancedOperationStage,
  AdvancedOperationStatus,
  AdvancedPlanContext,
  CreateAdvancedOperationPlanInput
} from './advancedTypes.js';

export class AdvancedOperationPlanStore {
  private readonly plans = new Map<string, AdvancedOperationPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    private readonly maxEntries: number = 100
  ) {}

  create(input: CreateAdvancedOperationPlanInput): AdvancedOperationPlan {
    this.cleanupExpired();
    this.evictTerminalPlans();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError(
        'PLAN_CAPACITY_FULL',
        'advanced-plan',
        'Advanced operation plan capacity is full; active plans cannot be evicted safely.'
      );
    }
    const createdAt = this.now();
    const payload = structuredClone(input.payload);
    const plan: AdvancedOperationPlan = {
      operationPlanId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      context: normalizeContext(input.context),
      operationKind: payload.kind,
      target: { ...input.target },
      transport: input.transport,
      inputSummary: structuredClone(input.inputSummary),
      currentStateSummary: { ...input.currentStateSummary },
      payloadFingerprint: fingerprint(payload),
      payload,
      rollbackSupported: input.rollbackSupported,
      stages: []
    };
    this.plans.set(plan.operationPlanId, plan);
    return plan;
  }

  get(operationPlanId: string): AdvancedOperationPlan {
    this.cleanupExpired();
    const plan = this.plans.get(operationPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'advanced-plan', 'Advanced operation plan was not found.');
    return plan;
  }

  getForContext(operationPlanId: string, context: AdvancedPlanContext): AdvancedOperationPlan {
    const plan = this.get(operationPlanId);
    this.assertContext(plan, context);
    return plan;
  }

  beginApply(operationPlanId: string, context: AdvancedPlanContext): AdvancedOperationPlan {
    const plan = this.getForContext(operationPlanId, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'advanced-plan', 'Advanced operation plan has expired. Create a new preview.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'advanced-plan', `Advanced operation plan is already ${plan.status.toLowerCase()}.`);
    }
    plan.status = 'APPLYING';
    return plan;
  }

  setStatus(operationPlanId: string, status: AdvancedOperationStatus): AdvancedOperationPlan {
    const plan = this.get(operationPlanId);
    plan.status = status;
    if (isTerminal(status)) {
      plan.terminalAt = this.now();
      purgePayload(plan);
    } else {
      plan.terminalAt = undefined;
    }
    return plan;
  }

  recordStage(operationPlanId: string, stage: Omit<AdvancedOperationStage, 'timestamp'>): AdvancedOperationPlan {
    const plan = this.get(operationPlanId);
    plan.stages.push({ ...stage, timestamp: new Date(this.now()).toISOString() });
    return plan;
  }

  recordResult(operationPlanId: string, resultSummary: string, primaryError?: AdvancedOperationError): AdvancedOperationPlan {
    const plan = this.get(operationPlanId);
    plan.resultSummary = resultSummary;
    plan.primaryError = primaryError;
    return plan;
  }

  view(operationPlanId: string, context?: AdvancedPlanContext): AdvancedOperationPlanView {
    const plan = context ? this.getForContext(operationPlanId, context) : this.get(operationPlanId);
    return {
      operationPlanId: plan.operationPlanId,
      createdAt: new Date(plan.createdAt).toISOString(),
      expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      toolProfile: plan.context.toolProfile,
      operationKind: plan.operationKind,
      target: { ...plan.target },
      transport: plan.transport,
      inputSummary: structuredClone(plan.inputSummary),
      currentStateSummary: { ...plan.currentStateSummary },
      payloadFingerprint: { ...plan.payloadFingerprint },
      rollbackSupported: plan.rollbackSupported,
      stages: plan.stages.map(stage => ({ ...stage })),
      confirmationMode: plan.confirmationMode,
      resultSummary: plan.resultSummary,
      primaryError: plan.primaryError ? { ...plan.primaryError } : undefined
    };
  }

  private assertContext(plan: AdvancedOperationPlan, context: AdvancedPlanContext): void {
    const expected = normalizeContext(context);
    if (
      plan.context.systemHost !== expected.systemHost
      || plan.context.client !== expected.client
      || plan.context.systemRole !== expected.systemRole
      || plan.context.toolProfile !== expected.toolProfile
    ) {
      throw new SafeAbapError('POLICY_DENIED', 'advanced-plan', 'Advanced operation plan does not match the current SAP context.');
    }
  }

  private cleanupExpired(): void {
    const timestamp = this.now();
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && timestamp >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = timestamp;
        purgePayload(plan);
      }
    }
  }

  private evictTerminalPlans(): void {
    while (this.plans.size >= this.maxEntries) {
      const removable = [...this.plans.values()]
        .filter(plan => isTerminal(plan.status))
        .sort((left, right) => (left.terminalAt || left.createdAt) - (right.terminalAt || right.createdAt))[0];
      if (!removable) return;
      this.plans.delete(removable.operationPlanId);
    }
  }
}

function fingerprint(payload: NonNullable<AdvancedOperationPlan['payload']>) {
  const input = stableJson(payload.input);
  const drift = stableJson(payload.drift);
  const recovery = 'recovery' in payload ? stableJson(payload.recovery) : undefined;
  return {
    inputHash: hash(input),
    inputBytes: Buffer.byteLength(input, 'utf8'),
    driftHash: hash(drift),
    driftBytes: Buffer.byteLength(drift, 'utf8'),
    ...(recovery === undefined ? {} : {
      recoveryHash: hash(recovery),
      recoveryBytes: Buffer.byteLength(recovery, 'utf8')
    })
  };
}

function purgePayload(plan: AdvancedOperationPlan): void {
  plan.payload = undefined;
}

function normalizeContext(context: AdvancedPlanContext): AdvancedPlanContext {
  return {
    systemHost: String(context.systemHost || '').trim().toLowerCase(),
    client: String(context.client || '').trim(),
    systemRole: String(context.systemRole || '').trim().toUpperCase(),
    toolProfile: context.toolProfile
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isTerminal(status: AdvancedOperationStatus): boolean {
  return status !== 'PREVIEWED' && status !== 'APPLYING';
}
