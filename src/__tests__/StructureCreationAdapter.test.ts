import { StructureCreationAdapter } from '../safe/adapters/StructureCreationAdapter'
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
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn(), findCollectionByUrl: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async name => name === 'Z001' ? [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }] : [])
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateControlledStructureShell as jest.Mock).mockResolvedValue({ success: true })
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({
    discoveryResult: { title: 'DDIC', collection: [] },
    collection: { href: '/sap/bc/adt/ddic/structures', title: 'Structures', acceptedContentTypes: ['application/vnd.sap.adt.structures.v2+xml', 'text/html'], templateLinks: [] }
  })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledStructureShell as jest.Mock).mockResolvedValue({ location: '/sap/bc/adt/ddic/structures/zzif_mcp_struct', structure: { name: 'ZZIF_MCP_STRUCT', packageName: 'Z001' } })
  value.objectStructure.mockResolvedValue({ objectUrl: '/sap/bc/adt/ddic/structures/zzif_mcp_struct', metaData: { 'adtcore:name': 'ZZIF_MCP_STRUCT', 'adtcore:type': 'TABL/DS', 'adtcore:version': 'inactive', 'abapsource:sourceUri': './zzif_mcp_struct/source/main' }, links: [] } as never)
  value.syntaxCheck.mockResolvedValue([])
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  ;(value.activateControlledStructure as jest.Mock).mockResolvedValue({ success: true, messages: [] })
  value.getObjectSource.mockResolvedValue('')
  value.setObjectSource.mockImplementation(async (_url, source) => { value.getObjectSource.mockResolvedValue(source) })
  return value
}

function request(): Record<string, unknown> {
  return { objectKind: 'DDIC_STRUCTURE', name: 'ZZIF_MCP_STRUCT', description: 'MCP结构', packageName: 'Z001', transportRequest: 'S4HK900009', fields: [{ name: 'TEST_TEXT', type: 'CHAR', length: 40 }] }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

describe('StructureCreationAdapter', () => {
  it('freezes the discovered content type and executes the controlled lifecycle', async () => {
    const value = configured()
    const adapter = new StructureCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    expect(prepared.review).toMatchObject({ shellContract: { adtType: 'TABL/DS', contentType: 'application/vnd.sap.adt.structures.v2+xml' } })
    expect((prepared.review as any).source).toContain('@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE')
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'TABL/DS', name: 'ZZIF_MCP_STRUCT' }] })
    expect(value.createControlledStructureShell).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZZIF_MCP_STRUCT' }), 'application/vnd.sap.adt.structures.v2+xml')
    expect(value.setObjectSource).toHaveBeenCalledWith('/sap/bc/adt/ddic/structures/zzif_mcp_struct/source/main', expect.any(String), 'LOCK-1', 'S4HK900009')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'PREWRITE_CHECKS', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'])
    expect(value.syntaxCheck).toHaveBeenNthCalledWith(
      1,
      '/sap/bc/adt/ddic/structures/zzif_mcp_struct/source/main',
      '/sap/bc/adt/ddic/structures/zzif_mcp_struct',
      expect.stringContaining('define structure zzif_mcp_struct'),
      undefined,
      'active'
    )
  })

  it('does not proceed when discovery has no accepted content type', async () => {
    const value = configured()
    ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue(undefined)
    await expect(new StructureCreationAdapter(value, policy).prepare(request())).rejects.toThrow('accepted content type')
  })
})
