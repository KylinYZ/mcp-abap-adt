import { createHash } from 'crypto'
import {
  assertControlledNumberRangeObjectSchema,
  controlledNumberRangeObjectUrl,
  NUMBER_RANGE_OBJECT_COLLECTION_PATH,
  NUMBER_RANGE_OBJECT_CONTENT_TYPE,
  NUMBER_RANGE_OBJECT_SHELL_CONTENT_TYPE,
  type ControlledNumberRangeObjectContent,
  type ControlledNumberRangeObjectShellInput,
  type Link,
  type NumberRangeObjectAbapLanguageVersion,
  type NumberRangeObjectBuffering
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

interface NumberRangeReferenceState {
  numberLengthDomain: {
    name: string
    uri: string
    datatype: string
    length: number
  }
  subType?: {
    name: string
    uri: string
    domainName: string
    domainUri: string
    domainLength: number
    valueTableRef: string
  }
  transactionId?: {
    name: string
    uri: string
  }
}

interface NumberRangeObjectCreationPayload {
  input: ControlledNumberRangeObjectShellInput
  content: ControlledNumberRangeObjectContent
  objectUrl: string
  packageUrl: string
  shellContentType: string
  schemaHash: string
  references: NumberRangeReferenceState
}

export class NumberRangeObjectCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'NUMBER_RANGE_OBJECT' as Extract<RepositoryObjectKind, 'NUMBER_RANGE_OBJECT'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 10)
    const description = requiredString(request, 'description', 60)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)

    const contentValues = contentValuesFromRequest(request)
    if (contentValues.prefix && !contentValues.subType) {
      throw new Error('prefix=true requires an active subType data element.')
    }

    const targetMatches = await this.client.searchObject(name, 'NROB/NRO', 10)
    assertTargetAbsent(targetMatches, name, 'NROB/NRO')
    const packageMatches = await this.client.searchObject(packageName, 'DEVC/K', 10)
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)

    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, transportRequest })
    const content = contentInput(input, contentValues)
    assertValidation(await validateNumberRangeObject(this.client, input), name)
    const schema = await readNumberRangeObjectSchema(this.client)
    assertControlledNumberRangeObjectSchema(schema)
    const shellContentType = await resolveShellContentType(this.client)
    // Resolve semantic dependencies during preview so apply can detect replacement or drift.
    const references = await resolveReferenceState(this.client, content)
    const transportInfo = await this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I')
    const transportDetails = await this.client.transportDetails(transportRequest)
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledNumberRangeObjectUrl(name)

    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'NROB/NRO', parentName: packageName },
      transportRequest,
      summary: `Create Number Range Object ${name} in package ${packageName}.`,
      payload: {
        input,
        content,
        objectUrl,
        packageUrl: packageObject['adtcore:uri'],
        shellContentType,
        schemaHash: hashSchema(schema),
        references
      } satisfies NumberRangeObjectCreationPayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        transportRequest,
        interval: content.interval,
        configuration: content.configuration,
        abapLanguageVersion: content.header.abapLanguageVersion,
        resolvedReferences: references,
        shellContract: {
          adtType: 'NROB/NRO',
          objectUrl,
          shellContentType,
          contentType: NUMBER_RANGE_OBJECT_CONTENT_TYPE,
          schemaFramework: 'objectTypes.v1',
          formatVersion: '1'
        }
      },
      compensationLimits: [
        'Only a Number Range Object proven to have been created by the current plan may be deleted.',
        'Unknown shell, JSON content, unlock, or activation outcomes stop automatic compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = numberRangeObjectPayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'NROB/NRO', 10), payload.input.name, 'NROB/NRO')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await validateNumberRangeObject(this.client, payload.input), payload.input.name)
    const schema = await readNumberRangeObjectSchema(this.client)
    assertControlledNumberRangeObjectSchema(schema)
    if (hashSchema(schema) !== payload.schemaHash) throw new Error('ADT Number Range Object schema changed after preview.')
    recordStage('REVALIDATE_SCHEMA', true)
    const currentShellContentType = await resolveShellContentType(this.client)
    if (currentShellContentType !== payload.shellContentType) {
      throw new Error('ADT Number Range Object shell content type changed after preview.')
    }
    const references = await resolveReferenceState(this.client, payload.content)
    if (stableJson(references) !== stableJson(payload.references)) {
      throw new Error('A Number Range Object dependency changed after preview.')
    }
    recordStage('REVALIDATE_REFERENCES', true)
    const transportInfo = await this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I')
    const transportDetails = await this.client.transportDetails(payload.input.transportRequest)
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let creation
    try {
      creation = await createNumberRangeObject(this.client, payload.input, payload.shellContentType)
    } catch (error) {
      throw unknownWrite('Number Range Object shell create', error)
    }
    plan.actualResources = [{ type: 'NROB/NRO', name: payload.input.name }]
    recordStage('CREATE_SHELL', true, creation.location)

    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertNumberRangeObjectIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input, 'inactive')
    const contentLink = sourceLink(inactive.links || [], payload.objectUrl)
    recordStage('RESOLVE_CREATED_OBJECT', true, contentLink.url)

    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      try {
        await writeNumberRangeObjectContent(
          this.client,
          contentLink.url,
          payload.content,
          contentLink.contentType,
          lock.LOCK_HANDLE,
          payload.input.transportRequest
        )
      } catch (error) {
        throw unknownWrite('Number Range Object JSON content write', error)
      }
      recordStage('WRITE_CONTENT', true)
      const workingContent = await readNumberRangeObjectContent(this.client, contentLink.url, contentLink.contentType, 'workingArea')
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
      throw unknownWrite('Number Range Object unlock', unlockError)
    }
    if (operationError) throw operationError

    let activation
    try {
      activation = await this.client.activate(payload.input.name, payload.objectUrl, undefined, true)
    } catch (error) {
      throw unknownWrite('Number Range Object activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)

    const active = await this.client.objectStructure(payload.objectUrl, 'active')
    assertNumberRangeObjectIdentity(active.metaData as unknown as Record<string, unknown>, payload.input, 'active')
    const activeLink = sourceLink(active.links || [], payload.objectUrl)
    const activeContent = await readNumberRangeObjectContent(this.client, activeLink.url, activeLink.contentType, 'active')
    assertContentMatches(payload.content, activeContent)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_ACTIVE_CONTENT', true)
    return {
      resultSummary: `Created, activated, and verified Number Range Object ${payload.input.name}.`,
      actualResources: [{ type: 'NROB/NRO', name: payload.input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = numberRangeObjectPayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'NROB/NRO' && resource.name === payload.input.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`Number Range Object compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'NROB/NRO', 10), payload.input.name, 'NROB/NRO')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveShellContentType(client: ControlledCreationAdtClient): Promise<string> {
  const result = await client.findCollectionByUrl?.(NUMBER_RANGE_OBJECT_COLLECTION_PATH)
  const accepted = result?.collection.acceptedContentTypes || []
  const exact = accepted.find(type => baseContentType(type) === NUMBER_RANGE_OBJECT_SHELL_CONTENT_TYPE)
  if (!exact) throw new Error('ADT discovery did not expose the reviewed Blue v1 shell content type for Number Range Object creation.')
  return exact
}

function sourceLink(links: Link[], objectUrl: string): { url: string; contentType: string } {
  const source = links.find(link => link.rel === 'http://www.sap.com/adt/relations/source'
    && link.type && !/^text\/html(?:\s*;|$)/i.test(link.type))
  if (!source?.href || !source.type) throw new Error('Created Number Range Object did not expose its JSON source link.')
  const contentType = normalizeContentType(source.type)
  const resolved = new URL(source.href, `https://adt.invalid${objectUrl}`).pathname
  if (!resolved.startsWith(`${NUMBER_RANGE_OBJECT_COLLECTION_PATH}/`)) {
    throw new Error('Number Range Object source link escaped the controlled ADT collection.')
  }
  return { url: resolved, contentType }
}

async function resolveReferenceState(
  client: ControlledCreationAdtClient,
  content: ControlledNumberRangeObjectContent
): Promise<NumberRangeReferenceState> {
  const numberLengthDomain = await resolveDomain(client, content.interval.numberLengthDomain, 1, 20, true)
  let subType: NumberRangeReferenceState['subType']
  if (content.interval.subType) {
    if (!client.getDataElementProperties) throw new Error('Controlled Data Element property reading is unavailable.')
    const dataElement = await exactObject(client, content.interval.subType, 'DTEL/DE')
    const dataElementProperties = await client.getDataElementProperties(dataElement.uri, 'active')
    if (String(dataElementProperties.metaData.name || '').toUpperCase() !== content.interval.subType) {
      throw new Error(`Data Element ${content.interval.subType} did not match its active property resource.`)
    }
    const domainName = String(dataElementProperties.properties.typeName || '').toUpperCase()
    if (!domainName) throw new Error(`Data Element ${content.interval.subType} is not based on a DDIC domain.`)
    const domain = await resolveDomain(client, domainName, 1, 6, false)
    if (!domain.valueTableRef) {
      throw new Error(`The domain behind Data Element ${content.interval.subType} does not define the check table required for a Number Range subobject.`)
    }
    subType = {
      name: content.interval.subType,
      uri: dataElement.uri,
      domainName: domain.name,
      domainUri: domain.uri,
      domainLength: domain.length,
      valueTableRef: domain.valueTableRef
    }
  }

  let transactionId: NumberRangeReferenceState['transactionId']
  if (content.configuration.transactionId) {
    const transaction = await exactObject(client, content.configuration.transactionId, 'TRAN/T')
    const structure = await client.objectStructure(transaction.uri, 'active')
    const metadata = structure.metaData as unknown as Record<string, unknown>
    if (String(metadata['adtcore:name'] || '').toUpperCase() !== content.configuration.transactionId
      || String(metadata['adtcore:type'] || '').toUpperCase() !== 'TRAN/T'
      || String(metadata['adtcore:version'] || '').toLowerCase() !== 'active') {
      throw new Error(`Transaction ${content.configuration.transactionId} is not active.`)
    }
    transactionId = transaction
  }
  return { numberLengthDomain, ...(subType ? { subType } : {}), ...(transactionId ? { transactionId } : {}) }
}

async function resolveDomain(
  client: ControlledCreationAdtClient,
  name: string,
  minimumLength: number,
  maximumLength: number,
  restrictType: boolean
): Promise<NumberRangeReferenceState['numberLengthDomain'] & { valueTableRef: string }> {
  if (!client.getDomainProperties) throw new Error('Controlled Domain property reading is unavailable.')
  const domain = await exactObject(client, name, 'DOMA/DD')
  const current = await client.getDomainProperties(domain.uri, 'active')
  const datatype = String(current.properties.typeInformation.datatype || '').toUpperCase()
  const length = Number(current.properties.typeInformation.length)
  if (String(current.metaData.name || '').toUpperCase() !== name
    || (restrictType && !['CHAR', 'NUMC'].includes(datatype))
    || !Number.isInteger(length)
    || length < minimumLength
    || length > maximumLength) {
    const typeRule = restrictType ? 'CHAR or NUMC and ' : ''
    throw new Error(`Domain ${name} must be active, ${typeRule}${minimumLength}-${maximumLength} characters long.`)
  }
  return {
    name,
    uri: domain.uri,
    datatype,
    length,
    valueTableRef: String(current.properties.valueInformation?.valueTableRef || '').toUpperCase()
  }
}

async function exactObject(
  client: ControlledCreationAdtClient,
  name: string,
  adtType: string
): Promise<{ name: string; uri: string }> {
  const matches = await client.searchObject(name, adtType, 10)
  const exact = matches.filter(item => item['adtcore:name'].toUpperCase() === name
    && item['adtcore:type'].toUpperCase() === adtType)
  if (exact.length !== 1 || !exact[0]['adtcore:uri']) throw new Error(`${adtType} dependency ${name} was not resolved uniquely.`)
  return { name, uri: exact[0]['adtcore:uri'] }
}

function contentInput(
  input: ControlledNumberRangeObjectShellInput,
  values: ReturnType<typeof contentValuesFromRequest>
): ControlledNumberRangeObjectContent {
  const originalLanguage = input.masterLanguage.toLowerCase()
  if (!/^[a-z]{2}$/.test(originalLanguage)) {
    throw new Error(`Package ${input.packageName} did not expose a two-letter original language required by objectTypes.v1.`)
  }
  return {
    formatVersion: '1',
    header: {
      description: input.description,
      originalLanguage,
      abapLanguageVersion: values.abapLanguageVersion
    },
    interval: {
      numberLengthDomain: values.numberLengthDomain,
      percentWarning: values.percentWarning,
      subType: values.subType,
      untilYear: values.untilYear,
      rolling: values.rolling,
      prefix: values.prefix
    },
    configuration: {
      ...(values.transactionId ? { transactionId: values.transactionId } : {}),
      buffering: values.buffering,
      bufferedNumbers: values.bufferedNumbers
    }
  }
}

function contentValuesFromRequest(request: Record<string, unknown>) {
  return {
    numberLengthDomain: repositoryName(request, 'numberLengthDomain', 30),
    percentWarning: requiredNumber(request, 'percentWarning', 0.1, 99.9),
    subType: optionalRepositoryName(request.subType, 'subType', 30),
    untilYear: requiredBoolean(request, 'untilYear'),
    rolling: requiredBoolean(request, 'rolling'),
    prefix: requiredBoolean(request, 'prefix'),
    transactionId: optionalBoundedName(request.transactionId, 'transactionId', 20),
    buffering: buffering(request.buffering),
    bufferedNumbers: requiredInteger(request, 'bufferedNumbers', 0, 99999999),
    abapLanguageVersion: languageVersion(request.abapLanguageVersion)
  }
}

function assertContentMatches(expected: ControlledNumberRangeObjectContent, actual: ControlledNumberRangeObjectContent): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error('Number Range Object content does not match the confirmed plan.')
  }
}

function assertNumberRangeObjectIdentity(
  metadata: Record<string, unknown>,
  input: ControlledNumberRangeObjectShellInput,
  expectedVersion: 'active' | 'inactive'
): void {
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== input.name
    || String(metadata['adtcore:type'] || '').toUpperCase() !== 'NROB/NRO'
    || String(metadata['adtcore:version'] || '').toLowerCase() !== expectedVersion) {
    throw new Error(`Created Number Range Object ${input.name} does not match the confirmed plan.`)
  }
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledNumberRangeObjectShellInput, 'name' | 'description' | 'packageName' | 'transportRequest'>
): ControlledNumberRangeObjectShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function numberRangeObjectPayload(plan: RepositoryCreationPlan): NumberRangeObjectCreationPayload {
  const payload = plan.payload as NumberRangeObjectCreationPayload | undefined
  if (!payload?.input?.name || !payload.content || !payload.shellContentType || !payload.schemaHash || !payload.references) {
    throw new Error('Number Range Object creation plan payload is unavailable.')
  }
  return payload
}

function requiredBoolean(request: Record<string, unknown>, key: string): boolean {
  if (request[key] !== true && request[key] !== false) throw new Error(`${key} must be boolean.`)
  return request[key] as boolean
}

function requiredNumber(request: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = request[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}.`)
  }
  return value
}

function requiredInteger(request: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = requiredNumber(request, key, minimum, maximum)
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer.`)
  return value
}

function optionalRepositoryName(value: unknown, key: string, maximum: number): string {
  if (value === undefined || value === null || value === '') return ''
  return repositoryName({ [key]: value }, key, maximum)
}

function optionalBoundedName(value: unknown, key: string, maximum: number): string {
  if (value === undefined || value === null || value === '') return ''
  return requiredString({ [key]: value }, key, maximum).toUpperCase()
}

function buffering(value: unknown): NumberRangeObjectBuffering {
  if (!['mainBuffer', 'parallel', 'none'].includes(String(value || ''))) {
    throw new Error("buffering must be 'mainBuffer', 'parallel', or 'none'.")
  }
  return value as NumberRangeObjectBuffering
}

function languageVersion(value: unknown): NumberRangeObjectAbapLanguageVersion {
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

function normalizeContentType(value: string): string {
  if (baseContentType(value) !== NUMBER_RANGE_OBJECT_CONTENT_TYPE) {
    throw new Error('Number Range Object source link did not expose the reviewed application/json content type.')
  }
  return NUMBER_RANGE_OBJECT_CONTENT_TYPE
}

async function validateNumberRangeObject(client: ControlledCreationAdtClient, input: ControlledNumberRangeObjectShellInput) {
  if (!client.validateControlledNumberRangeObject) throw new Error('Controlled Number Range Object validation is not available in this ADT client.')
  return client.validateControlledNumberRangeObject(input)
}

async function readNumberRangeObjectSchema(client: ControlledCreationAdtClient): Promise<unknown> {
  if (!client.readControlledNumberRangeObjectSchema) throw new Error('Controlled Number Range Object schema discovery is not available in this ADT client.')
  return client.readControlledNumberRangeObjectSchema()
}

async function createNumberRangeObject(client: ControlledCreationAdtClient, input: ControlledNumberRangeObjectShellInput, contentType: string) {
  if (!client.createControlledNumberRangeObjectShell) throw new Error('Controlled Number Range Object shell creation is not available in this ADT client.')
  return client.createControlledNumberRangeObjectShell(input, contentType)
}

async function readNumberRangeObjectContent(
  client: ControlledCreationAdtClient,
  contentUrl: string,
  contentType: string,
  version: 'active' | 'inactive' | 'workingArea'
) {
  if (!client.readControlledNumberRangeObjectContent) throw new Error('Controlled Number Range Object content reading is not available in this ADT client.')
  return client.readControlledNumberRangeObjectContent(contentUrl, contentType, version)
}

async function writeNumberRangeObjectContent(
  client: ControlledCreationAdtClient,
  contentUrl: string,
  content: ControlledNumberRangeObjectContent,
  contentType: string,
  lockHandle: string,
  transportRequest: string
) {
  if (!client.writeControlledNumberRangeObjectContent) throw new Error('Controlled Number Range Object content writing is not available in this ADT client.')
  return client.writeControlledNumberRangeObjectContent(contentUrl, content, contentType, lockHandle, transportRequest)
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
