import { AdvancedOperationPlanStore } from '../safe/AdvancedOperationPlanStore';
import { PackageChangeWorkflow } from '../safe/PackageChangeWorkflow';
import { SafetyPolicy } from '../safe/SafetyPolicy';

function policy() {
  return new SafetyPolicy({
    sapUrl: 'https://dev.example.com', sapClient: '100', systemRole: 'DEV',
    allowedHosts: 'dev.example.com', allowedClients: '100', allowedNamespaces: 'Z',
    auditPath: 'D:/audit', toolProfile: 'development'
  });
}

function harness(options: { executeError?: Error; drift?: boolean } = {}) {
  let packageName = 'ZOLD';
  const object = () => ({
    objectType: 'PROGRAM' as const, objectName: 'ZPROG', adtType: 'PROG/P',
    objectUrl: '/sap/bc/adt/programs/programs/zprog', sourceUrl: '/source', lockUrl: '/object',
    activationName: 'ZPROG', activationUrl: '/object', packageName
  });
  const resolver = { resolve: jest.fn(async () => object()) };
  let previewCount = 0;
  const client = {
    transportInfo: jest.fn().mockResolvedValue({ DEVCLASS: 'ZOLD', TRANSPORTS: [{ TRKORR: 'DEVK900001' }] }),
    transportDetails: jest.fn().mockResolvedValue({ 'tm:status': 'D' }),
    changePackagePreview: jest.fn(async (input: any, transport: string) => {
      previewCount += 1;
      return {
        ...input, transport,
        affectedObjects: { ...input.affectedObjects, newPackage: options.drift && previewCount > 1 ? 'ZOTHER' : input.newPackage }
      };
    }),
    changePackageExecute: jest.fn(async () => {
      if (options.executeError) throw options.executeError;
      packageName = 'ZNEW';
      return {};
    })
  };
  const plans = new AdvancedOperationPlanStore(900_000, () => 1_000, () => 'package-plan');
  const workflow = new PackageChangeWorkflow(client as never, resolver as never, policy(), plans, { append: jest.fn().mockResolvedValue(undefined) });
  return { workflow, client, plans, setPackage: (value: string) => { packageName = value; } };
}

describe('PackageChangeWorkflow', () => {
  const input = { objectType: 'PROGRAM', objectName: 'ZPROG', oldPackage: 'ZOLD', newPackage: 'ZNEW', transportRequest: 'DEVK900001' };

  it('previews once, re-previews for drift, and executes once', async () => {
    const test = harness();
    await test.workflow.preview(input);
    expect(test.client.changePackagePreview).toHaveBeenCalledTimes(1);
    expect(test.client.changePackageExecute).not.toHaveBeenCalled();
    await expect(test.workflow.apply('package-plan')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(test.client.changePackagePreview).toHaveBeenCalledTimes(2);
    expect(test.client.changePackageExecute).toHaveBeenCalledTimes(1);
  });

  it('stops before execute when the second preview drifts', async () => {
    const test = harness({ drift: true });
    await test.workflow.preview(input);
    await expect(test.workflow.apply('package-plan')).rejects.toMatchObject({ code: 'STATE_DRIFT' });
    expect(test.client.changePackageExecute).not.toHaveBeenCalled();
  });

  it('never retries or reverses an uncertain execute', async () => {
    const test = harness({ executeError: new Error('timeout') });
    await test.workflow.preview(input);
    await expect(test.workflow.apply('package-plan')).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME', details: { plan: { status: 'UNKNOWN_OUTCOME' } }
    });
    expect(test.client.changePackageExecute).toHaveBeenCalledTimes(1);
  });

  it('settles the plan when the confirmed drift preview fails remotely', async () => {
    const test = harness();
    await test.workflow.preview(input);
    test.client.changePackagePreview.mockRejectedValueOnce(new Error('preview endpoint unavailable'));

    await expect(test.workflow.apply('package-plan')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { plan: { status: 'FAILED' } }
    });
    expect(test.client.changePackageExecute).not.toHaveBeenCalled();
    expect(test.plans.view('package-plan').status).toBe('FAILED');
  });
});
