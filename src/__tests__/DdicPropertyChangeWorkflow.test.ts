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
  return { workflow, client, plans, previewInput, setActive: (value: typeof original) => { active = structuredClone(value); } };
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
});
