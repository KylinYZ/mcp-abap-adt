import { createHash } from 'crypto'
import {
  assertControlledSapObjectNodeTypeCreationContract,
  buildControlledSapObjectNodeTypeCreationContent,
  controlledSapObjectNodeTypeUrl,
  SAP_OBJECT_NODE_TYPE_ADDITIONAL_CONTENT_TYPE,
  SAP_OBJECT_NODE_TYPE_COLLECTION_PATH,
  SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_PATH,
  SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_CONTENT_TYPE,
  SAP_OBJECT_NODE_TYPE_NEW_CONTENT_PATH,
  SAP_OBJECT_NODE_TYPE_NEW_CONTENT_TYPE,
  SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_PATH,
  SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_CONTENT_TYPE,
  SAP_OBJECT_NODE_TYPE_SHELL_CONTENT_TYPE,
  SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE,
  SAP_OBJECT_TYPE_COLLECTION_PATH,
  SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE,
  type ControlledSapObjectNodeTypeContent,
  type ControlledSapObjectNodeTypeCreationContent,
  type ControlledSapObjectNodeTypeCreationContract,
  type ControlledSapObjectNodeTypeShellInput,
  type ControlledSapObjectTypeContent,
  type Link
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

interface SapObjectNodeTypeCreationPayload {
  input: ControlledSapObjectNodeTypeShellInput
  creationContent: ControlledSapObjectNodeTypeCreationContent
  objectUrl: string
  packageUrl: string
  shellContentType: string
  contractHash: string
  sapObjectTypeReference: {
    repositoryName: string
    semanticName: string
    uri: string
  }
}

interface SapObjectNodeTypeDiscoveryContract {
  shellContentType: string
  schemaType: string
  configurationType: string
  contentType: string
}

export class SapObjectNodeTypeCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'SAP_OBJECT_NODE_TYPE' as Extract<RepositoryObjectKind, 'SAP_OBJECT_NODE_TYPE'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const semanticName = sapObjectNodeTypeName(request.name)
    const repositoryObjectName = semanticName.toUpperCase()
    const description = requiredString(request, 'description', 60)
    const packageName = repositoryName(request, 'packageName', 30)
    const sapObjectTypeName = uppercaseRepositoryName(request, 'sapObjectTypeName', 30)
    const rootNode = requiredBoolean(request, 'rootNode')
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(repositoryObjectName)
    this.policy.assertTransportablePackage(packageName)

    assertTargetAbsent(
      await this.client.searchObject(repositoryObjectName, 'NONT/NOT', 10),
      repositoryObjectName,
      'NONT/NOT'
    )
    const packageMatches = await this.client.searchObject(packageName, 'DEVC/K', 10)
    const packageObject = exactObject(packageMatches, packageName, 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)
    const sapObjectTypeMatches = await this.client.searchObject(sapObjectTypeName, 'RONT/ROT', 10)
    const sapObjectTypeObject = exactObject(sapObjectTypeMatches, sapObjectTypeName, 'RONT/ROT')
    if (!sapObjectTypeObject) throw new Error(`SAP Object Type ${sapObjectTypeName} was not found.`)
    const sapObjectTypeReference = await readActiveSapObjectTypeReference(
      this.client,
      sapObjectTypeObject['adtcore:uri'],
      sapObjectTypeName
    )

    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, {
      repositoryName: repositoryObjectName,
      semanticName,
      description,
      packageName,
      transportRequest,
      sapObjectTypeName,
      rootNode
    })
    const creationContent = buildControlledSapObjectNodeTypeCreationContent(input)
    assertValidation(await validateSapObjectNodeType(this.client, input, creationContent), repositoryObjectName)
    const discoveryContract = await resolveDiscoveryContract(this.client)
    const creationContract = await readCreationContract(this.client)
    assertControlledSapObjectNodeTypeCreationContract(creationContract)

    const transportInfo = await this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I')
    const transportDetails = await this.client.transportDetails(transportRequest)
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledSapObjectNodeTypeUrl(repositoryObjectName)

    return {
      target: {
        objectKind: this.objectKind,
        objectName: repositoryObjectName,
        adtType: 'NONT/NOT',
        parentName: packageName
      },
      transportRequest,
      summary: `Create SAP Object Node Type ${semanticName} (${repositoryObjectName}) for ${sapObjectTypeReference.semanticName}.`,
      payload: {
        input,
        creationContent,
        objectUrl,
        packageUrl: packageObject['adtcore:uri'],
        shellContentType: discoveryContract.shellContentType,
        contractHash: contractHash(discoveryContract, creationContract),
        sapObjectTypeReference
      } satisfies SapObjectNodeTypeCreationPayload,
      review: {
        objectKind: this.objectKind,
        name: semanticName,
        repositoryName: repositoryObjectName,
        description,
        packageName,
        sapObjectTypeName,
        sapObjectTypeSemanticName: sapObjectTypeReference.semanticName,
        rootNode,
        transportRequest,
        derivedMetadata: creationContent.metadata,
        shellContract: {
          adtType: 'NONT/NOT',
          objectUrl,
          shellContentType: discoveryContract.shellContentType,
          additionalContentType: SAP_OBJECT_NODE_TYPE_ADDITIONAL_CONTENT_TYPE,
          sourceContentType: SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE,
          schemaFramework: 'newObjectTypes.v1'
        }
      },
      compensationLimits: [
        'Only an SAP Object Node Type proven to have been created by the current plan may be deleted.',
        'Unknown Blue shell, activation, or delete outcomes stop automatic retry and compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = sapObjectNodeTypePayload(plan)
    assertTargetAbsent(
      await this.client.searchObject(payload.input.repositoryName, 'NONT/NOT', 10),
      payload.input.repositoryName,
      'NONT/NOT'
    )
    recordStage('REVALIDATE_ABSENCE', true)

    const referenceMatches = await this.client.searchObject(payload.sapObjectTypeReference.repositoryName, 'RONT/ROT', 10)
    const reference = exactObject(referenceMatches, payload.sapObjectTypeReference.repositoryName, 'RONT/ROT')
    if (!reference || reference['adtcore:uri'] !== payload.sapObjectTypeReference.uri) {
      throw new Error(`SAP Object Type ${payload.sapObjectTypeReference.repositoryName} no longer matches the confirmed plan.`)
    }
    const activeReference = await readActiveSapObjectTypeReference(
      this.client,
      reference['adtcore:uri'],
      payload.sapObjectTypeReference.repositoryName
    )
    if (activeReference.semanticName !== payload.sapObjectTypeReference.semanticName) {
      throw new Error(`SAP Object Type ${payload.sapObjectTypeReference.repositoryName} semantic identity changed after preview.`)
    }
    recordStage('REVALIDATE_REFERENCE', true, activeReference.semanticName)

    assertValidation(
      await validateSapObjectNodeType(this.client, payload.input, payload.creationContent),
      payload.input.repositoryName
    )
    const discoveryContract = await resolveDiscoveryContract(this.client)
    const creationContract = await readCreationContract(this.client)
    assertControlledSapObjectNodeTypeCreationContract(creationContract)
    if (contractHash(discoveryContract, creationContract) !== payload.contractHash
      || discoveryContract.shellContentType !== payload.shellContentType) {
      throw new Error('ADT SAP Object Node Type creation contract changed after preview.')
    }
    recordStage('REVALIDATE_CONTRACT', true)

    const transportInfo = await this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I')
    const transportDetails = await this.client.transportDetails(payload.input.transportRequest)
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let creation
    try {
      creation = await createSapObjectNodeType(
        this.client,
        payload.input,
        payload.creationContent,
        payload.shellContentType
      )
    } catch (error) {
      throw unknownWrite('SAP Object Node Type Blue shell create', error)
    }
    plan.actualResources = [{ type: 'NONT/NOT', name: payload.input.repositoryName }]
    recordStage('CREATE_OBJECT', true, creation.location)

    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertSapObjectNodeTypeIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input, 'inactive')
    const inactiveLink = sourceLink(
      inactive.links || [], payload.objectUrl, SAP_OBJECT_NODE_TYPE_COLLECTION_PATH,
      SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE, 'SAP Object Node Type'
    )
    const inactiveContent = await readSapObjectNodeTypeContent(
      this.client, inactiveLink.url, inactiveLink.contentType, 'inactive'
    )
    assertSapObjectNodeTypeContent(
      payload.input, inactiveContent, payload.sapObjectTypeReference.semanticName, 'inactive'
    )
    recordStage('VERIFY_INACTIVE_OBJECT', true)
    recordStage('VERIFY_INACTIVE_CONTENT', true)

    let activation
    try {
      activation = await this.client.activate(payload.input.repositoryName, payload.objectUrl, undefined, true)
    } catch (error) {
      throw unknownWrite('SAP Object Node Type activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)

    const active = await this.client.objectStructure(payload.objectUrl, 'active')
    assertSapObjectNodeTypeIdentity(active.metaData as unknown as Record<string, unknown>, payload.input, 'active')
    const activeLink = sourceLink(
      active.links || [], payload.objectUrl, SAP_OBJECT_NODE_TYPE_COLLECTION_PATH,
      SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE, 'SAP Object Node Type'
    )
    const activeContent = await readSapObjectNodeTypeContent(this.client, activeLink.url, activeLink.contentType, 'active')
    assertSapObjectNodeTypeContent(payload.input, activeContent, payload.sapObjectTypeReference.semanticName, 'active')
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_ACTIVE_CONTENT', true)
    return {
      resultSummary: `Created, activated, and verified SAP Object Node Type ${payload.input.semanticName}.`,
      actualResources: [{ type: 'NONT/NOT', name: payload.input.repositoryName }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = sapObjectNodeTypePayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'NONT/NOT'
      && resource.name === payload.input.repositoryName)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`SAP Object Node Type compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(
      await this.client.searchObject(payload.input.repositoryName, 'NONT/NOT', 10),
      payload.input.repositoryName,
      'NONT/NOT'
    )
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveDiscoveryContract(client: ControlledCreationAdtClient): Promise<SapObjectNodeTypeDiscoveryContract> {
  const result = await client.findCollectionByUrl?.(SAP_OBJECT_NODE_TYPE_COLLECTION_PATH)
  const collection = result?.collection
  if (!collection) throw new Error('ADT discovery did not expose SAP Object Node Type creation.')
  const shellContentType = (collection.acceptedContentTypes || [])
    .find(type => baseContentType(type) === SAP_OBJECT_NODE_TYPE_SHELL_CONTENT_TYPE)
  if (!shellContentType) throw new Error('ADT discovery did not expose the reviewed Blue v2 SAP Object Node Type shell.')
  const schemaType = templateType(collection.templateLinks, 'http://www.sap.com/adt/categories/objects/new/schema/additional', SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_PATH, SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_CONTENT_TYPE)
  const configurationType = templateType(collection.templateLinks, 'http://www.sap.com/adt/categories/objects/new/configuration/additional', SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_PATH, SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_CONTENT_TYPE)
  const contentType = templateType(collection.templateLinks, 'http://www.sap.com/adt/categories/objects/new/content/additional', SAP_OBJECT_NODE_TYPE_NEW_CONTENT_PATH, SAP_OBJECT_NODE_TYPE_NEW_CONTENT_TYPE)
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
    throw new Error(`ADT discovery did not expose the reviewed SAP Object Node Type ${contractName} contract.`)
  }
  return normalizeContentType(link.type)
}

async function readActiveSapObjectTypeReference(
  client: ControlledCreationAdtClient,
  objectUrl: string,
  repositoryNameValue: string
): Promise<{ repositoryName: string; semanticName: string; uri: string }> {
  if (!objectUrl.startsWith(`${SAP_OBJECT_TYPE_COLLECTION_PATH}/`)) {
    throw new Error(`SAP Object Type ${repositoryNameValue} escaped the controlled RONT collection.`)
  }
  const structure = await client.objectStructure(objectUrl, 'active')
  const metadata = structure.metaData as unknown as Record<string, unknown>
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== repositoryNameValue
    || String(metadata['adtcore:type'] || '').toUpperCase() !== 'RONT/ROT'
    || String(metadata['adtcore:version'] || '').toLowerCase() !== 'active') {
    throw new Error(`SAP Object Type ${repositoryNameValue} is not the required active RONT/ROT reference.`)
  }
  const link = sourceLink(
    structure.links || [], objectUrl, SAP_OBJECT_TYPE_COLLECTION_PATH,
    SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE, 'SAP Object Type'
  )
  const content = await readSapObjectTypeContent(client, link.url, link.contentType)
  return { repositoryName: repositoryNameValue, semanticName: content.name, uri: objectUrl }
}

function sourceLink(
  links: Link[],
  objectUrl: string,
  collectionPath: string,
  expectedContentType: string,
  label: string
): { url: string; contentType: string } {
  const source = links.find(link => link.rel === 'http://www.sap.com/adt/relations/source'
    && link.type && !/^text\/html(?:\s*;|$)/i.test(link.type))
  if (!source?.href || !source.type) throw new Error(`Created ${label} did not expose its JSON source link.`)
  const contentType = baseContentType(source.type)
  if (contentType !== expectedContentType) throw new Error(`${label} source link did not use application/json.`)
  const resolved = new URL(source.href, `https://adt.invalid${objectUrl}`).pathname
  if (!resolved.startsWith(`${collectionPath}/`)) throw new Error(`${label} source link escaped the controlled ADT collection.`)
  return { url: resolved, contentType }
}

function assertSapObjectNodeTypeIdentity(
  metadata: Record<string, unknown>,
  input: ControlledSapObjectNodeTypeShellInput,
  expectedVersion: 'active' | 'inactive'
): void {
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== input.repositoryName
    || String(metadata['adtcore:type'] || '').toUpperCase() !== 'NONT/NOT'
    || String(metadata['adtcore:version'] || '').toLowerCase() !== expectedVersion) {
    throw new Error(`Created SAP Object Node Type ${input.repositoryName} does not match the confirmed plan.`)
  }
}

function assertSapObjectNodeTypeContent(
  input: ControlledSapObjectNodeTypeShellInput,
  content: ControlledSapObjectNodeTypeContent,
  sapObjectTypeSemanticName: string,
  expectedVersion: 'active' | 'inactive'
): void {
  const language = input.masterLanguage.toLowerCase()
  // The inactive document may retain the creation-time repository identity;
  // active content must expose the frozen CamelCase RONT semantic identity.
  const validReference = expectedVersion === 'active'
    ? content.sapObjectType === sapObjectTypeSemanticName
    : [input.sapObjectTypeName, sapObjectTypeSemanticName].includes(content.sapObjectType)
  if (content.formatVersion !== '1'
    || content.header.description !== input.description
    || content.header.originalLanguage !== language
    || content.name !== input.semanticName
    || !validReference
    || (content.rootNode ?? false) !== input.rootNode) {
    throw new Error('SAP Object Node Type content does not match the confirmed plan.')
  }
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<
    ControlledSapObjectNodeTypeShellInput,
    'repositoryName' | 'semanticName' | 'description' | 'packageName' | 'transportRequest' | 'sapObjectTypeName' | 'rootNode'
  >
): ControlledSapObjectNodeTypeShellInput {
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

function sapObjectNodeTypeName(value: unknown): string {
  const name = String(value || '').trim()
  if (!/^[A-Z][A-Za-z0-9]{0,29}$/.test(name)) {
    throw new Error('SAP Object Node Type name must be a 1-30 character PascalCase identifier.')
  }
  return name
}

function uppercaseRepositoryName(request: Record<string, unknown>, key: string, maximum: number): string {
  const raw = requiredString(request, key, maximum)
  const normalized = repositoryName(request, key, maximum)
  if (raw !== normalized) throw new Error(`${key} must be the uppercase RONT repository name.`)
  return normalized
}

function requiredBoolean(request: Record<string, unknown>, key: string): boolean {
  if (typeof request[key] !== 'boolean') throw new Error(`${key} must be a boolean.`)
  return request[key] as boolean
}

function exactObject<T extends { 'adtcore:name': string; 'adtcore:type': string }>(
  values: T[],
  name: string,
  type: string
): T | undefined {
  return values.find(value => value['adtcore:name'].toUpperCase() === name
    && value['adtcore:type'].toUpperCase() === type)
}

function sapObjectNodeTypePayload(plan: RepositoryCreationPlan): SapObjectNodeTypeCreationPayload {
  if (!plan.payload || typeof plan.payload !== 'object') throw new Error('SAP Object Node Type creation payload is unavailable.')
  return plan.payload as SapObjectNodeTypeCreationPayload
}

function contractHash(
  discovery: SapObjectNodeTypeDiscoveryContract,
  contract: ControlledSapObjectNodeTypeCreationContract
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

async function validateSapObjectNodeType(
  client: ControlledCreationAdtClient,
  input: ControlledSapObjectNodeTypeShellInput,
  content: ControlledSapObjectNodeTypeCreationContent
) {
  if (!client.validateControlledSapObjectNodeType) throw new Error('Controlled SAP Object Node Type validation is unavailable.')
  return client.validateControlledSapObjectNodeType(input, content)
}

async function readCreationContract(client: ControlledCreationAdtClient) {
  if (!client.readControlledSapObjectNodeTypeCreationContract) throw new Error('Controlled SAP Object Node Type schema reading is unavailable.')
  return client.readControlledSapObjectNodeTypeCreationContract()
}

async function createSapObjectNodeType(
  client: ControlledCreationAdtClient,
  input: ControlledSapObjectNodeTypeShellInput,
  content: ControlledSapObjectNodeTypeCreationContent,
  contentType: string
) {
  if (!client.createControlledSapObjectNodeType) throw new Error('Controlled SAP Object Node Type creation is unavailable.')
  return client.createControlledSapObjectNodeType(input, content, contentType)
}

async function readSapObjectNodeTypeContent(
  client: ControlledCreationAdtClient,
  url: string,
  contentType: string,
  version: 'active' | 'inactive' | 'workingArea'
) {
  if (!client.readControlledSapObjectNodeTypeContent) throw new Error('Controlled SAP Object Node Type content reading is unavailable.')
  return client.readControlledSapObjectNodeTypeContent(url, contentType, version)
}

async function readSapObjectTypeContent(
  client: ControlledCreationAdtClient,
  url: string,
  contentType: string
): Promise<ControlledSapObjectTypeContent> {
  if (!client.readControlledSapObjectTypeContent) throw new Error('Controlled SAP Object Type content reading is unavailable.')
  return client.readControlledSapObjectTypeContent(url, contentType, 'active')
}
