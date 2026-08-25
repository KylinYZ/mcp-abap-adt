import { MessageClassCreationAdapter } from '../safe/adapters/MessageClassCreationAdapter'
import type { ControlledCreationAdtClient } from '../safe/adapters/controlledCreationTools'
import { RepositoryCreationOutcomeUnknownError } from '../safe/RepositoryObjectCreationWorkflow'
import type { PreparedRepositoryCreation, RepositoryCreationPlan } from '../safe/repositoryCreationTypes'
import { SafetyPolicy } from '../safe/SafetyPolicy'

const policy = new SafetyPolicy({
  sapUrl: 'https://dev.example.test', sapClient: '300', sapUser: '068157', systemRole: 'DEV',
  allowedHosts: 'dev.example.test', allowedClients: '300', allowedNamespaces: 'Z', auditPath: './audit', toolProfile: 'development'
})

function client(): jest.Mocked<ControlledCreationAdtClient> {
  return {
    searchObject: jest.fn(), transportInfo: jest.fn(), transportDetails: jest.fn(), readControlledPackage: jest.fn(),
    validateNewObject: jest.fn(), createObject: jest.fn(), createObjectStateless: jest.fn(), objectStructure: jest.fn(), getObjectSource: jest.fn(), setObjectSource: jest.fn(),
    activate: jest.fn(), lock: jest.fn(), unLock: jest.fn(), deleteObject: jest.fn()
  } as unknown as jest.Mocked<ControlledCreationAdtClient>
}

function configured(): jest.Mocked<ControlledCreationAdtClient> {
  const value = client()
  let source = '<?xml version="1.0"?><mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZMSG"><adtcore:packageRef adtcore:name="Z001"/></mc:messageClass>'
  value.searchObject.mockImplementation(async name => name === 'Z001'
    ? [{ 'adtcore:name': 'Z001', 'adtcore:type': 'DEVC/K', 'adtcore:uri': '/sap/bc/adt/packages/z001' }]
    : [])
  value.readControlledPackage.mockResolvedValue({ name: 'Z001', language: 'ZH', masterLanguage: 'ZH', masterSystem: 'S4H', responsible: '068157' })
  ;(value.validateNewObject as jest.Mock).mockResolvedValue({ success: true })
  value.transportInfo.mockResolvedValue({ TRANSPORTS: [{ TRKORR: 'S4HK900009' }] } as never)
  value.transportDetails.mockResolvedValue({ 'tm:status': 'D' } as never)
  ;(value.createObjectStateless as jest.Mock).mockResolvedValue(undefined)
  value.objectStructure.mockImplementation(async url => ({ objectUrl: url, metaData: { 'adtcore:name': 'ZMSG', 'adtcore:type': 'MSAG/N' }, links: [] } as never))
  value.getObjectSource.mockImplementation(async () => source)
  value.setObjectSource.mockImplementation(async (_url, nextSource) => { source = nextSource })
  value.lock.mockResolvedValue({ LOCK_HANDLE: 'LOCK-1' } as never)
  value.unLock.mockResolvedValue('')
  value.activate.mockResolvedValue({ success: true, messages: [], inactive: [] } as never)
  return value
}

function plan(prepared: PreparedRepositoryCreation): RepositoryCreationPlan {
  return { creationPlanId: 'plan-1', createdAt: 1, expiresAt: 2, status: 'APPLYING', context: { systemHost: 'dev.example.test', client: '300', sapUser: '068157', systemRole: 'DEV', toolProfile: 'development' }, target: prepared.target, transportRequest: prepared.transportRequest, summary: prepared.summary, payloadHash: 'hash', payloadBytes: 1, payload: prepared.payload, stages: [], compensationLimits: prepared.compensationLimits }
}

describe('MessageClassCreationAdapter', () => {
  it('creates a shell, writes bounded message XML, activates, and verifies active content', async () => {
    const value = configured()
    const adapter = new MessageClassCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009', messages: [{ number: '001', text: 'Hello "SAP" & users' }] })
    const stages: string[] = []
    await expect(adapter.execute(plan(prepared), stage => stages.push(stage))).resolves.toMatchObject({ actualResources: [{ type: 'MSAG/N', name: 'ZMSG' }] })
    expect(value.createObjectStateless).toHaveBeenCalledWith(expect.objectContaining({ objtype: 'MSAG/N', contentType: 'application/*' }))
    expect(value.createObject).not.toHaveBeenCalled()
    expect(value.setObjectSource).toHaveBeenCalledWith(expect.stringContaining('/sap/bc/adt/messageclass/zmsg'), expect.stringContaining('mc:msgno="001" mc:msgtext="Hello &quot;SAP&quot; &amp; users"'), 'LOCK-1', 'S4HK900009')
    expect(stages).toEqual(['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'])
  })

  it('rejects duplicate numbers and overlong text before SAP validation', async () => {
    const value = configured()
    const adapter = new MessageClassCreationAdapter(value, policy)
    const base = { objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009' }
    await expect(adapter.prepare({ ...base, messages: [{ number: '001', text: 'A' }, { number: '001', text: 'B' }] })).rejects.toThrow('duplicated')
    await expect(adapter.prepare({ ...base, messages: [{ number: '002', text: 'x'.repeat(73) }] })).rejects.toThrow('1-72')
    expect(value.validateNewObject).not.toHaveBeenCalled()
  })

  it('rejects preview when stateless message class creation is unavailable', async () => {
    const value = configured()
    value.createObjectStateless = undefined
    const adapter = new MessageClassCreationAdapter(value, policy)

    await expect(adapter.prepare({ objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009', messages: [] }))
      .rejects.toThrow('Controlled stateless message class creation is unavailable')
    expect(value.validateNewObject).not.toHaveBeenCalled()
    expect(value.createObject).not.toHaveBeenCalled()
  })

  it('keeps an uncertain stateless create outcome unknown without retry or compensation ownership', async () => {
    const value = configured()
    const adapter = new MessageClassCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009', messages: [] })
    ;(value.createObjectStateless as jest.Mock).mockRejectedValue(new Error('timeout after POST'))
    const creationPlan = plan(prepared)

    await expect(adapter.execute(creationPlan, jest.fn())).rejects.toBeInstanceOf(RepositoryCreationOutcomeUnknownError)
    expect(value.createObjectStateless).toHaveBeenCalledTimes(1)
    expect(value.lock).not.toHaveBeenCalled()
    expect(value.deleteObject).not.toHaveBeenCalled()
    expect(creationPlan.actualResources).toBeUndefined()
  })

  it('unlocks a compensation lock when deletion fails', async () => {
    const value = configured()
    const adapter = new MessageClassCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009', messages: [] })
    const creationPlan = plan(prepared)
    creationPlan.actualResources = [{ type: 'MSAG/N', name: 'ZMSG' }]
    value.deleteObject.mockRejectedValue(new Error('使用者 068157 当前编辑 ZMSG'))
    const stages: Array<[string, boolean, string | undefined]> = []

    await expect(adapter.compensate(creationPlan, (stage, success, message) => stages.push([stage, success, message])))
      .rejects.toThrow('Message class compensation outcome is unknown: 使用者 068157 当前编辑 ZMSG')
    expect(value.unLock).toHaveBeenCalledWith('/sap/bc/adt/messageclass/zmsg', 'LOCK-1')
    expect(stages).toEqual([
      ['COMPENSATION_LOCK_RESOURCE', true, undefined],
      ['COMPENSATION_UNLOCK_RESOURCE', true, undefined]
    ])
  })

  it('does not unlock an object after successful compensation deletion', async () => {
    const value = configured()
    const adapter = new MessageClassCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009', messages: [] })
    const creationPlan = plan(prepared)
    creationPlan.actualResources = [{ type: 'MSAG/N', name: 'ZMSG' }]
    const stages: Array<[string, boolean, string | undefined]> = []

    await expect(adapter.compensate(creationPlan, (stage, success, message) => stages.push([stage, success, message])))
      .resolves.toBe(true)
    expect(value.deleteObject).toHaveBeenCalledWith('/sap/bc/adt/messageclass/zmsg', 'LOCK-1', 'S4HK900009')
    expect(value.unLock).not.toHaveBeenCalled()
    expect(stages).toEqual([
      ['COMPENSATION_LOCK_RESOURCE', true, undefined],
      ['COMPENSATE_CREATED_OBJECT', true, undefined]
    ])
  })

  it('preserves the deletion error when compensation unlock also fails', async () => {
    const value = configured()
    const adapter = new MessageClassCreationAdapter(value, policy)
    const prepared = await adapter.prepare({ objectKind: 'MESSAGE_CLASS', name: 'ZMSG', description: 'Messages', packageName: 'Z001', transportRequest: 'S4HK900009', messages: [] })
    const creationPlan = plan(prepared)
    creationPlan.actualResources = [{ type: 'MSAG/N', name: 'ZMSG' }]
    value.deleteObject.mockRejectedValue(new Error('delete rejected'))
    value.unLock.mockRejectedValue(new Error('unlock rejected'))
    const stages: Array<[string, boolean, string | undefined]> = []

    await expect(adapter.compensate(creationPlan, (stage, success, message) => stages.push([stage, success, message])))
      .rejects.toThrow('Message class compensation outcome is unknown: delete rejected')
    expect(stages).toEqual([
      ['COMPENSATION_LOCK_RESOURCE', true, undefined],
      ['COMPENSATION_UNLOCK_RESOURCE', false, 'unlock rejected']
    ])
  })
})
