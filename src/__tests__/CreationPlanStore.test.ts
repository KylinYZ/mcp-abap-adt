import { CreationPlanStore } from '../safe/CreationPlanStore';
import type { CreationPlan } from '../safe/creationTypes';

describe('CreationPlanStore', () => {
  let now = 1_000;

  function input(): Omit<CreationPlan, 'creationPlanId' | 'createdAt' | 'expiresAt' | 'status' | 'stages' | 'createdObjects'> {
    return {
      systemHost: 'dev.example.com', client: '100', transportRequest: 'DEVK900001',
      objects: [{
        objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New', adtType: 'PROG/P', packageName: 'Z001',
        parentName: 'Z001', parentPath: '/sap/bc/adt/packages/z001', objectUrl: '/sap/bc/adt/programs/programs/znew',
        sourceUrl: '/sap/bc/adt/programs/programs/znew/source/main', source: 'REPORT znew.', sourceHash: 'hash'
      }]
    };
  }

  it('expires plans and consumes them once', () => {
    const store = new CreationPlanStore(100, () => now, () => 'create-1');
    expect(store.beginApply(store.create(input()).creationPlanId).status).toBe('APPLYING');
    expect(() => store.beginApply('create-1')).toThrow('already applying');

    const expiring = new CreationPlanStore(100, () => now, () => 'create-2');
    expiring.create(input());
    now += 100;
    expect(() => expiring.beginApply('create-2')).toThrow('expired');
  });

  it('never exposes complete source in status views and purges it in normal terminal states', () => {
    const store = new CreationPlanStore(100, () => now, () => 'create-3');
    const plan = store.create(input());
    expect((store.view(plan.creationPlanId).objects[0] as unknown as Record<string, unknown>).source).toBeUndefined();
    store.setStatus(plan.creationPlanId, 'APPLIED');
    expect(plan.objects[0].source).toBeUndefined();
    expect(plan.objects[0].sourceHash).toBe('hash');
  });

  it('retains compensation payload until the recovery retention expires', () => {
    const store = new CreationPlanStore(100, () => now, () => 'create-4', 10, 500);
    const plan = store.create(input());
    store.setStatus(plan.creationPlanId, 'COMPENSATION_FAILED');
    now += 499;
    expect(store.get(plan.creationPlanId).objects[0].source).toContain('REPORT');
    now += 1;
    expect(store.get(plan.creationPlanId).objects[0].source).toBeUndefined();
  });
});
