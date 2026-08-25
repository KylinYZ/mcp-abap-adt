import { TableTypeCreationAdapter } from '../safe/adapters/TableTypeCreationAdapter'
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
    readControlledPackage: jest.fn(), validateControlledTableTypeShell: jest.fn(), createControlledTableTypeShell: jest.fn(),
    readControlledTableType: jest.fn(), writeControlledTableType: jest.fn(), readControlledAbapTypeCapabilities: jest.fn(), activateControlledTableType: jest.fn(),
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn()
  } as unknown as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async (name, type) => {
    if (name === 'Z001') return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    if (type === 'TTYP/DA') return []
    return []
  })
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateControlledTableTypeShell as jest.Mock).mockResolvedValue({ success: true })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.readControlledAbapTypeCapabilities as jest.Mock).mockResolvedValue([
    { name: 'char', pattern: 'char(len)', lengthMin: 1, lengthMax: 30000 },
    { name: 'curr', pattern: 'curr(len,decimals)', lengthMin: 1, lengthMax: 31, decimalsMin: 1, decimalsMax: 14 },
    { name: 'quan', pattern: 'quan(len,decimals)', lengthMin: 1, lengthMax: 31, decimalsMin: 0, decimalsMax: 14 }
  ])
  ;(value.createControlledTableTypeShell as jest.Mock).mockResolvedValue({ location: '/sap/bc/adt/ddic/tabletypes/zzif_mcp_tt', tableType: {} as never })
  const empty = {
    name: 'ZZIF_MCP_TT', description: 'TEST TT', packageName: 'Z001', version: 'inactive',
    rowType: { typeKind: 'predefinedAbapType', dataType: 'CURR', length: 10, decimals: 2 },
    initialRowCount: 0, accessType: 'standard', primaryKey: { definition: 'standard', kind: 'nonUnique' },
    secondaryKeys: { allowed: 'notSpecified' }, rawXml: '<ttyp:tableType />'
  } as never
  ;(value.readControlledTableType as jest.Mock).mockResolvedValue(empty)
  ;(value.writeControlledTableType as jest.Mock).mockImplementation(async (_name: string, _current: unknown, properties: { rowType: unknown }) => ({ ...(empty as object), ...(properties as object), rowType: properties.rowType, version: 'new' } as never))
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  ;(value.activateControlledTableType as jest.Mock).mockResolvedValue({ success: true, messages: [] } as never)
  return value
}

function request(): Record<string, unknown> {
  return {
    objectKind: 'DDIC_TABLE_TYPE', name: 'ZZIF_MCP_TT', description: 'TEST TT', packageName: 'Z001', transportRequest: 'S4HK900009',
    rowType: { typeKind: 'predefinedAbapType', dataType: 'CURR', length: 10, decimals: 2 }
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

describe('TableTypeCreationAdapter', () => {
  it('creates and verifies a CURR-based table type through the structured lifecycle', async () => {
    const value = configured()
    const adapter = new TableTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    expect(prepared.review).toMatchObject({ shellContract: { adtType: 'TTYP/DA', contentType: 'application/vnd.sap.adt.tabletype.v1+xml' } })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'TTYP/DA', name: 'ZZIF_MCP_TT' }] })
    expect(value.createControlledTableTypeShell).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZZIF_MCP_TT' }))
    expect(value.writeControlledTableType).toHaveBeenCalledWith('ZZIF_MCP_TT', expect.anything(), expect.objectContaining({ rowType: expect.objectContaining({ dataType: 'CURR', decimals: 2 }) }), 'LOCK-1', 'S4HK900009')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_PROPERTIES', 'VERIFY_PROPERTIES', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_PROPERTIES'])
  })

  it('uses target-advertised ranges for CURR and QUAN instead of rejecting them', async () => {
    const value = configured()
    const adapter = new TableTypeCreationAdapter(value, policy)
    await expect(adapter.prepare({ ...request(), rowType: { typeKind: 'predefinedAbapType', dataType: 'QUAN', length: 31, decimals: 14 } })).resolves.toBeDefined()
    await expect(adapter.prepare({ ...request(), rowType: { typeKind: 'predefinedAbapType', dataType: 'CURR', length: 32, decimals: 2 } })).rejects.toThrow('rowType.length')
  })
})
