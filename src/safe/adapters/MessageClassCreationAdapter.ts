import type { NewObjectOptions, ValidateOptions } from '../../adt/index.js'
import { RepositoryCreationOutcomeUnknownError } from '../RepositoryObjectCreationWorkflow.js'
import type { PreparedRepositoryCreation, RepositoryCreationExecutionResult, RepositoryCreationPlan, RepositoryObjectCreationAdapter } from '../repositoryCreationTypes.js'
import type { SafetyPolicy } from '../SafetyPolicy.js'
import type { ControlledCreationAdtClient } from './controlledCreationTools.js'
import { assertTargetAbsent, assertTransportAvailable, assertValidation, repositoryName, requiredString } from './creationAdapterTools.js'

interface MessageInput { number: string; text: string }
interface MessageClassPayload {
  name: string; description: string; packageName: string; transportRequest: string; packageUrl: string; objectUrl: string
  contentType: string; language: string; masterLanguage: string; masterSystem: string; responsible: string; messages: MessageInput[]
}

export class MessageClassCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'MESSAGE_CLASS' as const

  constructor(private readonly client: ControlledCreationAdtClient, private readonly policy: SafetyPolicy) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 20)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    const messages = parseMessages(request.messages)
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)
    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'MSAG/N', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'MSAG/N')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const language = packageMetadata.language || packageMetadata.masterLanguage
    const masterLanguage = packageMetadata.masterLanguage || language
    const responsible = packageMetadata.responsible || this.policy.sapUser
    if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) throw new Error(`Package ${packageName} did not expose the identity metadata required for controlled creation.`)
    if (!this.client.validateNewObject || !this.client.createObjectStateless) throw new Error('Controlled stateless message class creation is unavailable in this ADT client.')
    assertValidation(await this.client.validateNewObject({ objtype: 'MSAG/N', objname: name, description, packagename: packageName } satisfies ValidateOptions), name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = `/sap/bc/adt/messageclass/${name.toLowerCase()}`
    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'MSAG/N', parentName: packageName }, transportRequest,
      summary: `Create message class ${name} in package ${packageName}.`,
      payload: { name, description, packageName, transportRequest, packageUrl: packageObject['adtcore:uri'], objectUrl, contentType: 'application/*', language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible, messages } satisfies MessageClassPayload,
      review: { objectKind: this.objectKind, name, description, packageName, transportRequest, messages, shellContract: { adtType: 'MSAG/N', objectUrl, contentType: 'application/*' }, messageTextLimit: 72 },
      compensationLimits: ['Only the message class proven to have been created by the current plan may be deleted.', 'Unknown create, source, unlock, activation, or verification outcomes stop automatic compensation.']
    }
  }

  async execute(plan: RepositoryCreationPlan, recordStage: (stage: string, success: boolean, message?: string) => void): Promise<RepositoryCreationExecutionResult> {
    const payload = messageClassPayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.name, 'MSAG/N', 10), payload.name, 'MSAG/N')
    recordStage('REVALIDATE_ABSENCE', true)
    if (!this.client.validateNewObject) throw new Error('Controlled message class validation is unavailable in this ADT client.')
    assertValidation(await this.client.validateNewObject({ objtype: 'MSAG/N', objname: payload.name, description: payload.description, packagename: payload.packageName } satisfies ValidateOptions), payload.name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.packageName, 'I'),
      this.client.transportDetails(payload.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)
    if (!this.client.createObjectStateless) throw new Error('Controlled stateless message class creation is unavailable in this ADT client.')
    try {
      await this.client.createObjectStateless({ objtype: 'MSAG/N', name: payload.name, parentName: payload.packageName, description: payload.description, parentPath: payload.packageUrl, responsible: payload.responsible, language: payload.language, masterLanguage: payload.masterLanguage, masterSystem: payload.masterSystem, transport: payload.transportRequest, contentType: payload.contentType } satisfies NewObjectOptions)
    } catch (error) { throw unknownWrite('Message class create', error) }
    plan.actualResources = [{ type: 'MSAG/N', name: payload.name }]
    recordStage('CREATE_SHELL', true)
    const created = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertIdentity(created.metaData as unknown as Record<string, unknown>, payload)
    recordStage('RESOLVE_CREATED_OBJECT', true, payload.objectUrl)

    if (payload.messages.length > 0) {
      const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
      recordStage('LOCK_RESOURCE', true)
      let operationError: unknown
      try {
        let currentSource: string
        try { currentSource = await this.client.getObjectSource(payload.objectUrl, { version: 'inactive' }) } catch (error) { throw unknownWrite('Message class source read', error) }
        const nextSource = appendMessages(currentSource, payload.name, payload.messages)
        try { await this.client.setObjectSource(payload.objectUrl, nextSource, lock.LOCK_HANDLE, payload.transportRequest) } catch (error) { throw unknownWrite('Message class source write', error) }
        recordStage('WRITE_SOURCE', true)
      } catch (error) { operationError = error }
      try { await this.client.unLock(payload.objectUrl, lock.LOCK_HANDLE); recordStage('UNLOCK_RESOURCE', true) } catch (error) { recordStage('UNLOCK_RESOURCE', false, errorText(error)); throw unknownWrite('Message class unlock', error) }
      if (operationError) throw operationError
    }

    let activation
    try { activation = await this.client.activate(payload.name, payload.objectUrl, undefined, true) } catch (error) { throw unknownWrite('Message class activation', error) }
    if (!activation.success) throw new Error(activation.messages.map(message => message.shortText).filter(Boolean).join('; ') || 'SAP activation failed.')
    recordStage('ACTIVATE_OBJECT', true)
    let activeSource: string
    try {
      activeSource = await this.client.getObjectSource(payload.objectUrl, { version: 'active' })
      const active = await this.client.objectStructure(payload.objectUrl, 'active')
      assertIdentity(active.metaData as unknown as Record<string, unknown>, payload)
    } catch (error) { throw unknownWrite('Message class verification read', error) }
    verifyMessages(activeSource, payload.messages)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_SOURCE', true)
    return { resultSummary: `Created, activated, and verified message class ${payload.name}.`, actualResources: [{ type: 'MSAG/N', name: payload.name }] }
  }

  async compensate(plan: RepositoryCreationPlan, recordStage: (stage: string, success: boolean, message?: string) => void): Promise<boolean> {
    const payload = messageClassPayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'MSAG/N' && resource.name === payload.name)) return false
    let lockHandle: string | undefined
    let deleteCompleted = false
    let operationError: unknown
    try {
      const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
      lockHandle = lock.LOCK_HANDLE
      recordStage('COMPENSATION_LOCK_RESOURCE', true)
      try {
        await this.client.deleteObject(payload.objectUrl, lockHandle, payload.transportRequest)
        deleteCompleted = true
      } catch (error) {
        throw new Error(`Message class compensation outcome is unknown: ${errorText(error)}`)
      }
      assertTargetAbsent(await this.client.searchObject(payload.name, 'MSAG/N', 10), payload.name, 'MSAG/N')
      recordStage('COMPENSATE_CREATED_OBJECT', true)
    } catch (error) {
      operationError = error
    } finally {
      if (lockHandle && !deleteCompleted) {
        try {
          await this.client.unLock(payload.objectUrl, lockHandle)
          recordStage('COMPENSATION_UNLOCK_RESOURCE', true)
        } catch (error) {
          recordStage('COMPENSATION_UNLOCK_RESOURCE', false, errorText(error))
          if (!operationError) operationError = new Error(`Message class compensation unlock outcome is unknown: ${errorText(error)}`)
        }
      }
    }
    if (operationError) throw operationError
    return true
  }
}

function parseMessages(value: unknown): MessageInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error('messages must be an array with at most 100 entries.')
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`messages[${index}] must be an object.`)
    const record = item as Record<string, unknown>
    const number = String(record.number || '').trim()
    if (!/^\d{3}$/.test(number) || number === '000') throw new Error(`messages[${index}].number must be a three-digit value from 001 to 999.`)
    if (seen.has(number)) throw new Error(`Message number ${number} is duplicated.`)
    seen.add(number)
    const text = String(record.text || '').trim()
    if (!text || text.length > 72 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`messages[${index}].text must be 1-72 printable characters.`)
    return { number, text }
  })
}

function appendMessages(source: string, className: string, messages: MessageInput[]): string {
  const closing = source.search(/<\/mc:messageClass\s*>/i)
  if (closing < 0) throw new Error('Message class source did not contain the canonical closing element.')
  for (const message of messages) {
    if (new RegExp(`<mc:(?:messages|deletedmessages)\\b[^>]*\\bmc:msgno=["']${message.number}["']`, 'i').test(source)) throw new Error(`Message number ${message.number} already exists in the created message class.`)
  }
  const classUpper = className.toUpperCase()
  const classLower = className.toLowerCase()
  const entries = messages.map(message => `  <mc:messages mc:msgno="${message.number}" mc:msgtext="${xmlEscape(message.text)}" mc:selfexplainatory="false" mc:documented="false" mc:lastchangedby="" mc:lastmodified="" adtcore:name="">\n    <atom:link href="/sap/bc/adt/vit/docu/object_type/NA/object_name/${classUpper}${message.number}" rel="http://www.sap.com/adt/relations/longtext" xmlns:atom="http://www.w3.org/2005/Atom"/>\n    <atom:link href="/sap/bc/adt/messageclass/${classLower}/messages/${message.number}" rel="http://www.sap.com/adt/relations/messageclasses/messages" xmlns:atom="http://www.w3.org/2005/Atom"/>\n  </mc:messages>\n`).join('')
  return source.slice(0, closing) + entries + source.slice(closing)
}

function verifyMessages(source: string, messages: MessageInput[]): void {
  for (const message of messages) {
    const pattern = new RegExp(`<mc:messages\\b[^>]*\\bmc:msgno=["']${message.number}["'][^>]*\\bmc:msgtext=["']${escapeRegExp(xmlEscape(message.text))}["']`, 'i')
    if (!pattern.test(source)) throw new Error(`Active message class does not contain the confirmed message ${message.number}.`)
  }
}

function messageClassPayload(plan: RepositoryCreationPlan): MessageClassPayload {
  const payload = plan.payload as MessageClassPayload | undefined
  if (!payload?.name || !payload.objectUrl || !Array.isArray(payload.messages)) throw new Error('Message class creation plan payload is unavailable.')
  return payload
}

function assertIdentity(metaData: Record<string, unknown>, payload: MessageClassPayload): void {
  if (String(metaData['adtcore:name'] || '').toUpperCase() !== payload.name || String(metaData['adtcore:type'] || '').toUpperCase() !== 'MSAG/N') throw new Error(`Created message class ${payload.name} does not match the confirmed plan.`)
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError { return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
