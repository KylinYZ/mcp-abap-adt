import { DataElementCreationAdapter, DomainCreationAdapter } from '../safe/adapters/DdicPrimitiveCreationAdapter'
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
    readControlledPackage: jest.fn(), objectStructure: jest.fn(), activate: jest.fn(),
    lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn(),
    validateNewObject: jest.fn(), createObject: jest.fn(),
    getDomainProperties: jest.fn(), setDomainProperties: jest.fn(),
    getDataElementProperties: jest.fn(), setDataElementProperties: jest.fn()
  } as unknown as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  value.searchObject.mockImplementation(async (name, type) => {
    if (name === 'Z001') return [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    if (type === 'DOMA/DD' || type === 'DTEL/DE') return []
    return []
  })
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateNewObject as jest.Mock).mockResolvedValue({ success: true })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  value.objectStructure.mockImplementation(async url => ({ objectUrl: url, metaData: { 'adtcore:name': url.split('/').pop()!.toUpperCase(), 'adtcore:type': url.includes('/domains/') ? 'DOMA/DD' : 'DTEL/DE' }, links: [] } as never))
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  value.activate.mockResolvedValue({ success: true, messages: [], inactive: [] } as never)
  return value
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

const domainProperties = {
  typeInformation: { datatype: 'CHAR', length: 10, decimals: 0 },
  outputInformation: { length: 10, signExists: false, lowercase: false, ampmFormat: false }
}

const dataElementProperties = {
  typeName: '', dataType: 'CHAR', dataTypeLength: 10, dataTypeDecimals: 0,
  fieldLabels: { shortFieldLabel: 'Short', mediumFieldLabel: 'Medium', longFieldLabel: 'Long', headingFieldLabel: 'Heading' }
}

describe('DdicPrimitiveCreationAdapter', () => {
  it('creates and verifies a DDIC domain through the property contract', async () => {
    const value = configured()
    ;(value.getDomainProperties as jest.Mock).mockResolvedValue({
      metaData: { name: 'ZDOMAIN' } as never,
      properties: { ...domainProperties, valueInformation: { valueTableRef: '', appendExists: false } }
    })
    const adapter = new DomainCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'DDIC_DOMAIN', name: 'ZDOMAIN', description: 'Domain', packageName: 'Z001', transportRequest: 'S4HK900009', properties: domainProperties })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'DOMA/DD', name: 'ZDOMAIN' }] })
    expect(value.createObject).toHaveBeenCalledWith(expect.objectContaining({ objtype: 'DOMA/DD', name: 'ZDOMAIN', contentType: 'application/*' }))
    expect(value.setDomainProperties).toHaveBeenCalledWith(expect.stringContaining('/sap/bc/adt/ddic/domains/zdomain'), domainProperties, expect.objectContaining({ packageName: 'Z001' }), 'LOCK-1', 'S4HK900009')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_PROPERTIES', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_PROPERTIES'])
  })

  it('does not ignore non-empty SAP domain value defaults during verification', async () => {
    const value = configured()
    ;(value.getDomainProperties as jest.Mock).mockResolvedValue({
      metaData: { name: 'ZDOMAIN' } as never,
      properties: { ...domainProperties, valueInformation: { valueTableRef: 'ZVALUES', appendExists: false } }
    })
    const adapter = new DomainCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'DDIC_DOMAIN', name: 'ZDOMAIN', description: 'Domain', packageName: 'Z001', transportRequest: 'S4HK900009', properties: domainProperties })

    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('Activated DDIC properties do not match the confirmed plan.')
  })

  it('creates and verifies a DDIC data element with bounded labels', async () => {
    const value = configured()
    ;(value.getDataElementProperties as jest.Mock).mockResolvedValue({
      metaData: { name: 'ZDATA' } as never,
      properties: {
        ...dataElementProperties,
        fieldLabels: {
          ...dataElementProperties.fieldLabels,
          shortFieldLength: 10,
          mediumFieldLength: 20,
          longFieldLength: 40,
          headingFieldLength: 55
        },
        deactivateInputHistory: false,
        changeDocument: false,
        leftToRightDirection: false,
        deactivateBIDIFiltering: false
      }
    })
    const adapter = new DataElementCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'DATA_ELEMENT', name: 'ZDATA', description: 'Data element', packageName: 'Z001', transportRequest: 'S4HK900009', properties: dataElementProperties })
    await expect(adapter.execute(plan(prepared), () => undefined)).resolves.toMatchObject({ actualResources: [{ type: 'DTEL/DE', name: 'ZDATA' }] })
    expect(value.setDataElementProperties).toHaveBeenCalledWith(expect.stringContaining('/sap/bc/adt/ddic/dataelements/zdata'), dataElementProperties, expect.objectContaining({ packageName: 'Z001' }), 'LOCK-1', 'S4HK900009')
  })

  it('does not ignore non-default SAP data element flags during verification', async () => {
    const value = configured()
    ;(value.getDataElementProperties as jest.Mock).mockResolvedValue({
      metaData: { name: 'ZDATA' } as never,
      properties: { ...dataElementProperties, changeDocument: true }
    })
    const adapter = new DataElementCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'DATA_ELEMENT', name: 'ZDATA', description: 'Data element', packageName: 'Z001', transportRequest: 'S4HK900009', properties: dataElementProperties })

    await expect(adapter.execute(plan(prepared), () => undefined)).rejects.toThrow('Activated DDIC properties do not match the confirmed plan.')
  })

  it('requires an explicitly referenced domain to exist', async () => {
    const value = configured()
    await expect(new DataElementCreationAdapter(value, policy).prepare({
      objectKind: 'DATA_ELEMENT', name: 'ZDATA', description: 'Data element', packageName: 'Z001', transportRequest: 'S4HK900009',
      properties: { ...dataElementProperties, typeName: 'ZNO_DOMAIN' }
    })).rejects.toThrow('Referenced domain ZNO_DOMAIN was not found.')
    expect(value.validateNewObject).not.toHaveBeenCalled()
  })
})
