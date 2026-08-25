import { randomUUID } from 'crypto';
import { SafeAbapError } from './errors.js';
import type {
  PreparedRepositoryCreation,
  RepositoryCreationContext,
  RepositoryCreationPlan,
  RepositoryCreationPlanStatus,
  RepositoryCreationPlanView
} from './repositoryCreationTypes.js';

export class RepositoryObjectCreationPlanStore {
  private readonly plans = new Map<string, RepositoryCreationPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly idFactory: () => string = () => randomUUID(),
    private readonly maxEntries = 100
  ) {}

  create(
    context: RepositoryCreationContext,
    prepared: PreparedRepositoryCreation,
    fingerprint: { payloadHash: string; payloadBytes: number }
  ): RepositoryCreationPlanView {
    this.expireAndEvict();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError('PLAN_CAPACITY_FULL', 'plan', 'Repository creation plan capacity is full.');
    }
    const createdAt = this.now();
    const plan: RepositoryCreationPlan = {
      creationPlanId: this.idFactory(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      context: normalizeContext(context),
      target: clone(prepared.target),
      transportRequest: prepared.transportRequest,
      summary: prepared.summary,
      payloadHash: fingerprint.payloadHash,
      payloadBytes: fingerprint.payloadBytes,
      payload: clone(prepared.payload),
      stages: [],
      compensationLimits: [...prepared.compensationLimits]
    };
    this.plans.set(plan.creationPlanId, plan);
    return view(plan);
  }

  view(creationPlanId: string, context: RepositoryCreationContext): RepositoryCreationPlanView {
    return view(this.require(creationPlanId, context));
  }

  begin(creationPlanId: string, context: RepositoryCreationContext): RepositoryCreationPlan {
    const plan = this.require(creationPlanId, context);
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'plan', 'Repository creation plans may be applied exactly once.');
    }
    plan.status = 'APPLYING';
    return plan;
  }

  recordStage(creationPlanId: string, stage: string, success: boolean, message?: string): void {
    const plan = this.plans.get(creationPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'plan', 'Repository creation plan was not found.');
    plan.stages.push({ stage, success, timestamp: new Date(this.now()).toISOString(), ...(message ? { message } : {}) });
  }

  settle(
    creationPlanId: string,
    status: Exclude<RepositoryCreationPlanStatus, 'PREVIEWED' | 'APPLYING' | 'EXPIRED'>,
    update: Partial<Pick<RepositoryCreationPlan, 'actualResources' | 'resultSummary' | 'primaryError'>> = {}
  ): RepositoryCreationPlanView {
    const plan = this.plans.get(creationPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'plan', 'Repository creation plan was not found.');
    Object.assign(plan, clone(update));
    plan.status = status;
    plan.terminalAt = this.now();
    // Terminal records retain fingerprints and recovery evidence, never the full creation payload.
    delete plan.payload;
    return view(plan);
  }

  private require(creationPlanId: string, context: RepositoryCreationContext): RepositoryCreationPlan {
    const plan = this.plans.get(String(creationPlanId || ''));
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'plan', 'Repository creation plan was not found.');
    if (this.now() >= plan.expiresAt && plan.status === 'PREVIEWED') {
      plan.status = 'EXPIRED';
      plan.terminalAt = this.now();
      delete plan.payload;
      throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Repository creation plan has expired.');
    }
    if (JSON.stringify(plan.context) !== JSON.stringify(normalizeContext(context))) {
      throw new SafeAbapError('POLICY_DENIED', 'plan', 'Repository creation plan belongs to a different SAP or MCP context.');
    }
    return plan;
  }

  private expireAndEvict(): void {
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && this.now() >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = this.now();
        delete plan.payload;
      }
    }
    const terminal = [...this.plans.values()]
      .filter(plan => plan.terminalAt !== undefined)
      .sort((left, right) => (left.terminalAt || 0) - (right.terminalAt || 0));
    while (this.plans.size >= this.maxEntries && terminal.length > 0) {
      this.plans.delete(terminal.shift()!.creationPlanId);
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

function view(plan: RepositoryCreationPlan): RepositoryCreationPlanView {
  return clone({
    creationPlanId: plan.creationPlanId,
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
    summary: plan.summary,
    payloadHash: plan.payloadHash,
    payloadBytes: plan.payloadBytes,
    stages: plan.stages,
    compensationLimits: plan.compensationLimits,
    actualResources: plan.actualResources,
    resultSummary: plan.resultSummary,
    primaryError: plan.primaryError
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
