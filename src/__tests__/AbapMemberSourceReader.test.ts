import { createHash } from 'crypto';
import { AbapMemberSourceReader } from '../read/AbapMemberSourceReader';

const object = {
  objectType: 'CLASS' as const,
  objectName: 'ZCL_DEMO',
  adtType: 'CLAS/OC',
  objectUrl: '/sap/bc/adt/oo/classes/zcl_demo',
  sourceUrl: '/sap/bc/adt/oo/classes/zcl_demo/source/main',
  lockUrl: '/sap/bc/adt/oo/classes/zcl_demo',
  activationName: 'ZCL_DEMO',
  activationUrl: '/sap/bc/adt/oo/classes/zcl_demo'
};

const source = [
  'CLASS zcl_demo DEFINITION.',
  '  PUBLIC SECTION.',
  '    METHODS run',
  '      IMPORTING value(iv_id) TYPE string.',
  'ENDCLASS.',
  '',
  'CLASS zcl_demo IMPLEMENTATION.',
  '  METHOD run.',
  '    rv_value = iv_id.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

function methodElement(overrides: Record<string, unknown> = {}) {
  return {
    name: 'RUN',
    type: 'CLAS/OM',
    links: [
      { rel: 'http://www.sap.com/adt/relations/source/definitionBlock', href: './source/main#start=3,4;end=4,40' },
      { rel: 'http://www.sap.com/adt/relations/source/implementationBlock', href: './source/main#start=8,2;end=10,11' }
    ],
    children: [],
    ...overrides
  };
}

describe('AbapMemberSourceReader', () => {
  it('crops inclusive server ranges and returns the full-source hash without using regex boundaries', async () => {
    const client = {
      objectStructureElements: jest.fn().mockResolvedValue([methodElement()]),
      objectStructure: jest.fn(),
      getObjectSource: jest.fn().mockResolvedValue(source)
    };
    const resolver = { resolve: jest.fn().mockResolvedValue(object) };

    const result = await new AbapMemberSourceReader(client as never, resolver as never).read({
      objectType: 'CLASS', objectName: 'zcl_demo', memberName: 'run', version: 'active'
    });

    expect(client.objectStructureElements).toHaveBeenCalledWith(object.objectUrl, 'active');
    expect(client.getObjectSource).toHaveBeenCalledTimes(1);
    expect(client.getObjectSource).toHaveBeenCalledWith(object.sourceUrl, { version: 'active' });
    expect(result).toMatchObject({
      object: { objectType: 'CLASS', objectName: 'ZCL_DEMO', adtType: 'CLAS/OC' },
      member: { name: 'RUN', type: 'CLAS/OM' },
      version: 'active',
      fullSourceHash: createHash('sha256').update(source, 'utf8').digest('hex')
    });
    expect(result.fragments).toEqual([
      {
        kind: 'definition',
        range: { start: { line: 3, column: 4 }, end: { line: 4, column: 40 } },
        source: 'METHODS run\n      IMPORTING value(iv_id) TYPE string.'
      },
      {
        kind: 'implementation',
        range: { start: { line: 8, column: 2 }, end: { line: 10, column: 11 } },
        source: 'METHOD run.\n    rv_value = iv_id.\n  ENDMETHOD.'
      }
    ]);
  });

  it('fails closed for missing, duplicate, malformed, or out-of-bounds server ranges', async () => {
    const resolver = { resolve: jest.fn().mockResolvedValue(object) };
    const noRange = { objectStructureElements: jest.fn().mockResolvedValue([methodElement({ links: [] })]), getObjectSource: jest.fn() };
    await expect(new AbapMemberSourceReader(noRange as never, resolver as never).read({
      objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'RUN'
    })).rejects.toThrow('range');
    expect(noRange.getObjectSource).not.toHaveBeenCalled();

    const duplicate = { objectStructureElements: jest.fn().mockResolvedValue([methodElement(), methodElement()]), getObjectSource: jest.fn() };
    await expect(new AbapMemberSourceReader(duplicate as never, resolver as never).read({
      objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'RUN'
    })).rejects.toThrow('exactly one');

    const malformed = {
      objectStructureElements: jest.fn().mockResolvedValue([methodElement({
        links: [{ rel: 'http://www.sap.com/adt/relations/source/implementationBlock', href: './source/main#start=8,2' }]
      })]),
      getObjectSource: jest.fn()
    };
    await expect(new AbapMemberSourceReader(malformed as never, resolver as never).read({
      objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'RUN'
    })).rejects.toThrow('range');

    const outside = {
      objectStructureElements: jest.fn().mockResolvedValue([methodElement({
        links: [{ rel: 'http://www.sap.com/adt/relations/source/implementationBlock', href: './source/main#start=8,2;end=99,0' }]
      })]),
      getObjectSource: jest.fn().mockResolvedValue(source)
    };
    await expect(new AbapMemberSourceReader(outside as never, resolver as never).read({
      objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'RUN'
    })).rejects.toThrow('outside');
  });

  it('reads an exact function-module source URI only when member and object names match', async () => {
    const functionObject = {
      ...object,
      objectType: 'FUNCTION_MODULE' as const,
      objectName: 'Z_DEMO_FM',
      adtType: 'FUGR/FF',
      sourceUrl: '/sap/bc/adt/functions/groups/zfg/fmodules/z_demo_fm/source/main'
    };
    const client = { getObjectSource: jest.fn().mockResolvedValue('FUNCTION z_demo_fm.\nENDFUNCTION.') };
    const resolver = { resolve: jest.fn().mockResolvedValue(functionObject) };
    const reader = new AbapMemberSourceReader(client as never, resolver as never);

    const result = await reader.read({ objectType: 'FUNCTION_MODULE', objectName: 'Z_DEMO_FM', memberName: 'z_demo_fm' });

    expect(result.member).toEqual({ name: 'Z_DEMO_FM', type: 'FUGR/FF' });
    expect(result.fragments).toEqual([{ kind: 'member', source: 'FUNCTION z_demo_fm.\nENDFUNCTION.' }]);
    await expect(reader.read({ objectType: 'FUNCTION_MODULE', objectName: 'Z_DEMO_FM', memberName: 'OTHER' }))
      .rejects.toThrow('must match');
  });

  it('reads a class include only from its server-provided source URI', async () => {
    const client = {
      objectStructureElements: jest.fn().mockResolvedValue([]),
      objectStructure: jest.fn().mockResolvedValue({
        objectUrl: object.objectUrl,
        metaData: {},
        includes: [{
          'adtcore:name': 'ZCL_DEMO=======CCAU',
          'adtcore:type': 'CLAS/OC',
          'class:includeType': 'implementations',
          'abapsource:sourceUri': 'source/implementations',
          links: []
        }]
      }),
      getObjectSource: jest.fn().mockResolvedValue('METHODS SECTION')
    };
    const resolver = { resolve: jest.fn().mockResolvedValue(object) };

    const result = await new AbapMemberSourceReader(client as never, resolver as never).read({
      objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'implementations'
    });

    expect(client.getObjectSource).toHaveBeenCalledWith(
      '/sap/bc/adt/oo/classes/zcl_demo/source/implementations',
      { version: 'active' }
    );
    expect(result.fragments).toEqual([{ kind: 'include', source: 'METHODS SECTION' }]);
  });
});
