import { QualityCheckPlanStore } from '../safe/QualityCheckPlanStore';

const context = {
  systemHost: 'dev.example.test',
  client: '100',
  sapUser: 'DEVUSER',
  systemRole: 'DEV',
  toolProfile: 'development-workbench' as const
};

const object = {
  objectType: 'CLASS' as const,
  objectName: 'ZCL_TEST',
  adtType: 'CLAS/OC',
  objectUrl: '/sap/bc/adt/oo/classes/zcl_test',
  sourceUrl: '/sap/bc/adt/oo/classes/zcl_test/source/main',
  lockUrl: '/sap/bc/adt/oo/classes/zcl_test',
  activationName: 'ZCL_TEST',
  activationUrl: '/sap/bc/adt/oo/classes/zcl_test',
  packageName: 'ZPKG'
};

function input() {
  return {
    context,
    kind: 'ABAP_UNIT' as const,
    objects: [{ object, sourceHash: 'source-hash' }],
    riskLevel: 'HARMLESS' as const,
    duration: 'SHORT' as const,
    timeoutSeconds: 60,
    flags: { harmless: true, dangerous: false, critical: false, short: true, medium: false, long: false }
  };
}

describe('QualityCheckPlanStore', () => {
  it('binds plans to host, client, user, role, and profile without exposing private payloads', () => {
    const store = new QualityCheckPlanStore(60_000, () => 1_000, () => 'quality-1');
    store.create(input());

    const view = store.view('quality-1', context);

    expect(view).toMatchObject({
      qualityPlanId: 'quality-1', status: 'PREVIEWED', sapUser: 'DEVUSER', stateHash: expect.any(String)
    });
    expect(JSON.stringify(view)).not.toContain('sourceUrl');
    expect(JSON.stringify(view)).not.toContain('source-hash');
    expect(() => store.view('quality-1', { ...context, sapUser: 'OTHER' })).toThrow('current SAP context');
  });

  it('consumes a plan once and purges execution payload at terminal status', () => {
    const store = new QualityCheckPlanStore(60_000, () => 1_000, () => 'quality-1');
    store.create(input());
    store.beginRun('quality-1', context);

    expect(() => store.beginRun('quality-1', context)).toThrow('already running');
    store.setStatus('quality-1', 'UNKNOWN_OUTCOME');
    expect(store.get('quality-1').payload).toBeUndefined();
    expect(() => store.beginRun('quality-1', context)).toThrow('already unknown_outcome');
  });

  it('expires previewed plans and refuses to evict active plans at capacity', () => {
    let now = 1_000;
    const expiring = new QualityCheckPlanStore(100, () => now, () => 'quality-1');
    expiring.create(input());
    now = 1_100;
    expect(expiring.view('quality-1')).toMatchObject({ status: 'EXPIRED' });
    expect(expiring.get('quality-1').payload).toBeUndefined();

    const full = new QualityCheckPlanStore(60_000, () => 1_000, () => 'quality-1', 1);
    full.create(input());
    expect(() => full.create(input())).toThrow('capacity');
  });
});
