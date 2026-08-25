import { LogicalExternalSchemaCreationAdapter } from '../safe/adapters/LogicalExternalSchemaCreationAdapter'
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
    validateControlledSourceObject: jest.fn(), createControlledSourceObjectShell: jest.fn(), objectStructure: jest.fn(),
    getObjectSource: jest.fn(), setObjectSource: jest.fn(), syntaxCheck: jest.fn(), activate: jest.fn(),
    validateControlledTableShell: jest.fn(), createControlledTableShell: jest.fn(), readControlledTable: jest.fn(), readControlledTableSource: jest.fn(),
    writeControlledTableSource: jest.fn(), runControlledTableCheck: jest.fn(), readControlledTableSettings: jest.fn(), writeControlledTableSettings: jest.fn(),
    activateControlledTable: jest.fn(), activateControlledTableSettings: jest.fn(), lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn(),
    findCollectionByUrl: jest.fn(), validateControlledLogicalExternalSchema: jest.fn(), readControlledLogicalExternalSchemaSchema: jest.fn(),
    createControlledLogicalExternalSchemaShell: jest.fn(), readControlledLogicalExternalSchemaContent: jest.fn(), writeControlledLogicalExternalSchemaContent: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

const schema = {
  properties: {
    formatVersion: {},
    header: { properties: { description: {}, originalLanguage: {}, abapLanguageVersion: { enum: ['standard', 'cloudDevelopment'] } } },
    generalInformation: { properties: { defaultRemoteSchemaName: {}, usesRouting: {} } }
  }
}

function configured(sourceContentType = 'application/json; charset=UTF-8'): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async name => name === 'Z001'
    ? [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    : [])
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateControlledLogicalExternalSchema as jest.Mock).mockResolvedValue({ success: true })
  ;(value.readControlledLogicalExternalSchemaSchema as jest.Mock).mockResolvedValue(schema)
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({ discoveryResult: { title: 'DDIC', collection: [] }, collection: {
    href: '/sap/bc/adt/ddic/desd', title: 'DESD', acceptedContentTypes: ['application/vnd.sap.adt.blues.v1+xml'], templateLinks: []
  } })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledLogicalExternalSchemaShell as jest.Mock).mockResolvedValue({ location: '/sap/bc/adt/ddic/desd/zzif_mcp_schema', logicalExternalSchema: { name: 'ZZIF_MCP_SCHEMA' } })
  const links = [{ href: './zzif_mcp_schema/source/main', rel: 'http://www.sap.com/adt/relations/source', type: sourceContentType }]
  value.objectStructure.mockImplementation(async (_url, version) => ({
    objectUrl: '/sap/bc/adt/ddic/desd/zzif_mcp_schema',
    metaData: { 'adtcore:name': 'ZZIF_MCP_SCHEMA', 'adtcore:type': 'DESD/TYP', 'adtcore:version': version },
    links
  } as never))
  ;(value.readControlledLogicalExternalSchemaContent as jest.Mock).mockResolvedValue({ formatVersion: '1', header: { description: 'MCP schema', originalLanguage: 'zh', abapLanguageVersion: 'standard' }, generalInformation: { defaultRemoteSchemaName: 'REMOTE_SCHEMA' } })
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  value.activate.mockResolvedValue({ success: true, messages: [] } as never)
  return value
}

function request(): Record<string, unknown> {
  return { objectKind: 'LOGICAL_EXTERNAL_SCHEMA', name: 'ZZIF_MCP_SCHEMA', description: 'MCP schema', packageName: 'Z001', defaultRemoteSchemaName: 'REMOTE_SCHEMA', transportRequest: 'S4HK900009' }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

describe('LogicalExternalSchemaCreationAdapter', () => {
  it('writes, activates, and verifies server-driven JSON content', async () => {
    const value = configured()
    const adapter = new LogicalExternalSchemaCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'DESD/TYP', name: 'ZZIF_MCP_SCHEMA' }] })
    expect(value.writeControlledLogicalExternalSchemaContent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ formatVersion: '1' }), 'application/json', 'LOCK-1', 'S4HK900009')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'REVALIDATE_SCHEMA', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_CONTENT', 'VERIFY_CONTENT', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'])
  })

  it('stops as unknown when JSON write outcome is uncertain', async () => {
    const value = configured()
    ;(value.writeControlledLogicalExternalSchemaContent as jest.Mock).mockRejectedValue(new Error('connection lost'))
    const adapter = new LogicalExternalSchemaCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toBeInstanceOf(Error)
    expect(value.deleteObject).not.toHaveBeenCalled()
  })

  it('rejects non-DESD JSON media types before locking or writing', async () => {
    const value = configured('application/vnd.sap.adt.serverdriven.content.v1+json; framework=objectTypes.v1')
    const adapter = new LogicalExternalSchemaCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('reviewed application/json')
    expect(value.lock).not.toHaveBeenCalled()
    expect(value.writeControlledLogicalExternalSchemaContent).not.toHaveBeenCalled()
  })

  it('accepts SAP read-back that omits optional content fields', async () => {
    const value = configured()
    const adapter = new LogicalExternalSchemaCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    ;(value.readControlledLogicalExternalSchemaContent as jest.Mock).mockResolvedValue({
      formatVersion: '1', header: { description: 'MCP schema', originalLanguage: 'zh' }, generalInformation: {}
    })
    await expect(adapter.execute(plan(prepared), () => undefined)).resolves.toMatchObject({
      actualResources: [{ type: 'DESD/TYP', name: 'ZZIF_MCP_SCHEMA' }]
    })
  })
})
