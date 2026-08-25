import { RepositoryObjectCreationPlanStore } from '../safe/RepositoryObjectCreationPlanStore';

const context = {
  systemHost: 'DEV.EXAMPLE.TEST', client: '100', sapUser: 'test_user',
  systemRole: 'DEV', toolProfile: 'development' as const
};
const prepared = {
  target: { objectKind: 'PROGRAM' as const, objectName: 'ZTEST', adtType: 'PROG/P' },
  transportRequest: 'DEVK900001', summary: 'Create ZTEST', payload: { source: 'REPORT ztest.' },
  review: { source: 'REPORT ztest.' },
  compensationLimits: ['Only owned objects may be deleted.']
};

describe('RepositoryObjectCreationPlanStore', () => {
  it('binds plans to context, consumes once, and clears terminal payloads', () => {
    let now = 1_000;
    const store = new RepositoryObjectCreationPlanStore(60_000, () => now, () => 'plan-1', 10);
    const created = store.create(context, prepared, { payloadHash: 'hash', payloadBytes: 20 });

    expect(created).toMatchObject({ creationPlanId: 'plan-1', status: 'PREVIEWED', systemHost: 'dev.example.test', sapUser: 'TEST_USER' });
    expect(() => store.view('plan-1', { ...context, client: '200' })).toThrow('different SAP or MCP context');
    expect(store.begin('plan-1', context).payload).toEqual(prepared.payload);
    expect(() => store.begin('plan-1', context)).toThrow('exactly once');
    store.recordStage('plan-1', 'CREATE_SHELL', true, 'Created');
    now += 100;
    expect(store.settle('plan-1', 'APPLIED', { resultSummary: 'Created' })).toMatchObject({
      status: 'APPLIED', resultSummary: 'Created', stages: [{ stage: 'CREATE_SHELL', success: true }]
    });
    expect(store.view('plan-1', context)).not.toHaveProperty('payload');
  });

  it('expires previewed plans and enforces bounded capacity', () => {
    let now = 0;
    let sequence = 0;
    const store = new RepositoryObjectCreationPlanStore(10, () => now, () => `plan-${++sequence}`, 1);
    store.create(context, prepared, { payloadHash: 'hash', payloadBytes: 20 });
    expect(() => store.create(context, prepared, { payloadHash: 'hash', payloadBytes: 20 })).toThrow('capacity is full');
    now = 11;
    expect(() => store.view('plan-1', context)).toThrow('expired');
    expect(store.create(context, prepared, { payloadHash: 'hash', payloadBytes: 20 })).toMatchObject({ creationPlanId: 'plan-2' });
  });
});
