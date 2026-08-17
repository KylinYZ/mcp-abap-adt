import { createHash, randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type {
  CreateQualityCheckPlanInput,
  QualityCheckContext,
  QualityCheckError,
  QualityCheckPlan,
  QualityCheckPlanView,
  QualityCheckResultSummary,
  QualityCheckStage,
  QualityCheckStatus
} from './qualityTypes.js';

export class QualityCheckPlanStore {
  private readonly plans = new Map<string, QualityCheckPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    private readonly maxEntries: number = 100
  ) {}

  create(input: CreateQualityCheckPlanInput): QualityCheckPlan {
    this.cleanupExpired();
    this.evictTerminalPlans();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError('PLAN_CAPACITY_FULL', 'quality-plan', 'Quality check plan capacity is full.');
    }
    const createdAt = this.now();
    const payload = {
      kind: input.kind,
      objects: structuredClone(input.objects),
      variant: input.variant,
      flags: { ...input.flags },
      timeoutMs: input.timeoutSeconds * 1000
    };
    const plan: QualityCheckPlan = {
      qualityPlanId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      context: normalizeContext(input.context),
      kind: input.kind,
      objects: input.objects.map(snapshot => ({
        objectType: snapshot.object.objectType,
        objectName: snapshot.object.objectName,
        adtType: snapshot.object.adtType,
        ...(snapshot.object.packageName ? { packageName: snapshot.object.packageName } : {})
      })),
      variant: input.variant,
      riskLevel: input.riskLevel,
      duration: input.duration,
      timeoutSeconds: input.timeoutSeconds,
      stateHash: fingerprint(payload.objects),
      payload,
      stages: []
    };
    this.plans.set(plan.qualityPlanId, plan);
    return plan;
  }

  get(qualityPlanId: string): QualityCheckPlan {
    this.cleanupExpired();
    const plan = this.plans.get(qualityPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'quality-plan', 'Quality check plan was not found.');
    return plan;
  }

  getForContext(qualityPlanId: string, context: QualityCheckContext): QualityCheckPlan {
    const plan = this.get(qualityPlanId);
    if (!sameContext(plan.context, normalizeContext(context))) {
      throw new SafeAbapError('POLICY_DENIED', 'quality-plan', 'Quality check plan does not match the current SAP context.');
    }
    return plan;
  }

  beginRun(qualityPlanId: string, context: QualityCheckContext): QualityCheckPlan {
    const plan = this.getForContext(qualityPlanId, context);
    if (plan.status === 'EXPIRED') throw new SafeAbapError('PLAN_EXPIRED', 'quality-plan', 'Quality check plan has expired.');
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'quality-plan', `Quality check plan is already ${plan.status.toLowerCase()}.`);
    }
    plan.status = 'RUNNING';
    plan.confirmationMode = 'elicitation';
    return plan;
  }

  setStatus(qualityPlanId: string, status: QualityCheckStatus): QualityCheckPlan {
    const plan = this.get(qualityPlanId);
    plan.status = status;
    if (isTerminal(status)) {
      plan.terminalAt = this.now();
      plan.payload = undefined;
    }
    return plan;
  }

  recordStage(qualityPlanId: string, stage: Omit<QualityCheckStage, 'timestamp'>): void {
    const plan = this.get(qualityPlanId);
    plan.stages.push({ ...stage, timestamp: new Date(this.now()).toISOString() });
  }

  recordResult(qualityPlanId: string, result?: QualityCheckResultSummary, error?: QualityCheckError): void {
    const plan = this.get(qualityPlanId);
    plan.result = result ? structuredClone(result) : undefined;
    plan.primaryError = error ? { ...error } : undefined;
  }

  view(qualityPlanId: string, context?: QualityCheckContext): QualityCheckPlanView {
    const plan = context ? this.getForContext(qualityPlanId, context) : this.get(qualityPlanId);
    return {
      qualityPlanId: plan.qualityPlanId,
      createdAt: new Date(plan.createdAt).toISOString(),
      expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      sapUser: plan.context.sapUser,
      systemRole: plan.context.systemRole,
      toolProfile: plan.context.toolProfile,
      kind: plan.kind,
      objects: plan.objects.map(object => ({ ...object })),
      variant: plan.variant,
      riskLevel: plan.riskLevel,
      duration: plan.duration,
      timeoutSeconds: plan.timeoutSeconds,
      stateHash: plan.stateHash,
      stages: plan.stages.map(stage => ({ ...stage })),
      confirmationMode: plan.confirmationMode,
      result: plan.result ? structuredClone(plan.result) : undefined,
      primaryError: plan.primaryError ? { ...plan.primaryError } : undefined
    };
  }

  private cleanupExpired(): void {
    const timestamp = this.now();
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && timestamp >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = timestamp;
        plan.payload = undefined;
      }
    }
  }

  private evictTerminalPlans(): void {
    while (this.plans.size >= this.maxEntries) {
      const removable = [...this.plans.values()]
        .filter(plan => isTerminal(plan.status))
        .sort((left, right) => (left.terminalAt || left.createdAt) - (right.terminalAt || right.createdAt))[0];
      if (!removable) return;
      this.plans.delete(removable.qualityPlanId);
    }
  }
}

function normalizeContext(context: QualityCheckContext): QualityCheckContext {
  return {
    systemHost: String(context.systemHost || '').trim().toLowerCase(),
    client: String(context.client || '').trim(),
    sapUser: String(context.sapUser || '').trim().toUpperCase(),
    systemRole: String(context.systemRole || '').trim().toUpperCase(),
    toolProfile: context.toolProfile
  };
}

function sameContext(left: QualityCheckContext, right: QualityCheckContext): boolean {
  return left.systemHost === right.systemHost
    && left.client === right.client
    && left.sapUser === right.sapUser
    && left.systemRole === right.systemRole
    && left.toolProfile === right.toolProfile;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function isTerminal(status: QualityCheckStatus): boolean {
  return status !== 'PREVIEWED' && status !== 'RUNNING';
}
