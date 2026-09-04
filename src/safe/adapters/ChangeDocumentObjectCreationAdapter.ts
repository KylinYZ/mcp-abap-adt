import { createHash } from 'crypto'
import {
  assertControlledChangeDocumentObjectContract,
  CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH,
  CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE,
  CHANGE_DOCUMENT_OBJECT_SHELL_CONTENT_TYPE,
  controlledChangeDocumentObjectUrl,
  toSapChangeDocumentObjectCategory,
  type ChangeDocumentObjectAbapLanguageVersion,
  type ChangeDocumentObjectCategory,
  type ControlledChangeDocumentObjectContent,
  type ControlledChangeDocumentObjectShellInput,
  type ControlledChangeDocumentTableEntry,
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

interface FrozenChangeDocumentReference {
  name: string
  adtType: string
  uri: string
}

interface ChangeDocumentObjectCreationPayload {
  input: ControlledChangeDocumentObjectShellInput
  category: ChangeDocumentObjectCategory
  content: ControlledChangeDocumentObjectContent
  objectUrl: string
  packageUrl: string
  shellContentType: string
  contractHash: string
  tableReferences: FrozenChangeDocumentReference[]
  referenceTableReferences: FrozenChangeDocumentReference[]
  messageClassReference: FrozenChangeDocumentReference
}

const FIXED_ERROR_MESSAGE = { id: 'CD', number: '600' } as const

export class ChangeDocumentObjectCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'CHANGE_DOCUMENT_OBJECT' as Extract<RepositoryObjectKind, 'CHANGE_DOCUMENT_OBJECT'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 15)
    const description = requiredString(request, 'description', 60)
    const packageName = repositoryName(request, 'packageName', 30)
    const category = changeDocumentCategory(request.category)
    const abapLanguageVersion = languageVersion(request.abapLanguageVersion)
    const tablesAndStructures = tableEntries(request.tablesAndStructures)
    if (request.errorMessage !== undefined) {
      throw new Error('errorMessage is a hidden server-owned Change Document Object default and cannot be provided.')
    }
    const errorMessage = { ...FIXED_ERROR_MESSAGE }
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)

    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'CHDO/CHD', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'CHDO/CHD')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)

    const tableReferences = await resolveReferences(
      this.client,
      tablesAndStructures.map(entry => entry.name),
      'TABL',
      ['TABL/DT', 'TABL/DS'],
      'table or structure'
    )
    const referenceTableReferences = await resolveReferences(
      this.client,
      tablesAndStructures.map(entry => entry.referenceTable).filter(Boolean),
      'TABL',
      ['TABL/DT'],
      'reference table'
    )
    const messageClassReference = await resolveActiveReference(
      this.client,
      errorMessage.id,
      'MSAG/N',
      ['MSAG/N'],
      'message class'
    )
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, transportRequest })
    const content = contentInput(input, category, abapLanguageVersion, tablesAndStructures, errorMessage)
    assertValidation(await validateChangeDocumentObject(this.client, input), name)
    const contract = await readChangeDocumentObjectContract(this.client)
    assertControlledChangeDocumentObjectContract(contract)
    const shellContentType = await resolveShellContentType(this.client)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledChangeDocumentObjectUrl(name)

    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'CHDO/CHD', parentName: packageName },
      transportRequest,
      summary: `Create Change Document Object ${name} in package ${packageName}.`,
      payload: {
        input,
        category,
        content,
        objectUrl,
        packageUrl: packageObject['adtcore:uri'],
        shellContentType,
        contractHash: hashContract(contract),
        tableReferences,
        referenceTableReferences,
        messageClassReference
      } satisfies ChangeDocumentObjectCreationPayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        transportRequest,
        category,
        abapLanguageVersion,
        tablesAndStructures,
        errorMessage,
        frozenReferences: {
          tablesAndStructures: tableReferences,
          referenceTables: referenceTableReferences,
          messageClass: messageClassReference
        },
        shellContract: {
          adtType: 'CHDO/CHD',
          objectUrl,
          shellContentType,
          contentType: CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE,
          formatVersion: '1',
          generatedObject: 'SAP_ASSIGNED_AFTER_ACTIVATION'
        }
      },
      compensationLimits: [
        'Only an inactive Change Document Object proven to have been created by the current plan may be deleted.',
        'Once activation is attempted, generated Function Module or Class ownership is unknown and no automatic deletion is allowed.',
        'Unknown shell, JSON content, unlock, activation, or post-activation verification outcomes stop retry and compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = changeDocumentObjectPayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'CHDO/CHD', 10), payload.input.name, 'CHDO/CHD')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await validateChangeDocumentObject(this.client, payload.input), payload.input.name)
    await revalidateReferences(this.client, payload)
    recordStage('REVALIDATE_REFERENCES', true)
    const contract = await readChangeDocumentObjectContract(this.client)
    assertControlledChangeDocumentObjectContract(contract)
    if (hashContract(contract) !== payload.contractHash) {
      throw new Error('ADT Change Document Object contract changed after preview.')
    }
    const currentShellContentType = await resolveShellContentType(this.client)
    if (currentShellContentType !== payload.shellContentType) {
      throw new Error('ADT Change Document Object shell content type changed after preview.')
    }
    recordStage('REVALIDATE_CONTRACT', true)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I'),
      this.client.transportDetails(payload.input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    let creation
    try {
      creation = await createChangeDocumentObject(this.client, payload.input, payload.shellContentType)
    } catch (error) {
      throw unknownWrite('Change Document Object shell create', error)
    }
    plan.actualResources = [{ type: 'CHDO/CHD', name: payload.input.name }]
    recordStage('CREATE_SHELL', true, creation.location)

    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertChangeDocumentObjectIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input, 'inactive')
    const contentLink = sourceLink(inactive.links || [], payload.objectUrl)
    recordStage('RESOLVE_CREATED_OBJECT', true, contentLink.url)

    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      try {
        await writeChangeDocumentObjectContent(
          this.client,
          contentLink.url,
          payload.content,
          contentLink.contentType,
          lock.LOCK_HANDLE,
          payload.input.transportRequest
        )
      } catch (error) {
        throw unknownWrite('Change Document Object JSON content write', error)
      }
      recordStage('WRITE_CONTENT', true)
      const workingContent = await readChangeDocumentObjectContent(
        this.client,
        contentLink.url,
        contentLink.contentType,
        'workingArea'
      )
      assertWorkingContentMatches(payload.content, workingContent)
      recordStage('VERIFY_CONTENT', true)
    } catch (error) {
      operationError = error
    }
    try {
      await this.client.unLock(payload.objectUrl, lock.LOCK_HANDLE)
      recordStage('UNLOCK_RESOURCE', true)
    } catch (unlockError) {
      recordStage('UNLOCK_RESOURCE', false, errorText(unlockError))
      throw unknownWrite('Change Document Object unlock', unlockError)
    }
    if (operationError) throw operationError

    // CHDO activation can generate another repository object, so any activation attempt ends automatic cleanup eligibility.
    try {
      const activation = await this.client.activate(payload.input.name, payload.objectUrl, undefined, true)
      assertActivation(activation, 'ACTIVATE_OBJECT')
      recordStage('ACTIVATE_OBJECT', true)

      const active = await this.client.objectStructure(payload.objectUrl, 'active')
      assertChangeDocumentObjectIdentity(active.metaData as unknown as Record<string, unknown>, payload.input, 'active')
      const activeLink = sourceLink(active.links || [], payload.objectUrl)
      const activeContent = await readChangeDocumentObjectContent(this.client, activeLink.url, activeLink.contentType, 'active')
      const generatedObject = assertActiveContentMatches(payload, activeContent)
      recordStage('VERIFY_ACTIVE_OBJECT', true)
      const generatedReference = await verifyGeneratedObject(this.client, payload.category, generatedObject)
      recordStage('VERIFY_GENERATED_OBJECT', true, `${generatedReference.adtType} ${generatedReference.name}`)
      plan.actualResources = [
        { type: 'CHDO/CHD', name: payload.input.name },
        { type: generatedReference.adtType, name: generatedReference.name }
      ]
      recordStage('VERIFY_ACTIVE_CONTENT', true)
      return {
        resultSummary: `Created and verified Change Document Object ${payload.input.name} with generated ${generatedReference.adtType} ${generatedReference.name}.`,
        actualResources: plan.actualResources
      }
    } catch (error) {
      throw unknownWrite('Change Document Object activation or generated-object verification', error)
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = changeDocumentObjectPayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'CHDO/CHD' && resource.name === payload.input.name)) return false
    const inactive = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertChangeDocumentObjectIdentity(inactive.metaData as unknown as Record<string, unknown>, payload.input, 'inactive')
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`Change Document Object compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'CHDO/CHD', 10), payload.input.name, 'CHDO/CHD')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

async function resolveShellContentType(client: ControlledCreationAdtClient): Promise<string> {
  const result = await client.findCollectionByUrl?.(CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH)
  const accepted = result?.collection.acceptedContentTypes || []
  const exact = accepted.find(type => baseContentType(type) === CHANGE_DOCUMENT_OBJECT_SHELL_CONTENT_TYPE)
  if (!exact) throw new Error('ADT discovery did not expose the reviewed Blue v1 shell content type for Change Document Object creation.')
  return exact
}

function sourceLink(links: Link[], objectUrl: string): { url: string; contentType: string } {
  const source = links.find(link => link.rel === 'http://www.sap.com/adt/relations/source'
    && link.type && !/^text\/html(?:\s*;|$)/i.test(link.type))
  if (!source?.href || !source.type) throw new Error('Created Change Document Object did not expose its server-driven JSON source link.')
  const contentType = normalizeContentType(source.type)
  const resolved = new URL(source.href, `https://adt.invalid${objectUrl}`).pathname
  if (!resolved.startsWith(`${CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH}/`)) {
    throw new Error('Change Document Object source link escaped the controlled ADT collection.')
  }
  return { url: resolved, contentType }
}

function contentInput(
  input: ControlledChangeDocumentObjectShellInput,
  category: ChangeDocumentObjectCategory,
  abapLanguageVersion: ChangeDocumentObjectAbapLanguageVersion,
  tablesAndStructures: ControlledChangeDocumentTableEntry[],
  errorMessage: { id: string; number: string }
): ControlledChangeDocumentObjectContent {
  const originalLanguage = input.masterLanguage.toLowerCase()
  if (!/^[a-z]{2}$/.test(originalLanguage)) {
    throw new Error(`Package ${input.packageName} did not expose a two-letter original language required by chdo-v1.`)
  }
  return {
    formatVersion: '1',
    header: { description: input.description, originalLanguage, abapLanguageVersion },
    generalInformation: { category: toSapChangeDocumentObjectCategory(category) },
    tablesAndStructures,
    errorMessage
  }
}

function assertWorkingContentMatches(
  expected: ControlledChangeDocumentObjectContent,
  actual: ControlledChangeDocumentObjectContent
): void {
  const actualWithoutGenerated = withoutGeneratedObject(actual)
  const expectedWithoutGenerated = withoutGeneratedObject(expected)
  const actualCategory = actual.generalInformation.category
  const expectedCategory = expected.generalInformation.category
  if ((actualCategory === undefined && expectedCategory !== 'standard')
    || (actualCategory !== undefined && actualCategory !== expectedCategory)) {
    throw contentMismatch('Change Document Object working content', expectedWithoutGenerated, actualWithoutGenerated)
  }
  actualWithoutGenerated.generalInformation = { ...actualWithoutGenerated.generalInformation, category: expectedCategory }
  if (stableJson(actualWithoutGenerated) !== stableJson(expectedWithoutGenerated)) {
    throw contentMismatch('Change Document Object working content', expectedWithoutGenerated, actualWithoutGenerated)
  }
}

function assertActiveContentMatches(
  payload: ChangeDocumentObjectCreationPayload,
  actual: ControlledChangeDocumentObjectContent
): string {
  const expected = payload.content
  const actualWithoutGenerated = withoutGeneratedObject(actual)
  const expectedWithoutGenerated = withoutGeneratedObject(expected)
  const activeCategory = actual.generalInformation.category
  if (activeCategory !== undefined && activeCategory !== expected.generalInformation.category) {
    throw new Error('Active Change Document Object category does not match the confirmed plan.')
  }
  actualWithoutGenerated.generalInformation = { ...actualWithoutGenerated.generalInformation, category: expected.generalInformation.category }
  if (stableJson(actualWithoutGenerated) !== stableJson(expectedWithoutGenerated)) {
    throw new Error('Active Change Document Object content does not match the confirmed plan.')
  }
  const generatedObject = actual.generalInformation.generatedObject
  if (!generatedObject) throw new Error('Active Change Document Object did not expose its generated object.')
  return generatedObject
}

function withoutGeneratedObject(content: ControlledChangeDocumentObjectContent): ControlledChangeDocumentObjectContent {
  const { generatedObject: _generatedObject, ...generalInformation } = content.generalInformation
  return { ...content, generalInformation }
}

async function verifyGeneratedObject(
  client: ControlledCreationAdtClient,
  _category: ChangeDocumentObjectCategory,
  name: string
): Promise<FrozenChangeDocumentReference> {
  const expectedType = 'CLAS/OC'
  return resolveActiveReference(client, name, expectedType, [expectedType], 'generated object')
}

async function revalidateReferences(
  client: ControlledCreationAdtClient,
  payload: ChangeDocumentObjectCreationPayload
): Promise<void> {
  for (const reference of [
    ...payload.tableReferences,
    ...payload.referenceTableReferences,
    payload.messageClassReference
  ]) {
    const queryType = reference.adtType === 'MSAG/N' ? 'MSAG/N' : 'TABL'
    const allowedTypes = reference.adtType === 'MSAG/N' ? ['MSAG/N'] : [reference.adtType]
    const current = await resolveActiveReference(client, reference.name, queryType, allowedTypes, 'frozen reference')
    if (current.uri !== reference.uri || current.adtType !== reference.adtType) {
      throw new Error(`Referenced object ${reference.name} changed after preview.`)
    }
  }
}

async function resolveReferences(
  client: ControlledCreationAdtClient,
  names: string[],
  queryType: string,
  allowedTypes: string[],
  label: string
): Promise<FrozenChangeDocumentReference[]> {
  const result: FrozenChangeDocumentReference[] = []
  for (const name of [...new Set(names)]) {
    result.push(await resolveActiveReference(client, name, queryType, allowedTypes, label))
  }
  return result
}

async function resolveActiveReference(
  client: ControlledCreationAdtClient,
  name: string,
  queryType: string,
  allowedTypes: string[],
  label: string
): Promise<FrozenChangeDocumentReference> {
  const matches = await client.searchObject(name, queryType, 10)
  const normalizedTypes = allowedTypes.map(type => type.toUpperCase())
  const match = matches.find(item => item['adtcore:name'].toUpperCase() === name
    && normalizedTypes.includes(item['adtcore:type'].toUpperCase()))
  if (!match) throw new Error(`Active ${label} ${name} was not found.`)
  const structure = await client.objectStructure(match['adtcore:uri'], 'active')
  const metadata = structure.metaData as unknown as Record<string, unknown>
  const adtType = String(metadata['adtcore:type'] || '').toUpperCase()
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== name
    || !normalizedTypes.includes(adtType)
    || String(metadata['adtcore:version'] || '').toLowerCase() !== 'active') {
    throw new Error(`Referenced ${label} ${name} is not the expected active repository object.`)
  }
  return { name, adtType, uri: match['adtcore:uri'] }
}

function assertChangeDocumentObjectIdentity(
  metadata: Record<string, unknown>,
  input: ControlledChangeDocumentObjectShellInput,
  expectedVersion: 'active' | 'inactive'
): void {
  if (String(metadata['adtcore:name'] || '').toUpperCase() !== input.name
    || String(metadata['adtcore:type'] || '').toUpperCase() !== 'CHDO/CHD'
    || String(metadata['adtcore:version'] || '').toLowerCase() !== expectedVersion) {
    throw new Error(`Created Change Document Object ${input.name} does not match the confirmed plan.`)
  }
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledChangeDocumentObjectShellInput, 'name' | 'description' | 'packageName' | 'transportRequest'>
): ControlledChangeDocumentObjectShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function tableEntries(value: unknown): ControlledChangeDocumentTableEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error('tablesAndStructures must contain between 1 and 100 reviewed entries.')
  }
  const entries = value.map((item, index) => {
    const entry = objectInput(item, `tablesAndStructures[${index}]`)
    const insertions = loggingOptions(entry.databaseInsertions, `tablesAndStructures[${index}].databaseInsertions`)
    const deletions = loggingOptions(entry.databaseDeletions, `tablesAndStructures[${index}].databaseDeletions`)
    return {
      name: referenceName(entry.name, `tablesAndStructures[${index}].name`, 30),
      referenceTable: entry.referenceTable === undefined || entry.referenceTable === ''
        ? ''
        : referenceName(entry.referenceTable, `tablesAndStructures[${index}].referenceTable`, 30),
      multipleChanges: optionalBoolean(entry.multipleChanges, `tablesAndStructures[${index}].multipleChanges`),
      databaseInsertions: insertions,
      databaseDeletions: deletions
    }
  })
  const duplicate = entries.find((entry, index) => entries.findIndex(candidate => candidate.name === entry.name) !== index)
  if (duplicate) throw new Error(`tablesAndStructures contains duplicate object ${duplicate.name}.`)
  return entries
}

function loggingOptions(value: unknown, label: string): { logValues: boolean; logInitialValues: boolean } {
  const options = value === undefined ? {} : objectInput(value, label)
  const logValues = optionalBoolean(options.logValues, `${label}.logValues`)
  const logInitialValues = optionalBoolean(options.logInitialValues, `${label}.logInitialValues`)
  if (logInitialValues && !logValues) throw new Error(`${label}.logInitialValues requires logValues=true.`)
  return { logValues, logInitialValues }
}

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function referenceName(value: unknown, label: string, maximum: number): string {
  const name = String(value || '').trim().toUpperCase()
  if (!name || name.length > maximum || !/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error(`${label} must be a valid repository object name with at most ${maximum} characters.`)
  }
  return name
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false
  if (value !== true && value !== false) throw new Error(`${label} must be boolean.`)
  return value
}

function changeDocumentCategory(value: unknown): ChangeDocumentObjectCategory {
  const normalized = String(value || '')
  if (normalized !== 'standard' && normalized !== 'behaviorDefinition') {
    throw new Error("category must be 'standard' or 'behaviorDefinition'.")
  }
  return normalized
}

function languageVersion(value: unknown): ChangeDocumentObjectAbapLanguageVersion {
  const normalized = value === undefined ? 'standard' : String(value)
  if (normalized !== 'standard' && normalized !== 'cloudDevelopment') {
    throw new Error("abapLanguageVersion must be 'standard' or 'cloudDevelopment'.")
  }
  return normalized
}

function changeDocumentObjectPayload(plan: RepositoryCreationPlan): ChangeDocumentObjectCreationPayload {
  const payload = plan.payload as ChangeDocumentObjectCreationPayload | undefined
  if (!payload?.input?.name || !payload.content || !payload.shellContentType || !payload.contractHash) {
    throw new Error('Change Document Object creation plan payload is unavailable.')
  }
  return payload
}

function hashContract(contract: unknown): string {
  return createHash('sha256').update(stableJson(contract)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function contentMismatch(label: string, expected: unknown, actual: unknown): Error {
  const expectedJson = stableJson(expected)
  const actualJson = stableJson(actual)
  const path = firstMismatchPath(expected, actual) || '$'
  return new Error(
    `${label} does not match the confirmed plan at ${path}; `
    + `expectedKind=${valueKind(valueAtPath(expected, path))}, actualKind=${valueKind(valueAtPath(actual, path))}, `
    + `expectedHash=${createHash('sha256').update(expectedJson).digest('hex')}, `
    + `actualHash=${createHash('sha256').update(actualJson).digest('hex')}, `
    + `expectedBytes=${Buffer.byteLength(expectedJson, 'utf8')}, actualBytes=${Buffer.byteLength(actualJson, 'utf8')}.`
  )
}

function firstMismatchPath(expected: unknown, actual: unknown, path = '$'): string | undefined {
  if (valueKind(expected) !== valueKind(actual)) return path
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${path}.length`
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = firstMismatchPath(expected[index], actual[index], `${path}[${index}]`)
      if (mismatch) return mismatch
    }
    return undefined
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const expectedObject = expected as Record<string, unknown>
    const actualObject = actual as Record<string, unknown>
    const keys = [...new Set([...Object.keys(expectedObject), ...Object.keys(actualObject)])].sort()
    for (const key of keys) {
      if (!(key in expectedObject) || !(key in actualObject)) return `${path}.${key}`
      const mismatch = firstMismatchPath(expectedObject[key], actualObject[key], `${path}.${key}`)
      if (mismatch) return mismatch
    }
    return undefined
  }
  return Object.is(expected, actual) ? undefined : path
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path === '$') return value
  const parts = path.slice(2).split(/\.|\[|\]/).filter(Boolean)
  let current = value
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function baseContentType(value: string): string {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function normalizeContentType(value: string): string {
  if (baseContentType(value) !== CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE) {
    throw new Error('Change Document Object source link did not expose the reviewed application/json content type.')
  }
  return CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE
}

async function validateChangeDocumentObject(client: ControlledCreationAdtClient, input: ControlledChangeDocumentObjectShellInput) {
  if (!client.validateControlledChangeDocumentObject) throw new Error('Controlled Change Document Object validation is not available in this ADT client.')
  return client.validateControlledChangeDocumentObject(input)
}

async function readChangeDocumentObjectContract(client: ControlledCreationAdtClient) {
  if (!client.readControlledChangeDocumentObjectContract) throw new Error('Controlled Change Document Object contract discovery is not available in this ADT client.')
  return client.readControlledChangeDocumentObjectContract()
}

async function createChangeDocumentObject(
  client: ControlledCreationAdtClient,
  input: ControlledChangeDocumentObjectShellInput,
  contentType: string
) {
  if (!client.createControlledChangeDocumentObjectShell) throw new Error('Controlled Change Document Object shell creation is not available in this ADT client.')
  return client.createControlledChangeDocumentObjectShell(input, contentType)
}

async function readChangeDocumentObjectContent(
  client: ControlledCreationAdtClient,
  contentUrl: string,
  contentType: string,
  version: 'active' | 'inactive' | 'workingArea'
) {
  if (!client.readControlledChangeDocumentObjectContent) throw new Error('Controlled Change Document Object content reading is not available in this ADT client.')
  return client.readControlledChangeDocumentObjectContent(contentUrl, contentType, version)
}

async function writeChangeDocumentObjectContent(
  client: ControlledCreationAdtClient,
  contentUrl: string,
  content: ControlledChangeDocumentObjectContent,
  contentType: string,
  lockHandle: string,
  transportRequest: string
) {
  if (!client.writeControlledChangeDocumentObjectContent) throw new Error('Controlled Change Document Object content writing is not available in this ADT client.')
  return client.writeControlledChangeDocumentObjectContent(contentUrl, content, contentType, lockHandle, transportRequest)
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
