import { randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type { ChangePlan, ChangePlanStatus, ChangePlanView } from './types.js';

export class ChangePlanStore {
  private readonly plans = new Map<string, ChangePlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex')
  ) {}

  create(plan: Omit<ChangePlan, 'changePlanId' | 'createdAt' | 'expiresAt' | 'status' | 'stages'>): ChangePlan {
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
    const plan = this.plans.get(changePlanId);
    if (!plan) {
      throw new SafeAbapError('PLAN_NOT_FOUND', 'plan', 'Change plan was not found.');
    }
    if (this.now() >= plan.expiresAt && plan.status === 'PREVIEWED') {
      plan.status = 'EXPIRED';
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
      unlockSucceeded: plan.unlockSucceeded
    };
  }
}
