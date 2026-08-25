import { SapObjectNodeTypeCreationAdapter } from '../safe/adapters/SapObjectNodeTypeCreationAdapter'
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
      sapObjectType: { type: 'string', maxLength: 30 },
      rootNode: { type: 'boolean' },
      metadata: { properties: { name: {}, description: {}, package: {} } }
    },
    required: ['name', 'sapObjectType']
  },
  configuration: {
    properties: {
      name: { 'sap.adt.sideeffect': { determination: ['afterUpdate'] } },
      sapObjectType: { 'sap.adt.types': ['RONT'] },
      metadata: { properties: { name: { 'sap.adt.readonly': true } } }
    }
  },
  content: {}
}

const nodeContent = {
  formatVersion: '1' as const,
  header: { description: 'MCP SAP Object Node Type', originalLanguage: 'zh' },
  name: 'ZmcpNontTest', sapObjectType: 'ZmcpRontTest', rootNode: true
}

const sapObjectTypeContent = {
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
    createControlledSapObjectType: jest.fn(), readControlledSapObjectTypeContent: jest.fn(),
    validateControlledSapObjectNodeType: jest.fn(), readControlledSapObjectNodeTypeCreationContract: jest.fn(),
    createControlledSapObjectNodeType: jest.fn(), readControlledSapObjectNodeTypeContent: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async (name, type) => {
    if (name === 'Z001' && type === 'DEVC/K') {
      return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    }
    if (name === 'ZMCPRONTTEST' && type === 'RONT/ROT') {
      return [{
        'adtcore:name': 'ZMCPRONTTEST', 'adtcore:type': 'RONT/ROT',
        'adtcore:uri': '/sap/bc/adt/businessobjects/rontrot/zmcpronttest'
      }]
    }
    return []
  })
  value.readControlledPackage.mockResolvedValue({
    name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  })
  ;(value.validateControlledSapObjectNodeType as jest.Mock).mockResolvedValue({ success: true })
  ;(value.readControlledSapObjectNodeTypeCreationContract as jest.Mock).mockResolvedValue(contract)
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({
    discoveryResult: { title: 'SAP Object Node Type Management', collection: [] },
    collection: {
      href: '/sap/bc/adt/businessobjects/nontnot',
      title: 'SAP Object Node Type',
      acceptedContentTypes: ['application/vnd.sap.adt.blues.v2+xml', 'text/html'],
      templateLinks: [
        {
          rel: 'http://www.sap.com/adt/categories/objects/new/schema/additional',
          template: '/sap/bc/adt/businessobjects/nontnot/$new/schema{?relatedObjectUri}',
          type: 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=newObjectTypes.v1'
        },
        {
          rel: 'http://www.sap.com/adt/categories/objects/new/configuration/additional',
          template: '/sap/bc/adt/businessobjects/nontnot/$new/configuration{?relatedObjectUri}',
          type: 'application/vnd.sap.adt.serverdriven.configuration.v1+json; framework=newObjectTypes.v1'
        },
        {
          rel: 'http://www.sap.com/adt/categories/objects/new/content/additional',
          template: '/sap/bc/adt/businessobjects/nontnot/$new/content{?relatedObjectUri}',
          type: 'application/vnd.sap.adt.serverdriven.content.v1+json; framework=newObjectTypes.v1'
        }
      ]
    }
  })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledSapObjectNodeType as jest.Mock).mockResolvedValue({
    location: '/sap/bc/adt/businessobjects/nontnot/zmcpnonttest',
    sapObjectNodeType: { name: 'ZMCPNONTTEST', packageName: 'Z001', version: 'inactive' }
  })
  value.objectStructure.mockImplementation(async (url, version) => {
    if (url.includes('/rontrot/')) {
      return {
        objectUrl: url,
        metaData: { 'adtcore:name': 'ZMCPRONTTEST', 'adtcore:type': 'RONT/ROT', 'adtcore:version': 'active' },
        links: [{
          href: './zmcpronttest/source/main',
          rel: 'http://www.sap.com/adt/relations/source',
          type: 'application/json'
        }]
      } as never
    }
    return {
      objectUrl: url,
      metaData: { 'adtcore:name': 'ZMCPNONTTEST', 'adtcore:type': 'NONT/NOT', 'adtcore:version': version },
      links: [{
        href: './zmcpnonttest/source/main',
        rel: 'http://www.sap.com/adt/relations/source',
        type: 'application/json'
      }]
    } as never
  })
  ;(value.readControlledSapObjectTypeContent as jest.Mock).mockResolvedValue(sapObjectTypeContent)
  ;(value.readControlledSapObjectNodeTypeContent as jest.Mock).mockImplementation(
    async (_url, _contentType, version) => version === 'inactive'
      ? { ...nodeContent, sapObjectType: 'ZMCPRONTTEST' }
      : nodeContent
  )
  value.activate.mockResolvedValue({ success: true, messages: [] } as never)
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  return value
}

function request(): Record<string, unknown> {
  return {
    objectKind: 'SAP_OBJECT_NODE_TYPE', name: 'ZmcpNontTest', description: 'MCP SAP Object Node Type',
    packageName: 'Z001', sapObjectTypeName: 'ZMCPRONTTEST', rootNode: true,
    transportRequest: 'S4HK900009'
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

describe('SapObjectNodeTypeCreationAdapter', () => {
  it('freezes the active RONT identity, creates once, activates, and verifies JSON', async () => {
    const value = configured()
    const adapter = new SapObjectNodeTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: 'NONT/NOT', name: 'ZMCPNONTTEST' }]
    })
    expect(value.createControlledSapObjectNodeType).toHaveBeenCalledTimes(1)
    expect(value.createControlledSapObjectNodeType).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryName: 'ZMCPNONTTEST', semanticName: 'ZmcpNontTest',
        sapObjectTypeName: 'ZMCPRONTTEST', rootNode: true
      }),
      {
        name: 'ZmcpNontTest', sapObjectType: 'ZMCPRONTTEST', rootNode: true,
        metadata: { name: 'ZMCPNONTTEST', description: 'MCP SAP Object Node Type', package: 'Z001' }
      },
      'application/vnd.sap.adt.blues.v2+xml'
    )
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCE', 'REVALIDATE_CONTRACT', 'VALIDATE_TRANSPORT',
      'CREATE_OBJECT', 'VERIFY_INACTIVE_OBJECT', 'VERIFY_INACTIVE_CONTENT', 'ACTIVATE_OBJECT',
      'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ])
  })

  it('rejects non-PascalCase names and non-uppercase RONT references before SAP calls', async () => {
    const invalidNameClient = configured()
    await expect(new SapObjectNodeTypeCreationAdapter(invalidNameClient, policy).prepare({
      ...request(), name: 'ZMCP_NONT_TEST'
    })).rejects.toThrow('PascalCase')
    expect(invalidNameClient.searchObject).not.toHaveBeenCalled()

    const invalidReferenceClient = configured()
    await expect(new SapObjectNodeTypeCreationAdapter(invalidReferenceClient, policy).prepare({
      ...request(), sapObjectTypeName: 'ZmcpRontTest'
    })).rejects.toThrow('uppercase RONT repository name')
    expect(invalidReferenceClient.searchObject).not.toHaveBeenCalled()
  })

  it('requires an active RONT reference and freezes its semantic name', async () => {
    const inactiveClient = configured()
    inactiveClient.objectStructure.mockImplementation(async url => ({
      objectUrl: url,
      metaData: { 'adtcore:name': 'ZMCPRONTTEST', 'adtcore:type': 'RONT/ROT', 'adtcore:version': 'inactive' },
      links: []
    } as never))
    await expect(new SapObjectNodeTypeCreationAdapter(inactiveClient, policy).prepare(request()))
      .rejects.toThrow('active RONT/ROT')

    const changedClient = configured()
    const adapter = new SapObjectNodeTypeCreationAdapter(changedClient, policy)
    const prepared = await adapter.prepare(request())
    ;(changedClient.readControlledSapObjectTypeContent as jest.Mock).mockResolvedValue({
      ...sapObjectTypeContent, name: 'ChangedRontName'
    })
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('semantic identity changed')
    expect(changedClient.createControlledSapObjectNodeType).not.toHaveBeenCalled()
  })

  it('rejects creation-contract drift before creating the object', async () => {
    const value = configured()
    const adapter = new SapObjectNodeTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    ;(value.readControlledSapObjectNodeTypeCreationContract as jest.Mock).mockResolvedValue({
      ...contract,
      configuration: {
        ...contract.configuration,
        properties: {
          ...contract.configuration.properties,
          sapObjectType: { 'sap.adt.types': ['NONT'] }
        }
      }
    })
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('ADT 3.60.2')
    expect(value.createControlledSapObjectNodeType).not.toHaveBeenCalled()
  })

  it('classifies create and activation transport failures as unknown outcomes', async () => {
    const createClient = configured()
    ;(createClient.createControlledSapObjectNodeType as jest.Mock).mockRejectedValue(new Error('connection lost'))
    const createAdapter = new SapObjectNodeTypeCreationAdapter(createClient, policy)
    const createPrepared = await createAdapter.prepare(request())
    await expect(createAdapter.execute(plan(createPrepared), () => undefined))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(createClient.deleteObject).not.toHaveBeenCalled()

    const activationClient = configured()
    activationClient.activate.mockRejectedValue(new Error('connection lost'))
    const activationAdapter = new SapObjectNodeTypeCreationAdapter(activationClient, policy)
    const activationPrepared = await activationAdapter.prepare(request())
    await expect(activationAdapter.execute(plan(activationPrepared), () => undefined))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(activationClient.deleteObject).not.toHaveBeenCalled()
  })

  it('compensates only a resource recorded as owned by the current plan', async () => {
    const value = configured()
    const adapter = new SapObjectNodeTypeCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const ownedPlan = plan(prepared)
    ownedPlan.actualResources = [{ type: 'NONT/NOT', name: 'ZMCPNONTTEST' }]
    await expect(adapter.compensate(ownedPlan, () => undefined)).resolves.toBe(true)
    expect(value.deleteObject).toHaveBeenCalledWith(
      '/sap/bc/adt/businessobjects/nontnot/zmcpnonttest', 'LOCK-1', 'S4HK900009'
    )

    const unownedPlan = plan(prepared)
    await expect(adapter.compensate(unownedPlan, () => undefined)).resolves.toBe(false)
  })
})
