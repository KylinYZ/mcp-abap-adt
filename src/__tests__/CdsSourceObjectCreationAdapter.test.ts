import type { AbapObjectStructure, ControlledSourceObjectKind, SearchResult } from '../adt/index.js'
import { SourceObjectCreationAdapter } from '../safe/adapters/SourceObjectCreationAdapter'
import type { ControlledCreationAdtClient } from '../safe/adapters/controlledCreationTools'
import { RepositoryCreationOutcomeUnknownError } from '../safe/RepositoryObjectCreationWorkflow'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'
import { SafetyPolicy } from '../safe/SafetyPolicy'

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.test', sapClient: '300', sapUser: '068157', systemRole: 'DEV',
  allowedHosts: 'dev.example.test', allowedClients: '300', allowedNamespaces: 'Z',
  auditPath: './audit', toolProfile: 'development'
})

const cases = [
  {
    kind: 'CDS_DATA_DEFINITION' as const, type: 'DDLS/DF' as const, name: 'ZI_MCP_TEST',
    source: '@EndUserText.label: \'MCP\'\ndefine view entity ZI_MCP_TEST as select from t000 { key mandt }\n',
    objectUrl: '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test', reference: undefined
  },
  {
    kind: 'CDS_ACCESS_CONTROL' as const, type: 'DCLS/DL' as const, name: 'ZI_MCP_ROLE',
    source: '@MappingRole: true\ndefine role ZI_MCP_ROLE { grant select on ZI_MCP_TEST where true; }\n',
    objectUrl: '/sap/bc/adt/acm/dcl/sources/zi_mcp_role',
    reference: { name: 'ZI_MCP_TEST', type: 'STOB/DO', uri: '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test' }
  },
  {
    kind: 'CDS_METADATA_EXTENSION' as const, type: 'DDLX/EX' as const, name: 'ZE_MCP_TEST',
    source: '@Metadata.layer: #CUSTOMER\nannotate entity ZI_MCP_TEST with { @EndUserText.label: \'ID\' mandt; }\n',
    objectUrl: '/sap/bc/adt/ddic/ddlx/sources/ze_mcp_test',
    reference: { name: 'ZI_MCP_TEST', type: 'DDLS/DF', uri: '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test' }
  },
  {
    kind: 'CDS_ANNOTATION_DEFINITION' as const, type: 'DDLA/ADF' as const, name: 'ZMCP_ANNOTATION',
    source: '@Scope:[#VIEW]\ndefine annotation ZMCP_ANNOTATION { enabled : Boolean; }\n',
    objectUrl: '/sap/bc/adt/ddic/ddla/sources/zmcp_annotation', reference: undefined
  },
  {
    kind: 'SERVICE_DEFINITION' as const, type: 'SRVD/SRV' as const, name: 'ZUI_MCP_TEST',
    source: '@EndUserText.label: \'MCP\'\ndefine service ZUI_MCP_TEST { expose ZI_MCP_TEST; }\n',
    objectUrl: '/sap/bc/adt/ddic/srvd/sources/zui_mcp_test',
    reference: { name: 'ZI_MCP_TEST', type: 'STOB/DO', uri: '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test' }
  },
  {
    kind: 'BEHAVIOR_DEFINITION' as const, type: 'BDEF/BDO' as const, name: 'ZI_MCP_TEST',
    source: 'managed implementation in class zbp_i_mcp_test unique;\nstrict ( 2 );\ndefine behavior for ZI_MCP_TEST alias Test\nlock master\n{ create; }\n',
    objectUrl: '/sap/bc/adt/bo/behaviordefinitions/zi_mcp_test',
    reference: { name: 'ZI_MCP_TEST', type: 'STOB/DO', uri: '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test' }
  },
  {
    kind: 'CDS_TYPE' as const, type: 'DRTY/STY' as const, name: 'ZZ_MCP_TYPE_CHECK',
    source: '@EndUserText.label: \'MCP\'\ndefine type ZZ_MCP_TYPE_CHECK: abap.char(40);\n',
    objectUrl: '/sap/bc/adt/ddic/drty/sources/zz_mcp_type_check', reference: undefined
  },
  {
    kind: 'CDS_ASPECT' as const, type: 'DRAS/RAS' as const, name: 'ZZ_MCP_ASPECT_CHECK',
    source: '@EndUserText.label: \'MCP\'\ndefine aspect ZZ_MCP_ASPECT_CHECK { value: abap.char(40); }\n',
    objectUrl: '/sap/bc/adt/ddic/dras/sources/zz_mcp_aspect_check', reference: undefined
  },
  {
    kind: 'CDS_ENTITY_BUFFER' as const, type: 'DTEB/DF' as const, name: 'ZZ_MCP_BUFFER',
    source: 'define view entity buffer on ZI_MCP_TEST\n  layer core\n  type single\n',
    objectUrl: '/sap/bc/adt/ddic/dteb/sources/zz_mcp_buffer',
    reference: { name: 'ZI_MCP_TEST', type: 'STOB/DO', uri: '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test' }
  }
]

function baseClient(): jest.Mocked<ControlledCreationAdtClient> {
  return {
    searchObject: jest.fn(), transportInfo: jest.fn(), transportDetails: jest.fn(),
    validateControlledPackage: jest.fn(), getControlledPackageConstraints: jest.fn(),
    readControlledPackage: jest.fn(), createControlledPackage: jest.fn(),
    validateControlledSourceObject: jest.fn(), createControlledSourceObjectShell: jest.fn(),
    objectStructure: jest.fn(), getObjectSource: jest.fn(), setObjectSource: jest.fn(),
    syntaxCheck: jest.fn(), activate: jest.fn(),
    validateControlledTableShell: jest.fn(), createControlledTableShell: jest.fn(),
    readControlledTable: jest.fn(), readControlledTableSource: jest.fn(), writeControlledTableSource: jest.fn(),
    runControlledTableCheck: jest.fn(), readControlledTableSettings: jest.fn(), writeControlledTableSettings: jest.fn(),
    activateControlledTable: jest.fn(), activateControlledTableSettings: jest.fn(),
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function clientFor(testCase: typeof cases[number]): jest.Mocked<ControlledCreationAdtClient> {
  const client = baseClient()
  client.searchObject.mockImplementation(async (name, type) => {
    if (name === 'Z001') return [object('Z001', 'DEVC/K', '/sap/bc/adt/packages/z001')]
    if (testCase.reference && name === testCase.reference.name && (type === 'STOB' || type === 'DDLS/DF')) {
      return [object(testCase.reference.name, testCase.reference.type, testCase.reference.uri)]
    }
    return []
  })
  client.readControlledPackage.mockResolvedValue({
    name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  })
  client.validateControlledSourceObject.mockResolvedValue({ success: true })
  client.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  client.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  client.createControlledSourceObjectShell.mockResolvedValue({
    location: testCase.objectUrl, name: testCase.name, adtType: testCase.type
  })
  client.objectStructure.mockImplementation(async url => url === testCase.objectUrl
    ? structure(testCase.name, testCase.type, testCase.objectUrl)
    : referenceStructure(testCase.reference!))
  client.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  client.unLock.mockResolvedValue('')
  client.syntaxCheck.mockResolvedValue([])
  client.activate.mockResolvedValue({ success: true, messages: [], inactive: [] })
  client.getObjectSource.mockResolvedValue(testCase.source.replace(/\n/g, '\r\n'))
  return client
}

function object(name: string, type: string, uri: string): SearchResult {
  return { 'adtcore:name': name, 'adtcore:type': type, 'adtcore:uri': uri }
}

function structure(name: string, type: string, url: string): AbapObjectStructure {
  return {
    objectUrl: url,
    metaData: {
      'adtcore:name': name, 'adtcore:type': type, 'adtcore:version': 'active',
      'adtcore:changedAt': 0, 'adtcore:createdAt': 0, 'adtcore:changedBy': '068157',
      'adtcore:responsible': '068157', 'adtcore:language': 'ZH',
      'abapsource:sourceUri': `./${name.toLowerCase()}/source/main`
    },
    links: []
  }
}

function referenceStructure(reference: NonNullable<typeof cases[number]['reference']>): AbapObjectStructure {
  const result = structure(reference.name, reference.type, reference.uri)
  ;(result.metaData as unknown as Record<string, unknown>)['ddl:sourceType'] = 'view entity'
  return result
}

function request(testCase: typeof cases[number]): Record<string, unknown> {
  return {
    objectKind: testCase.kind, name: testCase.name, description: '受控 CDS 对象', packageName: 'Z001',
    transportRequest: 'S4HK900009', source: testCase.source,
    ...(testCase.reference ? { referencedObjectName: testCase.reference.name } : {})
  }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return {
    creationPlanId: 'plan-cds', createdAt: 1, expiresAt: 2, status: 'APPLYING',
    context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' },
    target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary,
    payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits
  }
}

describe('CDS SourceObjectCreationAdapter', () => {
  it.each(cases)('previews and executes the complete $kind lifecycle', async testCase => {
    const client = clientFor(testCase)
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    const prepared = await adapter.prepare(request(testCase))
    expect(client.createControlledSourceObjectShell).not.toHaveBeenCalled()
    expect(prepared.review).toMatchObject({
      objectKind: testCase.kind, name: testCase.name,
      referencedObjectName: testCase.reference?.name,
      shellContract: { adtType: testCase.type, objectUrl: testCase.objectUrl }
    })

    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: testCase.type, name: testCase.name }]
    })
    expect(client.setObjectSource).toHaveBeenCalledWith(
      `${testCase.objectUrl}/source/main`,
      testCase.source,
      'LOCK-1',
      'S4HK900009'
    )
    expect(client.syntaxCheck).toHaveBeenCalledWith(
      `${testCase.objectUrl}/source/main`,
      testCase.objectUrl,
      testCase.source,
      undefined,
      'active'
    )
    expect(stages).toContain('VERIFY_SOURCE')
    expect(stages.includes('REVALIDATE_REFERENCE')).toBe(Boolean(testCase.reference))
  })

  it('rejects missing, inactive, changed, or extension DDLS references before writes', async () => {
    const testCase = cases[2]
    const missing = clientFor(testCase)
    missing.searchObject.mockImplementation(async name => name === 'Z001'
      ? [object('Z001', 'DEVC/K', '/sap/bc/adt/packages/z001')]
      : [])
    await expect(new SourceObjectCreationAdapter(testCase.kind, missing, policy).prepare(request(testCase)))
      .rejects.toThrow('was not found')

    const inactive = clientFor(testCase)
    const inactiveReference = referenceStructure(testCase.reference!)
    inactiveReference.metaData['adtcore:version'] = 'inactive'
    inactive.objectStructure.mockImplementation(async url => url === testCase.reference!.uri
      ? inactiveReference
      : structure(testCase.name, testCase.type, testCase.objectUrl))
    await expect(new SourceObjectCreationAdapter(testCase.kind, inactive, policy).prepare(request(testCase)))
      .rejects.toThrow('is not active')

    const extension = clientFor(testCase)
    const extensionMetadata = referenceStructure(testCase.reference!)
    ;(extensionMetadata.metaData as unknown as Record<string, unknown>)['ddl:sourceType'] = 'view entity extend'
    extension.objectStructure.mockResolvedValue(extensionMetadata)
    await expect(new SourceObjectCreationAdapter(testCase.kind, extension, policy).prepare(request(testCase)))
      .rejects.toThrow('cannot annotate DDLS extension')
  })

  it('rejects source/reference drift locally and preserves unknown activation outcomes', async () => {
    const dcl = cases[1]
    const client = clientFor(dcl)
    const adapter = new SourceObjectCreationAdapter(dcl.kind, client, policy)
    await expect(adapter.prepare({ ...request(dcl), referencedObjectName: 'ZI_OTHER' }))
      .rejects.toThrow('ZI_OTHER')
    expect(client.createControlledSourceObjectShell).not.toHaveBeenCalled()

    const prepared = await adapter.prepare(request(dcl))
    client.activate.mockRejectedValue(new Error('activation response lost'))
    await expect(adapter.execute(plan(prepared), jest.fn()))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(client.activate).toHaveBeenCalledTimes(1)
    expect(client.deleteObject).not.toHaveBeenCalled()
  })

  it('rejects behavior definitions whose repository name differs from the root entity', async () => {
    const behavior = cases[5]
    const client = clientFor(behavior)
    await expect(new SourceObjectCreationAdapter(behavior.kind, client, policy).prepare({
      ...request(behavior), name: 'ZI_OTHER'
    })).rejects.toThrow('must match its root CDS entity')
    expect(client.searchObject).not.toHaveBeenCalled()
  })

  it('reads STOB activity from its owning DDLS object URL while freezing the search URI', async () => {
    const testCase = cases.find(item => item.kind === 'CDS_ACCESS_CONTROL')!
    const client = clientFor(testCase)
    const fragmentUri = '/sap/bc/adt/ddic/ddl/sources/zi_mcp_test/source/main#name=zi_mcp_test'
    client.searchObject.mockImplementation(async (name, type) => {
      if (name === 'Z001') return [object('Z001', 'DEVC/K', '/sap/bc/adt/packages/z001')]
      if (name === 'ZI_MCP_TEST' && type === 'STOB') return [object('ZI_MCP_TEST', 'STOB/DO', fragmentUri)]
      return []
    })
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)

    const prepared = await adapter.prepare(request(testCase))

    expect(client.objectStructure).toHaveBeenCalledWith('/sap/bc/adt/ddic/ddl/sources/zi_mcp_test', 'active')
    expect((prepared.payload as any).reference.uri).toBe(fragmentUri)
  })
})
