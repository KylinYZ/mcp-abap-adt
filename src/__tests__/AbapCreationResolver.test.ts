import { AbapCreationResolver } from '../safe/AbapCreationResolver';
import { SafetyPolicy } from '../safe/SafetyPolicy';
import type { CreationAdtClient } from '../safe/creationTypes';

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.com',
  sapClient: '100',
  systemRole: 'DEV',
  allowedHosts: 'dev.example.com',
  allowedClients: '100',
  allowedNamespaces: 'Z',
  auditPath: './audit'
});
function client(): jest.Mocked<CreationAdtClient> {
  return {
    searchObject: jest.fn(async query => query === 'Z001' ? [{
      'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001'
    }] as never : []),
    objectStructure: jest.fn(),
    mainPrograms: jest.fn(),
    transportInfo: jest.fn(),
    transportDetails: jest.fn(),
    getObjectSource: jest.fn(),
    setObjectSource: jest.fn(),
    syntaxCheck: jest.fn(),
    lock: jest.fn(),
    unLock: jest.fn(),
    activate: jest.fn(),
    validateNewObject: jest.fn(),
    createObject: jest.fn(),
    deleteObject: jest.fn()
  } as unknown as jest.Mocked<CreationAdtClient>;
}

describe('AbapCreationResolver', () => {
  it('resolves a new program without accepting ADT URLs from the caller', async () => {
    const resolver = new AbapCreationResolver(client(), policy);
    await expect(resolver.resolve([{
      objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New', packageName: 'Z001', source: 'REPORT znew.'
    }])).resolves.toEqual([expect.objectContaining({
      objectType: 'PROGRAM', adtType: 'PROG/P', objectUrl: '/sap/bc/adt/programs/programs/znew',
      parentPath: '/sap/bc/adt/packages/z001', sourceHash: expect.any(String)
    })]);
  });

  it('accepts a function group followed by its first function module', async () => {
    const resolver = new AbapCreationResolver(client(), policy);
    const result = await resolver.resolve([
      { objectType: 'FUNCTION_GROUP', objectName: 'ZFG', description: 'Group', packageName: 'Z001' },
      {
        objectType: 'FUNCTION_MODULE', objectName: 'Z_FM', description: 'Module', parentFunctionGroup: 'ZFG',
        source: 'FUNCTION z_fm.\nENDFUNCTION.'
      }
    ]);
    expect(result.map(item => item.objectType)).toEqual(['FUNCTION_GROUP', 'FUNCTION_MODULE']);
    expect(result[1]).toMatchObject({ parentFunctionGroup: 'ZFG', activationParentUrl: '/sap/bc/adt/functions/groups/zfg' });
  });

  it('accepts function-module parameters as part of the complete source signature', async () => {
    const adt = client();
    adt.searchObject.mockImplementation(async query => query === 'ZFG' ? [{
      'adtcore:name': 'ZFG', 'adtcore:type': 'FUGR/F',
      'adtcore:uri': '/sap/bc/adt/functions/groups/zfg', 'adtcore:packageName': 'Z001'
    }] as never : []);
    const source = [
      'FUNCTION z_fm',
      '  IMPORTING',
      '    VALUE(iv_input) TYPE string',
      '  EXPORTING',
      '    VALUE(ev_output) TYPE string.',
      '',
      '  ev_output = iv_input.',
      'ENDFUNCTION.'
    ].join('\n');

    await expect(new AbapCreationResolver(adt, policy).resolve([{
      objectType: 'FUNCTION_MODULE', objectName: 'Z_FM', description: 'Module',
      parentFunctionGroup: 'ZFG', source
    }])).resolves.toEqual([expect.objectContaining({ source, sourceHash: expect.any(String) })]);
  });

  it('rejects standalone function-group creation until its Eclipse activation protocol is captured', async () => {
    const resolver = new AbapCreationResolver(client(), policy);
    await expect(resolver.resolve([{
      objectType: 'FUNCTION_GROUP', objectName: 'ZFG', description: 'Group', packageName: 'Z001'
    }])).rejects.toMatchObject({ code: 'INVALID_CREATION_GRAPH', stage: 'validate' });
  });

  it('rejects unsupported graphs, generated group source, and invalid source framing', async () => {
    const resolver = new AbapCreationResolver(client(), policy);
    await expect(resolver.resolve([])).rejects.toMatchObject({ code: 'INVALID_CREATION_GRAPH' });
    await expect(resolver.resolve([{
      objectType: 'FUNCTION_GROUP', objectName: 'ZFG', description: 'Group', packageName: 'Z001', source: 'FUNCTION-POOL zfg.'
    }])).rejects.toThrow('forbidden');
    await expect(resolver.resolve([{
      objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New', packageName: 'Z001', source: 'WRITE test.'
    }])).rejects.toThrow('must start');
  });

  it('rejects an existing target without treating it as a source change', async () => {
    const adt = client();
    adt.searchObject.mockImplementation(async query => query === 'ZNEW' ? [{
      'adtcore:name': 'ZNEW', 'adtcore:type': 'PROG/P', 'adtcore:uri': '/sap/bc/adt/programs/programs/znew'
    }] as never : [{
      'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001'
    }] as never);
    await expect(new AbapCreationResolver(adt, policy).resolve([{
      objectType: 'PROGRAM', objectName: 'ZNEW', description: 'New', packageName: 'Z001', source: 'REPORT znew.'
    }])).rejects.toMatchObject({ code: 'OBJECT_ALREADY_EXISTS' });
  });

  it('requires an existing parent function group for a standalone function module', async () => {
    const resolver = new AbapCreationResolver(client(), policy);
    await expect(resolver.resolve([{
      objectType: 'FUNCTION_MODULE', objectName: 'Z_FM', description: 'Module', parentFunctionGroup: 'ZMISSING',
      source: 'FUNCTION z_fm.\nENDFUNCTION.'
    }])).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
  });
});
