import { randomUUID } from 'crypto';
import { SafeAbapError } from './errors.js';
import type { RepositoryCreationContext } from './repositoryCreationTypes.js';
import type {
  PreparedRepositoryCleanup,
  RepositoryCleanupPlan,
  RepositoryCleanupPlanStatus,
  RepositoryCleanupPlanView
} from './repositoryCleanupTypes.js';

export class RepositoryObjectCleanupPlanStore {
  private readonly plans = new Map<string, RepositoryCleanupPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly idFactory: () => string = () => randomUUID(),
    private readonly maxEntries = 100
  ) {}

  create(
    context: RepositoryCreationContext,
    prepared: PreparedRepositoryCleanup,
    fingerprint: { payloadHash: string; payloadBytes: number }
  ): RepositoryCleanupPlanView {
    this.expireAndEvict();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError('PLAN_CAPACITY_FULL', 'cleanup-plan', 'Repository cleanup plan capacity is full.');
    }
    const createdAt = this.now();
    const plan: RepositoryCleanupPlan = {
      cleanupPlanId: this.idFactory(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      context: normalizeContext(context),
      target: clone(prepared.target),
      transportRequest: prepared.transportRequest,
      dependencySummary: [...prepared.dependencySummary],
      summary: prepared.summary,
      payloadHash: fingerprint.payloadHash,
      payloadBytes: fingerprint.payloadBytes,
      cleanupOrder: prepared.resources.map(resource => ({
        objectKind: resource.objectKind,
        objectName: resource.objectName,
        adtType: resource.adtType
      })),
      resources: clone(prepared.resources),
      stages: []
    };
    this.plans.set(plan.cleanupPlanId, plan);
    return view(plan);
  }

  view(cleanupPlanId: string, context: RepositoryCreationContext): RepositoryCleanupPlanView {
    return view(this.require(cleanupPlanId, context));
  }

  begin(cleanupPlanId: string, context: RepositoryCreationContext): RepositoryCleanupPlan {
    const plan = this.require(cleanupPlanId, context);
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'cleanup-plan', 'Repository cleanup plans may be applied exactly once.');
    }
    plan.status = 'APPLYING';
    return plan;
  }

  recordStage(cleanupPlanId: string, stage: string, success: boolean, message?: string): void {
    const plan = this.plans.get(cleanupPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'cleanup-plan', 'Repository cleanup plan was not found.');
    plan.stages.push({ stage, success, timestamp: new Date(this.now()).toISOString(), ...(message ? { message } : {}) });
  }

  settle(
    cleanupPlanId: string,
    status: Exclude<RepositoryCleanupPlanStatus, 'PREVIEWED' | 'APPLYING' | 'EXPIRED'>,
    update: Partial<Pick<RepositoryCleanupPlan, 'resultSummary' | 'primaryError'>> = {}
  ): RepositoryCleanupPlanView {
    const plan = this.plans.get(cleanupPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'cleanup-plan', 'Repository cleanup plan was not found.');
    Object.assign(plan, clone(update));
    plan.status = status;
    plan.terminalAt = this.now();
    // Terminal cleanup records retain evidence fingerprints, never destructive execution payloads.
    delete plan.resources;
    return view(plan);
  }

  private require(cleanupPlanId: string, context: RepositoryCreationContext): RepositoryCleanupPlan {
    const plan = this.plans.get(String(cleanupPlanId || ''));
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'cleanup-plan', 'Repository cleanup plan was not found.');
    if (this.now() >= plan.expiresAt && plan.status === 'PREVIEWED') {
      plan.status = 'EXPIRED';
      plan.terminalAt = this.now();
      delete plan.resources;
      throw new SafeAbapError('PLAN_EXPIRED', 'cleanup-plan', 'Repository cleanup plan has expired.');
    }
    if (JSON.stringify(plan.context) !== JSON.stringify(normalizeContext(context))) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-plan', 'Repository cleanup plan belongs to a different SAP or MCP context.');
    }
    return plan;
  }

  private expireAndEvict(): void {
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && this.now() >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = this.now();
        delete plan.resources;
      }
    }
    const terminal = [...this.plans.values()]
      .filter(plan => plan.terminalAt !== undefined)
      .sort((left, right) => (left.terminalAt || 0) - (right.terminalAt || 0));
    while (this.plans.size >= this.maxEntries && terminal.length > 0) {
      this.plans.delete(terminal.shift()!.cleanupPlanId);
    }
  }
}

function normalizeContext(context: RepositoryCreationContext): RepositoryCreationContext {
  return {
    systemHost: String(context.systemHost || '').toLowerCase(),
    client: String(context.client || ''),
    sapUser: String(context.sapUser || '').toUpperCase(),
    systemRole: String(context.systemRole || '').toUpperCase(),
    toolProfile: context.toolProfile,
    realDevValidationEnabled: context.realDevValidationEnabled === true,
    realDevValidationObjects: [...new Set((context.realDevValidationObjects || []).map(item => String(item).toUpperCase()))].sort(),
    realDevValidationPrefix: String(context.realDevValidationPrefix || '').toUpperCase(),
    realDevValidationPackage: String(context.realDevValidationPackage || '').toUpperCase(),
    realDevValidationTransport: String(context.realDevValidationTransport || '').toUpperCase()
  };
}

function view(plan: RepositoryCleanupPlan): RepositoryCleanupPlanView {
  return clone({
    cleanupPlanId: plan.cleanupPlanId,
    createdAt: new Date(plan.createdAt).toISOString(),
    expiresAt: new Date(plan.expiresAt).toISOString(),
    ...(plan.terminalAt !== undefined ? { terminalAt: new Date(plan.terminalAt).toISOString() } : {}),
    status: plan.status,
    systemHost: String(plan.context.systemHost || ''),
    client: String(plan.context.client || ''),
    sapUser: String(plan.context.sapUser || ''),
    systemRole: plan.context.systemRole,
    toolProfile: plan.context.toolProfile,
    target: plan.target,
    transportRequest: plan.transportRequest,
    dependencySummary: plan.dependencySummary,
    summary: plan.summary,
    payloadHash: plan.payloadHash,
    payloadBytes: plan.payloadBytes,
    cleanupOrder: plan.cleanupOrder,
    stages: plan.stages,
    resultSummary: plan.resultSummary,
    primaryError: plan.primaryError
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
