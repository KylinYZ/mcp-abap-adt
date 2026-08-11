import { ChangePlanStore } from '../safe/ChangePlanStore';
import type { ChangePlan } from '../safe/types';

describe('ChangePlanStore', () => {
  let now = 1_000;

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
});
