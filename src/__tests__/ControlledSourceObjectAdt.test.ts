import {
  type AdtHTTP,
  buildControlledSourceObjectXml,
  createControlledSourceObjectShell,
  type ControlledSourceObjectInput,
  validateControlledSourceObject
} from '../adt/index.js'
import type { ResponseHeaders } from '../adt/AdtHTTP.js'

const validationResponse = '<asx:abap><asx:values><DATA><SEVERITY>S</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>'

const contracts = [
  {
    objectKind: 'ABAP_CLASS' as const,
    adtType: 'CLAS/OC' as const,
    name: 'ZCL_MCP_TEST',
    validationPath: '/sap/bc/adt/oo/validation/objectname',
    collectionPath: '/sap/bc/adt/oo/classes',
    rootName: 'class:abapClass',
    contentType: 'application/vnd.sap.adt.oo.classes.v4+xml',
    accept: 'application/vnd.sap.adt.oo.classes.v4+xml, application/vnd.sap.adt.oo.classes.v3+xml, application/vnd.sap.adt.oo.classes.v2+xml, application/vnd.sap.adt.oo.classes+xml'
  },
  {
    objectKind: 'ABAP_INTERFACE' as const,
    adtType: 'INTF/OI' as const,
    name: 'ZIF_MCP_TEST',
    validationPath: '/sap/bc/adt/oo/validation/objectname',
    collectionPath: '/sap/bc/adt/oo/interfaces',
    rootName: 'intf:abapInterface',
    contentType: 'application/vnd.sap.adt.oo.interfaces.v5+xml',
    accept: 'application/vnd.sap.adt.oo.interfaces.v5+xml, application/vnd.sap.adt.oo.interfaces.v4+xml, application/vnd.sap.adt.oo.interfaces.v3+xml, application/vnd.sap.adt.oo.interfaces.v2+xml, application/vnd.sap.adt.oo.interfaces+xml'
  },
  {
    objectKind: 'PROGRAM_INCLUDE' as const,
    adtType: 'PROG/I' as const,
    name: 'ZMCP_TEST_INCLUDE',
    validationPath: '/sap/bc/adt/includes/validation',
    collectionPath: '/sap/bc/adt/programs/includes',
    rootName: 'include:abapInclude',
    contentType: 'application/vnd.sap.adt.programs.includes.v2+xml',
    accept: 'application/vnd.sap.adt.programs.includes.v2+xml, application/vnd.sap.adt.programs.includes+xml'
  },
  {
    objectKind: 'CDS_DATA_DEFINITION' as const,
    adtType: 'DDLS/DF' as const,
    name: 'ZI_MCP_TEST',
    validationPath: '/sap/bc/adt/ddic/ddl/validation',
    collectionPath: '/sap/bc/adt/ddic/ddl/sources',
    rootName: 'ddl:ddlSource',
    contentType: 'application/*',
    accept: 'application/*'
  },
  {
    objectKind: 'CDS_ACCESS_CONTROL' as const,
    adtType: 'DCLS/DL' as const,
    name: 'ZI_MCP_TEST',
    validationPath: '/sap/bc/adt/acm/dcl/validation',
    collectionPath: '/sap/bc/adt/acm/dcl/sources',
    rootName: 'dcl:dclSource',
    contentType: 'application/vnd.sap.adt.dclSource+xml',
    accept: 'application/vnd.sap.adt.dclSource+xml'
  },
  {
    objectKind: 'CDS_METADATA_EXTENSION' as const,
    adtType: 'DDLX/EX' as const,
    name: 'ZE_MCP_TEST',
    validationPath: '/sap/bc/adt/ddic/ddlx/sources/validation',
    collectionPath: '/sap/bc/adt/ddic/ddlx/sources',
    rootName: 'ddlx:ddlxSource',
    contentType: 'application/vnd.sap.adt.ddic.ddlx.v1+xml',
    accept: 'application/vnd.sap.adt.ddic.ddlx.v1+xml'
  },
  {
    objectKind: 'CDS_ANNOTATION_DEFINITION' as const,
    adtType: 'DDLA/ADF' as const,
    name: 'ZMCP_ANNOTATION',
    validationPath: '/sap/bc/adt/ddic/ddla/sources/validation',
    collectionPath: '/sap/bc/adt/ddic/ddla/sources',
    rootName: 'ddla:ddlaSource',
    contentType: 'application/vnd.sap.adt.ddic.ddla.v1+xml',
    accept: 'application/vnd.sap.adt.ddic.ddla.v1+xml'
  },
  {
    objectKind: 'SERVICE_DEFINITION' as const,
    adtType: 'SRVD/SRV' as const,
    name: 'ZUI_MCP_TEST',
    validationPath: '/sap/bc/adt/ddic/srvd/sources/validation',
    collectionPath: '/sap/bc/adt/ddic/srvd/sources',
    rootName: 'srvd:srvdSource',
    contentType: 'application/vnd.sap.adt.ddic.srvd.v1+xml',
    accept: 'application/vnd.sap.adt.ddic.srvd.v1+xml'
  },
  {
    objectKind: 'BEHAVIOR_DEFINITION' as const,
    adtType: 'BDEF/BDO' as const,
    name: 'ZI_MCP_TEST',
    validationPath: '/sap/bc/adt/bo/behaviordefinitions/validation',
    collectionPath: '/sap/bc/adt/bo/behaviordefinitions',
    rootName: 'blue:blueSource',
    contentType: 'application/vnd.sap.adt.blues.v1+xml',
    accept: 'application/vnd.sap.adt.blues.v1+xml'
  },
  {
    objectKind: 'CDS_TYPE' as const,
    adtType: 'DRTY/STY' as const,
    name: 'ZZ_MCP_TYPE_CHECK',
    validationPath: '/sap/bc/adt/ddic/drty/sources/validation',
    collectionPath: '/sap/bc/adt/ddic/drty/sources',
    rootName: 'blue:blueSource',
    contentType: 'application/vnd.sap.adt.blues.v1+xml',
    accept: 'application/vnd.sap.adt.blues.v1+xml'
  },
  {
    objectKind: 'CDS_ASPECT' as const,
    adtType: 'DRAS/RAS' as const,
    name: 'ZZ_MCP_ASPECT_CHECK',
    validationPath: '/sap/bc/adt/ddic/dras/sources/validation',
    collectionPath: '/sap/bc/adt/ddic/dras/sources',
    rootName: 'blue:blueSource',
    contentType: 'application/vnd.sap.adt.blues.v1+xml',
    accept: 'application/vnd.sap.adt.blues.v1+xml'
  },
  {
    objectKind: 'CDS_ENTITY_BUFFER' as const,
    adtType: 'DTEB/DF' as const,
    name: 'ZZ_MCP_BUFFER',
    validationPath: '/sap/bc/adt/ddic/dteb/sources/validation',
    collectionPath: '/sap/bc/adt/ddic/dteb/sources',
    rootName: 'dteb:dtebSource',
    contentType: 'application/vnd.sap.adt.ddic.dteb.v1+xml',
    accept: 'application/vnd.sap.adt.ddic.dteb.v1+xml'
  }
]

function input(contract: typeof contracts[number]): ControlledSourceObjectInput {
  return {
    objectKind: contract.objectKind,
    adtType: contract.adtType,
    name: contract.name,
    description: '受控源码对象',
    packageName: 'Z001',
    transportRequest: 'S4HK900009',
    language: 'ZH',
    masterLanguage: 'ZH',
    masterSystem: 'S4H',
    responsible: '068157'
  }
}

function responseXml(contract: typeof contracts[number]): string {
  return buildControlledSourceObjectXml(input(contract))
}

function http(response: Partial<{ body: string; status: number; headers: ResponseHeaders }> = {}) {
  return {
    request: jest.fn().mockResolvedValue({ body: '', status: 200, statusText: 'OK', headers: {}, ...response })
  } as unknown as AdtHTTP
}

describe('controlled source-object ADT contract', () => {
  it.each(contracts)('uses the fixed validation contract for $objectKind', async contract => {
    const client = http({ body: validationResponse })
    await expect(validateControlledSourceObject(client, input(contract))).resolves.toMatchObject({ success: true })
    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      contract.validationPath,
      {
        method: 'POST',
        qs: {
          objname: contract.name,
          description: '受控源码对象',
          objtype: contract.adtType,
          packagename: 'Z001'
        },
        headers: { Accept: 'application/vnd.sap.as+xml' }
      }
    ])
  })

  it.each(contracts)('creates $objectKind with fixed media types and identity checks', async contract => {
    const location = `${contract.collectionPath}/${contract.name.toLowerCase()}`
    const client = http({ body: responseXml(contract), status: 201, headers: { location } })
    await expect(createControlledSourceObjectShell(client, input(contract))).resolves.toEqual({
      location, name: contract.name, adtType: contract.adtType,
      ownershipEvidence: 'CANONICAL_LOCATION'
    })
    expect((client.request as jest.Mock).mock.calls[0]).toEqual([
      contract.collectionPath,
      expect.objectContaining({
        method: 'POST',
        qs: { corrNr: 'S4HK900009' },
        headers: { 'Content-Type': contract.contentType, Accept: contract.accept }
      })
    ])
    const body = String((client.request as jest.Mock).mock.calls[0][1].body)
    expect(body).toContain(`<${contract.rootName}`)
    expect(body).toContain(`adtcore:name="${contract.name}"`)
    expect(body).toContain('adtcore:type="' + contract.adtType + '"')
    expect(body).toContain('<adtcore:packageRef adtcore:name="Z001"/>')
  })

  it('locks the Eclipse class defaults to public and final without applying them to other kinds', () => {
    const classXml = responseXml(contracts[0])
    expect(classXml).toContain('class:visibility="public"')
    expect(classXml).toContain('class:final="true"')
    expect(responseXml(contracts[1])).not.toContain('class:visibility')
    expect(responseXml(contracts[2])).not.toContain('class:final')
  })

  it('uses the ADT 3.60.2 DDLX model for metadata-extension shell creation', () => {
    const xml = responseXml(contracts[5])
    expect(xml).toContain('<ddlx:ddlxSource')
    expect(xml).toContain('xmlns:ddlx="http://www.sap.com/adt/ddic/ddlxsources"')
    expect(xml).toContain('adtcore:version="active"')
    expect(xml).not.toContain('<blue:blueSource')
  })

  it('locks service definitions to source type definition and BDEF to the Blue model', () => {
    const serviceXml = responseXml(contracts[7])
    expect(serviceXml).toContain('srvd:srvdSourceType="S"')
    const behaviorXml = responseXml(contracts[8])
    expect(behaviorXml).toContain('<blue:blueSource')
    expect(behaviorXml).toContain('xmlns:blue="http://www.sap.com/wbobj/blue"')
    expect(behaviorXml).not.toContain('srvd:srvdSourceType')
  })

  it('rejects non-canonical locations, response identity drift, and kind/type mismatches', async () => {
    const contract = contracts[0]
    await expect(createControlledSourceObjectShell(http({
      body: responseXml(contract), status: 201, headers: { location: '/sap/bc/adt/oo/classes/zother' }
    }), input(contract))).rejects.toThrow('canonical Location')
    await expect(createControlledSourceObjectShell(http({
      body: responseXml(contract).replace(/ZCL_MCP_TEST/g, 'ZCL_OTHER'),
      status: 201,
      headers: { location: '/sap/bc/adt/oo/classes/zcl_mcp_test' }
    }), input(contract))).rejects.toThrow('identity')
    expect(() => buildControlledSourceObjectXml({ ...input(contract), adtType: 'INTF/OI' as never }))
      .toThrow('kind and ADT type')
  })

  it('accepts an empty shell response when HTTP 201 has canonical Location', async () => {
    const contract = contracts[1]
    await expect(createControlledSourceObjectShell(http({
      body: '', status: 201, headers: { location: `${contract.collectionPath}/${contract.name.toLowerCase()}` }
    }), input(contract))).resolves.toEqual({
      location: `${contract.collectionPath}/${contract.name.toLowerCase()}`,
      name: contract.name,
      adtType: contract.adtType,
      ownershipEvidence: 'CANONICAL_LOCATION'
    })
  })

  it('defers ownership for the bounded HTTP 200 empty acknowledgement', async () => {
    const contract = contracts[1]
    await expect(createControlledSourceObjectShell(http({
      body: '', status: 200, headers: {}
    }), input(contract))).resolves.toEqual({
      location: `${contract.collectionPath}/${contract.name.toLowerCase()}`,
      name: contract.name,
      adtType: contract.adtType,
      ownershipEvidence: 'POST_CREATE_READBACK_REQUIRED'
    })
    await expect(createControlledSourceObjectShell(http({
      body: responseXml(contract), status: 200, headers: {}
    }), input(contract))).rejects.toThrow('HTTP 201')
  })

  it('accepts an absolute canonical Location and reports only the mismatched pathname', async () => {
    const contract = contracts[1]
    const canonicalPath = `${contract.collectionPath}/${contract.name.toLowerCase()}`
    await expect(createControlledSourceObjectShell(http({
      body: '',
      status: 201,
      headers: { Location: `HTTPS://dev.example.test${canonicalPath.toUpperCase()}/?sap-client=300#created` }
    }), input(contract))).resolves.toMatchObject({ name: contract.name, adtType: contract.adtType })

    await expect(createControlledSourceObjectShell(http({
      body: '',
      status: 201,
      headers: { location: 'https://developer:secret@dev.example.test/sap/bc/adt/oo/interfaces/zother?sap-client=300' }
    }), input(contract))).rejects.toThrow('Location path /sap/bc/adt/oo/interfaces/zother')
  })

  it('does not accept Content-Location as the creation Location', async () => {
    const contract = contracts[1]
    await expect(createControlledSourceObjectShell(http({
      body: '',
      status: 201,
      headers: { 'content-location': `${contract.collectionPath}/${contract.name.toLowerCase()}` }
    }), input(contract))).rejects.toThrow('Location path [missing]')
  })

  it('rejects ambiguous multiple Location values and non-HTTP URLs', async () => {
    const contract = contracts[1]
    const canonicalPath = `${contract.collectionPath}/${contract.name.toLowerCase()}`
    await expect(createControlledSourceObjectShell(http({
      body: '', status: 201, headers: { location: [canonicalPath, '/sap/bc/adt/oo/interfaces/zother'] }
    }), input(contract))).rejects.toThrow('Location path [missing]')
    await expect(createControlledSourceObjectShell(http({
      body: '', status: 201, headers: { location: `file://${canonicalPath}` }
    }), input(contract))).rejects.toThrow('Location path [invalid]')
  })
})
