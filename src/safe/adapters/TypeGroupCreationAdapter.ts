import {
  activateControlledTypeGroup,
  controlledTypeGroupSourceUrl,
  controlledTypeGroupUrl,
  type ControlledTypeGroupShellInput
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
import type { ControlledCreationAdtClient } from './controlledCreationTools.js'
import {
  assertActivation,
  assertNoCheckErrors,
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  controlledResponsible,
  repositoryName,
  requiredString,
  sameControlledMasterSystem
} from './creationAdapterTools.js'
import { compareSources } from '../sourceTools.js'

interface TypeGroupCreationPayload {
  input: ControlledTypeGroupShellInput
  source: string
  objectUrl: string
  sourceUrl: string
  packageUrl: string
  contentType: string
}

export class TypeGroupCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'DDIC_TYPE_GROUP' as Extract<RepositoryObjectKind, 'DDIC_TYPE_GROUP'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 5)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    const source = sourceInput(request)
    assertTypeGroupSource(name, source)
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)
    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'TYPE/DG', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'TYPE/DG')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, transportRequest })
    assertValidation(await validateTypeGroup(this.client, input), name)
    const contentType = await resolveTypeGroupContentType(this.client)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledTypeGroupUrl(name)
    const sourceUrl = controlledTypeGroupSourceUrl(name)
    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'TYPE/DG', parentName: packageName },
      transportRequest,
      summary: `Create DDIC type group ${name} in package ${packageName}.`,
      payload: { input, source, objectUrl, sourceUrl, packageUrl: packageObject['adtcore:uri'], contentType } satisfies TypeGroupCreationPayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        transportRequest,
        source,
        shellContract: { adtType: 'TYPE/DG', objectUrl, contentType }
      },
      compensationLimits: ['Only a type group proven to have been created by the current plan may be deleted.', 'Unknown shell, source, unlock, or activation outcomes stop automatic compensation.']
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = typeGroupPayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'TYPE/DG', 10), payload.input.name, 'TYPE/DG')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await validateTypeGroup(this.client, payload.input), payload.input.name)
    const currentContentType = await resolveTypeGroupContentType(this.client)
    if (currentContentType !== payload.contentType) throw new Error('ADT type group creation content type changed after preview.')
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I'),
      this.client.transportDetails(payload.input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let creation
    try {
      creation = await createTypeGroup(this.client, payload.input, payload.contentType)
    } catch (error) {
      throw unknownWrite('DDIC type group shell create', error)
    }
    recordStage('CREATE_SHELL', true)

    let createdStructure
    if (creation.ownershipEvidence === 'POST_CREATE_READBACK_REQUIRED') {
      try {
        createdStructure = await provePostCreateTypeGroupOwnership(this.client, payload.input, payload.objectUrl)
      } catch (error) {
        throw unknownWrite('DDIC type group shell ownership proof', error)
      }
      recordStage('PROVE_SHELL_OWNERSHIP', true, payload.objectUrl)
    } else {
      createdStructure = await this.client.objectStructure(payload.objectUrl, 'inactive')
      assertTypeGroupIdentity(createdStructure.metaData as unknown as Record<string, unknown>, payload.input)
    }
    plan.actualResources = [{ type: 'TYPE/DG', name: payload.input.name }]
    const actualSourceUrl = sourceUrlFromTypeGroup(
      createdStructure.metaData as unknown as Record<string, unknown>,
      payload.sourceUrl
    )
    recordStage('RESOLVE_CREATED_OBJECT', true, actualSourceUrl)
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      try {
        await this.client.setObjectSource(actualSourceUrl, payload.source, lock.LOCK_HANDLE, payload.input.transportRequest)
      } catch (error) {
        throw unknownWrite('DDIC type group source write', error)
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
      if (operationError instanceof RepositoryCreationOutcomeUnknownError) throw operationError
      throw unknownWrite('DDIC type group unlock', unlockError)
    }
    if (operationError) throw operationError
    let activation
    try {
      activation = await activateTypeGroup(this.client, payload.input.name)
    } catch (error) {
      throw unknownWrite('DDIC type group activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)
    const active = await this.client.objectStructure(payload.objectUrl, 'active')
    assertTypeGroupIdentity(active.metaData as unknown as Record<string, unknown>, payload.input)
    const activeSource = await this.client.getObjectSource(
      sourceUrlFromTypeGroup(active.metaData as unknown as Record<string, unknown>, payload.sourceUrl),
      { version: 'active' }
    )
    const comparison = compareSources(payload.source, activeSource)
    if (!comparison.matches) throw new Error(`Activated source for ${payload.input.name} does not match the confirmed plan.`)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_SOURCE', true, comparison.matchType)
    return {
      resultSummary: `Created, activated, and verified DDIC type group ${payload.input.name}.`,
      actualResources: [{ type: 'TYPE/DG', name: payload.input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = typeGroupPayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'TYPE/DG' && resource.name === payload.input.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`DDIC type group compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'TYPE/DG', 10), payload.input.name, 'TYPE/DG')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveTypeGroupContentType(client: ControlledCreationAdtClient): Promise<string> {
  const result = await client.findCollectionByUrl?.('/sap/bc/adt/ddic/typegroups')
  const accepted = result?.collection.acceptedContentTypes || []
  const preferred = [
    'application/vnd.sap.adt.ddic.typegroups.v2+xml',
    'application/vnd.sap.adt.ddic.typegroups.v3+xml',
    'application/vnd.sap.adt.ddic.typegroups+xml'
  ]
  const exact = preferred.find(type => accepted.some(value => value.toLowerCase() === type))
  if (exact) return exact
  const fallback = accepted.find(type => /^application\/[^;]+\+xml$/i.test(type) && /typegroups/i.test(type))
  if (fallback) return fallback
  throw new Error('ADT discovery did not expose an accepted content type for DDIC type group creation.')
}

async function validateTypeGroup(client: ControlledCreationAdtClient, input: ControlledTypeGroupShellInput) {
  if (!client.validateControlledTypeGroupShell) throw new Error('Controlled DDIC type group validation is not available in this ADT client.')
  return client.validateControlledTypeGroupShell(input)
}

async function createTypeGroup(client: ControlledCreationAdtClient, input: ControlledTypeGroupShellInput, contentType: string) {
  if (!client.createControlledTypeGroupShell) throw new Error('Controlled DDIC type group creation is not available in this ADT client.')
  return client.createControlledTypeGroupShell(input, contentType)
}

async function activateTypeGroup(client: ControlledCreationAdtClient, name: string) {
  if (!client.activateControlledTypeGroup) throw new Error('Controlled DDIC type group activation is not available in this ADT client.')
  return client.activateControlledTypeGroup(name)
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledTypeGroupShellInput, 'name' | 'description' | 'packageName' | 'transportRequest'>
): ControlledTypeGroupShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = controlledResponsible(packageMetadata.responsible, policy.sapUser)
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function typeGroupPayload(plan: RepositoryCreationPlan): TypeGroupCreationPayload {
  const payload = plan.payload as TypeGroupCreationPayload | undefined
  if (!payload?.input?.name || !payload.source || !payload.contentType) throw new Error('DDIC type group creation plan payload is unavailable.')
  return payload
}

function assertTypeGroupSource(name: string, source: string): void {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\bTYPE-POOL\\s+${escaped}\\s*\\.`, 'i').test(source)) {
    throw new Error(`Type group source must contain TYPE-POOL ${name} .`)
  }
  const declarations = source.matchAll(/\b(?:TYPES|CONSTANTS|DATA)\s+([A-Z][A-Z0-9_]*)/gi)
  for (const declaration of declarations) {
    if (!declaration[1].toUpperCase().startsWith(`${name}_`)) {
      throw new Error(`Type group declarations must begin with ${name}_.`)
    }
  }
}

function sourceInput(request: Record<string, unknown>): string {
  const source = String(request.source || '').trim()
  if (!source || source.length > 200000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) {
    throw new Error('source is required and must be a bounded ABAP source body.')
  }
  return source
}

function assertTypeGroupIdentity(metaData: Record<string, unknown>, input: ControlledTypeGroupShellInput): void {
  if (String(metaData['adtcore:name'] || '').toUpperCase() !== input.name
    || String(metaData['adtcore:type'] || '').toUpperCase() !== 'TYPE/DG') {
    throw new Error(`Created type group ${input.name} does not match the confirmed plan.`)
  }
}

async function provePostCreateTypeGroupOwnership(
  client: ControlledCreationAdtClient,
  input: ControlledTypeGroupShellInput,
  objectUrl: string
) {
  const exact = (await client.searchObject(input.name, 'TYPE/DG', 10)).filter(item => (
    item['adtcore:name'].toUpperCase() === input.name
    && item['adtcore:type'].toUpperCase() === 'TYPE/DG'
  ))
  if (exact.length !== 1
    || exact[0]['adtcore:uri'] !== objectUrl
    || String(exact[0]['adtcore:packageName'] || '').toUpperCase() !== input.packageName) {
    throw new Error(`SAP did not return one exact owned type group shell for ${input.name}.`)
  }
  const active = await client.objectStructure(objectUrl, 'active')
  const metadata = active.metaData as unknown as Record<string, unknown>
  assertTypeGroupIdentity(metadata, input)
  if (String(metadata['adtcore:version'] || '').toLowerCase() !== 'active'
    || String(metadata['adtcore:description'] || '') !== input.description
    || !sameSapIdentity(metadata['adtcore:responsible'], input.responsible)
    || String(metadata['adtcore:masterLanguage'] || '').toUpperCase() !== input.masterLanguage.toUpperCase()
    || !sameControlledMasterSystem(metadata['adtcore:masterSystem'], input.masterSystem)) {
    throw new Error(`SAP active type group metadata for ${input.name} does not prove ownership.`)
  }
  const [transportInfo, transportDetails] = await Promise.all([
    client.transportInfo(objectUrl, input.packageName, 'I'),
    client.transportDetails(input.transportRequest)
  ])
  assertTransportAvailable(transportInfo, transportDetails, input.transportRequest)
  if (String(transportInfo.OBJECTNAME || transportInfo.LOCKS?.OBJECT_KEY?.OBJ_NAME || '').toUpperCase() !== input.name
    || String(transportInfo.URI || '') !== objectUrl) {
    throw new Error(`SAP transport identity for ${input.name} does not prove ownership.`)
  }
  return active
}

function sameSapIdentity(actual: unknown, expected: string): boolean {
  const left = String(actual ?? '').trim().toUpperCase()
  const right = String(expected || '').trim().toUpperCase()
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return left.replace(/^0+/, '') === right.replace(/^0+/, '')
  }
  return left === right
}

function sourceUrlFromTypeGroup(metaData: Record<string, unknown>, fallback: string): string {
  const sourceUri = String(metaData['abapsource:sourceUri'] || '').trim()
  if (!sourceUri) return fallback
  if (sourceUri.startsWith('/')) return sourceUri
  const name = String(metaData['adtcore:name'] || '').toLowerCase()
  const relative = sourceUri.replace(/^\.\//, '').replace(new RegExp(`^${name}/`, 'i'), '')
  return `${controlledTypeGroupUrl(name)}/${relative}`
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
