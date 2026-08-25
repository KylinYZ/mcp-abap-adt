import { createHash } from 'crypto'
import {
  assertControlledSapObjectTypeCreationContract,
  buildControlledSapObjectTypeCreationContent,
  controlledSapObjectTypeUrl,
  SAP_OBJECT_TYPE_ADDITIONAL_CONTENT_TYPE,
  SAP_OBJECT_TYPE_COLLECTION_PATH,
  SAP_OBJECT_TYPE_NEW_CONFIGURATION_PATH,
  SAP_OBJECT_TYPE_NEW_CONFIGURATION_CONTENT_TYPE,
  SAP_OBJECT_TYPE_NEW_CONTENT_PATH,
  SAP_OBJECT_TYPE_NEW_CONTENT_TYPE,
  SAP_OBJECT_TYPE_NEW_SCHEMA_PATH,
  SAP_OBJECT_TYPE_NEW_SCHEMA_CONTENT_TYPE,
  SAP_OBJECT_TYPE_SHELL_CONTENT_TYPE,
  SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE,
  type ControlledSapObjectTypeContent,
  type ControlledSapObjectTypeCreationContent,
  type ControlledSapObjectTypeCreationContract,
  type ControlledSapObjectTypeShellInput,
  type Link,
  type SapObjectTypeCategory
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
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  repositoryName,
  requiredString
} from './creationAdapterTools.js'

interface SapObjectTypeCreationPayload {
  input: ControlledSapObjectTypeShellInput
  creationContent: ControlledSapObjectTypeCreationContent
  objectUrl: string
  packageUrl: string
  shellContentType: string
  contractHash: string
}

interface SapObjectTypeDiscoveryContract {
  shellContentType: string
  schemaType: string
  configurationType: string
  contentType: string
}

export class SapObjectTypeCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'SAP_OBJECT_TYPE' as Extract<RepositoryObjectKind, 'SAP_OBJECT_TYPE'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const semanticName = sapObjectTypeName(request.name)
    const repositoryObjectName = semanticName.toUpperCase()
    const description = requiredString(request, 'description', 60)
    const packageName = repositoryName(request, 'packageName', 30)
    const typeCategory = sapObjectTypeCategory(request.typeCategory)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(repositoryObjectName)
    this.policy.assertTransportablePackage(packageName)

    assertTargetAbsent(
      await this.client.searchObject(repositoryObjectName, 'RONT/ROT', 10),
      repositoryObjectName,
      'RONT/ROT'
    )
    const packageMatches = await this.client.searchObject(packageName, 'DEVC/K', 10)
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)

    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, {
      repositoryName: repositoryObjectName,
      semanticName,
      description,
      packageName,
      transportRequest,
      typeCategory
    })
    const creationContent = buildControlledSapObjectTypeCreationContent(input)
    assertValidation(await validateSapObjectType(this.client, input, creationContent), repositoryObjectName)
    const discoveryContract = await resolveDiscoveryContract(this.client)
    const creationContract = await readCreationContract(this.client)
    assertControlledSapObjectTypeCreationContract(creationContract)

    const transportInfo = await this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I')
    const transportDetails = await this.client.transportDetails(transportRequest)
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledSapObjectTypeUrl(repositoryObjectName)

    return {
      target: {
        objectKind: this.objectKind,
        objectName: repositoryObjectName,
        adtType: 'RONT/ROT',
        parentName: packageName
      },
      transportRequest,
      summary: `Create SAP Object Type ${semanticName} (${repositoryObjectName}) in package ${packageName}.`,
      payload: {
        input,
        creationContent,
        objectUrl,
        packageUrl: packageObject['adtcore:uri'],
        shellContentType: discoveryContract.shellContentType,
        contractHash: contractHash(discoveryContract, creationContract)
      } satisfies SapObjectTypeCreationPayload,
      review: {
        objectKind: this.objectKind,
        name: semanticName,
        repositoryName: repositoryObjectName,
        description,
        packageName,
        typeCategory,
        transportRequest,
        derivedMetadata: creationContent.metadata,
        shellContract: {
          adtType: 'RONT/ROT',
          objectUrl,
          shellContentType: discoveryContract.shellContentType,
          additionalContentType: SAP_OBJECT_TYPE_ADDITIONAL_CONTENT_TYPE,
          sourceContentType: SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE,
          schemaFramework: 'newObjectTypes.v1'
        }
      },
      compensationLimits: [
        'Only an SAP Object Type proven to have been created by the current plan may be deleted.',
        'Unknown Blue shell, activation, or delete outcomes stop automatic retry and compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = sapObjectTypePayload(plan)
    assertTargetAbsent(
      await this.client.searchObject(payload.input.repositoryName, 'RONT/ROT', 10),
      payload.input.repositoryName,
      'RONT/ROT'
    )
    recordStage('REVALIDATE_ABSENCE', true)

    assertValidation(
      await validateSapObjectType(this.client, payload.input, payload.creationContent),
      payload.input.repositoryName
    )
    const discoveryContract = await resolveDiscoveryContract(this.client)
    const creationContract = await readCreationContract(this.client)
    assertControlledSapObjectTypeCreationContract(creationContract)
    if (contractHash(discoveryContract, creationContract) !== payload.contractHash
      || discoveryContract.shellContentType !== payload.shellContentType) {
      throw new Error('ADT SAP Object Type creation contract changed after preview.')
    }
    recordStage('REVALIDATE_CONTRACT', true)

    const transportInfo = await this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I')
    const transportDetails = await this.client.transportDetails(payload.input.transportRequest)
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let creation
    try {
      creation = await createSapObjectType(
        this.client,
        payload.input,
        payload.creationContent,
        payload.shellContentType
      )
    } catch (error) {
      throw unknownWrite('SAP Object Type Blue shell create', error)
    }
    plan.actualResources = [{ type: 'RONT/ROT', name: payload.input.repositoryName }]
    recordStage('CREATE_OBJECT', true, creation.location)

    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertSapObjectTypeIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input, 'inactive')
    const inactiveLink = sourceLink(inactive.links || [], payload.objectUrl)
    const inactiveContent = await readSapObjectTypeContent(this.client, inactiveLink.url, inactiveLink.contentType, 'inactive')
    assertSapObjectTypeContent(payload.input, inactiveContent)
    recordStage('VERIFY_INACTIVE_OBJECT', true)
    recordStage('VERIFY_INACTIVE_CONTENT', true)

    let activation
    try {
      activation = await this.client.activate(payload.input.repositoryName, payload.objectUrl, undefined, true)
    } catch (error) {
      throw unknownWrite('SAP Object Type activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)

    const active = await this.client.objectStructure(payload.objectUrl, 'active')
    assertSapObjectTypeIdentity(active.metaData as unknown as Record<string, unknown>, payload.input, 'active')
    const activeLink = sourceLink(active.links || [], payload.objectUrl)
    const activeContent = await readSapObjectTypeContent(this.client, activeLink.url, activeLink.contentType, 'active')
    assertSapObjectTypeContent(payload.input, activeContent, inactiveContent.objectTypeCode)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_ACTIVE_CONTENT', true)
    return {
      resultSummary: `Created, activated, and verified SAP Object Type ${payload.input.semanticName}.`,
      actualResources: [{ type: 'RONT/ROT', name: payload.input.repositoryName }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = sapObjectTypePayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'RONT/ROT'
      && resource.name === payload.input.repositoryName)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`SAP Object Type compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(
      await this.client.searchObject(payload.input.repositoryName, 'RONT/ROT', 10),
      payload.input.repositoryName,
      'RONT/ROT'
    )
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveDiscoveryContract(client: ControlledCreationAdtClient): Promise<SapObjectTypeDiscoveryContract> {
  const result = await client.findCollectionByUrl?.(SAP_OBJECT_TYPE_COLLECTION_PATH)
  const collection = result?.collection
  if (!collection) throw new Error('ADT discovery did not expose SAP Object Type creation.')
  const shellContentType = (collection.acceptedContentTypes || [])
    .find(type => baseContentType(type) === SAP_OBJECT_TYPE_SHELL_CONTENT_TYPE)
  if (!shellContentType) throw new Error('ADT discovery did not expose the reviewed Blue v2 SAP Object Type shell.')
  const schemaType = templateType(collection.templateLinks, 'http://www.sap.com/adt/categories/objects/new/schema/additional', SAP_OBJECT_TYPE_NEW_SCHEMA_PATH, SAP_OBJECT_TYPE_NEW_SCHEMA_CONTENT_TYPE)
  const configurationType = templateType(collection.templateLinks, 'http://www.sap.com/adt/categories/objects/new/configuration/additional', SAP_OBJECT_TYPE_NEW_CONFIGURATION_PATH, SAP_OBJECT_TYPE_NEW_CONFIGURATION_CONTENT_TYPE)
  const contentType = templateType(collection.templateLinks, 'http://www.sap.com/adt/categories/objects/new/content/additional', SAP_OBJECT_TYPE_NEW_CONTENT_PATH, SAP_OBJECT_TYPE_NEW_CONTENT_TYPE)
  return { shellContentType, schemaType, configurationType, contentType }
}

function templateType(
  links: Array<{ rel: string; template: string; type?: string }>,
  relation: string,
  expectedPath: string,
  expectedType: string
): string {
  const link = links.find(candidate => candidate.rel === relation)
  // Bind each discovery relation to the exact endpoint used during apply.
  const matchesPath = link?.template === expectedPath || link?.template.startsWith(`${expectedPath}{`)
  if (!link?.type || normalizeContentType(link.type) !== normalizeContentType(expectedType)
    || !matchesPath) {
    const contractName = relation.split('/').slice(-2)[0]
    throw new Error(`ADT discovery did not expose the reviewed SAP Object Type ${contractName} contract.`)
  }
  return normalizeContentType(link.type)
}

function sourceLink(links: Link[], objectUrl: string): { url: string; contentType: string } {
  const source = links.find(link => link.rel === 'http://www.sap.com/adt/relations/source'
    && link.type && !/^text\/html(?:\s*;|$)/i.test(link.type))
  if (!source?.href || !source.type) throw new Error('Created SAP Object Type did not expose its JSON source link.')
  const contentType = baseContentType(source.type)
  if (contentType !== SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE) {
    throw new Error('Created SAP Object Type source link did not use application/json.')
  }
  const resolved = new URL(source.href, `https://adt.invalid${objectUrl}`).pathname
  if (!resolved.startsWith(`${SAP_OBJECT_TYPE_COLLECTION_PATH}/`)) {
    throw new Error('SAP Object Type source link escaped the controlled ADT collection.')
  }
  return { url: resolved, contentType }
}

function assertSapObjectTypeIdentity(
  metadata: Record<string, unknown>,
  input: ControlledSapObjectTypeShellInput,
  expectedVersion: 'active' | 'inactive'
): void {
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== input.repositoryName
    || String(metadata['adtcore:type'] || '').toUpperCase() !== 'RONT/ROT'
    || String(metadata['adtcore:version'] || '').toLowerCase() !== expectedVersion) {
    throw new Error(`Created SAP Object Type ${input.repositoryName} does not match the confirmed plan.`)
  }
}

function assertSapObjectTypeContent(
  input: ControlledSapObjectTypeShellInput,
  content: ControlledSapObjectTypeContent,
  expectedObjectTypeCode?: string
): void {
  const language = input.masterLanguage.toLowerCase()
  const hasValidObjectTypeCode = typeof content.objectTypeCode === 'string'
    && content.objectTypeCode.length > 0
    && content.objectTypeCode.length <= 5
    && !/[\r\n\u0000-\u001f\u007f]/.test(content.objectTypeCode)
  const objectTypeCodeIsValid = content.objectTypeCode === undefined || hasValidObjectTypeCode
  if (content.formatVersion !== '1'
    || content.header.description !== input.description
    || content.header.originalLanguage !== language
    || content.typeCategory !== input.typeCategory
    || content.name !== input.semanticName
    || !objectTypeCodeIsValid
    || (expectedObjectTypeCode !== undefined && content.objectTypeCode !== expectedObjectTypeCode)
    || content.interfaceBehaviorDefinition !== undefined
    || content.odmEntityName !== undefined) {
    throw new Error('SAP Object Type content does not match the confirmed plan.')
  }
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<
    ControlledSapObjectTypeShellInput,
    'repositoryName' | 'semanticName' | 'description' | 'packageName' | 'transportRequest' | 'typeCategory'
  >
): ControlledSapObjectTypeShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity fields required by the Blue v2 shell.`)
  }
  if (!/^[A-Z]{2}$/i.test(masterLanguage)) {
    throw new Error(`Package ${values.packageName} did not expose a two-letter original language.`)
  }
  return {
    ...values,
    language,
    masterLanguage,
    masterSystem: packageMetadata.masterSystem,
    responsible
  }
}

function sapObjectTypeName(value: unknown): string {
  const name = String(value || '').trim()
  if (!/^[A-Z][A-Za-z0-9]{0,29}$/.test(name)) {
    throw new Error('SAP Object Type name must be a 1-30 character PascalCase identifier.')
  }
  return name
}

function sapObjectTypeCategory(value: unknown): SapObjectTypeCategory {
  const category = String(value || '') as SapObjectTypeCategory
  const allowed: SapObjectTypeCategory[] = [
    'businessObject', 'technicalObject', 'analyticalObject',
    'configurationObject', 'dependentObject', 'hierarchyObject'
  ]
  if (!allowed.includes(category)) throw new Error('SAP Object Type category is not supported.')
  return category
}

function sapObjectTypePayload(plan: RepositoryCreationPlan): SapObjectTypeCreationPayload {
  if (!plan.payload || typeof plan.payload !== 'object') throw new Error('SAP Object Type creation payload is unavailable.')
  return plan.payload as SapObjectTypeCreationPayload
}

function contractHash(
  discovery: SapObjectTypeDiscoveryContract,
  contract: ControlledSapObjectTypeCreationContract
): string {
  return createHash('sha256').update(stableJson({ discovery, contract })).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeContentType(value: string): string {
  return String(value || '').split(';').map(part => part.trim().toLowerCase()).filter(Boolean).join('; ')
}

function baseContentType(value: string): string {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unknownWrite(operation: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${operation} outcome is unknown: ${errorText(error)}`)
}

async function validateSapObjectType(
  client: ControlledCreationAdtClient,
  input: ControlledSapObjectTypeShellInput,
  content: ControlledSapObjectTypeCreationContent
) {
  if (!client.validateControlledSapObjectType) throw new Error('Controlled SAP Object Type validation is unavailable.')
  return client.validateControlledSapObjectType(input, content)
}

async function readCreationContract(client: ControlledCreationAdtClient) {
  if (!client.readControlledSapObjectTypeCreationContract) throw new Error('Controlled SAP Object Type schema reading is unavailable.')
  return client.readControlledSapObjectTypeCreationContract()
}

async function createSapObjectType(
  client: ControlledCreationAdtClient,
  input: ControlledSapObjectTypeShellInput,
  content: ControlledSapObjectTypeCreationContent,
  contentType: string
) {
  if (!client.createControlledSapObjectType) throw new Error('Controlled SAP Object Type creation is unavailable.')
  return client.createControlledSapObjectType(input, content, contentType)
}

async function readSapObjectTypeContent(
  client: ControlledCreationAdtClient,
  url: string,
  contentType: string,
  version: 'active' | 'inactive' | 'workingArea'
) {
  if (!client.readControlledSapObjectTypeContent) throw new Error('Controlled SAP Object Type content reading is unavailable.')
  return client.readControlledSapObjectTypeContent(url, contentType, version)
}
