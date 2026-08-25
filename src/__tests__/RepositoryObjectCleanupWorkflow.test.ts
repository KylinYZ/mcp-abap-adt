import { RepositoryObjectCleanupPlanStore } from '../safe/RepositoryObjectCleanupPlanStore';
import { RepositoryObjectCleanupWorkflow } from '../safe/RepositoryObjectCleanupWorkflow';
import { RepositoryObjectCreationRegistry } from '../safe/RepositoryObjectCreationRegistry';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';

const validationContext = {
  systemHost: 'dev.example.test', client: '300', sapUser: 'TEST_USER',
  systemRole: 'DEV', toolProfile: 'development' as const,
  realDevValidationEnabled: true,
  realDevValidationObjects: ['PROGRAM', 'SAP_OBJECT_TYPE', 'SAP_OBJECT_NODE_TYPE'],
  realDevValidationPrefix: 'ZV',
  realDevValidationPackage: 'Z001',
  realDevValidationTransport: 'S4HK900009'
};

describe('RepositoryObjectCleanupWorkflow', () => {
  it('freezes server-owned identity and deletes exactly once after revalidation', async () => {
    const client = cleanupClient([{ name: 'ZVPROG2', type: 'PROG/P', url: '/programs/zvprog2' }]);
    const workflow = cleanupWorkflow(client, 'cleanup-1');

    await expect(workflow.preview({ objectKind: 'PROGRAM', name: 'ZVPROG2' })).resolves.toMatchObject({
      status: 'preview', confirmationRequired: true,
      plan: { cleanupPlanId: 'cleanup-1', cleanupOrder: [{ objectKind: 'PROGRAM', objectName: 'ZVPROG2' }] }
    });
    await expect(workflow.apply('cleanup-1')).resolves.toMatchObject({ status: 'success', plan: { status: 'COMPLETED' } });
    await expect(workflow.apply('cleanup-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(client.deleteObject).toHaveBeenCalledTimes(1);
    expect(workflow.status('cleanup-1')).toMatchObject({ status: 'COMPLETED', cleanupOrder: [{ objectName: 'ZVPROG2' }] });
  });

  it('freezes and executes dependent SAP node cleanup before its parent type', async () => {
    const client = cleanupClient([
      { name: 'ZVOBJECT8', type: 'RONT/ROT', url: '/ront/zvobject8' },
      { name: 'ZVOBJECT8', type: 'NONT/NOT', url: '/nont/zvobject8' }
    ]);
    const workflow = cleanupWorkflow(client, 'cleanup-2');

    const preview = await workflow.preview({ objectKind: 'SAP_OBJECT_TYPE', name: 'ZVOBJECT8' }) as any;
    expect(preview.plan.cleanupOrder.map((item: any) => item.objectKind)).toEqual(['SAP_OBJECT_NODE_TYPE', 'SAP_OBJECT_TYPE']);
    await workflow.apply('cleanup-2');
    expect(client.deleteObject.mock.calls.map((call: unknown[]) => call[0])).toEqual(['/nont/zvobject8', '/ront/zvobject8']);
  });

  it('stops after an uncertain delete, releases its lock best-effort, and never deletes the parent', async () => {
    const client = cleanupClient([
      { name: 'ZVOBJECT9', type: 'RONT/ROT', url: '/ront/zvobject9' },
      { name: 'ZVOBJECT9', type: 'NONT/NOT', url: '/nont/zvobject9' }
    ]);
    client.deleteObject.mockRejectedValueOnce(new Error('connection reset after DELETE'));
    const workflow = cleanupWorkflow(client, 'cleanup-3');
    await workflow.preview({ objectKind: 'SAP_OBJECT_TYPE', name: 'ZVOBJECT9' });

    await expect(workflow.apply('cleanup-3')).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(client.deleteObject).toHaveBeenCalledTimes(1);
    expect(client.unLock).toHaveBeenCalledTimes(1);
    expect(workflow.status('cleanup-3')).toMatchObject({ status: 'OUTCOME_UNKNOWN' });
  });

  it('fails closed when the validation switch, prefix, package, or transport evidence does not match', async () => {
    const client = cleanupClient([{ name: 'ZOTHER', type: 'PROG/P', url: '/programs/zother' }]);
    const disabled = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationEnabled: false },
      new RepositoryObjectCleanupPlanStore(60_000)
    );
    await expect(disabled.preview({ objectKind: 'PROGRAM', name: 'ZOTHER' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const enabled = cleanupWorkflow(client, 'cleanup-4');
    await expect(enabled.preview({ objectKind: 'PROGRAM', name: 'ZOTHER' })).rejects.toMatchObject({
      code: 'POLICY_DENIED', stage: 'cleanup-policy'
    });
    expect(client.deleteObject).not.toHaveBeenCalled();
  });
});

function cleanupWorkflow(client: ReturnType<typeof cleanupClient>, planId: string): RepositoryObjectCleanupWorkflow {
  return new RepositoryObjectCleanupWorkflow(
    client,
    new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
    validationContext,
    new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => planId)
  );
}

function cleanupClient(initial: Array<{ name: string; type: string; url: string }>) {
  const resources = new Map(initial.map(item => [item.type, { ...item, present: true }]));
  const client = {
    searchObject: jest.fn(async (query: string, type: string) => {
      const resource = resources.get(type);
      return resource?.present && resource.name === query
        ? [{
          'adtcore:name': resource.name,
          'adtcore:type': resource.type,
          'adtcore:uri': resource.url,
          'adtcore:packageName': 'Z001'
        }]
        : [];
    }),
    objectStructure: jest.fn(async (url: string) => {
      const resource = [...resources.values()].find(item => item.url === url)!;
      return {
        objectUrl: url,
        metaData: {
          'adtcore:name': resource.name,
          'adtcore:type': resource.type,
          'adtcore:version': 'active'
        }
      };
    }),
    transportInfo: jest.fn(async (url: string) => {
      const resource = [...resources.values()].find(item => item.url === url)!;
      return {
        PGMID: 'R3TR', OBJECT: resource.type.split('/')[0], OBJECTNAME: resource.name,
        LOCKS: {
          HEADER: { TRKORR: 'S4HK900009' }, TASKS: [],
          OBJECT_KEY: { PGMID: 'R3TR', OBJECT: resource.type.split('/')[0], OBJ_NAME: resource.name }
        },
        TRANSPORTS: []
      };
    }),
    transportDetails: jest.fn(async () => ({
      'tm:status': 'D',
      objects: [...resources.values()].filter(item => item.present).map(item => ({
        'tm:pgmid': 'R3TR', 'tm:type': item.type.split('/')[0], 'tm:name': item.name,
        'tm:dummy_uri': '', 'tm:obj_info': ''
      })),
      tasks: []
    })),
    lock: jest.fn(async () => ({ LOCK_HANDLE: 'LOCK-1' })),
    unLock: jest.fn(async () => ''),
    deleteObject: jest.fn(async (url: string) => {
      const resource = [...resources.values()].find(item => item.url === url)!;
      resource.present = false;
    })
  };
  return client as any;
}
