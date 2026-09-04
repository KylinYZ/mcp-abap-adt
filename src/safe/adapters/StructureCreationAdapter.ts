import {
  controlledStructureSourceUrl,
  controlledStructureUrl,
  type ControlledStructureShellInput
} from '../../adt/index.js'
import { RepositoryCreationOutcomeUnknownError } from '../RepositoryObjectCreationWorkflow.js'
import type {
  PreparedRepositoryCreation,
  RepositoryCreationExecutionResult,
  RepositoryCreationPlan,
  RepositoryObjectCreationAdapter,
  RepositoryObjectKind
} from '../repositoryCreationTypes.js'
import type { SafetyPolicy } from '../SafetyPolicy.js'
import { buildDdicStructureDdl, type DatabaseTableFieldInput } from '../tableDefinition.js'
import type { ControlledCreationAdtClient } from './controlledCreationTools.js'
import {
  assertActivation,
  assertNoCheckErrors,
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  repositoryName,
  requiredString
} from './creationAdapterTools.js'
import { compareSources } from '../sourceTools.js'

interface StructureCreationPayload {
  input: ControlledStructureShellInput
  source: string
  objectUrl: string
  sourceUrl: string
  packageUrl: string
  contentType: string
}

export class StructureCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'DDIC_STRUCTURE' as Extract<RepositoryObjectKind, 'DDIC_STRUCTURE'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 30)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    const source = buildDdicStructureDdl({ name, description, fields: request.fields as DatabaseTableFieldInput[] })
    assertStructureSource(name, source)
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)
    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'TABL/DS', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'TABL/DS')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, transportRequest })
    assertValidation(await validateStructure(this.client, input), name)
    const contentType = await resolveStructureContentType(this.client)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledStructureUrl(name)
    const sourceUrl = controlledStructureSourceUrl(name)
    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'TABL/DS', parentName: packageName },
      transportRequest,
      summary: `Create DDIC structure ${name} in package ${packageName}.`,
      payload: { input, source, objectUrl, sourceUrl, packageUrl: packageObject['adtcore:uri'], contentType } satisfies StructureCreationPayload,
      review: { objectKind: this.objectKind, name, description, packageName, transportRequest, fields: request.fields, source, shellContract: { adtType: 'TABL/DS', objectUrl, contentType } },
      compensationLimits: ['Only a structure proven to have been created by the current plan may be deleted.', 'Unknown shell, source, unlock, or activation outcomes stop automatic compensation.']
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = structurePayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'TABL/DS', 10), payload.input.name, 'TABL/DS')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await validateStructure(this.client, payload.input), payload.input.name)
    const currentContentType = await resolveStructureContentType(this.client)
    if (currentContentType !== payload.contentType) throw new Error('ADT structure creation content type changed after preview.')
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I'),
      this.client.transportDetails(payload.input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)
    try {
      await createStructure(this.client, payload.input, payload.contentType)
    } catch (error) {
      throw unknownWrite('DDIC structure shell create', error)
    }
    plan.actualResources = [{ type: 'TABL/DS', name: payload.input.name }]
    recordStage('CREATE_SHELL', true)
    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertStructureIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input)
    const actualSourceUrl = sourceUrlFromStructure(inactive.metaData as unknown as Record<string, unknown>, payload.sourceUrl)
    recordStage('RESOLVE_CREATED_OBJECT', true, actualSourceUrl)
    const prewriteChecks = await this.client.syntaxCheck(
      actualSourceUrl,
      payload.objectUrl,
      payload.source,
      undefined,
      'active'
    )
    assertNoCheckErrors(prewriteChecks, 'PREWRITE_CHECKS')
    recordStage('PREWRITE_CHECKS', true)
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      try {
        await this.client.setObjectSource(actualSourceUrl, payload.source, lock.LOCK_HANDLE, payload.input.transportRequest)
      } catch (error) {
        throw unknownWrite('DDIC structure source write', error)
      }
      recordStage('WRITE_SOURCE', true)
      const checks = await this.client.syntaxCheck(actualSourceUrl, payload.objectUrl, payload.source, undefined, 'active')
      assertNoCheckErrors(checks, 'RUN_CHECKS')
      recordStage('RUN_CHECKS', true)
    } catch (error) {
      operationError = error
    }
    try {
      await this.client.unLock(payload.objectUrl, lock.LOCK_HANDLE)
      recordStage('UNLOCK_RESOURCE', true)
    } catch (unlockError) {
      recordStage('UNLOCK_RESOURCE', false, errorText(unlockError))
      throw unknownWrite('DDIC structure unlock', unlockError)
    }
    if (operationError) throw operationError
    let activation
    try {
      activation = await activateStructure(this.client, payload.input.name)
    } catch (error) {
      throw unknownWrite('DDIC structure activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)
    const active = await this.client.objectStructure(payload.objectUrl, 'active')
    assertStructureIdentity(active.metaData as unknown as Record<string, unknown>, payload.input)
    const activeSource = await this.client.getObjectSource(sourceUrlFromStructure(active.metaData as unknown as Record<string, unknown>, payload.sourceUrl), { version: 'active' })
    const comparison = compareSources(payload.source, activeSource)
    if (!comparison.matches) throw new Error(`Activated source for ${payload.input.name} does not match the confirmed plan.`)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_SOURCE', true, comparison.matchType)
    return {
      resultSummary: `Created, activated, and verified DDIC structure ${payload.input.name}.`,
      actualResources: [{ type: 'TABL/DS', name: payload.input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = structurePayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'TABL/DS' && resource.name === payload.input.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`DDIC structure compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'TABL/DS', 10), payload.input.name, 'TABL/DS')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveStructureContentType(client: ControlledCreationAdtClient): Promise<string> {
  const result = await client.findCollectionByUrl?.('/sap/bc/adt/ddic/structures')
  const accepted = result?.collection.acceptedContentTypes || []
  const acceptedContentType = accepted.find(type => !/^text\/html(?:\s*;|$)/i.test(type))
  if (acceptedContentType) return acceptedContentType
  const links = result?.collection.templateLinks || []
  const exact = links.find(link => link.type && String(link.template || '').toLowerCase().includes('/ddic/structures'))
  const contentType = exact?.type || links.find(link => link.type)?.type
  if (!contentType) throw new Error('ADT discovery did not expose an accepted content type for DDIC structure creation.')
  return contentType
}

async function validateStructure(client: ControlledCreationAdtClient, input: Pick<ControlledStructureShellInput, 'name' | 'description'>) {
  if (!client.validateControlledStructureShell) throw new Error('Controlled DDIC structure validation is not available in this ADT client.')
  return client.validateControlledStructureShell(input)
}

async function createStructure(client: ControlledCreationAdtClient, input: ControlledStructureShellInput, contentType: string) {
  if (!client.createControlledStructureShell) throw new Error('Controlled DDIC structure creation is not available in this ADT client.')
  return client.createControlledStructureShell(input, contentType)
}

async function activateStructure(client: ControlledCreationAdtClient, name: string) {
  if (!client.activateControlledStructure) throw new Error('Controlled DDIC structure activation is not available in this ADT client.')
  return client.activateControlledStructure(name)
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledStructureShellInput, 'name' | 'description' | 'packageName' | 'transportRequest'>
): ControlledStructureShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function structurePayload(plan: RepositoryCreationPlan): StructureCreationPayload {
  const payload = plan.payload as StructureCreationPayload | undefined
  if (!payload?.input?.name || !payload.source || !payload.contentType) throw new Error('DDIC structure creation plan payload is unavailable.')
  return payload
}

function assertStructureSource(name: string, source: string): void {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\bdefine\\s+structure\\s+${escaped}\\s*\\{[\\s\\S]*\\}`, 'i').test(source)) {
    throw new Error(`Structure source must contain a complete define structure ${name} block.`)
  }
}

function assertStructureIdentity(metaData: Record<string, unknown>, input: ControlledStructureShellInput): void {
  if (String(metaData['adtcore:name'] || '').toUpperCase() !== input.name
    || String(metaData['adtcore:type'] || '').toUpperCase() !== 'TABL/DS') {
    throw new Error(`Created structure ${input.name} does not match the confirmed plan.`)
  }
}

function sourceUrlFromStructure(metaData: Record<string, unknown>, fallback: string): string {
  const sourceUri = String(metaData['abapsource:sourceUri'] || '').trim()
  if (!sourceUri) return fallback
  if (sourceUri.startsWith('/')) return sourceUri
  const name = String(metaData['adtcore:name'] || '').toLowerCase()
  const relative = sourceUri.replace(/^\.\//, '').replace(new RegExp(`^${name}/`, 'i'), '')
  return `${controlledStructureUrl(name)}/${relative}`
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
