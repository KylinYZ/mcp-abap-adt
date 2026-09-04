import { AbapObjectCreationWorkflow } from '../safe/AbapObjectCreationWorkflow';
import { CreationPlanStore } from '../safe/CreationPlanStore';
import { SafetyPolicy } from '../safe/SafetyPolicy';
import type { AbapCreationResolver } from '../safe/AbapCreationResolver';
import type { CreationAdtClient, ResolvedCreationObject } from '../safe/creationTypes';
import { SafeAbapError } from '../safe/errors';

const object: ResolvedCreationObject = {
  objectType: 'PROGRAM',
  objectName: 'ZNEW',
  description: 'New program',
  adtType: 'PROG/P',
  packageName: 'Z001',
  parentName: 'Z001',
  parentPath: '/sap/bc/adt/packages/z001',
  objectUrl: '/sap/bc/adt/programs/programs/znew',
  sourceUrl: '/sap/bc/adt/programs/programs/znew/source/main',
  source: 'REPORT znew.\nWRITE / test.',
  sourceHash: 'target-hash'
};

function harness(options: {
  syntaxError?: boolean;
  syntaxWarning?: boolean;
  uncertainCreate?: boolean;
  resolveCreatedFails?: boolean;
  activationThrows?: boolean;
  activeAfterActivationError?: boolean;
  inactiveAfterActivationError?: boolean;
  activationReturnsInactive?: boolean;
} = {}) {
  const calls: string[] = [];
  let exists = false;
  let source = '';
  let activationAttempted = false;
  const resolver = {
    resolve: jest.fn(async () => [{ ...object }]),
    assertTargetsAbsent: jest.fn(async () => {
      if (exists) throw new Error('already exists');
    }),
    resolveCreated: jest.fn(async (_expected: ResolvedCreationObject, version = 'inactive') => {
      if (!exists) throw new Error('not found');
      if (options.resolveCreatedFails) throw new Error('object structure unavailable');
      if (options.activationThrows && activationAttempted) {
        if (version === 'active' && !options.activeAfterActivationError) {
          throw new SafeAbapError('OBJECT_CREATION_FAILED', 'resolve-created', 'active version unavailable');
        }
        if (version === 'inactive' && !options.inactiveAfterActivationError) {
          throw new SafeAbapError('OBJECT_CREATION_FAILED', 'resolve-created', 'inactive version unavailable');
        }
      }
      return { ...object };
    })
  };
  const client = {
    searchObject: jest.fn(),
    objectStructure: jest.fn(),
    mainPrograms: jest.fn(),
    transportInfo: jest.fn(async () => ({
      DEVCLASS: 'Z001', TRANSPORTS: [{ TRKORR: 'DEVK900001' }], LOCKS: { TASKS: [] }
    })),
    transportDetails: jest.fn(async () => ({ 'tm:status': 'modifiable' })),
    getObjectSource: jest.fn(async () => { calls.push('getSource'); return source; }),
    setObjectSource: jest.fn(async (_url, value) => { calls.push('write'); source = value; }),
    syntaxCheck: jest.fn(async () => {
      calls.push('syntax');
      if (options.syntaxError) return [{ severity: 'E', line: 1, text: 'bad source' }];
      if (options.syntaxWarning) return [{ severity: 'WARNING', line: 1, text: 'warning only' }];
      return [];
    }),
    lock: jest.fn(async () => { calls.push('lock'); return { LOCK_HANDLE: 'lock-1' }; }),
    unLock: jest.fn(async () => { calls.push('unlock'); return ''; }),
    activate: jest.fn(async () => {
      calls.push('activate');
      activationAttempted = true;
      if (options.activationThrows) throw new Error('connection reset after activation request');
      if (options.activationReturnsInactive) {
        return {
          success: false,
          messages: [],
          inactive: [{
            object: {
              'adtcore:uri': object.objectUrl,
              'adtcore:type': object.adtType,
              'adtcore:name': object.objectName,
              'adtcore:parentUri': object.parentPath,
              user: 'SECRET_USER',
              deleted: false
            },
            transport: {
              'adtcore:uri': '/sap/bc/adt/cts/transportrequests/DEVK900001',
              'adtcore:type': 'TR/REQUEST',
              'adtcore:name': 'DEVK900001',
              'adtcore:parentUri': '',
              user: 'SECRET_USER',
              deleted: false
            }
          }]
        };
      }
      return { success: true, messages: [], inactive: [] };
    }),
    validateNewObject: jest.fn(async () => ({ success: true })),
    createObject: jest.fn(async () => {
      calls.push('create');
      exists = true;
      if (options.uncertainCreate) throw new Error('connection reset after request');
    }),
    deleteObject: jest.fn(async () => { calls.push('delete'); exists = false; })
  } as unknown as jest.Mocked<CreationAdtClient>;
  const policy = new SafetyPolicy({
    sapUrl: 'https://dev.example.com', sapClient: '100', systemRole: 'DEV',
    allowedHosts: 'dev.example.com', allowedClients: '100', allowedNamespaces: 'Z', auditPath: './audit'
  });
  const auditEvents: Record<string, unknown>[] = [];
  const workflow = new AbapObjectCreationWorkflow(
    client,
    resolver as unknown as AbapCreationResolver,
    policy,
    new CreationPlanStore(60_000, () => 1_000, () => 'creation-1'),
    { append: async event => { auditEvents.push(event as unknown as Record<string, unknown>); } }
  );
  return { workflow, client, resolver, calls, auditEvents, exists: () => exists };
}

const previewInput = {
  objects: [{
    objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New program', packageName: 'Z001', source: object.source
  }],
  transportRequest: 'DEVK900001'
};

describe('AbapObjectCreationWorkflow', () => {
  it('previews without mutations and applies the immutable program plan', async () => {
    const test = harness();
    const preview = await test.workflow.preview(previewInput);

    expect(preview).toMatchObject({
      status: 'preview', syntaxValidation: 'deferred_until_creation', confirmationRequired: true,
      sources: [{ objectName: 'ZNEW', source: object.source }]
    });
    expect(test.calls).toEqual([]);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(test.calls).toEqual(['create', 'lock', 'write', 'syntax', 'unlock', 'activate', 'getSource']);
    expect(test.client.activate).toHaveBeenCalledWith(object.objectName, object.objectUrl, undefined, true);
    expect(test.exists()).toBe(true);
    expect(test.workflow.status('creation-1')).toMatchObject({
      status: 'APPLIED', createdObjects: [{ objectName: 'ZNEW', ownershipProven: true, sourceMatchType: 'EXACT' }]
    });
  });

  it('deletes a proven object when authoritative syntax validation fails', async () => {
    const test = harness({ syntaxError: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({ code: 'SYNTAX_CHECK_FAILED', details: { plan: { status: 'COMPENSATED' } } });
    expect(test.calls).toEqual(['create', 'lock', 'write', 'syntax', 'unlock', 'lock', 'delete']);
    expect(test.exists()).toBe(false);
  });

  it('never deletes an object found after an uncertain create response', async () => {
    const test = harness({ uncertainCreate: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({
      code: 'OBJECT_CREATION_FAILED',
      details: { plan: { status: 'COMPENSATION_FAILED', createdObjects: [{ ownershipProven: false }] } }
    });
    expect(test.client.deleteObject).not.toHaveBeenCalled();
    expect(test.exists()).toBe(true);
  });

  it('records an acknowledged creation as uncertain when post-create resolution fails', async () => {
    const test = harness({ resolveCreatedFails: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({
      code: 'OBJECT_CREATION_FAILED',
      details: { plan: { status: 'COMPENSATION_FAILED', createdObjects: [{ ownershipProven: false }] } }
    });
    expect(test.client.deleteObject).not.toHaveBeenCalled();
    expect(test.exists()).toBe(true);
  });

  it('does not treat a WARNING severity label as a syntax error', async () => {
    const test = harness({ syntaxWarning: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
  });

  it('returns sanitized inactive diagnostics for an explicit activation failure', async () => {
    const test = harness({ activationReturnsInactive: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({
      code: 'ACTIVATION_FAILED',
      details: {
        inactiveCount: 1,
        inactiveObjects: [{
          uri: object.objectUrl,
          type: object.adtType,
          name: object.objectName,
          parentUri: object.parentPath
        }],
        plan: { status: 'COMPENSATED' }
      }
    });
    const serialized = JSON.stringify(test.workflow.status('creation-1'));
    expect(serialized).not.toContain('SECRET_USER');
    expect(serialized).not.toContain('REPORT znew');
    expect(serialized).not.toContain('lock-1');
    expect(test.auditEvents.at(-1)).toMatchObject({ activationInactiveCount: 1 });
  });

  it('continues without retrying when an activation exception is followed by an active version', async () => {
    const test = harness({ activationThrows: true, activeAfterActivationError: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(test.client.activate).toHaveBeenCalledTimes(1);
    expect(test.client.deleteObject).not.toHaveBeenCalled();
  });

  it('compensates when an activation exception is followed by a proven inactive version', async () => {
    const test = harness({ activationThrows: true, inactiveAfterActivationError: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({
      code: 'ACTIVATION_FAILED',
      details: { activationOutcome: 'INACTIVE_CONFIRMED', plan: { status: 'COMPENSATED' } }
    });
    expect(test.client.activate).toHaveBeenCalledTimes(1);
    expect(test.client.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('forbids compensation when activation outcome cannot be determined', async () => {
    const test = harness({ activationThrows: true });
    await test.workflow.preview(previewInput);

    await expect(test.workflow.apply({
      creationPlanId: 'creation-1', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({
      code: 'ACTIVATION_FAILED',
      details: { activationOutcome: 'UNKNOWN', plan: { status: 'COMPENSATION_FAILED' } }
    });
    expect(test.client.activate).toHaveBeenCalledTimes(1);
    expect(test.client.deleteObject).not.toHaveBeenCalled();
    expect(test.auditEvents.at(-1)).toMatchObject({ activationOutcome: 'UNKNOWN' });
  });

  it('creates a function-group include with the full L include name and verifies workingArea source only', async () => {
    const include: ResolvedCreationObject = {
      objectType: 'FUNCTION_GROUP_INCLUDE',
      objectName: 'LZVFG1001',
      description: 'Include 001',
      adtType: 'FUGR/I',
      packageName: 'Z001',
      parentName: 'ZVFG1',
      parentPath: '/sap/bc/adt/functions/groups/zvfg1',
      parentFunctionGroup: 'ZVFG1',
      objectUrl: '/sap/bc/adt/functions/groups/zvfg1/includes/lzvfg1001',
      sourceUrl: '/sap/bc/adt/functions/groups/zvfg1/includes/lzvfg1001/source/main',
      activationParentUrl: '/sap/bc/adt/functions/groups/zvfg1',
      creationName: '001',
      source: 'DATA gv_zvfg1001 TYPE i VALUE 1.',
      sourceHash: 'include-source-hash'
    };
    const existing = new Set<string>();
    const calls: string[] = [];
    const resolvedVersions: string[] = [];
    const createOptions: unknown[] = [];
    const resolver = {
      resolve: jest.fn(async () => [{ ...include }]),
      assertTargetsAbsent: jest.fn(async (targets: ResolvedCreationObject[]) => {
        const found = targets.find(target => existing.has(target.objectName));
        if (found) throw new Error(`${found.objectName} already exists`);
      }),
      resolveCreated: jest.fn(async (expected: ResolvedCreationObject, version = 'inactive') => {
        if (!existing.has(expected.objectName)) throw new Error('not found');
        resolvedVersions.push(`${expected.objectName}:${version}`);
        return { ...expected };
      })
    };
    const client = {
      transportInfo: jest.fn(async () => ({
        DEVCLASS: 'Z001', TRANSPORTS: [{ TRKORR: 'DEVK900001' }], LOCKS: { TASKS: [] }
      })),
      transportDetails: jest.fn(async () => ({ 'tm:status': 'modifiable' })),
      validateNewObject: jest.fn(async (options: { objname?: string }) => {
        calls.push(`validate:${options.objname}`);
        return { success: true };
      }),
      createObject: jest.fn(async (options: { name: string }) => {
        createOptions.push(options);
        calls.push(`create:${options.name}`);
        existing.add(options.name);
      }),
      lock: jest.fn(async (url: string) => {
        calls.push(`lock:${url}`);
        return { LOCK_HANDLE: `lock-${url}` };
      }),
      setObjectSource: jest.fn(async () => { calls.push('write:LZVFG1001'); }),
      syntaxCheck: jest.fn(async () => {
        calls.push('syntax:LZVFG1001');
        return [];
      }),
      unLock: jest.fn(async () => { calls.push('unlock:LZVFG1001'); return ''; }),
      getObjectSource: jest.fn(async (url: string, options?: { version?: string }) => {
        calls.push(`getSource:${url}:${options?.version || 'default'}`);
        if (url.toUpperCase().includes('UXX')) throw new Error('UXX must not be read for created include verification');
        return include.source as string;
      }),
      activate: jest.fn(async (...args: unknown[]) => {
        calls.push(`activate:${String(args[0])}`);
        return { success: true, messages: [], inactive: [] };
      }),
      deleteObject: jest.fn()
    } as unknown as jest.Mocked<CreationAdtClient>;
    const policy = new SafetyPolicy({
      sapUrl: 'https://dev.example.com', sapClient: '100', systemRole: 'DEV',
      allowedHosts: 'dev.example.com', allowedClients: '100', allowedNamespaces: 'Z', auditPath: './audit'
    });
    const workflow = new AbapObjectCreationWorkflow(
      client,
      resolver as unknown as AbapCreationResolver,
      policy,
      new CreationPlanStore(60_000, () => 1_000, () => 'include-plan'),
      { append: async () => undefined }
    );

    await workflow.preview({
      objects: [{
        objectType: 'FUNCTION_GROUP_INCLUDE',
        objectName: '001',
        description: 'Include 001',
        parentFunctionGroup: 'ZVFG1',
        source: include.source
      }],
      transportRequest: 'DEVK900001'
    });
    await expect(workflow.apply({
      creationPlanId: 'include-plan', confirmedByUser: true, confirmationMode: 'elicitation'
    })).resolves.toMatchObject({
      status: 'success',
      plan: {
        status: 'APPLIED',
        createdObjects: [expect.objectContaining({
          objectName: 'LZVFG1001',
          sourceMatchType: 'EXACT'
        })]
      }
    });

    expect(createOptions).toEqual([expect.objectContaining({
      objtype: 'FUGR/I',
      name: 'LZVFG1001',
      parentName: 'ZVFG1',
      contentType: 'application/vnd.sap.adt.functions.fincludes.v2+xml'
    })]);
    expect(client.activate).toHaveBeenCalledWith('LZVFG1001', include.objectUrl, undefined, true);
    expect(client.getObjectSource).toHaveBeenCalledWith(include.sourceUrl, { version: 'workingArea' });
    expect(resolvedVersions).toEqual(['LZVFG1001:inactive', 'LZVFG1001:workingArea']);
    expect(calls.join('\n').toUpperCase()).not.toContain('UXX');
    expect(existing).toEqual(new Set(['LZVFG1001']));
  });

  it('uses Eclipse function-module activation, verifies the parent, and compensates in reverse order', async () => {
    const functionGroup: ResolvedCreationObject = {
      objectType: 'FUNCTION_GROUP',
      objectName: 'ZNEW_FG',
      description: 'New function group',
      adtType: 'FUGR/F',
      packageName: 'Z001',
      parentName: 'Z001',
      parentPath: '/sap/bc/adt/packages/z001',
      objectUrl: '/sap/bc/adt/functions/groups/znew_fg',
      sourceUrl: '/sap/bc/adt/functions/groups/znew_fg/source/main'
    };
    const functionModule: ResolvedCreationObject = {
      objectType: 'FUNCTION_MODULE',
      objectName: 'ZNEW_FM',
      description: 'New function module',
      adtType: 'FUGR/FF',
      packageName: 'Z001',
      parentName: 'ZNEW_FG',
      parentPath: functionGroup.objectUrl,
      parentFunctionGroup: 'ZNEW_FG',
      objectUrl: `${functionGroup.objectUrl}/fmodules/znew_fm`,
      sourceUrl: `${functionGroup.objectUrl}/fmodules/znew_fm/source/main`,
      activationParentUrl: functionGroup.objectUrl,
      source: 'FUNCTION znew_fm\n  IMPORTING\n    VALUE(iv_input) TYPE string.\n\n  DATA(result) = iv_input.\nENDFUNCTION.',
      sourceHash: 'function-source-hash'
    };
    const objects = [functionGroup, functionModule];
    const existing = new Set<string>();
    const calls: string[] = [];
    const activationArguments: unknown[][] = [];
    const resolvedVersions: string[] = [];
    const resolver = {
      resolve: jest.fn(async () => objects.map(value => ({ ...value }))),
      assertTargetsAbsent: jest.fn(async (targets: ResolvedCreationObject[]) => {
        const found = targets.find(target => existing.has(target.objectName));
        if (found) throw new Error(`${found.objectName} already exists`);
      }),
      resolveCreated: jest.fn(async (expected: ResolvedCreationObject, version = 'inactive') => {
        if (!existing.has(expected.objectName)) throw new Error('not found');
        resolvedVersions.push(`${expected.objectName}:${version}`);
        return { ...expected };
      })
    };
    const client = {
      transportInfo: jest.fn(async () => ({
        DEVCLASS: 'Z001', TRANSPORTS: [{ TRKORR: 'DEVK900001' }], LOCKS: { TASKS: [] }
      })),
      transportDetails: jest.fn(async () => ({ 'tm:status': 'modifiable' })),
      validateNewObject: jest.fn(async (options: { objname?: string }) => {
        calls.push(`validate:${options.objname}`);
        if (options.objname === 'ZNEW_FM' && !existing.has('ZNEW_FG')) {
          throw new Error('parent function group is missing');
        }
        return { success: true };
      }),
      createObject: jest.fn(async (options: { name: string }) => {
        calls.push(`create:${options.name}`);
        existing.add(options.name);
      }),
      lock: jest.fn(async (url: string) => {
        calls.push(`lock:${url}`);
        return { LOCK_HANDLE: `lock-${url}` };
      }),
      setObjectSource: jest.fn(async () => { calls.push('write:ZNEW_FM'); }),
      syntaxCheck: jest.fn(async () => {
        calls.push('syntax:ZNEW_FM');
        return [];
      }),
      unLock: jest.fn(async () => { calls.push('unlock:ZNEW_FM'); return ''; }),
      getObjectSource: jest.fn(async () => {
        calls.push('getSource:ZNEW_FM');
        return (functionModule.source as string)
          .replace(/(TYPE string\.)\n+/, '$1\n\n\n\n')
          .replace(/\n/g, '\r\n');
      }),
      activate: jest.fn(async (...args: unknown[]) => {
        activationArguments.push(args);
        calls.push(`activate:${String(args[0])}`);
        return { success: true, messages: [], inactive: [] };
      }),
      deleteObject: jest.fn(async (url: string) => {
        const name = url.includes('/fmodules/') ? 'ZNEW_FM' : 'ZNEW_FG';
        calls.push(`delete:${name}`);
        existing.delete(name);
      })
    } as unknown as jest.Mocked<CreationAdtClient>;
    const policy = new SafetyPolicy({
      sapUrl: 'https://dev.example.com', sapClient: '100', systemRole: 'DEV',
      allowedHosts: 'dev.example.com', allowedClients: '100', allowedNamespaces: 'Z', auditPath: './audit'
    });
    const workflow = new AbapObjectCreationWorkflow(
      client,
      resolver as unknown as AbapCreationResolver,
      policy,
      new CreationPlanStore(60_000, () => 1_000, () => 'creation-graph'),
      {
        append: async event => {
          // Exercise recovery after both the module and its new parent are proven active.
          if (event.eventType === 'OBJECT_VERIFIED:ZNEW_FG') throw new Error('audit unavailable');
        }
      }
    );

    await expect(workflow.preview({
      objects: [
        { objectType: 'FUNCTION_GROUP', objectName: 'ZNEW_FG', description: 'New group', packageName: 'Z001' },
        { objectType: 'FUNCTION_MODULE', objectName: 'ZNEW_FM', description: 'New module', parentFunctionGroup: 'ZNEW_FG', source: functionModule.source }
      ],
      transportRequest: 'DEVK900001'
    })).resolves.toMatchObject({ deferredObjectValidation: ['ZNEW_FM'] });
    expect(calls).toEqual(['validate:ZNEW_FG']);

    await expect(workflow.apply({
      creationPlanId: 'creation-graph', confirmedByUser: true, confirmationMode: 'elicitation'
    })).rejects.toMatchObject({
      code: 'OBJECT_CREATION_FAILED',
      details: { plan: { status: 'COMPENSATED', compensationSucceeded: true } }
    });
    expect(calls).toEqual([
      'validate:ZNEW_FG',
      'validate:ZNEW_FG', 'create:ZNEW_FG',
      'validate:ZNEW_FM', 'create:ZNEW_FM',
      `lock:${functionModule.objectUrl}`, 'write:ZNEW_FM', 'syntax:ZNEW_FM', 'unlock:ZNEW_FM',
      'activate:ZNEW_FM', 'getSource:ZNEW_FM',
      `lock:${functionModule.objectUrl}`, 'delete:ZNEW_FM',
      `lock:${functionGroup.objectUrl}`, 'delete:ZNEW_FG'
    ]);
    expect(existing.size).toBe(0);
    expect(activationArguments).toEqual([[
      'ZNEW_FM', functionModule.objectUrl, undefined, true
    ]]);
    expect(resolvedVersions).toEqual([
      'ZNEW_FG:inactive',
      'ZNEW_FM:inactive',
      'ZNEW_FM:active',
      'ZNEW_FG:active'
    ]);

    calls.length = 0;
    activationArguments.length = 0;
    resolvedVersions.length = 0;
    const successWorkflow = new AbapObjectCreationWorkflow(
      client,
      resolver as unknown as AbapCreationResolver,
      policy,
      new CreationPlanStore(60_000, () => 1_000, () => 'creation-success'),
      { append: async () => undefined }
    );
    await successWorkflow.preview({
      objects: [
        { objectType: 'FUNCTION_GROUP', objectName: 'ZNEW_FG', description: 'New group', packageName: 'Z001' },
        { objectType: 'FUNCTION_MODULE', objectName: 'ZNEW_FM', description: 'New module', parentFunctionGroup: 'ZNEW_FG', source: functionModule.source }
      ],
      transportRequest: 'DEVK900001'
    });

    await expect(successWorkflow.apply({
      creationPlanId: 'creation-success', confirmedByUser: true, confirmationMode: 'elicitation'
    })).resolves.toMatchObject({
      status: 'success',
      plan: {
        status: 'APPLIED',
        compensationAttempted: undefined,
        createdObjects: expect.arrayContaining([expect.objectContaining({
          objectName: 'ZNEW_FM',
          sourceMatchType: 'FUNCTION_MODULE_FORMAT_NORMALIZED',
          compensationAttempted: undefined
        })])
      }
    });
    expect(existing).toEqual(new Set(['ZNEW_FG', 'ZNEW_FM']));
    expect(activationArguments).toEqual([[
      'ZNEW_FM', functionModule.objectUrl, undefined, true
    ]]);
    expect(resolvedVersions).toEqual([
      'ZNEW_FG:inactive',
      'ZNEW_FM:inactive',
      'ZNEW_FM:active',
      'ZNEW_FG:active'
    ]);
  });
});
