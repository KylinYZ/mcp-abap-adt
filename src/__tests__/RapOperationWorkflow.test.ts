import { AdvancedOperationPlanStore } from '../safe/AdvancedOperationPlanStore';
import { RapOperationWorkflow } from '../safe/RapOperationWorkflow';
import { SafetyPolicy } from '../safe/SafetyPolicy';

const content = {
  general: { description: 'Demo' },
  businessObject: {
    dataModelEntity: { cdsName: 'Z_I_DEMO' },
    behavior: { implementationType: 'managed', implementationClass: 'ZBP_I_DEMO', draftTable: 'ZDEMO_D' }
  },
  serviceProjection: { name: 'Z_C_DEMO' },
  businessService: {
    serviceDefinition: { name: 'ZUI_DEMO' },
    serviceBinding: { name: 'ZUI_DEMO_O4', bindingType: 'OData V4 - UI' }
  }
};

function policy() {
  return new SafetyPolicy({
    sapUrl: 'https://dev.example.com', sapClient: '100', systemRole: 'DEV',
    allowedHosts: 'dev.example.com', allowedClients: '100', allowedNamespaces: 'Z',
    auditPath: 'D:/audit', toolProfile: 'development'
  });
}

function harness(options: { missingObject?: boolean; noObjects?: boolean; generateError?: Error } = {}) {
  const expected = [
    { uri: '/sap/bc/adt/programs/programs/z_i_demo', type: 'PROG/P', name: 'Z_I_DEMO', description: 'root' },
    { uri: '/sap/bc/adt/oo/classes/zbp_i_demo', type: 'CLAS/OC', name: 'ZBP_I_DEMO', description: 'behavior' }
  ];
  const client = {
    searchObject: jest.fn().mockResolvedValue([{ 'adtcore:name': 'ZREF', 'adtcore:type': 'DDLS/DF', 'adtcore:uri': '/sap/bc/adt/ddic/ddl/sources/zref', 'adtcore:packageName': 'ZPKG' }]),
    objectStructure: jest.fn(async (uri: string) => {
      if (options.noObjects || (options.missingObject && uri === expected[1].uri)) throw new Error('not found');
      const item = expected.find(entry => entry.uri === uri) || expected[0];
      return { objectUrl: uri, metaData: { 'adtcore:name': item.name, 'adtcore:type': item.type, 'adtcore:changedAt': 1, 'adtcore:changedBy': 'DEV', 'adtcore:createdAt': 1, 'adtcore:createdBy': 'DEV', 'adtcore:language': 'EN', 'adtcore:responsible': 'DEV', 'adtcore:version': 'active' } };
    }),
    getObjectSource: jest.fn().mockRejectedValue(new Error('binding state endpoint unavailable')),
    transportInfo: jest.fn().mockResolvedValue({ DEVCLASS: 'ZPKG', TRANSPORTS: [{ TRKORR: 'DEVK900001' }] }),
    transportDetails: jest.fn().mockResolvedValue({ 'tm:status': 'D' }),
    rapGenIsAvailable: jest.fn().mockResolvedValue(true),
    rapGenGetSchema: jest.fn().mockResolvedValue('{"type":"object"}'),
    rapGenGetUiConfig: jest.fn().mockResolvedValue('{}'),
    rapGenValidateInitial: jest.fn().mockResolvedValue({ severity: 'ok', shortText: 'ok' }),
    rapGenValidateContent: jest.fn().mockResolvedValue({ severity: 'ok', shortText: 'ok' }),
    rapGenPreview: jest.fn().mockResolvedValue(expected),
    rapGenGenerate: jest.fn(async () => { if (options.generateError) throw options.generateError; return expected; }),
    rapGenPublishService: jest.fn().mockResolvedValue({ severity: 'ok', shortText: 'published' })
  };
  const plans = new AdvancedOperationPlanStore(900_000, () => 1_000, () => options.missingObject ? 'partial-plan' : 'rap-plan');
  const workflow = new RapOperationWorkflow(client as never, policy(), plans, { append: jest.fn().mockResolvedValue(undefined) });
  return { workflow, client, plans };
}

describe('RapOperationWorkflow', () => {
  it('validates and previews RAP generation without generating', async () => {
    const test = harness();
    const preview = await test.workflow.preview({ operation: {
      kind: 'RAP_GENERATE', genId: 'uiservice', referenceObjectName: 'ZREF', packageName: 'ZPKG',
      transportRequest: 'DEVK900001', content
    } });
    expect(preview.plan).toMatchObject({ operationKind: 'RAP_GENERATE', status: 'PREVIEWED' });
    expect(test.client.rapGenGenerate).not.toHaveBeenCalled();
    expect(test.client.rapGenPreview).toHaveBeenCalledTimes(1);
  });

  it('generates once and verifies every expected object', async () => {
    const test = harness();
    await test.workflow.preview({ operation: {
      kind: 'RAP_GENERATE', genId: 'uiservice', referenceObjectName: 'ZREF', packageName: 'ZPKG',
      transportRequest: 'DEVK900001', content
    } });
    await expect(test.workflow.apply('rap-plan')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(test.client.rapGenGenerate).toHaveBeenCalledTimes(1);
  });

  it('reports partial success without deleting generated objects', async () => {
    const test = harness({ missingObject: true });
    await test.workflow.preview({ operation: {
      kind: 'RAP_GENERATE', genId: 'uiservice', referenceObjectName: 'ZREF', packageName: 'ZPKG',
      transportRequest: 'DEVK900001', content
    } });
    await expect(test.workflow.apply('partial-plan')).rejects.toMatchObject({ code: 'VERIFICATION_FAILED', details: { plan: { status: 'PARTIAL_SUCCESS' } } });
    expect(test.client.rapGenGenerate).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain generation outcome and never retries', async () => {
    const test = harness({ noObjects: true, generateError: new Error('connection reset') });
    await test.workflow.preview({ operation: {
      kind: 'RAP_GENERATE', genId: 'uiservice', referenceObjectName: 'ZREF', packageName: 'ZPKG',
      transportRequest: 'DEVK900001', content
    } });
    await expect(test.workflow.apply('rap-plan')).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', details: { plan: { status: 'UNKNOWN_OUTCOME' } } });
    expect(test.client.rapGenGenerate).toHaveBeenCalledTimes(1);
  });

  it('does not hide an unobservable publication state', async () => {
    const test = harness();
    await test.workflow.preview({ operation: { kind: 'RAP_PUBLISH_SERVICE', serviceBindingName: 'ZSRV' } });
    await expect(test.workflow.apply('rap-plan')).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(test.client.rapGenPublishService).toHaveBeenCalledTimes(1);
  });

  it('settles the plan when the confirmed availability recheck fails', async () => {
    const test = harness();
    await test.workflow.preview({ operation: {
      kind: 'RAP_GENERATE', genId: 'uiservice', referenceObjectName: 'ZREF', packageName: 'ZPKG',
      transportRequest: 'DEVK900001', content
    } });
    test.client.rapGenIsAvailable.mockRejectedValueOnce(new Error('availability endpoint unavailable'));

    await expect(test.workflow.apply('rap-plan')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { plan: { status: 'FAILED' } }
    });
    expect(test.client.rapGenGenerate).not.toHaveBeenCalled();
    expect(test.plans.view('rap-plan').status).toBe('FAILED');
  });
});
