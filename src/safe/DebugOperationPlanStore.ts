import { createHash, randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type {
  DebugOperation,
  DebugOperationPlan,
  DebugOperationPlanView,
  DebugOperationStatus
} from './debugTypes.js';

export interface DebugPlanContext {
  systemHost: string;
  client: string;
  targetUser: string;
}

export class DebugOperationPlanStore {
  private readonly plans = new Map<string, DebugOperationPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    private readonly maxEntries: number = 100
  ) {}

  create(input: DebugPlanContext & { operation: DebugOperation; summary: string; risk: string }): DebugOperationPlan {
    this.cleanupExpired();
    this.evictTerminalPlans();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError('PLAN_CAPACITY_FULL', 'debug-plan', 'Debug operation plan capacity is full.');
    }

    const createdAt = this.now();
    const plan: DebugOperationPlan = {
      ...input,
      targetUser: normalizeUser(input.targetUser),
      debugOperationPlanId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      operationHash: operationHash(input.operation),
      ...(input.operation.kind === 'SET_VARIABLE' ? {
        variableValueHashes: {
          oldValueHash: valueHash(input.operation.oldValue),
          newValueHash: valueHash(input.operation.newValue),
          oldValueBytes: Buffer.byteLength(input.operation.oldValue, 'utf8'),
          newValueBytes: Buffer.byteLength(input.operation.newValue, 'utf8')
        }
      } : {})
    };
    this.plans.set(plan.debugOperationPlanId, plan);
    return plan;
  }

  get(debugOperationPlanId: string): DebugOperationPlan {
    this.cleanupExpired();
    const plan = this.plans.get(debugOperationPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'debug-plan', 'Debug operation plan was not found.');
    return plan;
  }

  beginApply(debugOperationPlanId: string, context: DebugPlanContext): DebugOperationPlan {
    const plan = this.get(debugOperationPlanId);
    this.assertContext(plan, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'debug-plan', 'Debug operation plan has expired. Create a new preview.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'debug-plan', `Debug operation plan is already ${plan.status.toLowerCase()}.`);
    }
    plan.status = 'APPLYING';
    return plan;
  }

  setStatus(debugOperationPlanId: string, status: DebugOperationStatus): DebugOperationPlan {
    const plan = this.get(debugOperationPlanId);
    plan.status = status;
    if (isTerminal(status)) {
      plan.terminalAt = this.now();
      redactSensitivePayload(plan.operation);
    }
    return plan;
  }

  view(debugOperationPlanId: string): DebugOperationPlanView {
    const plan = this.get(debugOperationPlanId);
    return {
      debugOperationPlanId: plan.debugOperationPlanId,
      createdAt: new Date(plan.createdAt).toISOString(),
      expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status,
      systemHost: plan.systemHost,
      client: plan.client,
      targetUser: plan.targetUser,
      operation: publicOperation(plan),
      operationHash: plan.operationHash,
      summary: plan.summary,
      risk: plan.risk,
      confirmationMode: plan.confirmationMode,
      resultSummary: plan.resultSummary,
      primaryError: plan.primaryError
    };
  }

  private assertContext(plan: DebugOperationPlan, context: DebugPlanContext): void {
    if (
      plan.systemHost !== context.systemHost
      || plan.client !== context.client
      || plan.targetUser !== normalizeUser(context.targetUser)
    ) {
      throw new SafeAbapError('POLICY_DENIED', 'debug-plan', 'Debug operation plan does not match the current SAP context.');
    }
  }

  private cleanupExpired(): void {
    const timestamp = this.now();
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && timestamp >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = timestamp;
        redactSensitivePayload(plan.operation);
      }
    }
  }

  private evictTerminalPlans(): void {
    while (this.plans.size >= this.maxEntries) {
      const removable = [...this.plans.values()]
        .filter(plan => isTerminal(plan.status))
        .sort((left, right) => (left.terminalAt || left.createdAt) - (right.terminalAt || right.createdAt))[0];
      if (!removable) return;
      this.plans.delete(removable.debugOperationPlanId);
    }
  }
}

function publicOperation(plan: DebugOperationPlan): Record<string, unknown> {
  const operation = plan.operation;
  if (operation.kind !== 'SET_VARIABLE') return { ...operation };
  return {
    kind: operation.kind,
    targetUser: operation.targetUser,
    authorizationId: operation.authorizationId,
    debuggeeId: operation.debuggeeId,
    variableName: operation.variableName,
    oldValueHash: plan.variableValueHashes?.oldValueHash,
    newValueHash: plan.variableValueHashes?.newValueHash,
    oldValueSummary: valueSummary(plan.variableValueHashes?.oldValueBytes || 0),
    newValueSummary: valueSummary(plan.variableValueHashes?.newValueBytes || 0),
    stack: operation.stack,
    parents: operation.parents
  };
}

function redactSensitivePayload(operation: DebugOperation): void {
  if (operation.kind !== 'SET_VARIABLE') return;
  operation.oldValue = '';
  operation.newValue = '';
}

function operationHash(operation: DebugOperation): string {
  return createHash('sha256').update(stableJson(operation), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function valueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function valueSummary(bytes: number): string {
  return `<redacted:${bytes} bytes>`;
}

function normalizeUser(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function isTerminal(status: DebugOperationStatus): boolean {
  return status === 'APPLIED' || status === 'FAILED' || status === 'UNKNOWN' || status === 'EXPIRED';
}
