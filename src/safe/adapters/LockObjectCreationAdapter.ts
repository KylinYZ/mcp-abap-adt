import {
  controlledLockObjectUrl,
  type ControlledLockObjectShellInput
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
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  repositoryName,
  requiredString
} from './creationAdapterTools.js'

interface LockObjectCreationPayload {
  input: ControlledLockObjectShellInput
  objectUrl: string
  packageUrl: string
  primaryTableUrl: string
  contentType: string
}

export class LockObjectCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'DDIC_LOCK_OBJECT' as Extract<RepositoryObjectKind, 'DDIC_LOCK_OBJECT'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 16)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const primaryTable = repositoryName(request, 'primaryTable', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)
    const [targetMatches, packageMatches, tableMatches] = await Promise.all([
      this.client.searchObject(name, 'ENQU/DL', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10),
      this.client.searchObject(primaryTable, 'TABL/DT', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'ENQU/DL')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)
    const primaryTableObject = tableMatches.find(item => item['adtcore:name'].toUpperCase() === primaryTable && item['adtcore:type'].toUpperCase() === 'TABL/DT')
    if (!primaryTableObject) throw new Error(`Primary table ${primaryTable} was not found.`)
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, primaryTable, transportRequest })
    assertValidation(await validateLockObject(this.client, input), name)
    const contentType = await resolveLockObjectContentType(this.client)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledLockObjectUrl(name)
    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'ENQU/DL', parentName: packageName },
      transportRequest,
      summary: `Create DDIC lock object ${name} for table ${primaryTable} in package ${packageName}.`,
      payload: { input, objectUrl, packageUrl: packageObject['adtcore:uri'], primaryTableUrl: primaryTableObject['adtcore:uri'], contentType } satisfies LockObjectCreationPayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        primaryTable,
        transportRequest,
        shellContract: { adtType: 'ENQU/DL', objectUrl, contentType, allowRFC: false, lockMode: '' }
      },
      compensationLimits: ['Only a lock object proven to have been created by the current plan may be deleted.', 'Unknown create, delete, or lock outcomes stop automatic compensation.']
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = lockObjectPayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'ENQU/DL', 10), payload.input.name, 'ENQU/DL')
    recordStage('REVALIDATE_ABSENCE', true)
    const tableMatches = await this.client.searchObject(payload.input.primaryTable, 'TABL/DT', 10)
    const table = tableMatches.find(item => item['adtcore:name'].toUpperCase() === payload.input.primaryTable && item['adtcore:type'].toUpperCase() === 'TABL/DT')
    if (!table || table['adtcore:uri'] !== payload.primaryTableUrl) throw new Error(`Primary table ${payload.input.primaryTable} no longer matches the confirmed plan.`)
    recordStage('REVALIDATE_REFERENCE', true, payload.input.primaryTable)
    assertValidation(await validateLockObject(this.client, payload.input), payload.input.name)
    const currentContentType = await resolveLockObjectContentType(this.client)
    if (currentContentType !== payload.contentType) throw new Error('ADT lock object creation content type changed after preview.')
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I'),
      this.client.transportDetails(payload.input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)
    let creation
    try {
      creation = await createLockObject(this.client, payload.input, payload.contentType)
    } catch (error) {
      throw unknownWrite('DDIC lock object create', error)
    }
    if (creation.lockObject.name !== payload.input.name
      || (creation.lockObject.packageName && creation.lockObject.packageName.toUpperCase() !== payload.input.packageName)
      || (creation.lockObject.primaryTable && creation.lockObject.primaryTable.toUpperCase() !== payload.input.primaryTable)) {
      throw new Error('DDIC lock object creation response does not match the confirmed plan.')
    }
    plan.actualResources = [{ type: 'ENQU/DL', name: payload.input.name }]
    recordStage('CREATE_OBJECT', true, creation.location)
    const created = await this.client.objectStructure(payload.objectUrl, 'active')
    assertLockObjectIdentity(created.metaData as unknown as Record<string, unknown>, payload.input)
    recordStage('VERIFY_CREATED_OBJECT', true)
    return {
      resultSummary: `Created and verified DDIC lock object ${payload.input.name}.`,
      actualResources: [{ type: 'ENQU/DL', name: payload.input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = lockObjectPayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'ENQU/DL' && resource.name === payload.input.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`DDIC lock object compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'ENQU/DL', 10), payload.input.name, 'ENQU/DL')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveLockObjectContentType(client: ControlledCreationAdtClient): Promise<string> {
  const result = await client.findCollectionByUrl?.('/sap/bc/adt/ddic/lockobjects/sources')
  const accepted = result?.collection.acceptedContentTypes || []
  const exact = accepted.find(type => type.toLowerCase() === 'application/vnd.sap.adt.lockobjects.v1+xml')
  if (exact) return exact
  const fallback = accepted.find(type => /^application\/[^;]+\+xml$/i.test(type) && /lockobjects/i.test(type))
  if (fallback) return fallback
  throw new Error('ADT discovery did not expose an accepted content type for DDIC lock object creation.')
}

async function validateLockObject(client: ControlledCreationAdtClient, input: ControlledLockObjectShellInput) {
  if (!client.validateControlledLockObjectShell) throw new Error('Controlled DDIC lock object validation is not available in this ADT client.')
  return client.validateControlledLockObjectShell(input)
}

async function createLockObject(client: ControlledCreationAdtClient, input: ControlledLockObjectShellInput, contentType: string) {
  if (!client.createControlledLockObjectShell) throw new Error('Controlled DDIC lock object creation is not available in this ADT client.')
  return client.createControlledLockObjectShell(input, contentType)
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledLockObjectShellInput, 'name' | 'description' | 'packageName' | 'primaryTable' | 'transportRequest'>
): ControlledLockObjectShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function lockObjectPayload(plan: RepositoryCreationPlan): LockObjectCreationPayload {
  const payload = plan.payload as LockObjectCreationPayload | undefined
  if (!payload?.input?.name || !payload.contentType || !payload.primaryTableUrl) throw new Error('DDIC lock object creation plan payload is unavailable.')
  return payload
}

function assertLockObjectIdentity(metaData: Record<string, unknown>, input: ControlledLockObjectShellInput): void {
  if (String(metaData['adtcore:name'] || '').toUpperCase() !== input.name
    || String(metaData['adtcore:type'] || '').toUpperCase() !== 'ENQU/DL') {
    throw new Error(`Created lock object ${input.name} does not match the confirmed plan.`)
  }
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
