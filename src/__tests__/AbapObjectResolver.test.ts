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
