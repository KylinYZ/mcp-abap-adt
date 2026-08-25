import { type AbapObjectStructure, type ControlledSourceObjectKind, isClassStructure } from '../adt/index.js'
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
    kind: 'ABAP_CLASS' as const,
    type: 'CLAS/OC' as const,
    name: 'ZCL_MCP_TEST',
    source: 'CLASS zcl_mcp_test DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS zcl_mcp_test IMPLEMENTATION.\nENDCLASS.\n',
    sourceUrl: '/sap/bc/adt/oo/classes/zcl_mcp_test/includes/main'
  },
  {
    kind: 'ABAP_INTERFACE' as const,
    type: 'INTF/OI' as const,
    name: 'ZIF_MCP_TEST',
    source: 'INTERFACE zif_mcp_test PUBLIC.\nENDINTERFACE.\n',
    sourceUrl: '/sap/bc/adt/oo/interfaces/zif_mcp_test/source/main'
  },
  {
    kind: 'PROGRAM_INCLUDE' as const,
    type: 'PROG/I' as const,
    name: 'ZMCP_TEST_INCLUDE',
    source: 'DATA gv_test TYPE string.\n',
    sourceUrl: '/sap/bc/adt/programs/includes/zmcp_test_include/source/main'
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
  client.searchObject.mockImplementation(async name => name === 'Z001' ? [{
    'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001'
  }] : [])
  client.readControlledPackage.mockResolvedValue({
    name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  })
  client.validateControlledSourceObject.mockResolvedValue({ success: true })
  client.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  client.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  client.createControlledSourceObjectShell.mockResolvedValue({
    location: objectUrl(testCase), name: testCase.name, adtType: testCase.type
  })
  client.objectStructure.mockImplementation(async (_url, version) => structure(testCase, version || 'inactive'))
  client.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  client.unLock.mockResolvedValue('')
  client.syntaxCheck.mockResolvedValue([])
  client.activate.mockResolvedValue({ success: true, messages: [], inactive: [] })
  client.getObjectSource.mockResolvedValue(testCase.source.replace(/\n/g, '\r\n'))
  return client
}

function structure(testCase: typeof cases[number], version: string): AbapObjectStructure {
  const metadata = {
    'adtcore:name': testCase.name,
    'adtcore:type': testCase.type,
    'adtcore:version': version,
    'adtcore:changedAt': 0,
    'adtcore:createdAt': 0,
    'adtcore:changedBy': '068157',
    'adtcore:responsible': '068157',
    'adtcore:language': 'ZH'
  }
  if (testCase.kind === 'ABAP_CLASS') {
    return {
      objectUrl: objectUrl(testCase),
      metaData: {
        ...metadata,
        'abapoo:modeled': false,
        'class:abstract': false,
        'class:category': 'generalObjectType',
        'class:final': true,
        'class:sharedMemoryEnabled': false,
        'class:visibility': 'public'
      },
      includes: [{
        'abapsource:sourceUri': './wrong-source-uri',
        'adtcore:changedAt': 0,
        'adtcore:changedBy': '068157',
        'adtcore:createdAt': 0,
        'adtcore:createdBy': '068157',
        'adtcore:name': testCase.name,
        'adtcore:type': 'CLAS/OM',
        'adtcore:version': version,
        'class:includeType': 'main',
        links: [{ href: `./${testCase.name.toLowerCase()}/includes/main`, rel: 'source', type: 'text/plain' }]
      }]
    }
  }
  return {
    objectUrl: objectUrl(testCase),
    metaData: { ...metadata, 'abapsource:sourceUri': `./${testCase.name.toLowerCase()}/source/main` },
    links: []
  }
}

function objectUrl(testCase: typeof cases[number]): string {
  const collection = testCase.kind === 'ABAP_CLASS' ? '/sap/bc/adt/oo/classes'
    : testCase.kind === 'ABAP_INTERFACE' ? '/sap/bc/adt/oo/interfaces'
      : '/sap/bc/adt/programs/includes'
  return `${collection}/${testCase.name.toLowerCase()}`
}

function request(testCase: typeof cases[number]): Record<string, unknown> {
  return {
    objectKind: testCase.kind,
    name: testCase.name,
    description: '受控源码对象',
    packageName: 'Z001',
    transportRequest: 'S4HK900009',
    source: testCase.source
  }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return {
    creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING',
    context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' },
    target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary,
    payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits
  }
}

describe('SourceObjectCreationAdapter', () => {
  it.each(cases)('prepares without writes and executes the complete $kind lifecycle', async testCase => {
    const client = clientFor(testCase)
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    const prepared = await adapter.prepare(request(testCase))
    expect(client.createControlledSourceObjectShell).not.toHaveBeenCalled()
    expect(prepared.review).toMatchObject({
      objectKind: testCase.kind, name: testCase.name, source: testCase.source,
      shellContract: { adtType: testCase.type, objectUrl: objectUrl(testCase) }
    })

    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: testCase.type, name: testCase.name }]
    })
    expect(client.setObjectSource).toHaveBeenCalledWith(
      testCase.sourceUrl, testCase.source, 'LOCK-1', 'S4HK900009'
    )
    expect(client.syntaxCheck).toHaveBeenCalledWith(
      testCase.sourceUrl, objectUrl(testCase), testCase.source, undefined, 'active'
    )
    expect(client.activate).toHaveBeenCalledTimes(1)
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT',
      'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT',
      'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'
    ])
  })

  it('preserves a source-write unknown outcome when unlock also fails', async () => {
    const testCase = cases[0]
    const client = clientFor(testCase)
    client.setObjectSource.mockRejectedValue(new Error('socket reset after PUT'))
    client.unLock.mockRejectedValue(new Error('unlock response lost'))
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    const prepared = await adapter.prepare(request(testCase))

    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toThrow('Source write outcome is unknown')
    expect(client.unLock).toHaveBeenCalledTimes(1)
    expect(client.activate).not.toHaveBeenCalled()
    expect(client.deleteObject).not.toHaveBeenCalled()
  })

  it('treats an activation exception as unknown without retrying', async () => {
    const testCase = cases[1]
    const client = clientFor(testCase)
    client.activate.mockRejectedValue(new Error('activation timeout'))
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    const prepared = await adapter.prepare(request(testCase))

    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(client.activate).toHaveBeenCalledTimes(1)
    expect(client.getObjectSource).not.toHaveBeenCalled()
    expect(client.deleteObject).not.toHaveBeenCalled()
  })

  it('rejects a source URL outside the created object resource before locking', async () => {
    const testCase = cases[1]
    const client = clientFor(testCase)
    client.objectStructure.mockResolvedValue({
      ...structure(testCase, 'inactive'),
      metaData: {
        ...structure(testCase, 'inactive').metaData,
        'abapsource:sourceUri': '../programs/includes/zother/source/main'
      }
    } as AbapObjectStructure)
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    const prepared = await adapter.prepare(request(testCase))

    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toThrow('controlled source URL')
    expect(client.lock).not.toHaveBeenCalled()
    expect(client.setObjectSource).not.toHaveBeenCalled()
  })

  it('compensates only the exact object owned by the current plan', async () => {
    const testCase = cases[2]
    const client = clientFor(testCase)
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    const prepared = await adapter.prepare(request(testCase))
    const owned = plan(prepared)
    owned.actualResources = [{ type: testCase.type, name: testCase.name }]

    await expect(adapter.compensate!(owned, jest.fn())).resolves.toBe(true)
    expect(client.deleteObject).toHaveBeenCalledWith(objectUrl(testCase), 'LOCK-1', 'S4HK900009')
    await expect(adapter.compensate!(plan(prepared), jest.fn())).resolves.toBe(false)
    expect(client.deleteObject).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ABAP_CLASS', 'ZCL_MCP_TEST', 'CLASS zcl_other DEFINITION. ENDCLASS. CLASS zcl_other IMPLEMENTATION. ENDCLASS.'],
    ['ABAP_INTERFACE', 'ZIF_MCP_TEST', 'INTERFACE zif_other. ENDINTERFACE.']
  ] as Array<[ControlledSourceObjectKind, string, string]>)('rejects a mismatched %s source frame before any SAP call', async (kind, name, source) => {
    const client = baseClient()
    const adapter = new SourceObjectCreationAdapter(kind, client, policy)
    await expect(adapter.prepare({
      objectKind: kind, name, description: 'Mismatch', packageName: 'Z001',
      transportRequest: 'S4HK900009', source
    })).rejects.toThrow(name)
    expect(client.searchObject).not.toHaveBeenCalled()
  })

  it('rejects class source or SAP metadata that drifts from the public final contract', async () => {
    const testCase = cases[0]
    const client = clientFor(testCase)
    const adapter = new SourceObjectCreationAdapter(testCase.kind, client, policy)
    await expect(adapter.prepare({
      ...request(testCase),
      source: 'CLASS zcl_mcp_test DEFINITION PUBLIC CREATE PUBLIC.\nENDCLASS.\nCLASS zcl_mcp_test IMPLEMENTATION.\nENDCLASS.\n'
    })).rejects.toThrow('public and final')
    expect(client.searchObject).not.toHaveBeenCalled()

    const prepared = await adapter.prepare(request(testCase))
    const drifted = structure(testCase, 'inactive')
    if (!isClassStructure(drifted)) throw new Error('Expected class structure fixture.')
    drifted.metaData['class:final'] = false
    client.objectStructure.mockResolvedValue(drifted)
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toThrow('public and final contract')
    expect(client.lock).not.toHaveBeenCalled()
  })
})
