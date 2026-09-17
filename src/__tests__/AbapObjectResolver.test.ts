import { AbapObjectResolver } from '../safe/AbapObjectResolver';
import type { SafeAdtClient } from '../safe/types';

function fakeClient(overrides: Partial<SafeAdtClient>): SafeAdtClient {
  return {
    searchObject: jest.fn(),
    objectStructure: jest.fn(),
    mainPrograms: jest.fn().mockResolvedValue([]),
    transportInfo: jest.fn(),
    transportDetails: jest.fn(),
    getObjectSource: jest.fn(),
    setObjectSource: jest.fn(),
    syntaxCheck: jest.fn(),
    lock: jest.fn(),
    unLock: jest.fn(),
    activate: jest.fn(),
    ...overrides
  };
}

const metadata = (name: string, type: string, sourceUri?: string) => ({
  'adtcore:changedAt': 0,
  'adtcore:changedBy': 'DEVELOPER',
  'adtcore:createdAt': 0,
  'adtcore:language': 'EN',
  'adtcore:name': name,
  'adtcore:responsible': 'DEVELOPER',
  'adtcore:type': type,
  'adtcore:version': 'active',
  'abapsource:sourceUri': sourceUri
});

describe('AbapObjectResolver', () => {
  it.each([
    ['PROGRAM', 'ZPROG', 'PROG/P', '/sap/bc/adt/programs/programs/zprog', '/sap/bc/adt/programs/programs/zprog/source/main'],
    ['FUNCTION_MODULE', 'Z_FUNC', 'FUGR/FF', '/sap/bc/adt/functions/groups/zgroup/fmodules/z_func', '/sap/bc/adt/functions/groups/zgroup/fmodules/z_func/source/main']
  ])('resolves %s from exact ADT metadata', async (objectType, objectName, adtType, objectUrl, sourceUrl) => {
    const client = fakeClient({
      searchObject: jest.fn().mockResolvedValue([{
        'adtcore:name': objectName,
        'adtcore:type': adtType,
        'adtcore:uri': objectUrl,
        'adtcore:packageName': 'ZPKG'
      }]),
      objectStructure: jest.fn().mockResolvedValue({
        objectUrl,
        metaData: metadata(objectName, adtType, objectType === 'PROGRAM' ? 'source/main' : sourceUrl),
        links: []
      })
    });

    const resolved = await new AbapObjectResolver(client).resolve(objectType, objectName);
    expect(resolved.sourceUrl).toBe(sourceUrl);
    expect(resolved.objectName).toBe(objectName);
    if (objectType === 'FUNCTION_MODULE') {
      expect(resolved.parentObject).toBe('ZGROUP');
      expect(resolved.activationParentUrl).toBe('/sap/bc/adt/functions/groups/zgroup');
    }
  });

  it('resolves the main class source include', async () => {
    const objectUrl = '/sap/bc/adt/oo/classes/zcl_test';
    const sourceUrl = `${objectUrl}/source/main`;
    const client = fakeClient({
      searchObject: jest.fn().mockResolvedValue([{
        'adtcore:name': 'ZCL_TEST',
        'adtcore:type': 'CLAS/OC',
        'adtcore:uri': objectUrl
      }]),
      objectStructure: jest.fn().mockResolvedValue({
        objectUrl,
        metaData: {
          ...metadata('ZCL_TEST', 'CLAS/OC'),
          'abapoo:modeled': false,
          'class:abstract': false,
          'class:category': '00',
          'class:final': false,
          'class:sharedMemoryEnabled': false,
          'class:visibility': 'public'
        },
        includes: [{
          'abapsource:sourceUri': sourceUrl,
          'adtcore:changedAt': 0,
          'adtcore:changedBy': 'DEVELOPER',
          'adtcore:createdAt': 0,
          'adtcore:createdBy': 'DEVELOPER',
          'adtcore:name': 'ZCL_TEST',
          'adtcore:type': 'CLAS/OC',
          'adtcore:version': 'active',
          'class:includeType': 'main',
          links: []
        }]
      })
    });

    const resolved = await new AbapObjectResolver(client).resolve('CLASS', 'ZCL_TEST');
    expect(resolved.sourceUrl).toBe(sourceUrl);
  });

  // —— class include 粒度解析（source.class-include 受控链）——

  /** 构造带 main + 四种 include 条目的类 structure（sourceUri 用相对形态，覆盖 URL 归一化）。 */
  function classStructureWithIncludes(objectUrl: string, includeTypes: string[]) {
    const includes = ['main', ...includeTypes].map(type => ({
      'abapsource:sourceUri': `source/${type}`,
      'adtcore:changedAt': 0,
      'adtcore:changedBy': 'DEVELOPER',
      'adtcore:createdAt': 0,
      'adtcore:createdBy': 'DEVELOPER',
      'adtcore:name': 'ZCL_TEST',
      'adtcore:type': 'CLAS/OC',
      'adtcore:version': 'active',
      'class:includeType': type,
      links: []
    }));
    return {
      objectUrl,
      metaData: metadata('ZCL_TEST', 'CLAS/OC'),
      includes
    };
  }

  function classClient(structure: ReturnType<typeof classStructureWithIncludes>) {
    return fakeClient({
      searchObject: jest.fn().mockResolvedValue([{
        'adtcore:name': 'ZCL_TEST',
        'adtcore:type': 'CLAS/OC',
        'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_test'
      }]),
      objectStructure: jest.fn().mockResolvedValue(structure)
    });
  }

  it.each(['definitions', 'implementations', 'macros', 'testclasses'] as const)(
    'resolves the %s class include as the writable source while locking the parent class',
    async kind => {
      const client = classClient(classStructureWithIncludes('/sap/bc/adt/oo/classes/zcl_test', [
        'definitions', 'implementations', 'macros', 'testclasses'
      ]));

      const resolved = await new AbapObjectResolver(client).resolve('CLASS', 'ZCL_TEST', kind);
      expect(resolved.sourceUrl).toBe(`/sap/bc/adt/oo/classes/zcl_test/source/${kind}`);
      expect(resolved.classInclude).toBe(kind);
      // include 没有独立锁/激活身份：锁与激活仍归属父类
      expect(resolved.lockUrl).toBe('/sap/bc/adt/oo/classes/zcl_test');
      expect(resolved.activationUrl).toBe('/sap/bc/adt/oo/classes/zcl_test');
      expect(resolved.activationName).toBe('ZCL_TEST');
    }
  );

  it('keeps the main-source resolution untouched when no classInclude hint is given', async () => {
    const client = classClient(classStructureWithIncludes('/sap/bc/adt/oo/classes/zcl_test', ['definitions']));

    const resolved = await new AbapObjectResolver(client).resolve('CLASS', 'ZCL_TEST');
    expect(resolved.sourceUrl).toBe('/sap/bc/adt/oo/classes/zcl_test/source/main');
    expect(resolved.classInclude).toBeUndefined();
  });

  it('rejects a missing testclasses include with a create-first hint', async () => {
    const client = classClient(classStructureWithIncludes('/sap/bc/adt/oo/classes/zcl_test', ['definitions']));

    await expect(new AbapObjectResolver(client).resolve('CLASS', 'ZCL_TEST', 'testclasses'))
      .rejects.toMatchObject({
        code: 'OBJECT_RESOLUTION_FAILED',
        message: expect.stringContaining('createTestInclude')
      });
  });

  it('rejects an include kind the class does not expose', async () => {
    const client = classClient(classStructureWithIncludes('/sap/bc/adt/oo/classes/zcl_test', []));

    await expect(new AbapObjectResolver(client).resolve('CLASS', 'ZCL_TEST', 'macros'))
      .rejects.toMatchObject({
        code: 'OBJECT_RESOLUTION_FAILED',
        message: expect.stringContaining('does not expose a macros include')
      });
  });

  it('rejects classInclude outside the four supported kinds', async () => {
    const client = classClient(classStructureWithIncludes('/sap/bc/adt/oo/classes/zcl_test', ['definitions']));

    await expect(new AbapObjectResolver(client).resolve('CLASS', 'ZCL_TEST', 'main'))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects classInclude for non-CLASS object types', async () => {
    const resolver = new AbapObjectResolver(classClient(classStructureWithIncludes('/x', ['definitions'])));

    await expect(resolver.resolve('PROGRAM', 'ZPROG', 'definitions'))
      .rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        message: expect.stringContaining('only valid for CLASS objects')
      });
  });

  it('resolves a function-group include without requesting a main-program context', async () => {
    const objectName = 'LZFG_SAP2EAMTOP';
    const objectUrl = '/sap/bc/adt/functions/groups/zfg_sap2eam/includes/lzfg_sap2eamtop';
    const sourceUrl = `${objectUrl}/source/main`;
    const client = fakeClient({
      searchObject: jest.fn().mockResolvedValue([{
        // SAP may identify the parent unit in search metadata, so the exact include name must also be recoverable from the URI.
        'adtcore:name': 'ZFG_SAP2EAM',
        'adtcore:type': 'FUGR/I',
        'adtcore:uri': objectUrl,
        'adtcore:packageName': 'ZPKG'
      }]),
      objectStructure: jest.fn().mockResolvedValue({
        objectUrl,
        metaData: metadata(objectName, 'FUGR/I', 'source/main'),
        links: []
      }),
      mainPrograms: jest.fn().mockRejectedValue(new Error('must not be called'))
    });

    const resolved = await new AbapObjectResolver(client).resolve('INCLUDE', objectName);

    expect(resolved).toMatchObject({
      objectType: 'INCLUDE',
      objectName,
      adtType: 'FUGR/I',
      objectUrl,
      sourceUrl,
      lockUrl: objectUrl,
      activationName: objectName,
      activationUrl: objectUrl,
      packageName: 'ZPKG'
    });
    expect(resolved.mainProgram).toBeUndefined();
    expect(client.mainPrograms).not.toHaveBeenCalled();
  });

  it('uses the type-specific ADT URI when search metadata names an include unit', async () => {
    const objectUrl = '/sap/bc/adt/programs/programs/zprog';
    const client = fakeClient({
      searchObject: jest.fn().mockResolvedValue([{
        'adtcore:name': 'LZPROGU01',
        'adtcore:type': 'PROG/P',
        'adtcore:uri': objectUrl,
        'adtcore:packageName': 'ZPKG'
      }]),
      objectStructure: jest.fn().mockResolvedValue({
        objectUrl,
        metaData: metadata('ZPROG', 'PROG/P', `${objectUrl}/source/main`),
        links: []
      })
    });

    const resolved = await new AbapObjectResolver(client).resolve('PROGRAM', 'ZPROG');
    expect(resolved.objectName).toBe('ZPROG');
  });

  it('requires one proven main program for includes', async () => {
    const objectUrl = '/sap/bc/adt/programs/includes/zinclude';
    const client = fakeClient({
      searchObject: jest.fn().mockResolvedValue([{
        'adtcore:name': 'ZINCLUDE',
        'adtcore:type': 'PROG/I',
        'adtcore:uri': objectUrl
      }]),
      objectStructure: jest.fn().mockResolvedValue({
        objectUrl,
        metaData: metadata('ZINCLUDE', 'PROG/I', `${objectUrl}/source/main`),
        links: []
      }),
      mainPrograms: jest.fn().mockResolvedValue([
        { 'adtcore:uri': '/sap/bc/adt/programs/programs/zmain1', 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZMAIN1' },
        { 'adtcore:uri': '/sap/bc/adt/programs/programs/zmain2', 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZMAIN2' }
      ])
    });

    await expect(new AbapObjectResolver(client).resolve('INCLUDE', 'ZINCLUDE'))
      .rejects.toThrow('exactly one main program');
  });
});
