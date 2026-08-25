import { createHash } from 'crypto'
import {
  assertControlledLogicalExternalSchemaSchema,
  controlledLogicalExternalSchemaUrl,
  LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH,
  LOGICAL_EXTERNAL_SCHEMA_CONTENT_TYPE,
  LOGICAL_EXTERNAL_SCHEMA_SHELL_CONTENT_TYPE,
  normalizeLogicalExternalSchemaContentType,
  type ControlledLogicalExternalSchemaContent,
  type ControlledLogicalExternalSchemaShellInput,
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

interface LogicalExternalSchemaCreationPayload {
  input: ControlledLogicalExternalSchemaShellInput
  content: ControlledLogicalExternalSchemaContent
  objectUrl: string
  packageUrl: string
  shellContentType: string
  schemaHash: string
}

export class LogicalExternalSchemaCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'LOGICAL_EXTERNAL_SCHEMA' as Extract<RepositoryObjectKind, 'LOGICAL_EXTERNAL_SCHEMA'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 30)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const defaultRemoteSchemaName = requiredString(request, 'defaultRemoteSchemaName', 255)
    const abapLanguageVersion = languageVersion(request.abapLanguageVersion)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)

    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'DESD/TYP', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'DESD/TYP')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)

    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, transportRequest })
    const content = contentInput(input, defaultRemoteSchemaName, abapLanguageVersion)
    assertValidation(await validateLogicalExternalSchema(this.client, input), name)
    const schema = await readLogicalExternalSchemaSchema(this.client)
    assertControlledLogicalExternalSchemaSchema(schema)
    const shellContentType = await resolveShellContentType(this.client)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledLogicalExternalSchemaUrl(name)

    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'DESD/TYP', parentName: packageName },
      transportRequest,
      summary: `Create Logical External Schema ${name} in package ${packageName}.`,
      payload: {
        input,
        content,
        objectUrl,
        packageUrl: packageObject['adtcore:uri'],
        shellContentType,
        schemaHash: hashSchema(schema)
      } satisfies LogicalExternalSchemaCreationPayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        transportRequest,
        defaultRemoteSchemaName,
        abapLanguageVersion,
        shellContract: {
          adtType: 'DESD/TYP',
          objectUrl,
          shellContentType,
          contentType: LOGICAL_EXTERNAL_SCHEMA_CONTENT_TYPE,
          formatVersion: '1',
          usesRouting: false
        }
      },
      compensationLimits: [
        'Only a Logical External Schema proven to have been created by the current plan may be deleted.',
        'Unknown shell, JSON content, unlock, or activation outcomes stop automatic compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = logicalExternalSchemaPayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'DESD/TYP', 10), payload.input.name, 'DESD/TYP')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await validateLogicalExternalSchema(this.client, payload.input), payload.input.name)
    const schema = await readLogicalExternalSchemaSchema(this.client)
    assertControlledLogicalExternalSchemaSchema(schema)
    if (hashSchema(schema) !== payload.schemaHash) throw new Error('ADT Logical External Schema schema changed after preview.')
    recordStage('REVALIDATE_SCHEMA', true)
    const currentShellContentType = await resolveShellContentType(this.client)
    if (currentShellContentType !== payload.shellContentType) {
      throw new Error('ADT Logical External Schema shell content type changed after preview.')
    }
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I'),
      this.client.transportDetails(payload.input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let creation
    try {
      creation = await createLogicalExternalSchema(this.client, payload.input, payload.shellContentType)
    } catch (error) {
      throw unknownWrite('Logical External Schema shell create', error)
    }
    plan.actualResources = [{ type: 'DESD/TYP', name: payload.input.name }]
    recordStage('CREATE_SHELL', true, creation.location)

    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertLogicalExternalSchemaIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input, 'inactive')
    const contentLink = sourceLink(inactive.links || [], payload.objectUrl)
    recordStage('RESOLVE_CREATED_OBJECT', true, contentLink.url)
    const initialContent = await readLogicalExternalSchemaContent(this.client, contentLink.url, contentLink.contentType, 'inactive')
    assertRoutingDisabled(initialContent)

    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      try {
        await writeLogicalExternalSchemaContent(
          this.client,
          contentLink.url,
          payload.content,
          contentLink.contentType,
          lock.LOCK_HANDLE,
          payload.input.transportRequest
        )
      } catch (error) {
        throw unknownWrite('Logical External Schema JSON content write', error)
      }
      recordStage('WRITE_CONTENT', true)
      const workingContent = await readLogicalExternalSchemaContent(this.client, contentLink.url, contentLink.contentType, 'workingArea')
      assertContentMatches(payload.content, workingContent)
      recordStage('VERIFY_CONTENT', true)
    } catch (error) {
      operationError = error
    }
    try {
      await this.client.unLock(payload.objectUrl, lock.LOCK_HANDLE)
      recordStage('UNLOCK_RESOURCE', true)
    } catch (unlockError) {
      recordStage('UNLOCK_RESOURCE', false, errorText(unlockError))
      throw unknownWrite('Logical External Schema unlock', unlockError)
    }
    if (operationError) throw operationError

    let activation
    try {
      activation = await this.client.activate(payload.input.name, payload.objectUrl, undefined, true)
    } catch (error) {
      throw unknownWrite('Logical External Schema activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)

    const active = await this.client.objectStructure(payload.objectUrl, 'active')
    assertLogicalExternalSchemaIdentity(active.metaData as unknown as Record<string, unknown>, payload.input, 'active')
    const activeLink = sourceLink(active.links || [], payload.objectUrl)
    const activeContent = await readLogicalExternalSchemaContent(this.client, activeLink.url, activeLink.contentType, 'active')
    assertContentMatches(payload.content, activeContent)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_ACTIVE_CONTENT', true)
    return {
      resultSummary: `Created, activated, and verified Logical External Schema ${payload.input.name}.`,
      actualResources: [{ type: 'DESD/TYP', name: payload.input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = logicalExternalSchemaPayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'DESD/TYP' && resource.name === payload.input.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`Logical External Schema compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'DESD/TYP', 10), payload.input.name, 'DESD/TYP')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveShellContentType(client: ControlledCreationAdtClient): Promise<string> {
  const result = await client.findCollectionByUrl?.(LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH)
  const accepted = result?.collection.acceptedContentTypes || []
  const exact = accepted.find(type => baseContentType(type) === LOGICAL_EXTERNAL_SCHEMA_SHELL_CONTENT_TYPE)
  if (!exact) throw new Error('ADT discovery did not expose the reviewed Blue v1 shell content type for Logical External Schema creation.')
  return exact
}

function sourceLink(links: Link[], objectUrl: string): { url: string; contentType: string } {
  const source = links.find(link => link.rel === 'http://www.sap.com/adt/relations/source'
    && link.type && !/^text\/html(?:\s*;|$)/i.test(link.type))
  if (!source?.href || !source.type) throw new Error('Created Logical External Schema did not expose its server-driven JSON source link.')
  const contentType = normalizeLogicalExternalSchemaContentType(source.type)
  const resolved = new URL(source.href, `https://adt.invalid${objectUrl}`).pathname
  if (!resolved.startsWith(`${LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH}/`)) {
    throw new Error('Logical External Schema source link escaped the controlled ADT collection.')
  }
  return { url: resolved, contentType }
}

function contentInput(
  input: ControlledLogicalExternalSchemaShellInput,
  defaultRemoteSchemaName: string,
  abapLanguageVersion: 'standard' | 'cloudDevelopment'
): ControlledLogicalExternalSchemaContent {
  const originalLanguage = input.masterLanguage.toLowerCase()
  if (!/^[a-z]{2}$/.test(originalLanguage)) {
    throw new Error(`Package ${input.packageName} did not expose a two-letter original language required by objectTypes.v1.`)
  }
  return {
    formatVersion: '1',
    header: { description: input.description, originalLanguage, abapLanguageVersion },
    generalInformation: { defaultRemoteSchemaName }
  }
}

function assertContentMatches(expected: ControlledLogicalExternalSchemaContent, actual: ControlledLogicalExternalSchemaContent): void {
  assertRoutingDisabled(actual)
  if (actual.formatVersion !== expected.formatVersion
    || actual.header.description !== expected.header.description
    || actual.header.originalLanguage !== expected.header.originalLanguage
    || (actual.header.abapLanguageVersion !== undefined
      && actual.header.abapLanguageVersion !== expected.header.abapLanguageVersion)
    || (actual.generalInformation.defaultRemoteSchemaName !== undefined
      && actual.generalInformation.defaultRemoteSchemaName !== expected.generalInformation.defaultRemoteSchemaName)) {
    throw new Error('Logical External Schema content does not match the confirmed plan.')
  }
}

function assertRoutingDisabled(content: ControlledLogicalExternalSchemaContent): void {
  if (content.generalInformation.usesRouting === true) {
    throw new Error('Logical External Schema usesRouting=true is outside the controlled creation contract.')
  }
}

function assertLogicalExternalSchemaIdentity(
  metadata: Record<string, unknown>,
  input: ControlledLogicalExternalSchemaShellInput,
  expectedVersion: 'active' | 'inactive'
): void {
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== input.name
    || String(metadata['adtcore:type'] || '').toUpperCase() !== 'DESD/TYP'
    || String(metadata['adtcore:version'] || '').toLowerCase() !== expectedVersion) {
    throw new Error(`Created Logical External Schema ${input.name} does not match the confirmed plan.`)
  }
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledLogicalExternalSchemaShellInput, 'name' | 'description' | 'packageName' | 'transportRequest'>
): ControlledLogicalExternalSchemaShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function logicalExternalSchemaPayload(plan: RepositoryCreationPlan): LogicalExternalSchemaCreationPayload {
  const payload = plan.payload as LogicalExternalSchemaCreationPayload | undefined
  if (!payload?.input?.name || !payload.content || !payload.shellContentType || !payload.schemaHash) {
    throw new Error('Logical External Schema creation plan payload is unavailable.')
  }
  return payload
}

function languageVersion(value: unknown): 'standard' | 'cloudDevelopment' {
  const normalized = value === undefined ? 'standard' : String(value)
  if (normalized !== 'standard' && normalized !== 'cloudDevelopment') {
    throw new Error("abapLanguageVersion must be 'standard' or 'cloudDevelopment'.")
  }
  return normalized
}

function hashSchema(schema: unknown): string {
  return createHash('sha256').update(stableJson(schema)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function baseContentType(value: string): string {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

async function validateLogicalExternalSchema(client: ControlledCreationAdtClient, input: ControlledLogicalExternalSchemaShellInput) {
  if (!client.validateControlledLogicalExternalSchema) throw new Error('Controlled Logical External Schema validation is not available in this ADT client.')
  return client.validateControlledLogicalExternalSchema(input)
}

async function readLogicalExternalSchemaSchema(client: ControlledCreationAdtClient): Promise<unknown> {
  if (!client.readControlledLogicalExternalSchemaSchema) throw new Error('Controlled Logical External Schema schema discovery is not available in this ADT client.')
  return client.readControlledLogicalExternalSchemaSchema()
}

async function createLogicalExternalSchema(client: ControlledCreationAdtClient, input: ControlledLogicalExternalSchemaShellInput, contentType: string) {
  if (!client.createControlledLogicalExternalSchemaShell) throw new Error('Controlled Logical External Schema shell creation is not available in this ADT client.')
  return client.createControlledLogicalExternalSchemaShell(input, contentType)
}

async function readLogicalExternalSchemaContent(
  client: ControlledCreationAdtClient,
  contentUrl: string,
  contentType: string,
  version: 'active' | 'inactive' | 'workingArea'
) {
  if (!client.readControlledLogicalExternalSchemaContent) throw new Error('Controlled Logical External Schema content reading is not available in this ADT client.')
  return client.readControlledLogicalExternalSchemaContent(contentUrl, contentType, version)
}

async function writeLogicalExternalSchemaContent(
  client: ControlledCreationAdtClient,
  contentUrl: string,
  content: ControlledLogicalExternalSchemaContent,
  contentType: string,
  lockHandle: string,
  transportRequest: string
) {
  if (!client.writeControlledLogicalExternalSchemaContent) throw new Error('Controlled Logical External Schema content writing is not available in this ADT client.')
  return client.writeControlledLogicalExternalSchemaContent(contentUrl, content, contentType, lockHandle, transportRequest)
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
