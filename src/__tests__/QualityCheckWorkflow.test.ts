import { QualityCheckPlanStore } from '../safe/QualityCheckPlanStore';
import { QualityCheckWorkflow } from '../safe/QualityCheckWorkflow';
import { SafetyPolicy } from '../safe/SafetyPolicy';

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

function setup(overrides: Record<string, unknown> = {}) {
  const policy = new SafetyPolicy({
    sapUrl: 'https://dev.example.test', sapClient: '100', sapUser: 'DEVUSER', systemRole: 'DEV',
    allowedHosts: 'dev.example.test', allowedClients: '100', allowedNamespaces: 'Z',
    auditPath: 'C:\\audit', toolProfile: 'development-workbench'
  });
  const client = {
    getObjectSource: jest.fn().mockResolvedValue('CLASS zcl_test DEFINITION. ENDCLASS.'),
    atcCustomizing: jest.fn().mockResolvedValue({
      properties: [{ name: 'systemCheckVariant', value: 'DEFAULT' }], excemptions: []
    }),
    unitTestRun: jest.fn().mockResolvedValue([{
      'adtcore:name': 'LTC_TEST', 'adtcore:type': 'CLAS/OC', uriType: 'semantic',
      durationCategory: 'short', riskLevel: 'harmless', alerts: [], testmethods: [{
        'adtcore:name': 'TEST', 'adtcore:type': 'CLAS/OM', 'adtcore:uri': '/test',
        executionTime: 1, uriType: 'semantic', unit: 'ms', alerts: []
      }]
    }]),
    createAtcRun: jest.fn().mockResolvedValue({ id: 'RUN-1', timestamp: 123, infos: [] }),
    ...overrides
  };
  const resolver = { resolve: jest.fn().mockResolvedValue(object) };
  const auditEvents: Record<string, unknown>[] = [];
  const audit = { append: jest.fn(async event => { auditEvents.push(event); }) };
  const store = new QualityCheckPlanStore(60_000, () => 1_000, () => 'quality-1');
  const workflow = new QualityCheckWorkflow(client as never, resolver as never, policy, store, audit);
  return { workflow, client, resolver, auditEvents, store, policy };
}

const unitInput = {
  kind: 'ABAP_UNIT' as const,
  objects: [{ objectType: 'CLASS', objectName: 'ZCL_TEST' }],
  timeoutSeconds: 30
};

describe('QualityCheckWorkflow', () => {
  it('previews without executing and asks for an explicit ATC variant when omitted', async () => {
    const unit = setup();
    await expect(unit.workflow.preview(unitInput)).resolves.toMatchObject({
      status: 'preview', plan: { status: 'PREVIEWED', riskLevel: 'HARMLESS', duration: 'SHORT' }
    });
    expect(unit.client.unitTestRun).not.toHaveBeenCalled();
    expect(unit.client.createAtcRun).not.toHaveBeenCalled();

    const atc = setup();
    await expect(atc.workflow.preview({ kind: 'ATC', objects: unitInput.objects })).resolves.toEqual({
      status: 'variant_required', kind: 'ATC', configuredSystemVariant: 'DEFAULT',
      message: expect.stringContaining('explicit ATC variant'), confirmationRequired: false
    });
    expect(atc.resolver.resolve).not.toHaveBeenCalled();
    expect(atc.client.createAtcRun).not.toHaveBeenCalled();
  });

  it('revalidates drift and calls ABAP Unit exactly once with frozen flags and timeout', async () => {
    const test = setup();
    await test.workflow.preview({ ...unitInput, riskLevel: 'DANGEROUS', duration: 'MEDIUM' });

    const result = await test.workflow.run('quality-1');

    expect(test.client.unitTestRun).toHaveBeenCalledTimes(1);
    expect(test.client.unitTestRun).toHaveBeenCalledWith(
      [object.objectUrl],
      { harmless: false, dangerous: true, critical: false, short: false, medium: true, long: false },
      30_000
    );
    expect(result).toMatchObject({
      status: 'success',
      plan: { status: 'SUCCEEDED', result: { kind: 'ABAP_UNIT', classCount: 1, methodCount: 1, alertCount: 0 } }
    });
    expect(JSON.stringify(result)).not.toContain('sourceUrl');
    expect(test.auditEvents.every(event => !JSON.stringify(event).includes('CLASS zcl_test'))).toBe(true);
  });

  it('calls ATC exactly once for all frozen objects and returns a bounded run identifier', async () => {
    const secondObject = { ...object, objectName: 'ZCL_SECOND', objectUrl: '/sap/bc/adt/oo/classes/zcl_second' };
    const test = setup();
    jest.mocked(test.resolver.resolve)
      .mockResolvedValueOnce(object)
      .mockResolvedValueOnce(secondObject)
      .mockResolvedValueOnce(object)
      .mockResolvedValueOnce(secondObject);
    await test.workflow.preview({
      kind: 'ATC', variant: 'DEFAULT',
      objects: [{ objectType: 'CLASS', objectName: 'ZCL_TEST' }, { objectType: 'CLASS', objectName: 'ZCL_SECOND' }]
    });

    const result = await test.workflow.run('quality-1');

    expect(test.client.createAtcRun).toHaveBeenCalledTimes(1);
    expect(test.client.createAtcRun).toHaveBeenCalledWith(
      'DEFAULT', [object.objectUrl, secondObject.objectUrl], 100, 60_000
    );
    expect(result).toMatchObject({ plan: { result: { kind: 'ATC', runResultId: 'RUN-1' } } });
  });

  it('blocks source drift before execution', async () => {
    const test = setup();
    jest.mocked(test.client.getObjectSource)
      .mockResolvedValueOnce('SOURCE A')
      .mockResolvedValueOnce('SOURCE B');
    await test.workflow.preview(unitInput);

    await expect(test.workflow.run('quality-1')).rejects.toMatchObject({
      code: 'STATE_DRIFT', details: { plan: { status: 'FAILED' } }
    });
    expect(test.client.unitTestRun).not.toHaveBeenCalled();
  });

  it('marks uncertain execution UNKNOWN_OUTCOME and never calls the runner twice', async () => {
    const test = setup({ unitTestRun: jest.fn().mockRejectedValue(new Error('timeout with SECRET body')) });
    await test.workflow.preview(unitInput);

    await expect(test.workflow.run('quality-1')).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME', details: { plan: { status: 'UNKNOWN_OUTCOME' } }
    });
    await expect(test.workflow.run('quality-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(test.client.unitTestRun).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(test.workflow.status('quality-1'))).not.toContain('SECRET');
  });

  it('keeps a confirmed remote result successful when completion audit fails', async () => {
    const test = setup();
    jest.mocked((test.workflow as any).audit.append)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await test.workflow.preview(unitInput);

    await expect(test.workflow.run('quality-1')).rejects.toThrow('audit unavailable');

    expect(test.client.unitTestRun).toHaveBeenCalledTimes(1);
    expect(test.workflow.status('quality-1')).toMatchObject({ status: 'SUCCEEDED', result: { kind: 'ABAP_UNIT' } });
    await expect(test.workflow.run('quality-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
  });

  it('rejects QAS and non-workbench profiles before SAP access', async () => {
    for (const options of [
      { systemRole: 'QAS', toolProfile: 'development-workbench' },
      { systemRole: 'DEV', toolProfile: 'development' }
    ]) {
      const test = setup();
      (test.policy as any).systemRole = options.systemRole;
      (test.policy as any).toolProfile = options.toolProfile;
      await expect(test.workflow.preview(unitInput)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(test.resolver.resolve).not.toHaveBeenCalled();
    }
  });
});
