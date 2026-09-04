import { ServiceBindingCreationAdapter } from '../safe/adapters/ServiceBindingCreationAdapter'
import type { ControlledCreationAdtClient } from '../safe/adapters/controlledCreationTools'
import { RepositoryCreationOutcomeUnknownError } from '../safe/RepositoryObjectCreationWorkflow'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'
import { SafetyPolicy } from '../safe/SafetyPolicy'

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.test', sapClient: '300', sapUser: '068157', systemRole: 'DEV',
  allowedHosts: 'dev.example.test', allowedClients: '300', allowedNamespaces: 'Z',
  auditPath: './audit', toolProfile: 'development'
})

const bindingXml = '<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZUI_MCP_BINDING" adtcore:type="SRVB/SVB" adtcore:version="active" srvb:bindingCreated="true" srvb:published="false"><atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="x"/><adtcore:packageRef adtcore:name="Z001"/><srvb:services srvb:name="ZUI_MCP_BINDING"><srvb:content srvb:version="0001"><srvb:serviceDefinition adtcore:name="ZUI_MCP_SERVICE"/></srvb:content></srvb:services><srvb:binding srvb:type="ODATA" srvb:version="V4" srvb:category="1"><srvb:implementation adtcore:name=""/></srvb:binding></srvb:serviceBinding>'

function baseClient(): jest.Mocked<ControlledCreationAdtClient> {
  return {
    searchObject: jest.fn(), transportInfo: jest.fn(), transportDetails: jest.fn(),
    validateControlledPackage: jest.fn(), getControlledPackageConstraints: jest.fn(),
    readControlledPackage: jest.fn(), createControlledPackage: jest.fn(),
    validateControlledSourceObject: jest.fn(), createControlledSourceObjectShell: jest.fn(),
    validateControlledServiceBinding: jest.fn(), createControlledServiceBinding: jest.fn(),
    objectStructure: jest.fn(), getObjectSource: jest.fn(), setObjectSource: jest.fn(),
    syntaxCheck: jest.fn(), activate: jest.fn(),
    validateControlledTableShell: jest.fn(), createControlledTableShell: jest.fn(),
    readControlledTable: jest.fn(), readControlledTableSource: jest.fn(), writeControlledTableSource: jest.fn(),
    runControlledTableCheck: jest.fn(), readControlledTableSettings: jest.fn(), writeControlledTableSettings: jest.fn(),
    activateControlledTable: jest.fn(), activateControlledTableSettings: jest.fn(),
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function configuredClient(): jest.Mocked<ControlledCreationAdtClient> {
  const client = baseClient()
  client.searchObject.mockImplementation(async name => {
    if (name === 'Z001') return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    if (name === 'ZUI_MCP_SERVICE') return [{ 'adtcore:name': 'ZUI_MCP_SERVICE', 'adtcore:type': 'SRVD/SRV', 'adtcore:uri': '/sap/bc/adt/ddic/srvd/sources/zui_mcp_service' }]
    return []
  })
  client.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  client.objectStructure.mockImplementation(async objectUrl => objectUrl.includes('/businessservices/bindings/')
    ? { objectUrl, metaData: {
        'adtcore:name': 'ZUI_MCP_BINDING', 'adtcore:type': 'SRVB/SVB', 'adtcore:version': 'active',
        'srvb:bindingCreated': true, 'srvb:published': false
      }, links: [] } as never
    : { objectUrl, metaData: {
        'adtcore:name': 'ZUI_MCP_SERVICE', 'adtcore:type': 'SRVD/SRV', 'adtcore:version': 'active'
      }, links: [] } as never)
  ;(client.validateControlledServiceBinding as jest.Mock).mockResolvedValue({ success: true })
  ;(client.createControlledServiceBinding as jest.Mock).mockResolvedValue({ location: '/sap/bc/adt/businessservices/bindings/zui_mcp_binding', name: 'ZUI_MCP_BINDING', adtType: 'SRVB/SVB' })
  client.getObjectSource.mockResolvedValue(bindingXml)
  client.activate.mockResolvedValue({ success: true, messages: [], inactive: [] })
  client.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  client.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  client.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  client.deleteObject.mockResolvedValue(undefined)
  return client
}

function request(): Record<string, unknown> {
  return {
    objectKind: 'SERVICE_BINDING', name: 'ZUI_MCP_BINDING', description: 'MCP service binding', packageName: 'Z001',
    serviceDefinition: 'ZUI_MCP_SERVICE', bindingType: 'ODATA_V4_WEB_API', bindingCategory: '1', transportRequest: 'S4HK900009'
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

describe('ServiceBindingCreationAdapter', () => {
  it('previews without writing and executes the complete verified lifecycle', async () => {
    const client = configuredClient()
    const adapter = new ServiceBindingCreationAdapter(client, policy)
    const prepared = await adapter.prepare(request())
    expect(client.createControlledServiceBinding).not.toHaveBeenCalled()
    expect(prepared.review).toMatchObject({ serviceDefinition: 'ZUI_MCP_SERVICE', bindingType: 'ODATA_V4_WEB_API', bindingCategory: '1' })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: 'SRVB/SVB', name: 'ZUI_MCP_BINDING' }]
    })
    expect(client.createControlledServiceBinding).toHaveBeenCalledTimes(1)
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCE', 'VALIDATE_TRANSPORT', 'CREATE_OBJECT',
      'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_CONFIGURATION'
    ])
    expect(client.activate).toHaveBeenCalledWith(
      'ZUI_MCP_BINDING', '/sap/bc/adt/businessservices/bindings/zui_mcp_binding', undefined, true
    )
    expect(client.getObjectSource).toHaveBeenCalledWith(
      '/sap/bc/adt/businessservices/bindings/zui_mcp_binding', { version: 'active' }
    )
  })

  it('rejects category mismatches and inactive or changed service definitions before creation', async () => {
    const client = configuredClient()
    const adapter = new ServiceBindingCreationAdapter(client, policy)
    await expect(adapter.prepare({ ...request(), bindingCategory: '0' })).rejects.toThrow('requires bindingCategory 1')
    client.objectStructure.mockResolvedValueOnce({ objectUrl: '', metaData: {
      'adtcore:name': 'ZUI_MCP_SERVICE', 'adtcore:type': 'SRVD/SRV', 'adtcore:version': 'inactive'
    }, links: [] } as never)
    await expect(adapter.prepare(request())).rejects.toThrow('not an active')
    client.objectStructure.mockResolvedValue({ objectUrl: '', metaData: {
      'adtcore:name': 'ZOTHER', 'adtcore:type': 'SRVD/SRV', 'adtcore:version': 'active'
    }, links: [] } as never)
    await expect(adapter.prepare(request())).rejects.toThrow('not an active')
    expect(client.createControlledServiceBinding).not.toHaveBeenCalled()
  })

  it('classifies uncertain creation outcomes without retrying', async () => {
    const client = configuredClient()
    ;(client.createControlledServiceBinding as jest.Mock).mockRejectedValue(new Error('socket reset after POST'))
    const adapter = new ServiceBindingCreationAdapter(client, policy)
    const prepared = await adapter.prepare(request())
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(client.createControlledServiceBinding).toHaveBeenCalledTimes(1)
    expect(client.deleteObject).not.toHaveBeenCalled()
  })

  it('requires an active, created, and unpublished binding after activation', async () => {
    const client = configuredClient()
    client.objectStructure.mockImplementation(async objectUrl => objectUrl.includes('/businessservices/bindings/')
      ? { objectUrl, metaData: {
          'adtcore:name': 'ZUI_MCP_BINDING', 'adtcore:type': 'SRVB/SVB', 'adtcore:version': 'inactive',
          'srvb:bindingCreated': false, 'srvb:published': false
        }, links: [] } as never
      : { objectUrl, metaData: {
          'adtcore:name': 'ZUI_MCP_SERVICE', 'adtcore:type': 'SRVD/SRV', 'adtcore:version': 'active'
        }, links: [] } as never)
    const adapter = new ServiceBindingCreationAdapter(client, policy)
    const prepared = await adapter.prepare(request())
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toThrow('not active and unpublished')
  })

  it('compensates only a binding recorded as owned by the current plan', async () => {
    const client = configuredClient()
    const adapter = new ServiceBindingCreationAdapter(client, policy)
    const prepared = await adapter.prepare(request())
    const owned = plan(prepared)
    owned.actualResources = [{ type: 'SRVB/SVB', name: 'ZUI_MCP_BINDING' }]
    await expect(adapter.compensate!(owned, jest.fn())).resolves.toBe(true)
    expect(client.deleteObject).toHaveBeenCalledWith('/sap/bc/adt/businessservices/bindings/zui_mcp_binding', 'LOCK-1', 'S4HK900009')
    await expect(adapter.compensate!(plan(prepared), jest.fn())).resolves.toBe(false)
  })
})
