import { LockObjectCreationAdapter } from '../safe/adapters/LockObjectCreationAdapter'
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
    validateControlledLockObjectShell: jest.fn(), createControlledLockObjectShell: jest.fn(),
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn(), findCollectionByUrl: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async name => {
    if (name === 'Z001') return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    if (name === 'ZZIF_MCP_TEST') return [{ 'adtcore:name': 'ZZIF_MCP_TEST', 'adtcore:type': 'TABL/DT', 'adtcore:uri': '/sap/bc/adt/ddic/tables/zzif_mcp_test' }]
    return []
  })
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateControlledLockObjectShell as jest.Mock).mockResolvedValue({ success: true })
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({
    discoveryResult: { title: 'DDIC', collection: [] },
    collection: { href: '/sap/bc/adt/ddic/lockobjects/sources', title: 'Lock Objects', acceptedContentTypes: ['application/vnd.sap.adt.lockobjects.v1+xml', 'text/html'], templateLinks: [] }
  })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledLockObjectShell as jest.Mock).mockResolvedValue({ location: '/sap/bc/adt/ddic/lockobjects/sources/ezzenqchk', lockObject: { name: 'EZZENQCHK', packageName: 'Z001', primaryTable: 'ZZIF_MCP_TEST' } })
  value.objectStructure.mockResolvedValue({ objectUrl: '/sap/bc/adt/ddic/lockobjects/sources/ezzenqchk', metaData: { 'adtcore:name': 'EZZENQCHK', 'adtcore:type': 'ENQU/DL', 'adtcore:version': 'active' }, links: [] } as never)
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  return value
}

function request(): Record<string, unknown> {
  return { objectKind: 'DDIC_LOCK_OBJECT', name: 'EZZENQCHK', description: 'MCP锁对象', packageName: 'Z001', primaryTable: 'ZZIF_MCP_TEST', transportRequest: 'S4HK900009' }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

describe('LockObjectCreationAdapter', () => {
  it('executes structured creation without source or activation stages', async () => {
    const value = configured()
    const adapter = new LockObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    expect(prepared.review).toMatchObject({ shellContract: { adtType: 'ENQU/DL', contentType: 'application/vnd.sap.adt.lockobjects.v1+xml', allowRFC: false } })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'ENQU/DL', name: 'EZZENQCHK' }] })
    expect(value.createControlledLockObjectShell).toHaveBeenCalledWith(expect.objectContaining({ primaryTable: 'ZZIF_MCP_TEST' }), 'application/vnd.sap.adt.lockobjects.v1+xml')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCE', 'VALIDATE_TRANSPORT', 'CREATE_OBJECT', 'VERIFY_CREATED_OBJECT'])
  })

  it('rejects a missing primary table before validation', async () => {
    const value = configured()
    value.searchObject.mockResolvedValue([])
    await expect(new LockObjectCreationAdapter(value, policy).prepare(request())).rejects.toThrow('Package Z001 was not found')
  })

  it('rejects lock object names without the required E prefix before SAP access', async () => {
    const value = configured()
    await expect(new LockObjectCreationAdapter(value, policy).prepare({
      ...request(), name: 'ZVLOCK2'
    })).rejects.toThrow('must begin with E')
    expect(value.searchObject).not.toHaveBeenCalled()
  })
})
