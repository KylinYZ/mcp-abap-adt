import { TypeGroupCreationAdapter } from '../safe/adapters/TypeGroupCreationAdapter'
import type { ControlledCreationAdtClient } from '../safe/adapters/controlledCreationTools'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'
import { SafetyPolicy } from '../safe/SafetyPolicy'

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.test', sapClient: '300', sapUser: '068157', systemRole: 'DEV',
  allowedHosts: 'dev.example.test', allowedClients: '300', allowedNamespaces: 'Z', auditPath: './audit', toolProfile: 'development'
})

function client(): jest.Mocked<ControlledCreationAdtClient> {
  return {
    searchObject: jest.fn(), transportInfo: jest.fn(), transportDetails: jest.fn(),
    validateControlledPackage: jest.fn(), getControlledPackageConstraints: jest.fn(), readControlledPackage: jest.fn(), createControlledPackage: jest.fn(),
    validateControlledSourceObject: jest.fn(), createControlledSourceObjectShell: jest.fn(),
    objectStructure: jest.fn(), getObjectSource: jest.fn(), setObjectSource: jest.fn(), syntaxCheck: jest.fn(), activate: jest.fn(),
    validateControlledTableShell: jest.fn(), createControlledTableShell: jest.fn(), readControlledTable: jest.fn(), readControlledTableSource: jest.fn(),
    writeControlledTableSource: jest.fn(), runControlledTableCheck: jest.fn(), readControlledTableSettings: jest.fn(), writeControlledTableSettings: jest.fn(),
    activateControlledTable: jest.fn(), activateControlledTableSettings: jest.fn(),
    validateControlledStructureShell: jest.fn(), createControlledStructureShell: jest.fn(), activateControlledStructure: jest.fn(),
    validateControlledTypeGroupShell: jest.fn(), createControlledTypeGroupShell: jest.fn(), activateControlledTypeGroup: jest.fn(),
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn(), findCollectionByUrl: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async name => name === 'Z001'
    ? [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    : [])
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateControlledTypeGroupShell as jest.Mock).mockResolvedValue({ success: true })
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({
    discoveryResult: { title: 'DDIC', collection: [] },
    collection: { href: '/sap/bc/adt/ddic/typegroups', title: 'Type Groups', acceptedContentTypes: ['application/vnd.sap.adt.ddic.typegroups.v2+xml', 'application/vnd.sap.adt.ddic.typegroups.v3+xml'], templateLinks: [] }
  })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledTypeGroupShell as jest.Mock).mockResolvedValue({ location: '/sap/bc/adt/ddic/typegroups/zztg1', typeGroup: { name: 'ZZTG1', packageName: 'Z001' } })
  value.objectStructure.mockResolvedValue({ objectUrl: '/sap/bc/adt/ddic/typegroups/zztg1', metaData: { 'adtcore:name': 'ZZTG1', 'adtcore:type': 'TYPE/DG', 'adtcore:version': 'inactive', 'abapsource:sourceUri': 'source/main' }, links: [] } as never)
  value.syntaxCheck.mockResolvedValue([])
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  ;(value.activateControlledTypeGroup as jest.Mock).mockResolvedValue({ success: true, messages: [] })
  value.getObjectSource.mockResolvedValue('TYPE-POOL ZZTG1 .')
  value.setObjectSource.mockImplementation(async (_url, source) => { value.getObjectSource.mockResolvedValue(source) })
  return value
}

function request(): Record<string, unknown> {
  return { objectKind: 'DDIC_TYPE_GROUP', name: 'ZZTG1', description: 'MCP类型组', packageName: 'Z001', transportRequest: 'S4HK900009', source: 'TYPE-POOL ZZTG1 .\nTYPES: BEGIN OF ty_demo, value TYPE i, END OF ty_demo.' }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

describe('TypeGroupCreationAdapter', () => {
  it('freezes discovery content type and executes the controlled lifecycle', async () => {
    const value = configured()
    const adapter = new TypeGroupCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    expect(prepared.review).toMatchObject({ shellContract: { adtType: 'TYPE/DG', contentType: 'application/vnd.sap.adt.ddic.typegroups.v2+xml' } })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'TYPE/DG', name: 'ZZTG1' }] })
    expect(value.createControlledTypeGroupShell).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZZTG1' }), 'application/vnd.sap.adt.ddic.typegroups.v2+xml')
    expect(value.setObjectSource).toHaveBeenCalledWith('/sap/bc/adt/ddic/typegroups/zztg1/source/main', expect.any(String), 'LOCK-1', 'S4HK900009')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'])
  })

  it('rejects a source that does not declare the requested type pool', async () => {
    await expect(new TypeGroupCreationAdapter(configured(), policy).prepare({ ...request(), source: 'TYPE-POOL OTHER .' })).rejects.toThrow('TYPE-POOL ZZTG1')
  })
})
