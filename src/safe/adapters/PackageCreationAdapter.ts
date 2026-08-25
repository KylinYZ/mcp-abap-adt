import type { ControlledPackageDocument, ControlledPackageInput } from '../../adt/index.js'
import { RepositoryCreationOutcomeUnknownError } from '../RepositoryObjectCreationWorkflow.js'
import type {
  PreparedRepositoryCreation,
  RepositoryCreationExecutionResult,
  RepositoryCreationPlan,
  RepositoryObjectCreationAdapter
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

interface PackageCreationPayload {
  input: ControlledPackageInput
  parentPackageUrl: string
}

export class PackageCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'PACKAGE' as const

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 30)
    const description = requiredString(request, 'description', 120)
    const parentPackageName = repositoryName(request, 'parentPackageName', 30)
    const softwareComponent = repositoryName(request, 'softwareComponent', 30)
    const transportLayer = repositoryName(request, 'transportLayer', 20)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(parentPackageName)

    const [targetMatches, parentMatches] = await Promise.all([
      this.client.searchObject(name, 'DEVC/K', 10),
      this.client.searchObject(parentPackageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'DEVC/K')
    const parent = parentMatches.find(item => item['adtcore:name'].toUpperCase() === parentPackageName && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!parent) throw new Error(`Parent package ${parentPackageName} was not found.`)

    const metadata = await this.client.readControlledPackage(parentPackageName)
    const language = metadata.language || metadata.masterLanguage
    const masterLanguage = metadata.masterLanguage || language
    const masterSystem = metadata.masterSystem
    const responsible = metadata.responsible || this.policy.sapUser
    if (!language || !masterLanguage || !masterSystem || !responsible) {
      throw new Error(`Parent package ${parentPackageName} did not expose the identity metadata required for controlled creation.`)
    }
    if (isInvalidResponsible(responsible)) {
      throw new Error(`Parent package ${parentPackageName} exposes invalid responsible user '${responsible}'. SAP requires a valid user, not the system value SAP.`)
    }
    const input: ControlledPackageInput = {
      name, description, parentPackageName, softwareComponent, transportLayer, transportRequest,
      language, masterLanguage, masterSystem, responsible
    }
    assertValidation(await this.client.validateControlledPackage(input, 'basic'), name)
    await this.client.getControlledPackageConstraints(input)
    assertValidation(await this.client.validateControlledPackage(input, 'full'), name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(parent['adtcore:uri'], parentPackageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)

    return {
      target: { objectKind: 'PACKAGE', objectName: name, adtType: 'DEVC/K', parentName: parentPackageName },
      transportRequest,
      summary: `Create encapsulated development package ${name} below ${parentPackageName}.`,
      payload: { input, parentPackageUrl: parent['adtcore:uri'] } satisfies PackageCreationPayload,
      review: {
        objectKind: 'PACKAGE', name, description, parentPackageName, softwareComponent, transportLayer,
        transportRequest, fixedAttributes: { packageType: 'development', isEncapsulated: true, recordChanges: true }
      },
      compensationLimits: ['Automatic deletion requires proven ownership and an empty package.']
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = packagePayload(plan)
    const { input } = payload
    assertTargetAbsent(await this.client.searchObject(input.name, 'DEVC/K', 10), input.name, 'DEVC/K')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await this.client.validateControlledPackage(input, 'full'), input.name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.parentPackageUrl, input.parentPackageName, 'I'),
      this.client.transportDetails(input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let result
    try {
      result = await this.client.createControlledPackage(input)
    } catch (error) {
      throw unknownWrite('Package create', error)
    }
    plan.actualResources = [{ type: 'DEVC/K', name: input.name }]
    recordStage('CREATE_SHELL', true, result.location)
    const actual = await this.client.readControlledPackage(input.name)
    assertPackageMatch(actual, input)
    recordStage('VERIFY_PROPERTIES', true)
    return {
      resultSummary: `Created and verified development package ${input.name}.`,
      actualResources: [{ type: 'DEVC/K', name: input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = packagePayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'DEVC/K' && resource.name === payload.input.name)) return false
    const objectUrl = `/sap/bc/adt/packages/${payload.input.name.toLowerCase()}`
    const lock = await this.client.lock(objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`Package compensation outcome is unknown: ${error instanceof Error ? error.message : String(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'DEVC/K', 10), payload.input.name, 'DEVC/K')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

function isInvalidResponsible(value: string): boolean {
  return value.trim().toUpperCase() === 'SAP'
}

function packagePayload(plan: RepositoryCreationPlan): PackageCreationPayload {
  const payload = plan.payload as PackageCreationPayload | undefined
  if (!payload?.input) throw new Error('Package creation plan payload is unavailable.')
  return payload
}

function assertPackageMatch(actual: ControlledPackageDocument, input: ControlledPackageInput): void {
  const matches = actual.name === input.name
    && actual.description === input.description
    && actual.parentPackageName === input.parentPackageName
    && actual.softwareComponent === input.softwareComponent
    && actual.transportLayer === input.transportLayer
    && actual.packageType === 'development'
    && actual.isEncapsulated === true
    && actual.recordChanges === true
  if (!matches) throw new Error(`Created package ${input.name} does not match the confirmed plan.`)
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  const detail = error instanceof Error ? error.message : String(error)
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${detail}`)
}
