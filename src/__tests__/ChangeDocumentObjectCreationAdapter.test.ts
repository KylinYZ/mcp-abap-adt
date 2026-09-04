import { ChangeDocumentObjectCreationAdapter } from '../safe/adapters/ChangeDocumentObjectCreationAdapter'
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
      formatVersion: {},
      header: { properties: { description: {}, originalLanguage: {}, abapLanguageVersion: { enum: ['standard', 'cloudDevelopment'] } } },
      generalInformation: { properties: { category: { enum: ['standard', 'behaviorDefiniton'] }, generatedObject: {} } },
      tablesAndStructures: {
        items: {
          properties: {
            name: {}, referenceTable: {}, multipleChanges: {},
            databaseInsertions: { properties: { logValues: {}, logInitialValues: {} } },
            databaseDeletions: { properties: { logValues: {}, logInitialValues: {} } }
          }
        }
      },
      errorMessage: { properties: { id: {}, number: {} } }
    },
    required: ['formatVersion', 'header', 'tablesAndStructures', 'errorMessage']
  },
  configuration: {
    properties: {
      generalInformation: { properties: { generatedObject: { 'sap.adt.types': ['CLAS', 'FUNC'] } } },
      tablesAndStructures: { items: { properties: { name: { 'sap.adt.types': ['TABL'] }, referenceTable: { 'sap.adt.types': ['TABL'] } } } },
      errorMessage: { 'sap.adt.hidden': true, properties: { id: { 'sap.adt.types': ['MSAG'] } } }
    }
  }
}

const workingContent = {
  formatVersion: '1' as const,
  header: { description: 'MCP change document', originalLanguage: 'zh', abapLanguageVersion: 'standard' as const },
  generalInformation: { category: 'standard' as const },
  tablesAndStructures: [{
    name: 'ZZIF_MCP_TEST', referenceTable: '', multipleChanges: true,
    databaseInsertions: { logValues: false, logInitialValues: false },
    databaseDeletions: { logValues: false, logInitialValues: false }
  }],
  errorMessage: { id: 'CD', number: '600' }
}

function client(): jest.Mocked<ControlledCreationAdtClient> {
  return {
    searchObject: jest.fn(),
    objectStructure: jest.fn(),
    readControlledPackage: jest.fn(),
    validateControlledChangeDocumentObject: jest.fn(),
    readControlledChangeDocumentObjectContract: jest.fn(),
    findCollectionByUrl: jest.fn(),
    transportInfo: jest.fn(),
    transportDetails: jest.fn(),
    createControlledChangeDocumentObjectShell: jest.fn(),
    readControlledChangeDocumentObjectContent: jest.fn(),
    writeControlledChangeDocumentObjectContent: jest.fn(),
    lock: jest.fn(),
    unLock: jest.fn(),
    activate: jest.fn(),
    deleteObject: jest.fn()
  } as unknown as jest.Mocked<ControlledCreationAdtClient>
}

function configured(category: 'standard' | 'behaviorDefinition' = 'standard'): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async (name, type) => {
    if (name === 'Z001' && type === 'DEVC/K') {
      return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    }
    if (name === 'ZZIF_MCP_TEST' && type === 'TABL') {
      return [{ 'adtcore:name': name, 'adtcore:type': 'TABL/DT', 'adtcore:uri': '/sap/bc/adt/ddic/tables/zzif_mcp_test' }]
    }
    if (name === 'CD' && type === 'MSAG/N') {
      return [{ 'adtcore:name': name, 'adtcore:type': 'MSAG/N', 'adtcore:uri': '/sap/bc/adt/messageclass/cd' }]
    }
    if (name === 'ZCL_ZZMCPCHDO_CHDO' && type === 'CLAS/OC') {
      return [{ 'adtcore:name': name, 'adtcore:type': 'CLAS/OC', 'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_zzmcpchdo_chdo' }]
    }
    if (name === 'CL_ZZMCPCHDO_CHDO' && type === 'CLAS/OC') {
      return [{ 'adtcore:name': name, 'adtcore:type': 'CLAS/OC', 'adtcore:uri': '/sap/bc/adt/oo/classes/cl_zzmcpchdo_chdo' }]
    }
    return []
  })
  value.objectStructure.mockImplementation((async (
    url: string,
    version?: 'active' | 'inactive' | 'workingArea'
  ) => {
    if (url.includes('/ddic/tables/')) return structure(url, 'ZZIF_MCP_TEST', 'TABL/DT', 'active')
    if (url.includes('/messageclass/')) return structure(url, 'CD', 'MSAG/N', 'active')
    if (url.includes('/zcl_zzmcpchdo_chdo')) return structure(url, 'ZCL_ZZMCPCHDO_CHDO', 'CLAS/OC', 'active')
    if (url.includes('/oo/classes/')) return structure(url, 'CL_ZZMCPCHDO_CHDO', 'CLAS/OC', 'active')
    return {
      ...structure(url, 'ZZMCPCHDO', 'CHDO/CHD', version || 'inactive'),
      links: [{
        href: './zzmcpchdo/source/main',
        rel: 'http://www.sap.com/adt/relations/source',
        type: 'application/json'
      }]
    } as never
  }) as never)
  value.readControlledPackage.mockResolvedValue({
    name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  })
  ;(value.validateControlledChangeDocumentObject as jest.Mock).mockResolvedValue({ success: true })
  ;(value.readControlledChangeDocumentObjectContract as jest.Mock).mockResolvedValue(contract)
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({
    discoveryResult: { title: 'Change Documents', collection: [] },
    collection: {
      href: '/sap/bc/adt/changedocuments/objects',
      title: 'Change Documents',
      acceptedContentTypes: ['application/vnd.sap.adt.blues.v1+xml', 'text/html'],
      templateLinks: []
    }
  })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createControlledChangeDocumentObjectShell as jest.Mock).mockResolvedValue({
    location: '/sap/bc/adt/changedocuments/objects/zzmcpchdo',
    changeDocumentObject: { name: 'ZZMCPCHDO', packageName: 'Z001', version: 'inactive' }
  })
  ;(value.readControlledChangeDocumentObjectContent as jest.Mock).mockImplementation(
    async (_url, _type, version) => version === 'active'
      ? {
          ...workingContent,
          generalInformation: {
            generatedObject: category === 'behaviorDefinition' ? 'CL_ZZMCPCHDO_CHDO' : 'ZCL_ZZMCPCHDO_CHDO'
          }
        }
      : {
          ...workingContent,
          generalInformation: category === 'behaviorDefinition' ? { category: 'behaviorDefiniton' } : {}
        }
  )
  ;(value.writeControlledChangeDocumentObjectContent as jest.Mock).mockImplementation(async (_url, content) => content)
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  value.activate.mockResolvedValue({ success: true, messages: [] } as never)
  return value
}

function structure(url: string, name: string, type: string, version: string) {
  return {
    objectUrl: url,
    metaData: { 'adtcore:name': name, 'adtcore:type': type, 'adtcore:version': version },
    links: []
  }
}

function request(category: 'standard' | 'behaviorDefinition' = 'standard'): Record<string, unknown> {
  return {
    objectKind: 'CHANGE_DOCUMENT_OBJECT',
    name: 'ZZMCPCHDO',
    description: 'MCP change document',
    packageName: 'Z001',
    category,
    tablesAndStructures: [{ name: 'ZZIF_MCP_TEST', multipleChanges: true }],
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

describe('ChangeDocumentObjectCreationAdapter', () => {
  it('freezes references, creates once, and verifies the generated Class', async () => {
    const value = configured()
    const adapter = new ChangeDocumentObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [
        { type: 'CHDO/CHD', name: 'ZZMCPCHDO' },
        { type: 'CLAS/OC', name: 'ZCL_ZZMCPCHDO_CHDO' }
      ]
    })
    expect(value.createControlledChangeDocumentObjectShell).toHaveBeenCalledTimes(1)
    expect(value.writeControlledChangeDocumentObjectContent).toHaveBeenCalledWith(
      '/sap/bc/adt/changedocuments/objects/zzmcpchdo/source/main',
      expect.objectContaining({ generalInformation: { category: 'standard' } }),
      'application/json', 'LOCK-1', 'S4HK900009'
    )
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCES', 'REVALIDATE_CONTRACT', 'VALIDATE_TRANSPORT',
      'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_CONTENT', 'VERIFY_CONTENT',
      'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_GENERATED_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ])
  })

  it('maps behaviorDefinition and requires an active generated Class', async () => {
    const value = configured('behaviorDefinition')
    const adapter = new ChangeDocumentObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request('behaviorDefinition'))
    expect(prepared.review).toMatchObject({ category: 'behaviorDefinition' })
    await expect(adapter.execute(plan(prepared), () => undefined)).resolves.toMatchObject({
      actualResources: expect.arrayContaining([{ type: 'CLAS/OC', name: 'CL_ZZMCPCHDO_CHDO' }])
    })
    expect(value.writeControlledChangeDocumentObjectContent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ generalInformation: { category: 'behaviorDefiniton' } }),
      'application/json', 'LOCK-1', 'S4HK900009'
    )
  })

  it('rejects unsafe names and inconsistent logging before SAP calls', async () => {
    const longNameClient = configured()
    await expect(new ChangeDocumentObjectCreationAdapter(longNameClient, policy).prepare({
      ...request(), name: 'ZZMCPCHDO_TOO_LONG'
    })).rejects.toThrow('bounded line')
    expect(longNameClient.searchObject).not.toHaveBeenCalled()

    const loggingClient = configured()
    await expect(new ChangeDocumentObjectCreationAdapter(loggingClient, policy).prepare({
      ...request(),
      tablesAndStructures: [{
        name: 'ZZIF_MCP_TEST',
        databaseInsertions: { logInitialValues: true }
      }]
    })).rejects.toThrow('requires logValues=true')
    expect(loggingClient.searchObject).not.toHaveBeenCalled()

    const hiddenDefaultClient = configured()
    await expect(new ChangeDocumentObjectCreationAdapter(hiddenDefaultClient, policy).prepare({
      ...request(), errorMessage: { id: 'CD', number: '600' }
    })).rejects.toThrow('hidden server-owned')
    expect(hiddenDefaultClient.searchObject).not.toHaveBeenCalled()
  })

  it('rejects reference or contract drift before shell creation', async () => {
    const referenceClient = configured()
    const referenceAdapter = new ChangeDocumentObjectCreationAdapter(referenceClient, policy)
    const referencePrepared = await referenceAdapter.prepare(request())
    referenceClient.objectStructure.mockImplementation((async (url: string) => {
      if (url.includes('/ddic/tables/')) return structure(url, 'ZZIF_MCP_TEST', 'TABL/DT', 'inactive')
      if (url.includes('/messageclass/')) return structure(url, 'CD', 'MSAG/N', 'active')
      return structure(url, 'ZZMCPCHDO', 'CHDO/CHD', 'inactive')
    }) as never)
    await expect(referenceAdapter.execute(plan(referencePrepared), () => undefined)).rejects.toThrow('not the expected active')
    expect(referenceClient.createControlledChangeDocumentObjectShell).not.toHaveBeenCalled()

    const contractClient = configured()
    const contractAdapter = new ChangeDocumentObjectCreationAdapter(contractClient, policy)
    const contractPrepared = await contractAdapter.prepare(request())
    ;(contractClient.readControlledChangeDocumentObjectContract as jest.Mock).mockResolvedValue({
      ...contract,
      schema: { ...contract.schema, title: 'changed' }
    })
    await expect(contractAdapter.execute(plan(contractPrepared), () => undefined)).rejects.toThrow('changed after preview')
    expect(contractClient.createControlledChangeDocumentObjectShell).not.toHaveBeenCalled()
  })

  it('reports only structural metadata when working content differs', async () => {
    const value = configured()
    ;(value.readControlledChangeDocumentObjectContent as jest.Mock).mockResolvedValue({
      ...workingContent,
      generalInformation: {},
      errorMessage: { id: 'OTHER', number: '600' }
    })
    const adapter = new ChangeDocumentObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toThrow(
      /at \$\.errorMessage\.id; expectedKind=string, actualKind=string, expectedHash=[a-f0-9]{64}, actualHash=[a-f0-9]{64}, expectedBytes=\d+, actualBytes=\d+\./
    )
  })

  it('classifies activation and generated-object verification failures as unknown without deletion', async () => {
    const activationClient = configured()
    activationClient.activate.mockRejectedValue(new Error('connection lost'))
    const activationAdapter = new ChangeDocumentObjectCreationAdapter(activationClient, policy)
    const activationPrepared = await activationAdapter.prepare(request())
    await expect(activationAdapter.execute(plan(activationPrepared), () => undefined))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(activationClient.deleteObject).not.toHaveBeenCalled()

    const generatedClient = configured()
    generatedClient.searchObject.mockImplementation(async (name, type) => {
      if (name === 'Z001' && type === 'DEVC/K') return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
      if (name === 'ZZIF_MCP_TEST' && type === 'TABL') return [{ 'adtcore:name': name, 'adtcore:type': 'TABL/DT', 'adtcore:uri': '/sap/bc/adt/ddic/tables/zzif_mcp_test' }]
      if (name === 'CD' && type === 'MSAG/N') return [{ 'adtcore:name': name, 'adtcore:type': 'MSAG/N', 'adtcore:uri': '/sap/bc/adt/messageclass/cd' }]
      return []
    })
    const generatedAdapter = new ChangeDocumentObjectCreationAdapter(generatedClient, policy)
    const generatedPrepared = await generatedAdapter.prepare(request())
    await expect(generatedAdapter.execute(plan(generatedPrepared), () => undefined))
      .rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(generatedClient.deleteObject).not.toHaveBeenCalled()
  })

  it('compensates only an inactive CHDO recorded as owned by the current plan', async () => {
    const value = configured()
    const adapter = new ChangeDocumentObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const ownedPlan = plan(prepared)
    ownedPlan.actualResources = [{ type: 'CHDO/CHD', name: 'ZZMCPCHDO' }]
    await expect(adapter.compensate(ownedPlan, () => undefined)).resolves.toBe(true)
    expect(value.deleteObject).toHaveBeenCalledWith(
      '/sap/bc/adt/changedocuments/objects/zzmcpchdo', 'LOCK-1', 'S4HK900009'
    )

    const unownedPlan = plan(prepared)
    await expect(adapter.compensate(unownedPlan, () => undefined)).resolves.toBe(false)
  })
})
