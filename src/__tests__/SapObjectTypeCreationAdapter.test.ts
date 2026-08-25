import { SapObjectTypeCreationAdapter } from '../safe/adapters/SapObjectTypeCreationAdapter'
import type { ControlledCreationAdtClient } from '../safe/adapters/controlledCreationTools'
import { RepositoryCreationOutcomeUnknownError } from '../safe/RepositoryObjectCreationWorkflow'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'
import { SafetyPolicy } from '../safe/SafetyPolicy'

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.test', sapClient: '300', sapUser: '068157', systemRole: 'DEV',
  allowedHosts: 'dev.example.test', allowedClients: '300', allowedNamespaces: 'Z', auditPath: './audit', toolProfile: 'development'
})

const contract = {
  schema: {
    properties: {
      name: { type: 'string', maxLength: 30 },
      typeCategory: { type: 'string', enum: ['bo', 'to', 'ao', 'co', 'do', 'ho'] },
      metadata: { properties: { name: {}, description: {}, package: {} } }
    },
    required: ['name']
  },
  configuration: {
    properties: {
      name: { 'sap.adt.sideeffect': { determination: ['afterUpdate'] } },
      metadata: { properties: { name: { 'sap.adt.readonly': true } } }
    }
  },
  content: {}
}

const content = {
  formatVersion: '1' as const,
  header: { description: 'MCP SAP Object Type', originalLanguage: 'zh' },
  typeCategory: 'businessObject' as const,
  name: 'ZmcpRontTest',
  objectTypeCode: '9001'
}

function client(): jest.Mocked<ControlledCreationAdtClient> {
  return {
    searchObject: jest.fn(), transportInfo: jest.fn(), transportDetails: jest.fn(),
    validateControlledPackage: jest.fn(), getControlledPackageConstraints: jest.fn(), readControlledPackage: jest.fn(), createControlledPackage: jest.fn(),
    validateControlledSourceObject: jest.fn(), createControlledSourceObjectShell: jest.fn(), objectStructure: jest.fn(),
    getObjectSource: jest.fn(), setObjectSource: jest.fn(), syntaxCheck: jest.fn(), activate: jest.fn(),
    validateControlledTableShell: jest.fn(), createControlledTableShell: jest.fn(), readControlledTable: jest.fn(), readControlledTableSource: jest.fn(),
    writeControlledTableSource: jest.fn(), runControlledTableCheck: jest.fn(), readControlledTableSettings: jest.fn(), writeControlledTableSettings: jest.fn(),
    activateControlledTable: jest.fn(), activateControlledTableSettings: jest.fn(), lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn(),
    findCollectionByUrl: jest.fn(), validateControlledSapObjectType: jest.fn(), readControlledSapObjectTypeCreationContract: jest.fn(),
    createControlledSapObjectType: jest.fn(), readControlledSapObjectTypeContent: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async (name, type) => name === 'Z001' && type === 'DEVC/K'
    ? [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    : [])
  value.readControlledPackage.mockResolvedValue({
    name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  })
  ;(value.validateControlledSapObjectType as jest.Mock).mockResolvedValue({ success: true })
  ;(value.readControlledSapObjectTypeCreationContract as jest.Mock).mockResolvedValue(contract)
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({
    discoveryResult: { title: 'SAP Object Type Management', collection: [] },
    collection: {
      href: '/sap/bc/adt/businessobjects/rontrot',
      title: 'SAP Object Type',
      acceptedContentTypes: ['application/vnd.sap.adt.blues.v2+xml', 'text/html'],
      templateLinks: [
        {
          rel: 'http://www.sap.com/adt/categories/objects/new/schema/additional',
          template: '/sap/bc/adt/businessobjects/rontrot/$new/schema{?relatedObjectUri}',
          type: 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=newObjectTypes.v1'
        },
        {
          rel: 'http://www.sap.com/adt/categories/objects/new/configuration/additional',
          template: '/sap/bc/adt/businessobjects/rontrot/$new/configuration{?relatedObjectUri}',
          type: 'application/vnd.sap.adt.serverdriven.configuration.v1+json; framework=newObjectTypes.v1'
        },
        {
          rel: 'http://www.sap.com/adt/categories/objects/new/content/additional',
          template: '/sap/bc/adt/businessobjects/rontrot/$new/content{?relatedObjectUri}',
          type: 'application/vnd.sap.adt.serverdriven.content.v1+json; framework=newObjectTypes.v1'
        }
      ]
    }
  })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledSapObjectType as jest.Mock).mockResolvedValue({
    location: '/sap/bc/adt/businessobjects/rontrot/zmcpronttest',
    sapObjectType: { name: 'ZMCPRONTTEST', packageName: 'Z001', version: 'inactive' }
  })
  const links = [{
    href: './zmcpronttest/source/main',
    rel: 'http://www.sap.com/adt/relations/source',
    type: 'application/json'
  }]
  value.objectStructure.mockImplementation(async (url, version) => ({
    objectUrl: url,
    metaData: { 'adtcore:name': 'ZMCPRONTTEST', 'adtcore:type': 'RONT/ROT', 'adtcore:version': version },
    links
  } as never))
  ;(value.readControlledSapObjectTypeContent as jest.Mock).mockResolvedValue(content)
  value.activate.mockResolvedValue({ success: true, messages: [] } as never)
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  return value
}

function request(): Record<string, unknown> {
  return {
    objectKind: 'SAP_OBJECT_TYPE', name: 'ZmcpRontTest', description: 'MCP SAP Object Type',
    packageName: 'Z001', typeCategory: 'businessObject', transportRequest: 'S4HK900009'
  }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return {
    creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING',
    context: {
      systemHost: 'dev.example.test', client: '300', sapUser: '068157',
      systemRole: 'DEV', toolProfile: 'development'
    },
    target: prepared.target,
    transportRequest: prepared.transportRequest,
    summary: prepared.summary,
    payloadHash: 'hash',
    payloadBytes: 1,
    payload: prepared.payload,
    stages: [],
    compensationLimits: prepared.compensationLimits
  }
}

describe('SapObjectTypeCreationAdapter', () => {
  it('freezes the contract, creates once, activates, and verifies canonical JSON', async () => {
    const value = configured()
    const adapter = new SapObjectTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: 'RONT/ROT', name: 'ZMCPRONTTEST' }]
    })
    expect(value.createControlledSapObjectType).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryName: 'ZMCPRONTTEST', semanticName: 'ZmcpRontTest' }),
      {
        name: 'ZmcpRontTest', typeCategory: 'bo',
        metadata: { name: 'ZMCPRONTTEST', description: 'MCP SAP Object Type', package: 'Z001' }
      },
      'application/vnd.sap.adt.blues.v2+xml'
    )
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'REVALIDATE_CONTRACT', 'VALIDATE_TRANSPORT', 'CREATE_OBJECT',
      'VERIFY_INACTIVE_OBJECT', 'VERIFY_INACTIVE_CONTENT', 'ACTIVATE_OBJECT',
      'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ])
  })

  it('rejects non-PascalCase names before any SAP call', async () => {
    const value = configured()
    await expect(new SapObjectTypeCreationAdapter(value, policy).prepare({ ...request(), name: 'ZMCP_RONT_TEST' }))
      .rejects.toThrow('PascalCase')
    expect(value.searchObject).not.toHaveBeenCalled()
  })

  it('accepts objectTypeCode remaining absent after activation', async () => {
    const value = configured()
    ;(value.readControlledSapObjectTypeContent as jest.Mock)
      .mockResolvedValueOnce({ ...content, objectTypeCode: undefined })
      .mockResolvedValueOnce({ ...content, objectTypeCode: undefined })
    await expect(new SapObjectTypeCreationAdapter(value, policy).execute(
      plan(await new SapObjectTypeCreationAdapter(value, policy).prepare(request())), () => undefined
    )).resolves.toMatchObject({ actualResources: [{ type: 'RONT/ROT', name: 'ZMCPRONTTEST' }] })
  })

  it('accepts objectTypeCode assigned only after activation', async () => {
    const value = configured()
    ;(value.readControlledSapObjectTypeContent as jest.Mock)
      .mockResolvedValueOnce({ ...content, objectTypeCode: undefined })
      .mockResolvedValueOnce(content)
    await expect(new SapObjectTypeCreationAdapter(value, policy).execute(
      plan(await new SapObjectTypeCreationAdapter(value, policy).prepare(request())), () => undefined
    )).resolves.toMatchObject({ actualResources: [{ type: 'RONT/ROT', name: 'ZMCPRONTTEST' }] })
  })

  it('preserves an objectTypeCode already assigned in inactive content', async () => {
    const value = configured()
    ;(value.readControlledSapObjectTypeContent as jest.Mock)
      .mockResolvedValueOnce(content)
      .mockResolvedValueOnce({ ...content, objectTypeCode: undefined })
    await expect(new SapObjectTypeCreationAdapter(value, policy).execute(
      plan(await new SapObjectTypeCreationAdapter(value, policy).prepare(request())), () => undefined
    )).rejects.toThrow('does not match')

    const mismatch = configured()
    ;(mismatch.readControlledSapObjectTypeContent as jest.Mock)
      .mockResolvedValueOnce({ ...content, objectTypeCode: '9001' })
      .mockResolvedValueOnce({ ...content, objectTypeCode: '9002' })
    await expect(new SapObjectTypeCreationAdapter(mismatch, policy).execute(
      plan(await new SapObjectTypeCreationAdapter(mismatch, policy).prepare(request())), () => undefined
    )).rejects.toThrow('does not match')
  })

  it('rejects creation-contract drift before creating the object', async () => {
    const value = configured()
    const adapter = new SapObjectTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    ;(value.readControlledSapObjectTypeCreationContract as jest.Mock).mockResolvedValue({
      ...contract,
      configuration: {
        ...contract.configuration,
        properties: {
          ...contract.configuration.properties,
          typeCategory: { 'sap.adt.readonly': true }
        }
      }
    })
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('changed after preview')
    expect(value.createControlledSapObjectType).not.toHaveBeenCalled()
  })

  it('rejects discovery links that point at a different new-object endpoint', async () => {
    const value = configured()
    const discovery = await value.findCollectionByUrl!('/sap/bc/adt/businessobjects/rontrot')
    discovery!.collection.templateLinks[0].template = '/sap/bc/adt/businessobjects/rontrot/$new/content{?relatedObjectUri}'
    ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue(discovery)

    await expect(new SapObjectTypeCreationAdapter(value, policy).prepare(request()))
      .rejects.toThrow('schema contract')
    expect(value.createControlledSapObjectType).not.toHaveBeenCalled()
  })

  it('classifies create and activation transport failures as unknown outcomes', async () => {
    const createClient = configured()
    ;(createClient.createControlledSapObjectType as jest.Mock).mockRejectedValue(new Error('connection lost'))
    const createAdapter = new SapObjectTypeCreationAdapter(createClient, policy)
    const createPrepared = await createAdapter.prepare(request())
    await expect(createAdapter.execute(plan(createPrepared), () => undefined))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(createClient.deleteObject).not.toHaveBeenCalled()

    const activationClient = configured()
    activationClient.activate.mockRejectedValue(new Error('connection lost'))
    const activationAdapter = new SapObjectTypeCreationAdapter(activationClient, policy)
    const activationPrepared = await activationAdapter.prepare(request())
    await expect(activationAdapter.execute(plan(activationPrepared), () => undefined))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(activationClient.deleteObject).not.toHaveBeenCalled()
  })

  it('compensates only a resource recorded as owned by the current plan', async () => {
    const value = configured()
    const adapter = new SapObjectTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const ownedPlan = plan(prepared)
    ownedPlan.actualResources = [{ type: 'RONT/ROT', name: 'ZMCPRONTTEST' }]
    await expect(adapter.compensate(ownedPlan, () => undefined)).resolves.toBe(true)
    expect(value.deleteObject).toHaveBeenCalledWith(
      '/sap/bc/adt/businessobjects/rontrot/zmcpronttest', 'LOCK-1', 'S4HK900009'
    )

    const unownedPlan = plan(prepared)
    await expect(adapter.compensate(unownedPlan, () => undefined)).resolves.toBe(false)
  })
})
