import { randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type { ChangePlan, ChangePlanStatus, ChangePlanView } from './types.js';

export class ChangePlanStore {
  private readonly plans = new Map<string, ChangePlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    private readonly maxEntries: number = 100,
    private readonly rollbackFailedRetentionMs: number = 86_400_000
  ) {}

  create(plan: Omit<ChangePlan, 'changePlanId' | 'createdAt' | 'expiresAt' | 'status' | 'stages'>): ChangePlan {
    this.cleanupPayloads();
    this.evictRemovablePlans();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError(
        'PLAN_CAPACITY_FULL',
        'plan',
        'Change plan capacity is full; active and retained recovery plans cannot be evicted safely.'
      );
    }
    const createdAt = this.now();
    const stored: ChangePlan = {
      ...plan,
      changePlanId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      stages: []
    };
    this.plans.set(stored.changePlanId, stored);
    return stored;
  }

  get(changePlanId: string): ChangePlan {
    this.cleanupPayloads();
    const plan = this.plans.get(changePlanId);
    if (!plan) {
      throw new SafeAbapError('PLAN_NOT_FOUND', 'plan', 'Change plan was not found.');
    }
    return plan;
  }

  beginApply(changePlanId: string): ChangePlan {
    const plan = this.get(changePlanId);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'plan', 'Change plan has expired. Create a new preview.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'plan', `Change plan is already ${plan.status.toLowerCase()}.`);
    }
    plan.status = 'APPLYING';
    return plan;
  }

  setStatus(changePlanId: string, status: ChangePlanStatus): ChangePlan {
    const plan = this.get(changePlanId);
    plan.status = status;
    if (isTerminal(status)) {
      plan.terminalAt = this.now();
      if (status !== 'ROLLBACK_FAILED') this.purgePayload(plan);
    } else {
      plan.terminalAt = undefined;
    }
    this.cleanupPayloads();
    return plan;
  }

  view(changePlanId: string): ChangePlanView {
    const plan = this.get(changePlanId);
    return {
      changePlanId: plan.changePlanId,
      createdAt: new Date(plan.createdAt).toISOString(),
      expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status,
      systemHost: plan.systemHost,
      client: plan.client,
      object: plan.object,
      transportRequest: plan.transportRequest,
      originalHash: plan.originalHash,
      targetHash: plan.targetHash,
      diffSummary: plan.diffSummary,
      syntaxMessages: plan.syntaxMessages,
      stages: [...plan.stages],
      primaryError: plan.primaryError,
      rollbackAttempted: plan.rollbackAttempted,
      rollbackSucceeded: plan.rollbackSucceeded,
      unlockSucceeded: plan.unlockSucceeded,
      verifiedSourceHash: plan.verifiedSourceHash,
      sourceMatchType: plan.sourceMatchType,
      rollbackVerifiedSourceHash: plan.rollbackVerifiedSourceHash,
      rollbackSourceMatchType: plan.rollbackSourceMatchType
    };
  }

  private cleanupPayloads(): void {
    const timestamp = this.now();
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && timestamp >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = timestamp;
        this.purgePayload(plan);
      } else if (
        plan.status === 'ROLLBACK_FAILED'
        && plan.terminalAt !== undefined
        && timestamp - plan.terminalAt >= this.rollbackFailedRetentionMs
      ) {
        this.purgePayload(plan);
      }
    }
  }

  private evictRemovablePlans(): void {
    while (this.plans.size >= this.maxEntries) {
      const removable = [...this.plans.values()]
        .filter(plan => this.isRemovable(plan))
        .sort((left, right) => (left.terminalAt || left.createdAt) - (right.terminalAt || right.createdAt))[0];
      if (!removable) return;
      this.plans.delete(removable.changePlanId);
    }
  }

  private isRemovable(plan: ChangePlan): boolean {
    if (!isTerminal(plan.status)) return false;
    if (plan.status !== 'ROLLBACK_FAILED') return true;
    return plan.terminalAt !== undefined && this.now() - plan.terminalAt >= this.rollbackFailedRetentionMs;
  }

  private purgePayload(plan: ChangePlan): void {
    plan.originalSource = '';
    plan.targetSource = '';
    plan.diff = '';
  }
}

function isTerminal(status: ChangePlanStatus): boolean {
  return status === 'APPLIED'
    || status === 'ROLLED_BACK'
    || status === 'ROLLBACK_FAILED'
    || status === 'EXPIRED'
    || status === 'FAILED';
}
