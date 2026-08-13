import { ChangePlanStore } from '../safe/ChangePlanStore';
import type { ChangePlan } from '../safe/types';

describe('ChangePlanStore', () => {
  let now = 1_000;
  let nextId = 1;

  function planInput(): Omit<ChangePlan, 'changePlanId' | 'createdAt' | 'expiresAt' | 'status' | 'stages'> {
    return {
      systemHost: 'dev.example.com',
      client: '100',
      object: {
        objectType: 'PROGRAM',
        objectName: 'ZTEST',
        adtType: 'PROG/P',
        objectUrl: '/sap/bc/adt/programs/programs/ztest',
        sourceUrl: '/sap/bc/adt/programs/programs/ztest/source/main',
        lockUrl: '/sap/bc/adt/programs/programs/ztest',
        activationName: 'ZTEST',
        activationUrl: '/sap/bc/adt/programs/programs/ztest'
      },
      transportRequest: 'DEVK900001',
      originalSource: 'REPORT ztest.',
      targetSource: 'REPORT ztest.\nWRITE test.',
      originalHash: 'original',
      targetHash: 'target',
      diff: '-old\n+new',
      diffSummary: {
        addedLines: 1,
        removedLines: 0,
        unchangedPrefixLines: 1,
        unchangedSuffixLines: 0
      },
      syntaxMessages: []
    };
  }

  it('expires plans and prevents reuse', () => {
    const store = new ChangePlanStore(100, () => now, () => 'plan-1');
    const plan = store.create(planInput());
    expect(store.beginApply(plan.changePlanId).status).toBe('APPLYING');
    expect(() => store.beginApply(plan.changePlanId)).toThrow('already applying');

    const second = new ChangePlanStore(100, () => now, () => 'plan-2');
    second.create(planInput());
    now += 100;
    expect(() => second.beginApply('plan-2')).toThrow('expired');
  });

  it('does not expose complete source in status views', () => {
    const store = new ChangePlanStore(100, () => now, () => 'plan-3');
    store.create(planInput());
    const view = store.view('plan-3') as unknown as Record<string, unknown>;
    expect(view.originalSource).toBeUndefined();
    expect(view.targetSource).toBeUndefined();
    expect(view.diff).toBeUndefined();
  });

  it('exposes small verification diagnostics without exposing source payloads', () => {
    const store = new ChangePlanStore(100, () => now, () => 'plan-diagnostics');
    const plan = store.create(planInput());
    plan.verifiedSourceHash = 'verified';
    plan.sourceMatchType = 'LINE_ENDING_NORMALIZED';
    plan.rollbackVerifiedSourceHash = 'rollback';
    plan.rollbackSourceMatchType = 'EXACT';

    expect(store.view(plan.changePlanId)).toMatchObject({
      verifiedSourceHash: 'verified',
      sourceMatchType: 'LINE_ENDING_NORMALIZED',
      rollbackVerifiedSourceHash: 'rollback',
      rollbackSourceMatchType: 'EXACT'
    });
  });

  it.each(['APPLIED', 'ROLLED_BACK', 'EXPIRED', 'FAILED'] as const)(
    'purges complete payload when a plan becomes %s',
    status => {
      const store = new ChangePlanStore(100, () => now, () => 'plan', 10, 1_000);
      const plan = store.create(planInput());

      store.setStatus(plan.changePlanId, status);

      expect(plan.originalSource).toBe('');
      expect(plan.targetSource).toBe('');
      expect(plan.diff).toBe('');
      expect(plan.originalHash).toBe('original');
      expect(plan.diffSummary.addedLines).toBe(1);
    }
  );

  it.each(['PREVIEWED', 'APPLYING'] as const)('retains recovery payload while a plan is %s', status => {
    const store = new ChangePlanStore(100, () => now, () => 'plan', 10, 1_000);
    const plan = store.create(planInput());
    if (status === 'APPLYING') store.beginApply(plan.changePlanId);

    expect(plan.originalSource).toBe('REPORT ztest.');
    expect(plan.targetSource).toContain('WRITE');
    expect(plan.diff).toContain('+new');
  });

  it('retains rollback recovery payload until the configured retention expires', () => {
    const store = new ChangePlanStore(100, () => now, () => 'plan', 10, 500);
    const plan = store.create(planInput());
    store.setStatus(plan.changePlanId, 'ROLLBACK_FAILED');

    now += 499;
    expect(store.get(plan.changePlanId).originalSource).toBe('REPORT ztest.');
    now += 1;
    expect(store.get(plan.changePlanId).originalSource).toBe('');
    expect(store.view(plan.changePlanId).status).toBe('ROLLBACK_FAILED');
  });

  it('evicts the oldest removable terminal record before creating a new plan', () => {
    const store = new ChangePlanStore(100, () => now, () => `plan-${nextId++}`, 2, 500);
    const first = store.create(planInput());
    store.setStatus(first.changePlanId, 'APPLIED');
    now += 1;
    const active = store.create(planInput());

    const created = store.create(planInput());

    expect(created.changePlanId).toBe('plan-3');
    expect(() => store.get(first.changePlanId)).toThrow('not found');
    expect(store.get(active.changePlanId).status).toBe('PREVIEWED');
  });

  it('does not evict active or retained recovery plans when capacity is exhausted', () => {
    const store = new ChangePlanStore(100, () => now, () => `plan-${nextId++}`, 2, 500);
    const previewed = store.create(planInput());
    const recovery = store.create(planInput());
    store.setStatus(recovery.changePlanId, 'ROLLBACK_FAILED');

    expect(() => store.create(planInput())).toThrow('capacity');
    expect(store.get(previewed.changePlanId).status).toBe('PREVIEWED');
    expect(store.get(recovery.changePlanId).originalSource).toBe('REPORT ztest.');
  });
});
