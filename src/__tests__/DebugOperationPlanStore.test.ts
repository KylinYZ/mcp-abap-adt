import { DebugOperationPlanStore } from '../safe/DebugOperationPlanStore';
import type { DebugOperation } from '../safe/debugTypes';

describe('DebugOperationPlanStore', () => {
  let now = 1_000;
  let nextId = 1;
  const context = { systemHost: 'dev.example.com', client: '100', targetUser: 'DEVUSER' };

  function listenerOperation(): DebugOperation {
    return {
      kind: 'CREATE_LISTENER',
      listener: {
        debuggingMode: 'user',
        terminalId: 'terminal-1',
        ideId: 'ide-1',
        targetUser: 'DEVUSER'
      }
    };
  }

  it('expires and consumes a frozen plan only once', () => {
    const store = new DebugOperationPlanStore(100, () => now, () => 'plan-1');
    store.create({ ...context, operation: listenerOperation(), summary: 'Create listener', risk: 'Changes listener state' });
    expect(store.beginApply('plan-1', context).status).toBe('APPLYING');
    expect(() => store.beginApply('plan-1', context)).toThrow('already applying');

    const expiring = new DebugOperationPlanStore(100, () => now, () => 'plan-2');
    expiring.create({ ...context, operation: listenerOperation(), summary: 'Create listener', risk: 'Changes listener state' });
    now += 100;
    expect(() => expiring.beginApply('plan-2', context)).toThrow('expired');
  });

  it('rejects a plan from another host, client, or user context', () => {
    const store = new DebugOperationPlanStore(100, () => now, () => 'plan-context');
    store.create({ ...context, operation: listenerOperation(), summary: 'Create listener', risk: 'Changes listener state' });
    expect(() => store.beginApply('plan-context', { ...context, client: '200' })).toThrow('current SAP context');
    expect(() => store.beginApply('plan-context', { ...context, targetUser: 'OTHER' })).toThrow('current SAP context');
  });

  it('hides complete variable values from public views and purges them on expiry', () => {
    const store = new DebugOperationPlanStore(100, () => now, () => 'variable-plan');
    const plan = store.create({
      ...context,
      operation: {
        kind: 'SET_VARIABLE',
        targetUser: 'DEVUSER',
        authorizationId: 'auth-1',
        debuggeeId: 'debuggee-1',
        variableName: 'LV_SECRET',
        oldValue: 'old-secret',
        newValue: 'new-secret',
        stack: { stackPosition: 1, programName: 'ZTEST', line: 12 },
        parents: ['@ROOT']
      },
      summary: 'Change LV_SECRET',
      risk: 'Changes runtime state'
    });

    const serialized = JSON.stringify(store.view(plan.debugOperationPlanId));
    expect(serialized).not.toContain('old-secret');
    expect(serialized).not.toContain('new-secret');
    expect(serialized).toContain('oldValueHash');

    now += 100;
    store.view(plan.debugOperationPlanId);
    expect(plan.operation.kind === 'SET_VARIABLE' && plan.operation.oldValue).toBe('');
    expect(plan.operation.kind === 'SET_VARIABLE' && plan.operation.newValue).toBe('');
  });

  it('purges variable values after any terminal result while retaining hashes and byte summaries', () => {
    const store = new DebugOperationPlanStore(100, () => now, () => 'terminal-variable');
    const plan = store.create({
      ...context,
      operation: {
        kind: 'SET_VARIABLE',
        targetUser: 'DEVUSER',
        authorizationId: 'auth-1',
        debuggeeId: 'debuggee-1',
        variableName: 'LV_SECRET',
        oldValue: 'old-secret',
        newValue: 'new-secret',
        stack: { stackPosition: 1 },
        parents: ['@ROOT']
      },
      summary: 'Change LV_SECRET',
      risk: 'Changes runtime state'
    });
    store.setStatus(plan.debugOperationPlanId, 'APPLIED');
    const serialized = JSON.stringify(store.view(plan.debugOperationPlanId));
    expect(serialized).not.toContain('old-secret');
    expect(serialized).not.toContain('new-secret');
    expect(serialized).toContain('<redacted:10 bytes>');
    expect(serialized).toContain('oldValueHash');
  });

  it('evicts terminal plans but never active plans at capacity', () => {
    const store = new DebugOperationPlanStore(100, () => now, () => `plan-${nextId++}`, 2);
    const first = store.create({ ...context, operation: listenerOperation(), summary: 'one', risk: 'risk' });
    store.setStatus(first.debugOperationPlanId, 'APPLIED');
    const active = store.create({ ...context, operation: listenerOperation(), summary: 'two', risk: 'risk' });
    expect(store.create({ ...context, operation: listenerOperation(), summary: 'three', risk: 'risk' }).debugOperationPlanId).toBe('plan-3');
    expect(() => store.get(first.debugOperationPlanId)).toThrow('not found');
    expect(store.get(active.debugOperationPlanId).status).toBe('PREVIEWED');

    const full = new DebugOperationPlanStore(100, () => now, () => `active-${nextId++}`, 1);
    full.create({ ...context, operation: listenerOperation(), summary: 'active', risk: 'risk' });
    expect(() => full.create({ ...context, operation: listenerOperation(), summary: 'blocked', risk: 'risk' })).toThrow('capacity');
  });
});
