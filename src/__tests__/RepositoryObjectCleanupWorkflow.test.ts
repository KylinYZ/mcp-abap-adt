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
    expect(workflow.status('cleanup-1')).toMatchObject({
      status: 'COMPLETED',
      cleanupOrder: [{ objectName: 'ZVPROG2' }],
      stages: expect.arrayContaining([expect.objectContaining({ stage: 'TRANSPORT_DELETION_ENTRY_VERIFIED', success: true })])
    });
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

  it('freezes a generated CHDO class but deletes only the parent and verifies cascade absence', async () => {
    const client = cleanupClient([
      { name: 'ZVPCHDO04', type: 'CHDO/CHD', url: '/changedocuments/objects/zvpchdo04' },
      { name: 'ZCL_ZVPCHDO04_CHDO', type: 'CLAS/OC', url: '/oo/classes/zcl_zvpchdo04_chdo' }
    ]);
    client.objectStructure.mockImplementation(async (url: string) => {
      const type = url.includes('/changedocuments/') ? 'CHDO/CHD' : 'CLAS/OC';
      const name = type === 'CHDO/CHD' ? 'ZVPCHDO04' : 'ZCL_ZVPCHDO04_CHDO';
      return {
        objectUrl: url,
        metaData: { 'adtcore:name': name, 'adtcore:type': type, 'adtcore:version': 'active' },
        links: type === 'CHDO/CHD' ? [{
          href: './zvpchdo04/source/main', rel: 'http://www.sap.com/adt/relations/source', type: 'application/json'
        }] : []
      } as never;
    });
    client.getObjectSource.mockResolvedValue(JSON.stringify({
      generalInformation: { generatedObject: 'ZCL_ZVPCHDO04_CHDO' }
    }));
    const originalDelete = client.deleteObject.getMockImplementation()!;
    client.deleteObject.mockImplementation(async (url: string) => {
      await originalDelete(url);
      await originalDelete('/oo/classes/zcl_zvpchdo04_chdo');
    });
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['CHANGE_DOCUMENT_OBJECT'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-chdo')
    );

    const preview = await workflow.preview({ objectKind: 'CHANGE_DOCUMENT_OBJECT', name: 'ZVPCHDO04' }) as any;
    expect(preview.plan.cleanupOrder).toEqual([
      expect.objectContaining({ objectName: 'ZCL_ZVPCHDO04_CHDO', cleanupMode: 'CASCADE_VERIFY' }),
      expect.objectContaining({ objectName: 'ZVPCHDO04', cleanupMode: 'DIRECT' })
    ]);
    await expect(workflow.apply('cleanup-chdo')).resolves.toMatchObject({ status: 'success' });
    expect(client.deleteObject).toHaveBeenCalledTimes(1);
    expect(client.deleteObject).toHaveBeenCalledWith('/changedocuments/objects/zvpchdo04', 'LOCK-1', 'S4HK900009');
  });

  it('freezes the validation parent for a function-group include through apply', async () => {
    const client = cleanupClient([{
      name: 'LZVFG2Z01', type: 'FUGR/I', url: '/functions/groups/zvfg2/includes/lzvfg2z01'
    }]);
    const context = {
      ...validationContext,
      realDevValidationObjects: ['FUNCTION_GROUP_INCLUDE']
    };
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      context,
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-include')
    );

    const preview = await workflow.preview({
      objectKind: 'FUNCTION_GROUP_INCLUDE', name: 'LZVFG2Z01', parentName: 'ZVFG2'
    }) as any;
    expect(preview.plan.target).toMatchObject({ objectName: 'LZVFG2Z01', parentName: 'ZVFG2' });
    await expect(workflow.apply('cleanup-include')).resolves.toMatchObject({ status: 'success' });
    expect(client.deleteObject).toHaveBeenCalledTimes(1);
    expect(client.searchObject).toHaveBeenCalledWith('LZVFG2Z01', undefined, 20);
  });

  it('accepts E plus the configured prefix for DDIC lock object cleanup', async () => {
    const client = cleanupClient([{ name: 'EZVLOCK3', type: 'ENQU/DL', url: '/lockobjects/ezvlock3' }]);
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['DDIC_LOCK_OBJECT'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-lock')
    );

    await expect(workflow.preview({ objectKind: 'DDIC_LOCK_OBJECT', name: 'EZVLOCK3' })).resolves.toMatchObject({ status: 'preview' });
    await expect(workflow.apply('cleanup-lock')).resolves.toMatchObject({ status: 'success' });
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

  it('fails when CTS loses or duplicates the exact deletion entry', async () => {
    for (const entriesAfterDelete of [0, 2]) {
      const client = cleanupClient([{ name: `ZVCTS${entriesAfterDelete}`, type: 'PROG/P', url: `/programs/zvcts${entriesAfterDelete}` }]);
      const originalTransportDetails = client.transportDetails.getMockImplementation();
      client.transportDetails.mockImplementation(async () => {
        const details = await originalTransportDetails();
        if (client.deleteObject.mock.calls.length === 0) return details;
        const entry = details.objects[0];
        return { ...details, objects: Array(entriesAfterDelete).fill(entry) };
      });
      const workflow = cleanupWorkflow(client, `cleanup-cts-${entriesAfterDelete}`);
      await workflow.preview({ objectKind: 'PROGRAM', name: `ZVCTS${entriesAfterDelete}` });

      await expect(workflow.apply(`cleanup-cts-${entriesAfterDelete}`)).rejects.toMatchObject({
        code: 'VERIFICATION_FAILED', stage: 'cleanup-transport'
      });
      expect(client.deleteObject).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores matching creation and technical-setting entries when one deletion entry remains', async () => {
    const client = cleanupClient([{ name: 'ZVPROG1', type: 'PROG/P', url: '/programs/zvprog1' }]);
    const originalTransportDetails = client.transportDetails.getMockImplementation();
    client.transportDetails.mockImplementation(async () => {
      const details = await originalTransportDetails();
      return {
        ...details,
        objects: [
          { ...details.objects[0], 'tm:obj_func': '' },
          { 'tm:pgmid': 'LIMU', 'tm:type': 'TABT', 'tm:name': 'ZVTABLE1', 'tm:obj_func': '' },
          details.objects[0]
        ]
      };
    });
    const workflow = cleanupWorkflow(client, 'cleanup-table');
    await workflow.preview({ objectKind: 'PROGRAM', name: 'ZVPROG1' });

    await expect(workflow.apply('cleanup-table')).resolves.toMatchObject({ status: 'success' });
  });

  it('completes local absence when one exact neutral transport entry remains', async () => {
    const client = cleanupClient([{ name: 'ZVNEUTRAL1', type: 'PROG/P', url: '/programs/zvneutral1' }]);
    const originalTransportDetails = client.transportDetails.getMockImplementation()!;
    client.transportDetails.mockImplementation(async () => {
      const details = await originalTransportDetails();
      return { ...details, objects: details.objects.map((entry: any) => ({ ...entry, 'tm:obj_func': '' })) };
    });
    const workflow = cleanupWorkflow(client, 'cleanup-neutral');
    await workflow.preview({ objectKind: 'PROGRAM', name: 'ZVNEUTRAL1' });

    await expect(workflow.apply('cleanup-neutral')).resolves.toMatchObject({
      status: 'success',
      plan: {
        status: 'COMPLETED_LOCAL_ABSENCE',
        transportDisposition: 'NEUTRAL_ENTRIES_VERIFIED',
        stages: expect.arrayContaining([expect.objectContaining({ stage: 'TRANSPORT_NEUTRAL_ENTRY_VERIFIED' })])
      }
    });
  });

  it('rejects duplicate neutral transport entries', async () => {
    const client = cleanupClient([{ name: 'ZVNEUTRAL2', type: 'PROG/P', url: '/programs/zvneutral2' }]);
    const originalTransportDetails = client.transportDetails.getMockImplementation()!;
    client.transportDetails.mockImplementation(async () => {
      const details = await originalTransportDetails();
      const neutral = { ...details.objects[0], 'tm:obj_func': '' };
      return { ...details, objects: [neutral, neutral] };
    });
    const workflow = cleanupWorkflow(client, 'cleanup-neutral-duplicate');
    await workflow.preview({ objectKind: 'PROGRAM', name: 'ZVNEUTRAL2' });

    await expect(workflow.apply('cleanup-neutral-duplicate')).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED', stage: 'cleanup-transport'
    });
  });

  it('requires the Service Binding SRVB and G4BA keys to share one neutral disposition', async () => {
    const client = cleanupClient([{
      name: 'ZVPSVB03', type: 'SRVB/SVB', url: '/businessservices/bindings/zvpsvb03'
    }]);
    const originalTransportDetails = client.transportDetails.getMockImplementation()!;
    client.transportDetails.mockImplementation(async () => {
      const details = await originalTransportDetails();
      return {
        ...details,
        objects: [
          { ...details.objects[0], 'tm:obj_func': '' },
          { 'tm:pgmid': 'R3TR', 'tm:type': 'G4BA', 'tm:name': 'ZVPSVB03', 'tm:obj_func': '' }
        ]
      };
    });
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['SERVICE_BINDING'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-service-binding')
    );

    const preview = await workflow.preview({ objectKind: 'SERVICE_BINDING', name: 'ZVPSVB03' }) as any;
    expect(preview.plan.target.transportCompanionKeys).toEqual([{
      programId: 'R3TR', objectType: 'G4BA', objectName: 'ZVPSVB03'
    }]);
    await expect(workflow.apply('cleanup-service-binding')).resolves.toMatchObject({
      plan: { status: 'COMPLETED_LOCAL_ABSENCE', transportDisposition: 'NEUTRAL_ENTRIES_VERIFIED' }
    });
  });

  it('accepts function-group CTS evidence when SAPL technical names are normalized back to the business name', async () => {
    const client = cleanupClient([{ name: 'ZVFG7', type: 'FUGR/F', url: '/functions/groups/zvfg7' }]);
    client.transportInfo.mockResolvedValue({
      PGMID: 'R3TR',
      OBJECT: 'REPS',
      OBJECTNAME: 'SAPLZVFG7',
      LOCKS: {
        HEADER: { TRKORR: 'S4HK900009' },
        TASKS: [],
        OBJECT_KEY: { PGMID: 'R3TR', OBJECT: 'REPS', OBJ_NAME: 'SAPLZVFG7' }
      },
      TRANSPORTS: []
    } as never);
    client.transportDetails.mockResolvedValue({
      'tm:status': 'modifiable',
      objects: [{
        'tm:pgmid': 'R3TR',
        'tm:type': 'REPS',
        'tm:name': 'ZVFG7',
        'tm:dummy_uri': '',
        'tm:obj_info': '',
        'tm:obj_func': ''
      }],
      tasks: []
    } as never);

    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['FUNCTION_GROUP'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-fg-sapl')
    );
    await expect(workflow.preview({ objectKind: 'FUNCTION_GROUP', name: 'ZVFG7' })).resolves.toMatchObject({
      plan: { target: expect.objectContaining({ transportObjectName: 'SAPLZVFG7' }) }
    });

    await expect(workflow.apply('cleanup-fg-sapl')).resolves.toMatchObject({
      status: 'success',
      plan: {
        status: 'COMPLETED_LOCAL_ABSENCE',
        transportDisposition: 'NEUTRAL_ENTRIES_VERIFIED'
      }
    });
  });

  it('accepts the standard R3TR/FUGR business key for a function group', async () => {
    const client = cleanupClient([{ name: 'ZVFG8', type: 'FUGR/F', url: '/functions/groups/zvfg8' }]);
    client.transportInfo.mockResolvedValue({
      PGMID: 'LIMU', OBJECT: 'REPS', OBJECTNAME: 'SAPLZVFG8',
      LOCKS: { HEADER: { TRKORR: 'S4HK900009' }, TASKS: [], OBJECT_KEY: { PGMID: 'LIMU', OBJECT: 'REPS', OBJ_NAME: 'SAPLZVFG8' } },
      TRANSPORTS: []
    } as never);
    client.transportDetails.mockResolvedValue({
      'tm:status': 'modifiable',
      objects: [{ 'tm:pgmid': 'R3TR', 'tm:type': 'FUGR', 'tm:name': 'ZVFG8', 'tm:obj_func': '' }],
      tasks: []
    } as never);
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['FUNCTION_GROUP'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-fg-r3tr')
    );
    await expect(workflow.preview({ objectKind: 'FUNCTION_GROUP', name: 'ZVFG8' })).resolves.toBeDefined();
    await expect(workflow.apply('cleanup-fg-r3tr')).resolves.toMatchObject({
      status: 'success', plan: { status: 'COMPLETED_LOCAL_ABSENCE', transportDisposition: 'NEUTRAL_ENTRIES_VERIFIED' }
    });
  });

  it('resolves a function module without the lossy FUGR quick-search filter', async () => {
    const client = cleanupClient([{ name: 'ZVFM11B', type: 'FUGR/FF', url: '/functions/groups/zvfg11/fmodules/zvfm11b' }]);
    client.searchObject.mockImplementation(async (query: string, type?: string) => (
      query === 'ZVFM11B' && type === undefined
        ? [{ 'adtcore:name': 'ZVFM11B', 'adtcore:type': 'FUGR/FF', 'adtcore:uri': '/functions/groups/zvfg11/fmodules/zvfm11b', 'adtcore:packageName': 'Z001' }]
        : []
    ));
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['FUNCTION_MODULE'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-fm-search')
    );

    await expect(workflow.preview({ objectKind: 'FUNCTION_MODULE', name: 'ZVFM11B', parentName: 'ZVFG11' })).resolves.toBeDefined();
    expect(client.searchObject).toHaveBeenCalledWith('ZVFM11B', undefined, 20);
  });

  it('accepts the generated function-pool lock key for a frozen function-module parent', async () => {
    const client = cleanupClient([{ name: 'ZVFM12', type: 'FUGR/FF', url: '/functions/groups/zvfg12/fmodules/zvfm12' }]);
    client.searchObject.mockImplementation(async (query: string, type?: string) => (
      query === 'ZVFM12' && type === undefined
        ? [{ 'adtcore:name': 'ZVFM12', 'adtcore:type': 'FUGR/FF', 'adtcore:uri': '/functions/groups/zvfg12/fmodules/zvfm12', 'adtcore:packageName': 'Z001' }]
        : []
    ));
    client.transportInfo.mockResolvedValue({
      PGMID: 'LIMU', OBJECT: 'FUNC', OBJECTNAME: 'ZVFM12',
      LOCKS: { HEADER: { TRKORR: 'S4HK900009' }, TASKS: [], OBJECT_KEY: { PGMID: 'LIMU', OBJECT: 'REPS', OBJ_NAME: 'LZVFG12UXX' } },
      TRANSPORTS: []
    } as never);
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['FUNCTION_MODULE'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-fm-lock')
    );

    await expect(workflow.preview({ objectKind: 'FUNCTION_MODULE', name: 'ZVFM12', parentName: 'ZVFG12' })).resolves.toBeDefined();
  });

  it('accepts the generated function-pool CTS key for a function module', async () => {
    const client = cleanupClient([{ name: 'ZVFM13', type: 'FUGR/FF', url: '/functions/groups/zvfg13/fmodules/zvfm13' }]);
    client.searchObject.mockImplementation(async (query: string, type?: string) => (
      query === 'ZVFM13' && type === undefined && client.deleteObject.mock.calls.length === 0
        ? [{ 'adtcore:name': 'ZVFM13', 'adtcore:type': 'FUGR/FF', 'adtcore:uri': '/functions/groups/zvfg13/fmodules/zvfm13', 'adtcore:packageName': 'Z001' }]
        : []
    ));
    client.transportInfo.mockResolvedValue({
      PGMID: 'LIMU', OBJECT: 'FUNC', OBJECTNAME: 'ZVFM13',
      LOCKS: { HEADER: { TRKORR: 'S4HK900009' }, TASKS: [], OBJECT_KEY: { PGMID: 'LIMU', OBJECT: 'REPS', OBJ_NAME: 'LZVFG13UXX' } },
      TRANSPORTS: []
    } as never);
    client.transportDetails.mockResolvedValue({
      'tm:status': 'modifiable',
      objects: [{ 'tm:pgmid': 'LIMU', 'tm:type': 'REPS', 'tm:name': 'LZVFG13UXX', 'tm:obj_func': '' }],
      tasks: []
    } as never);
    const workflow = new RepositoryObjectCleanupWorkflow(
      client,
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...validationContext, realDevValidationObjects: ['FUNCTION_MODULE'] },
      new RepositoryObjectCleanupPlanStore(60_000, () => 1_000, () => 'cleanup-fm-cts')
    );

    await expect(workflow.preview({ objectKind: 'FUNCTION_MODULE', name: 'ZVFM13', parentName: 'ZVFG13' })).resolves.toMatchObject({
      plan: { target: { transportIdentityAliases: [{ programId: 'LIMU', objectType: 'REPS', objectName: 'LZVFG13UXX' }] } }
    });
    await expect(workflow.apply('cleanup-fm-cts')).resolves.toMatchObject({
      status: 'success', plan: { status: 'COMPLETED_LOCAL_ABSENCE', transportDisposition: 'NEUTRAL_ENTRIES_VERIFIED' }
    });
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
  const transportObjects = initial.map(item => ({
    'tm:pgmid': 'R3TR', 'tm:type': item.type.split('/')[0], 'tm:name': item.name,
    'tm:dummy_uri': '', 'tm:obj_info': '', 'tm:obj_func': 'D'
  }));
  const client = {
    searchObject: jest.fn(async (query: string, type: string | undefined) => {
      const resource = type
        ? resources.get(type)
        : [...resources.values()].find(item => item.name === query);
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
    getObjectSource: jest.fn(async () => ''),
    readControlledPackage: jest.fn(async (name: string) => ({ name, parentPackageName: 'Z001' })),
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
      objects: transportObjects,
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
