import { AdvancedOperationPlanStore } from '../safe/AdvancedOperationPlanStore';
import { DdicPropertyChangeWorkflow } from '../safe/DdicPropertyChangeWorkflow';
import { SafetyPolicy } from '../safe/SafetyPolicy';

const original = {
  metaData: {
    name: 'ZDOMAIN', description: 'Old', language: 'EN', masterLanguage: 'EN', masterSystem: 'DEV',
    responsible: 'DEVELOPER', packageName: 'ZPKG'
  },
  properties: {
    typeInformation: { datatype: 'CHAR', length: 10, decimals: 0 },
    outputInformation: { length: 10, signExists: false, lowercase: false, ampmFormat: false }
  }
};

const proposed = {
  metaData: { ...original.metaData, description: 'New' },
  properties: { ...original.properties, outputInformation: { ...original.properties.outputInformation, lowercase: true } }
};

function policy() {
  return new SafetyPolicy({
    sapUrl: 'https://dev.example.com', sapClient: '100', systemRole: 'DEV',
    allowedHosts: 'dev.example.com', allowedClients: '100', allowedNamespaces: 'Z',
    auditPath: 'D:/audit', toolProfile: 'development'
  });
}

function harness(options: { activationResults?: boolean[]; setterError?: Error } = {}) {
  let active = structuredClone(original);
  let inactive = structuredClone(original);
  const activationResults = [...(options.activationResults || [true])];
  const client = {
    searchObject: jest.fn(),
    getDomainProperties: jest.fn(async (_url: string, version = 'active') => structuredClone(version === 'inactive' ? inactive : active)),
    setDomainProperties: jest.fn(async (_url: string, properties: unknown, metaData: unknown) => {
      if (options.setterError) throw options.setterError;
      inactive = structuredClone({ properties, metaData }) as typeof inactive;
    }),
    getDataElementProperties: jest.fn(), setDataElementProperties: jest.fn(),
    getTextElements: jest.fn(), setTextElements: jest.fn(),
    transportInfo: jest.fn().mockResolvedValue({ DEVCLASS: 'ZPKG', TRANSPORTS: [{ TRKORR: 'DEVK900001' }] }),
    transportDetails: jest.fn().mockResolvedValue({ 'tm:status': 'D' }),
    lock: jest.fn().mockResolvedValue({ LOCK_HANDLE: 'secret-lock' }),
    unLock: jest.fn().mockResolvedValue(''),
    activate: jest.fn(async () => {
      const success = activationResults.shift() ?? true;
      if (success) active = structuredClone(inactive);
      return { success, messages: success ? [] : [{ shortText: 'Activation failed' }], inactive: success ? [] : [{}] };
    })
  };
  const plans = new AdvancedOperationPlanStore(900_000, () => 1_000, () => 'ddic-plan');
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const workflow = new DdicPropertyChangeWorkflow(client as never, policy(), plans, audit);
  const previewInput = {
    operation: {
      kind: 'SET_DOMAIN_PROPERTIES', objectName: 'ZDOMAIN', transportRequest: 'DEVK900001',
      properties: proposed.properties, metaData: proposed.metaData
    }
  };
  const state: { active: Record<string, unknown>; backfill: Record<string, unknown> } = {
    active: structuredClone(original) as unknown as Record<string, unknown>,
    backfill: structuredClone(original) as unknown as Record<string, unknown>
  };
  return { workflow, client, plans, previewInput, state, setActive: (value: typeof original) => { active = structuredClone(value); } };
}

describe('DdicPropertyChangeWorkflow', () => {
  it('previews without locking or writing and applies one confirmed setter', async () => {
    const test = harness();
    const preview = await test.workflow.preview(test.previewInput);
    expect(preview.plan).toMatchObject({ operationKind: 'SET_DOMAIN_PROPERTIES', status: 'PREVIEWED', rollbackSupported: true });
    expect(preview.plan.inputSummary.changedFields).toEqual(expect.arrayContaining(['metaData.description', 'properties.outputInformation.lowercase']));
    expect(test.client.lock).not.toHaveBeenCalled();
    expect(test.client.setDomainProperties).not.toHaveBeenCalled();

    await expect(test.workflow.apply('ddic-plan')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(test.client.setDomainProperties).toHaveBeenCalledTimes(1);
    expect(test.client.activate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(test.plans.view('ddic-plan'))).not.toContain('secret-lock');
  });

  it('rejects drift before locking or writing', async () => {
    const test = harness();
    await test.workflow.preview(test.previewInput);
    test.setActive({ ...original, metaData: { ...original.metaData, description: 'Concurrent' } });
    await expect(test.workflow.apply('ddic-plan')).rejects.toMatchObject({ code: 'STATE_DRIFT', details: { plan: { status: 'FAILED' } } });
    expect(test.client.lock).not.toHaveBeenCalled();
    expect(test.client.setDomainProperties).not.toHaveBeenCalled();
  });

  it('restores the original state once when activation fails', async () => {
    const test = harness({ activationResults: [false, true] });
    await test.workflow.preview(test.previewInput);
    await expect(test.workflow.apply('ddic-plan')).rejects.toMatchObject({
      code: 'REMOTE_WRITE_FAILED', details: { plan: { status: 'ROLLED_BACK' } }
    });
    expect(test.client.setDomainProperties).toHaveBeenCalledTimes(2);
    expect(test.client.activate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failed setter when the inactive state is unchanged', async () => {
    const test = harness({ setterError: new Error('connection closed') });
    await test.workflow.preview(test.previewInput);
    await expect(test.workflow.apply('ddic-plan')).rejects.toMatchObject({
      code: 'REMOTE_WRITE_FAILED', details: { plan: { status: 'FAILED' } }
    });
    expect(test.client.setDomainProperties).toHaveBeenCalledTimes(1);
    expect(test.client.activate).not.toHaveBeenCalled();
  });

  it('settles the plan when a confirmed transport recheck fails', async () => {
    const test = harness();
    await test.workflow.preview(test.previewInput);
    test.client.transportInfo.mockRejectedValueOnce(new Error('transport endpoint unavailable'));

    await expect(test.workflow.apply('ddic-plan')).rejects.toMatchObject({
      code: 'TRANSPORT_INVALID', details: { plan: { status: 'FAILED' } }
    });
    expect(test.client.lock).not.toHaveBeenCalled();
    expect(test.plans.view('ddic-plan').status).toBe('FAILED');
  });

  it('locks the REPT text pool subresource for SET_TEXT_ELEMENTS and verifies by readback', async () => {
    const test = harness();
    // S/4 真机实测：文本池写入锁挂在 REPT 子对象（textelements 资源 URL），锁主程序会被拒
    let textpool: Array<Record<string, unknown>> = [];
    test.client.searchObject.mockResolvedValue([
      { 'adtcore:uri': '/sap/bc/adt/programs/programs/ztxtpool', 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZTXTPOOL', 'adtcore:packageName': 'ZPKG' }
    ]);
    test.client.getTextElements.mockImplementation(async () => ({ textElements: structuredClone(textpool), programName: 'ZTXTPOOL' }));
    test.client.setTextElements.mockImplementation(async (_url: string, _cat: string, elements: Array<Record<string, unknown>>) => {
      textpool = structuredClone(elements);
    });

    await test.workflow.preview({
      operation: {
        kind: 'SET_TEXT_ELEMENTS', objectType: 'PROGRAM', objectName: 'ZTXTPOOL', category: 'symbols',
        transportRequest: 'DEVK900001', elements: [{ id: '001', text: 'Hello', maxLength: 132 }]
      }
    });
    await expect(test.workflow.apply('ddic-plan')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(test.client.lock).toHaveBeenCalledWith('/sap/bc/adt/textelements/programs/ztxtpool', 'MODIFY');
    expect(test.client.unLock).toHaveBeenCalledWith('/sap/bc/adt/textelements/programs/ztxtpool', 'secret-lock');
    expect(test.client.setTextElements).toHaveBeenCalledWith(
      '/sap/bc/adt/textelements/programs/ztxtpool', 'symbols', [{ id: '001', text: 'Hello', maxLength: 132 }], 'secret-lock', 'DEVK900001'
    );
    expect(test.client.activate).toHaveBeenCalledTimes(1);
  });

  it('verifies data element labels by submitted paths, tolerating SAP server backfill', async () => {
    const test = harness();
    // S/4 真机实测：DDIC 属性读回带服务器合法回填（标签长度、responsible 数字化），
    // 整体 hash 恒不相等；verify 只要求提交路径逐项匹配
    test.client.getDataElementProperties.mockImplementation(async (_url: string, version = 'active') => {
      const state = version === 'inactive' ? test.state.backfill : test.state.active;
      return { metaData: structuredClone(state.metaData), properties: structuredClone(state.properties) };
    });
    test.client.setDataElementProperties.mockImplementation(async (_url: string, properties: unknown, metaData: unknown) => {
      // 模拟 SAP：提交的字段落盘 + 服务器回填额外字段（标签长度、responsible 数字化）
      const backfilled = {
        metaData: { ...structuredClone(metaData as Record<string, unknown>), responsible: 68157, packageDescription: 'Customer development class' },
        properties: {
          ...structuredClone(properties as Record<string, unknown>),
          fieldLabels: { ...(properties as { fieldLabels: Record<string, unknown> }).fieldLabels, shortFieldLength: 10, mediumFieldLength: 20, longFieldLength: 40, headingFieldLength: 55 }
        }
      };
      test.state.backfill = backfilled;
      // 模拟激活成功后 active 态切换为新回填态
      test.state.active = structuredClone(backfilled);
    });
    test.state.active = {
      metaData: { name: 'ZDTEL', description: 'Old', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: 68157, packageName: 'ZPKG', packageDescription: 'Customer development class' },
      properties: {
        typeName: 'ZDOM', dataType: 'CHAR', dataTypeLength: 10, dataTypeDecimals: 0,
        fieldLabels: { shortFieldLabel: 'OldS', shortFieldLength: 10, mediumFieldLabel: 'Old M', mediumFieldLength: 20, longFieldLabel: 'Old long', longFieldLength: 40, headingFieldLabel: 'Old heading', headingFieldLength: 55 }
      }
    };
    test.state.backfill = structuredClone(test.state.active);

    await test.workflow.preview({
      operation: {
        kind: 'SET_DATA_ELEMENT_PROPERTIES', objectName: 'ZDTEL', transportRequest: 'DEVK900001',
        properties: {
          typeName: 'ZDOM', dataType: 'CHAR', dataTypeLength: 10, dataTypeDecimals: 0,
          fieldLabels: { shortFieldLabel: 'NewS', mediumFieldLabel: 'New M', longFieldLabel: 'New long', headingFieldLabel: 'New heading' }
        },
        metaData: { name: 'ZDTEL', description: 'Old', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: 68157, packageName: 'ZPKG' }
      }
    });
    await expect(test.workflow.apply('ddic-plan')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
  });
});
