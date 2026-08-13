import { randomBytes } from 'crypto';
import type { CreationPlan, CreationPlanStatus, CreationPlanView } from './creationTypes.js';
import { SafeAbapError } from './errors.js';

export class CreationPlanStore {
  private readonly plans = new Map<string, CreationPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    private readonly maxEntries: number = 100,
    private readonly compensationFailedRetentionMs: number = 86_400_000
  ) {}

  create(
    input: Omit<CreationPlan, 'creationPlanId' | 'createdAt' | 'expiresAt' | 'status' | 'stages' | 'createdObjects'>
  ): CreationPlan {
    this.cleanupPayloads();
    this.evictRemovablePlans();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError(
        'PLAN_CAPACITY_FULL',
        'plan',
        'Creation plan capacity is full; active and retained compensation plans cannot be evicted safely.'
      );
    }
    const createdAt = this.now();
    const plan: CreationPlan = {
      ...input,
      creationPlanId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      stages: [],
      createdObjects: []
    };
    this.plans.set(plan.creationPlanId, plan);
    return plan;
  }

  get(creationPlanId: string): CreationPlan {
    this.cleanupPayloads();
    const plan = this.plans.get(creationPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'plan', 'Creation plan was not found.');
    return plan;
  }

  beginApply(creationPlanId: string): CreationPlan {
    const plan = this.get(creationPlanId);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Creation plan has expired. Create a new preview.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError(
        'PLAN_ALREADY_CONSUMED',
        'plan',
        `Creation plan is already ${plan.status.toLowerCase()}.`
      );
    }
    plan.status = 'APPLYING';
    return plan;
  }

  setStatus(creationPlanId: string, status: CreationPlanStatus): CreationPlan {
    const plan = this.get(creationPlanId);
    plan.status = status;
    if (isTerminal(status)) {
      plan.terminalAt = this.now();
      if (status !== 'COMPENSATION_FAILED') this.purgePayload(plan);
    }
    this.cleanupPayloads();
    return plan;
  }

  view(creationPlanId: string): CreationPlanView {
    const plan = this.get(creationPlanId);
    return {
      creationPlanId: plan.creationPlanId,
      createdAt: new Date(plan.createdAt).toISOString(),
      expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status,
      systemHost: plan.systemHost,
      client: plan.client,
      transportRequest: plan.transportRequest,
      objects: plan.objects.map(object => ({
        objectType: object.objectType,
        objectName: object.objectName,
        description: object.description,
        packageName: object.packageName,
        parentFunctionGroup: object.parentFunctionGroup,
        objectUrl: object.objectUrl,
        sourceHash: object.sourceHash
      })),
      stages: [...plan.stages],
      createdObjects: plan.createdObjects.map(object => ({
        objectType: object.objectType,
        objectName: object.objectName,
        actualObjectUrl: object.actualObjectUrl,
        ownershipProven: object.ownershipProven,
        unlockSucceeded: object.unlockSucceeded,
        verifiedSourceHash: object.verifiedSourceHash,
        sourceMatchType: object.sourceMatchType,
        compensationAttempted: object.compensationAttempted,
        compensationSucceeded: object.compensationSucceeded
      })),
      primaryError: plan.primaryError,
      confirmationMode: plan.confirmationMode,
      compensationAttempted: plan.compensationAttempted,
      compensationSucceeded: plan.compensationSucceeded
    };
  }

  private cleanupPayloads(): void {
    const timestamp = this.now();
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && timestamp >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = timestamp;
        this.purgePayload(plan);
      } else if (plan.status === 'COMPENSATION_FAILED'
        && plan.terminalAt !== undefined
        && timestamp - plan.terminalAt >= this.compensationFailedRetentionMs) {
        this.purgePayload(plan);
      }
    }
  }

  private purgePayload(plan: CreationPlan): void {
    for (const object of plan.objects) object.source = undefined;
    for (const object of plan.createdObjects) object.source = undefined;
  }

  private evictRemovablePlans(): void {
    while (this.plans.size >= this.maxEntries) {
      const removable = [...this.plans.values()]
        .filter(plan => isTerminal(plan.status)
          && (plan.status !== 'COMPENSATION_FAILED'
            || (plan.terminalAt !== undefined
              && this.now() - plan.terminalAt >= this.compensationFailedRetentionMs)))
        .sort((left, right) => (left.terminalAt || left.createdAt) - (right.terminalAt || right.createdAt))[0];
      if (!removable) return;
      this.plans.delete(removable.creationPlanId);
    }
  }
}

function isTerminal(status: CreationPlanStatus): boolean {
  return ['APPLIED', 'COMPENSATED', 'COMPENSATION_FAILED', 'FAILED', 'EXPIRED'].includes(status);
}
