import { DatabaseTableCreationAdapter } from '../safe/adapters/DatabaseTableCreationAdapter'
import { PackageCreationAdapter } from '../safe/adapters/PackageCreationAdapter'
import type { ControlledCreationAdtClient } from '../safe/adapters/controlledCreationTools'
import { RepositoryCreationOutcomeUnknownError } from '../safe/RepositoryObjectCreationWorkflow'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'
import { SafetyPolicy } from '../safe/SafetyPolicy'

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.test', sapClient: '300', sapUser: '068157', systemRole: 'DEV',
  allowedHosts: 'dev.example.test', allowedClients: '300', allowedNamespaces: 'Z',
  auditPath: './audit', toolProfile: 'development'
})

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

function transportable(client: jest.Mocked<ControlledCreationAdtClient>): void {
  client.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  client.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return {
    creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING',
    context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' },
    target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary,
    payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits
  }
}

describe('controlled repository creation adapters', () => {
  it('prepares and executes a package using parent-package identity instead of hard-coded values', async () => {
    const client = baseClient()
    client.searchObject.mockImplementation(async name => name === 'ZPARENT' ? [{
      'adtcore:name': 'ZPARENT', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/zparent'
    }] : [])
    client.readControlledPackage.mockImplementation(async name => name === 'ZPARENT' ? {
      name, language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
    } : {
      name, description: 'Child', parentPackageName: 'ZPARENT', softwareComponent: 'HOME', transportLayer: 'SAP',
      packageType: 'development', isEncapsulated: true, recordChanges: true
    })
    client.validateControlledPackage.mockResolvedValue({ success: true })
    client.getControlledPackageConstraints.mockResolvedValue('<constraints/>')
    client.createControlledPackage.mockResolvedValue({
      location: '/sap/bc/adt/packages/zchild', package: { name: 'ZCHILD' }
    })
    transportable(client)
    const adapter = new PackageCreationAdapter(client, policy)
    const prepared = await adapter.prepare({
      name: 'ZCHILD', description: 'Child', parentPackageName: 'ZPARENT', softwareComponent: 'HOME',
      transportLayer: 'SAP', transportRequest: 'S4HK900009'
    })
    expect(client.createControlledPackage).not.toHaveBeenCalled()
    expect(prepared.payload).toMatchObject({ input: { language: 'ZH', masterSystem: 'S4H', responsible: '068157' } })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: 'DEVC/K', name: 'ZCHILD' }]
    })
    expect(client.createControlledPackage).toHaveBeenCalledTimes(1)
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'VERIFY_PROPERTIES'])
  })

  it('uses the authenticated user when the parent exposes responsible SAP and validates it remotely', async () => {
    const client = baseClient()
    client.searchObject.mockImplementation(async name => name === 'ZPARENT' ? [{
      'adtcore:name': 'ZPARENT', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/zparent'
    }] : [])
    client.readControlledPackage.mockResolvedValue({
      name: 'ZPARENT', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: 'SAP'
    })
    client.validateControlledPackage.mockResolvedValue({ success: true })
    client.getControlledPackageConstraints.mockResolvedValue('<constraints/>')
    transportable(client)
    const adapter = new PackageCreationAdapter(client, policy)
    await expect(adapter.prepare({
      name: 'ZCHILD', description: 'Child', parentPackageName: 'ZPARENT', softwareComponent: 'HOME',
      transportLayer: 'SAP', transportRequest: 'S4HK900009'
    })).resolves.toMatchObject({
      payload: { input: { responsible: '068157' } },
      review: { responsible: '068157', responsibleSource: 'CURRENT_AUTHENTICATED_USER' }
    })
    expect(client.validateControlledPackage).toHaveBeenCalledTimes(2)
    expect(client.validateControlledPackage).toHaveBeenCalledWith(expect.objectContaining({ responsible: '068157' }), 'basic')
    expect(client.validateControlledPackage).toHaveBeenCalledWith(expect.objectContaining({ responsible: '068157' }), 'full')
  })

  it('executes the complete table source and technical-settings chain', async () => {
    const client = tableClient()
    const adapter = new DatabaseTableCreationAdapter(client, policy)
    const prepared = await adapter.prepare({
      objectKind: 'DATABASE_TABLE', name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001',
      transportRequest: 'S4HK900009', fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'CURRENCY', type: 'WAERS' },
        { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' }
      ]
    })
    expect(client.createControlledTableShell).not.toHaveBeenCalled()
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: 'TABL/DT', name: 'ZZIF_MCP_TEST' }, { type: 'TABL/DTT', name: 'ZZIF_MCP_TEST' }]
    })
    expect(client.runControlledTableCheck.mock.calls.map(call => [call[1], call[2] === undefined])).toEqual([
      ['tableStatusCheck', false], ['abapCheckRun', false], ['tableStatusCheck', true]
    ])
    expect(client.activateControlledTable.mock.invocationCallOrder[0]).toBeLessThan(
      client.readControlledTableSource.mock.invocationCallOrder[0]
    )
    expect(client.activateControlledTableSettings).toHaveBeenCalledTimes(1)
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT',
      'LOCK_RESOURCE', 'RUN_CHECKS', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE',
      'ACTIVATE_OBJECT', 'VERIFY_SOURCE', 'LOCK_RESOURCE', 'WRITE_TECHNICAL_SETTINGS',
      'UNLOCK_RESOURCE', 'ACTIVATE_RESOURCE', 'VERIFY_TECHNICAL_SETTINGS'
    ])
  })

  it('accepts SAP field alignment and CRLF without weakening table DDL verification', async () => {
    const client = tableClient()
    client.readControlledTableSource.mockImplementation(async (_name, version) => version === 'active'
      ? "@EndUserText.label : 'MCP测试表'\r\n@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\r\n@AbapCatalog.tableCategory : #TRANSPARENT\r\n@AbapCatalog.deliveryClass : #A\r\n@AbapCatalog.dataMaintenance : #RESTRICTED\r\ndefine table zzif_mcp_test {\r\n\r\n  key client    : abap.clnt not null;\r\n      currency  : waers;\r\n  @Semantics.amount.currencyCode : 'zzif_mcp_test.currency'\r\n      amount    : abap.curr(15,2);\r\n}\r\n"
      : '')
    const adapter = new DatabaseTableCreationAdapter(client, policy)
    const prepared = await adapter.prepare({
      name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001', transportRequest: 'S4HK900009',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'CURRENCY', type: 'WAERS' },
        { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' }
      ]
    })

    await expect(adapter.execute(plan(prepared), jest.fn())).resolves.toMatchObject({
      actualResources: [{ type: 'TABL/DT', name: 'ZZIF_MCP_TEST' }, { type: 'TABL/DTT', name: 'ZZIF_MCP_TEST' }]
    })
  })

  it.each([
    ['field type', 'abap.curr(15,2)', 'abap.curr(16,2)'],
    ['key marker', 'key client', 'client'],
    ['annotation value', '#TRANSPARENT', '#GLOBAL_TEMPORARY'],
    ['string literal', "'zzif_mcp_test.currency'", "'zzif_mcp_test.client'"],
    ['identifier boundary', 'define table', 'definetable']
  ])('rejects an active table DDL with a changed %s', async (_label, expectedFragment, actualFragment) => {
    const client = tableClient()
    const activeSource = await client.readControlledTableSource('ZZIF_MCP_TEST', 'active')
    client.readControlledTableSource.mockImplementation(async (_name, version) => version === 'active'
      ? activeSource.replace(expectedFragment, actualFragment)
      : '')
    const adapter = new DatabaseTableCreationAdapter(client, policy)
    const prepared = await adapter.prepare({
      name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001', transportRequest: 'S4HK900009',
      fields: [
        { name: 'CLIENT', key: true, type: 'CLNT' },
        { name: 'CURRENCY', type: 'WAERS' },
        { name: 'AMOUNT', type: 'CURR', length: 15, decimals: 2, referenceField: 'CURRENCY' }
      ]
    })

    const verificationMessages: string[] = []
    await expect(adapter.execute(plan(prepared), (stage, success, message) => {
      if (stage === 'VERIFY_SOURCE' && !success && message) verificationMessages.push(message)
    })).rejects.toThrow(
      'Active source for ZZIF_MCP_TEST does not match the confirmed plan.'
    )
    const diagnostics = JSON.parse(verificationMessages[0])
    expect(diagnostics).toEqual(expect.objectContaining({
      expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      actualHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedTokenCount: expect.any(Number), actualTokenCount: expect.any(Number),
      firstMismatchIndex: expect.any(Number), expectedTokenKind: expect.any(String), actualTokenKind: expect.any(String)
    }))
    expect(verificationMessages[0]).not.toContain(expectedFragment)
    expect(verificationMessages[0]).not.toContain(actualFragment)
    expect(client.writeControlledTableSettings).not.toHaveBeenCalled()
  })

  it('marks a source-write exception unknown, unlocks, and never activates or deletes', async () => {
    const client = tableClient()
    client.writeControlledTableSource.mockRejectedValue(new Error('socket reset'))
    const adapter = new DatabaseTableCreationAdapter(client, policy)
    const prepared = await adapter.prepare({
      name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001', transportRequest: 'S4HK900009',
      fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }]
    })
    await expect(adapter.execute(plan(prepared), jest.fn())).rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(client.unLock).toHaveBeenCalledTimes(1)
    expect(client.activateControlledTable).not.toHaveBeenCalled()
    expect(client.deleteObject).not.toHaveBeenCalled()
  })

  it('compensates only a table recorded as owned by the current plan', async () => {
    const client = tableClient()
    const adapter = new DatabaseTableCreationAdapter(client, policy)
    const prepared = await adapter.prepare({
      name: 'ZZIF_MCP_TEST', description: 'MCP测试表', packageName: 'Z001', transportRequest: 'S4HK900009',
      fields: [{ name: 'CLIENT', key: true, type: 'CLNT' }]
    })
    const owned = plan(prepared)
    owned.actualResources = [{ type: 'TABL/DT', name: 'ZZIF_MCP_TEST' }]
    await expect(adapter.compensate!(owned, jest.fn())).resolves.toBe(true)
    expect(client.deleteObject).toHaveBeenCalledWith(
      '/sap/bc/adt/ddic/tables/zzif_mcp_test', 'LOCK-1', 'S4HK900009'
    )
    const unowned = plan(prepared)
    await expect(adapter.compensate!(unowned, jest.fn())).resolves.toBe(false)
    expect(client.deleteObject).toHaveBeenCalledTimes(1)
  })
})

function tableClient(): jest.Mocked<ControlledCreationAdtClient> {
  const client = baseClient()
  client.searchObject.mockImplementation(async name => name === 'Z001' ? [{
    'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001'
  }] : [])
  client.readControlledPackage.mockResolvedValue({
    name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157'
  })
  client.validateControlledTableShell.mockResolvedValue({ success: true })
  transportable(client)
  client.createControlledTableShell.mockResolvedValue({
    location: '/sap/bc/adt/ddic/tables/zzif_mcp_test',
    table: { name: 'ZZIF_MCP_TEST', packageName: 'Z001', version: 'inactive' }
  })
  client.readControlledTable.mockResolvedValue({ name: 'ZZIF_MCP_TEST', packageName: 'Z001', version: 'inactive' })
  client.runControlledTableCheck.mockResolvedValue([])
  client.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  client.unLock.mockResolvedValue('')
  client.activateControlledTable.mockResolvedValue({ success: true, messages: [], inactive: [] })
  client.readControlledTableSource.mockImplementation(async (_name, version) => version === 'active'
    ? "@EndUserText.label : 'MCP测试表'\n@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n@AbapCatalog.tableCategory : #TRANSPARENT\n@AbapCatalog.deliveryClass : #A\n@AbapCatalog.dataMaintenance : #RESTRICTED\ndefine table zzif_mcp_test {\n\n  key client : abap.clnt not null;\n  currency : waers;\n  @Semantics.amount.currencyCode : 'zzif_mcp_test.currency'\n  amount : abap.curr(15,2);\n}\n"
    : '')
  const settings = {
    name: 'ZZIF_MCP_TEST', description: 'MCP测试表', language: 'ZH', version: 'active',
    changedAt: '2026-08-19T06:08:10Z', changedBy: '068157', createdAt: '2026-08-19T03:46:03Z', createdBy: '068157',
    dataClass: 'APPL1' as const, sizeCategory: 0, buffering: 'NOT_ALLOWED' as const, storageType: 'C' as const, loggingEnabled: false
  }
  client.readControlledTableSettings.mockResolvedValue(settings)
  client.writeControlledTableSettings.mockResolvedValue(settings)
  client.activateControlledTableSettings.mockResolvedValue({ success: true, messages: [], inactive: [] })
  return client
}
