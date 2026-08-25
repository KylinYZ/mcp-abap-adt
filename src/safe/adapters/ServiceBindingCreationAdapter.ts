import type {
  ControlledServiceBindingInput,
  ControlledServiceBindingType,
  SearchResult,
  ServiceBinding
} from '../../adt/index.js'
import {
  controlledServiceBindingUrl,
  parseServiceBinding
} from '../../adt/index.js'
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

interface ServiceBindingCreationPayload {
  input: ControlledServiceBindingInput
  packageUrl: string
  serviceDefinitionUri: string
  bindingUrl: string
}

const BINDING_TYPES: ControlledServiceBindingType[] = [
  'ODATA_V2_UI', 'ODATA_V2_WEB_API', 'ODATA_V4_UI', 'ODATA_V4_WEB_API'
]

export class ServiceBindingCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'SERVICE_BINDING' as const

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const input = this.inputFromRequest(request)
    this.policy.assertMutationAllowed(input.name)
    this.policy.assertTransportablePackage(input.packageName)
    assertBindingCategory(input.bindingType, input.bindingCategory)

    const [targetMatches, packageMatches, serviceDefinitionMatches] = await Promise.all([
      this.client.searchObject(input.name, 'SRVB/SVB', 10),
      this.client.searchObject(input.packageName, 'DEVC/K', 10),
      this.client.searchObject(input.serviceDefinition, 'SRVD/SRV', 10)
    ])
    assertTargetAbsent(targetMatches, input.name, 'SRVB/SVB')
    const packageObject = exactMatch(packageMatches, input.packageName, 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${input.packageName} was not found.`)
    const serviceDefinition = exactMatch(serviceDefinitionMatches, input.serviceDefinition, 'SRVD/SRV')
    if (!serviceDefinition) throw new Error(`Service definition ${input.serviceDefinition} was not found.`)
    await assertActiveServiceDefinition(this.client, serviceDefinition)

    const packageMetadata = await this.client.readControlledPackage(input.packageName)
    const identity = {
      language: packageMetadata.language || packageMetadata.masterLanguage,
      masterLanguage: packageMetadata.masterLanguage || packageMetadata.language,
      masterSystem: packageMetadata.masterSystem,
      responsible: packageMetadata.responsible || this.policy.sapUser
    }
    if (!identity.language || !identity.masterLanguage || !identity.masterSystem || !identity.responsible) {
      throw new Error(`Package ${input.packageName} did not expose the identity metadata required for controlled creation.`)
    }
    const controlledInput: ControlledServiceBindingInput = {
      ...input,
      language: identity.language!,
      masterLanguage: identity.masterLanguage!,
      masterSystem: identity.masterSystem!,
      responsible: identity.responsible!
    }
    const validate = this.client.validateControlledServiceBinding
    if (!validate) throw new Error('The ADT client does not expose controlled service binding validation.')
    assertValidation(await validate.call(this.client, controlledInput), input.name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], input.packageName, 'I'),
      this.client.transportDetails(input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, input.transportRequest)
    const bindingUrl = controlledServiceBindingUrl(input.name)
    return {
      target: { objectKind: 'SERVICE_BINDING', objectName: input.name, adtType: 'SRVB/SVB', parentName: input.packageName },
      transportRequest: input.transportRequest,
      summary: `Create ${input.bindingType} service binding ${input.name} for ${input.serviceDefinition}.`,
      payload: { input: controlledInput, packageUrl: packageObject['adtcore:uri'], serviceDefinitionUri: serviceDefinition['adtcore:uri'], bindingUrl } satisfies ServiceBindingCreationPayload,
      review: {
        objectKind: 'SERVICE_BINDING', name: input.name, description: input.description,
        packageName: input.packageName, serviceDefinition: input.serviceDefinition,
        bindingType: input.bindingType, bindingCategory: input.bindingCategory,
        transportRequest: input.transportRequest, canonicalUrl: bindingUrl
      },
      compensationLimits: [
        'Only a service binding proven to have been created by the current plan may be deleted.',
        'Unknown create or delete outcomes stop automatic retry and compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = serviceBindingPayload(plan)
    const { input } = payload
    assertTargetAbsent(await this.client.searchObject(input.name, 'SRVB/SVB', 10), input.name, 'SRVB/SVB')
    recordStage('REVALIDATE_ABSENCE', true)
    await revalidateReferences(this.client, payload)
    recordStage('REVALIDATE_REFERENCE', true, input.serviceDefinition)
    assertBindingCategory(input.bindingType, input.bindingCategory)
    const validate = this.client.validateControlledServiceBinding
    const create = this.client.createControlledServiceBinding
    if (!validate || !create) throw new Error('The ADT client does not expose controlled service binding operations.')
    assertValidation(await validate.call(this.client, input), input.name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, input.packageName, 'I'),
      this.client.transportDetails(input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    try {
      await create.call(this.client, input)
    } catch (error) {
      throw unknownWrite('Service binding create', error)
    }
    plan.actualResources = [{ type: 'SRVB/SVB', name: input.name }]
    recordStage('CREATE_OBJECT', true)

    const canonical = await this.client.getObjectSource(payload.bindingUrl)
    assertBindingIdentity(parseServiceBinding(canonical), input)
    recordStage('VERIFY_CREATED_OBJECT', true)
    return {
      resultSummary: `Created and verified service binding ${input.name}.`,
      actualResources: [{ type: 'SRVB/SVB', name: input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = serviceBindingPayload(plan)
    const { input, bindingUrl } = payload
    if (!plan.actualResources?.some(resource => resource.type === 'SRVB/SVB' && resource.name === input.name)) return false
    const lock = await this.client.lock(bindingUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(bindingUrl, lock.LOCK_HANDLE, input.transportRequest)
    } catch (error) {
      throw new Error(`Service binding compensation outcome is unknown: ${errorDetail(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(input.name, 'SRVB/SVB', 10), input.name, 'SRVB/SVB')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }

  private inputFromRequest(request: Record<string, unknown>): Omit<ControlledServiceBindingInput, 'language' | 'masterLanguage' | 'masterSystem' | 'responsible'> {
    const bindingType = requiredString(request, 'bindingType', 32).toUpperCase() as ControlledServiceBindingType
    if (!BINDING_TYPES.includes(bindingType)) throw new Error(`Unsupported service binding type ${bindingType}.`)
    return {
      objectKind: 'SERVICE_BINDING', adtType: 'SRVB/SVB',
      name: repositoryName(request, 'name', 26),
      description: requiredString(request, 'description', 120),
      packageName: repositoryName(request, 'packageName', 30),
      serviceDefinition: repositoryName(request, 'serviceDefinition', 30),
      bindingType,
      bindingCategory: requiredString(request, 'bindingCategory', 1) as '0' | '1',
      transportRequest: this.policy.assertTransportFormat(String(request.transportRequest || ''))
    }
  }
}

async function revalidateReferences(client: ControlledCreationAdtClient, payload: ServiceBindingCreationPayload): Promise<void> {
  const matches = await client.searchObject(payload.input.serviceDefinition, 'SRVD/SRV', 10)
  const serviceDefinition = exactMatch(matches, payload.input.serviceDefinition, 'SRVD/SRV')
  if (!serviceDefinition || serviceDefinition['adtcore:uri'] !== payload.serviceDefinitionUri) {
    throw new Error(`Service definition ${payload.input.serviceDefinition} no longer matches the confirmed plan.`)
  }
  await assertActiveServiceDefinition(client, serviceDefinition)
}

async function assertActiveServiceDefinition(client: ControlledCreationAdtClient, reference: SearchResult): Promise<void> {
  const structure = await client.objectStructure(reference['adtcore:uri'], 'active')
  if (String(structure.metaData['adtcore:name'] || '').toUpperCase() !== reference['adtcore:name'].toUpperCase()
    || String(structure.metaData['adtcore:type'] || '').toUpperCase() !== 'SRVD/SRV'
    || String(structure.metaData['adtcore:version'] || '').toLowerCase() !== 'active') {
    throw new Error(`Service definition ${reference['adtcore:name']} is not an active SRVD/SRV object.`)
  }
}

function assertBindingCategory(type: ControlledServiceBindingType, category: string): void {
  const expected = type.endsWith('_UI') ? '0' : '1'
  if (category !== expected) throw new Error(`${type} requires bindingCategory ${expected}.`)
}

function assertBindingIdentity(binding: ServiceBinding, input: ControlledServiceBindingInput): void {
  if (String(binding.name || '').toUpperCase() !== input.name
    || String(binding.type || '').toUpperCase() !== 'SRVB/SVB'
    || String(binding.packageRef?.name || '').toUpperCase() !== input.packageName) {
    throw new Error(`Created service binding ${input.name} does not match the confirmed identity.`)
  }
  const service = binding.services?.find(item => String(item.serviceDefinition?.name || '').toUpperCase() === input.serviceDefinition)
  const expectedVersion = input.bindingType.startsWith('ODATA_V2') ? 'V2' : 'V4'
  const expectedCategory = input.bindingCategory
  if (!service || String(service.version).padStart(4, '0') !== '0001'
    || String(binding.binding?.type || '').toUpperCase() !== 'ODATA'
    || String(binding.binding?.version || '').toUpperCase() !== expectedVersion
    || String(binding.binding?.category || '') !== expectedCategory) {
    throw new Error(`Created service binding ${input.name} does not match the confirmed service configuration.`)
  }
}

function exactMatch(results: SearchResult[], name: string, adtType: string): SearchResult | undefined {
  return results.find(item => item['adtcore:name'].toUpperCase() === name.toUpperCase()
    && item['adtcore:type'].toUpperCase() === adtType.toUpperCase())
}

function serviceBindingPayload(plan: RepositoryCreationPlan): ServiceBindingCreationPayload {
  const payload = plan.payload as ServiceBindingCreationPayload | undefined
  if (!payload?.input || !payload.packageUrl || !payload.serviceDefinitionUri || !payload.bindingUrl) {
    throw new Error('Service binding creation plan payload is unavailable.')
  }
  return payload
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorDetail(error)}`)
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
