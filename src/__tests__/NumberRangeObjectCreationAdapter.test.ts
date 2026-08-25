import { NumberRangeObjectCreationAdapter } from '../safe/adapters/NumberRangeObjectCreationAdapter'
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
    findCollectionByUrl: jest.fn(), validateControlledNumberRangeObject: jest.fn(), readControlledNumberRangeObjectSchema: jest.fn(),
    createControlledNumberRangeObjectShell: jest.fn(), readControlledNumberRangeObjectContent: jest.fn(), writeControlledNumberRangeObjectContent: jest.fn(),
    getDomainProperties: jest.fn(), getDataElementProperties: jest.fn()
  } as jest.Mocked<ControlledCreationAdtClient>
}

const schema = {
  properties: {
    formatVersion: {},
    header: { properties: { description: {}, originalLanguage: {}, abapLanguageVersion: { enum: ['standard', 'cloudDevelopment'] } } },
    interval: {
      properties: { numberLengthDomain: {}, percentWarning: {}, subType: {}, untilYear: {}, rolling: {}, prefix: {} },
      required: ['numberLengthDomain', 'percentWarning', 'untilYear', 'rolling', 'prefix']
    },
    configuration: {
      properties: { transactionId: {}, buffering: { enum: ['mainBuffer', 'parallel', 'none'] }, bufferedNumbers: {} },
      required: ['buffering', 'bufferedNumbers']
    }
  }
}

const content = {
  formatVersion: '1' as const,
  header: { description: 'MCP number range', originalLanguage: 'zh', abapLanguageVersion: 'standard' as const },
  interval: {
    numberLengthDomain: 'CHAR10', percentWarning: 10, subType: 'ZSUB',
    untilYear: false, rolling: true, prefix: true
  },
  configuration: { transactionId: 'SE38', buffering: 'mainBuffer' as const, bufferedNumbers: 10 }
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async (name, type) => {
    const objects: Record<string, { 'adtcore:name': string; 'adtcore:type': string; 'adtcore:uri': string }> = {
      'Z001|DEVC/K': { 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' },
      'CHAR10|DOMA/DD': { 'adtcore:name': 'CHAR10', 'adtcore:type': 'DOMA/DD', 'adtcore:uri': '/sap/bc/adt/ddic/domains/char10' },
      'ZSUB|DTEL/DE': { 'adtcore:name': 'ZSUB', 'adtcore:type': 'DTEL/DE', 'adtcore:uri': '/sap/bc/adt/ddic/dataelements/zsub' },
      'ZSUBDOM|DOMA/DD': { 'adtcore:name': 'ZSUBDOM', 'adtcore:type': 'DOMA/DD', 'adtcore:uri': '/sap/bc/adt/ddic/domains/zsubdom' },
      'SE38|TRAN/T': { 'adtcore:name': 'SE38', 'adtcore:type': 'TRAN/T', 'adtcore:uri': '/sap/bc/adt/repository/informationsystem/transactions/se38' }
    }
    return objects[`${name}|${type}`] ? [objects[`${name}|${type}`]] : []
  })
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateControlledNumberRangeObject as jest.Mock).mockResolvedValue({ success: true })
  ;(value.readControlledNumberRangeObjectSchema as jest.Mock).mockResolvedValue(schema)
  ;(value.findCollectionByUrl as jest.Mock).mockResolvedValue({ discoveryResult: { title: 'Number Ranges', collection: [] }, collection: {
    href: '/sap/bc/adt/numberranges/objects', title: 'Number Range Objects', acceptedContentTypes: ['application/vnd.sap.adt.blues.v1+xml'], templateLinks: []
  } })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.getDomainProperties as jest.Mock).mockImplementation(async (url: string) => url.endsWith('zsubdom')
    ? { metaData: { name: 'ZSUBDOM' }, properties: { typeInformation: { datatype: 'CHAR', length: 4 }, valueInformation: { valueTableRef: 'ZSUBTAB' } } }
    : { metaData: { name: 'CHAR10' }, properties: { typeInformation: { datatype: 'CHAR', length: 10 } } })
  ;(value.getDataElementProperties as jest.Mock).mockResolvedValue({
    metaData: { name: 'ZSUB' }, properties: { typeName: 'ZSUBDOM', dataType: 'CHAR', dataTypeLength: 4 }
  })
  ;(value.createControlledNumberRangeObjectShell as jest.Mock).mockResolvedValue({
    location: '/sap/bc/adt/numberranges/objects/zzmcpnr01', numberRangeObject: { name: 'ZZMCPNR01' }
  })
  const links = [{ href: './zzmcpnr01/source/main', rel: 'http://www.sap.com/adt/relations/source', type: 'application/json' }]
  value.objectStructure.mockImplementation(async (url, version) => url.includes('transactions')
    ? ({ objectUrl: url, metaData: { 'adtcore:name': 'SE38', 'adtcore:type': 'TRAN/T', 'adtcore:version': 'active' }, links: [] } as never)
    : ({
      objectUrl: '/sap/bc/adt/numberranges/objects/zzmcpnr01',
      metaData: { 'adtcore:name': 'ZZMCPNR01', 'adtcore:type': 'NROB/NRO', 'adtcore:version': version },
      links
    } as never))
  ;(value.readControlledNumberRangeObjectContent as jest.Mock).mockResolvedValue(content)
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  value.activate.mockResolvedValue({ success: true, messages: [] } as never)
  return value
}

function request(): Record<string, unknown> {
  return {
    objectKind: 'NUMBER_RANGE_OBJECT', name: 'ZZMCPNR01', description: 'MCP number range', packageName: 'Z001',
    numberLengthDomain: 'CHAR10', percentWarning: 10, subType: 'ZSUB', untilYear: false, rolling: true, prefix: true,
    transactionId: 'SE38', buffering: 'mainBuffer', bufferedNumbers: 10, transportRequest: 'S4HK900009'
  }
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

describe('NumberRangeObjectCreationAdapter', () => {
  it('freezes dependencies, writes JSON, activates, and verifies content', async () => {
    const value = configured()
    const adapter = new NumberRangeObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({
      actualResources: [{ type: 'NROB/NRO', name: 'ZZMCPNR01' }]
    })
    expect(value.writeControlledNumberRangeObjectContent).toHaveBeenCalledWith(
      expect.any(String), content, 'application/json', 'LOCK-1', 'S4HK900009'
    )
    expect(stages).toEqual([
      'REVALIDATE_ABSENCE', 'REVALIDATE_SCHEMA', 'REVALIDATE_REFERENCES', 'VALIDATE_TRANSPORT',
      'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_CONTENT', 'VERIFY_CONTENT',
      'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ])
  })

  it('rejects prefix mode without a subobject data element', async () => {
    const value = configured()
    await expect(new NumberRangeObjectCreationAdapter(value, policy).prepare({ ...request(), subType: undefined }))
      .rejects.toThrow('prefix=true')
    expect(value.searchObject).not.toHaveBeenCalled()
  })

  it('rejects DDIC dependency drift before creating the shell', async () => {
    const value = configured()
    const adapter = new NumberRangeObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    ;(value.getDomainProperties as jest.Mock).mockImplementation(async (url: string) => url.endsWith('zsubdom')
      ? { metaData: { name: 'ZSUBDOM' }, properties: { typeInformation: { datatype: 'CHAR', length: 4 }, valueInformation: { valueTableRef: 'ZSUBTAB' } } }
      : { metaData: { name: 'CHAR10' }, properties: { typeInformation: { datatype: 'CHAR', length: 11 } } })
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('dependency changed')
    expect(value.createControlledNumberRangeObjectShell).not.toHaveBeenCalled()
  })

  it('stops as unknown when the JSON write result is uncertain', async () => {
    const value = configured()
    ;(value.writeControlledNumberRangeObjectContent as jest.Mock).mockRejectedValue(new Error('connection lost'))
    const adapter = new NumberRangeObjectCreationAdapter(value, policy)
    const prepared = await adapter.prepare(request())
    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toBeInstanceOf(Error)
    expect(value.deleteObject).not.toHaveBeenCalled()
  })
})
