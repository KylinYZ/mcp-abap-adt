import { adtException, ValidateObjectUrl, ValidateStateful } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity } from '../utilities'
import type { ObjectVersion } from './objectstructure'
import type { ValidationResult } from './objectcreator'

export const CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH = '/sap/bc/adt/changedocuments/objects'
export const CHANGE_DOCUMENT_OBJECT_VALIDATION_PATH = `${CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH}/validation`
export const CHANGE_DOCUMENT_OBJECT_SCHEMA_PATH = `${CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH}/$schema`
export const CHANGE_DOCUMENT_OBJECT_CONFIGURATION_PATH = `${CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH}/$configuration`
export const CHANGE_DOCUMENT_OBJECT_SHELL_CONTENT_TYPE = 'application/vnd.sap.adt.blues.v1+xml'
export const CHANGE_DOCUMENT_OBJECT_VALIDATION_CONTENT_TYPE = 'application/vnd.sap.as+xml'
export const CHANGE_DOCUMENT_OBJECT_SCHEMA_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=objectTypes.v1'
export const CHANGE_DOCUMENT_OBJECT_CONFIGURATION_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.configuration.v1+json; framework=objectTypes.v1'
export const CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE = 'application/json'

export type ChangeDocumentObjectAbapLanguageVersion = 'standard' | 'cloudDevelopment'
export type ChangeDocumentObjectCategory = 'standard' | 'behaviorDefinition'
export type ChangeDocumentObjectSapCategory = 'standard' | 'behaviorDefiniton'

export interface ControlledChangeDocumentObjectShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledChangeDocumentLoggingOptions {
  logValues: boolean
  logInitialValues: boolean
}

export interface ControlledChangeDocumentTableEntry {
  name: string
  referenceTable: string
  multipleChanges: boolean
  databaseInsertions: ControlledChangeDocumentLoggingOptions
  databaseDeletions: ControlledChangeDocumentLoggingOptions
}

export interface ControlledChangeDocumentObjectContent {
  formatVersion: '1'
  header: {
    description: string
    originalLanguage: string
    abapLanguageVersion: ChangeDocumentObjectAbapLanguageVersion
  }
  generalInformation: {
    category?: ChangeDocumentObjectSapCategory
    generatedObject?: string
  }
  tablesAndStructures: ControlledChangeDocumentTableEntry[]
  errorMessage: {
    id: string
    number: string
  }
}

export interface ControlledChangeDocumentObjectContract {
  schema: unknown
  configuration: unknown
}

export interface ControlledChangeDocumentObjectDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
}

export interface ControlledChangeDocumentObjectCreationResult {
  location: string
  changeDocumentObject: ControlledChangeDocumentObjectDocument
}

export async function validateControlledChangeDocumentObject(
  h: AdtHTTP,
  input: Pick<ControlledChangeDocumentObjectShellInput, 'name' | 'description' | 'packageName'>
): Promise<ValidationResult> {
  const response = await h.request(CHANGE_DOCUMENT_OBJECT_VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objtype: 'CHDO/CHD',
      objname: input.name,
      description: input.description,
      packagename: input.packageName
    },
    headers: { Accept: CHANGE_DOCUMENT_OBJECT_VALIDATION_CONTENT_TYPE }
  })
  const body = String(response.body || '').trim()
  if (!body) return { success: true }
  const checkResult = body.match(/<CHECK_RESULT>([^<]*)<\/CHECK_RESULT>/i)?.[1]?.trim().toUpperCase()
  if (checkResult !== 'X') throw adtException('SAP rejected the Change Document Object name or package assignment.')
  return { success: true }
}

export async function readControlledChangeDocumentObjectContract(
  h: AdtHTTP
): Promise<ControlledChangeDocumentObjectContract> {
  const schema = await h.request(CHANGE_DOCUMENT_OBJECT_SCHEMA_PATH, {
    headers: { Accept: CHANGE_DOCUMENT_OBJECT_SCHEMA_CONTENT_TYPE }
  })
  const configuration = await h.request(CHANGE_DOCUMENT_OBJECT_CONFIGURATION_PATH, {
    headers: { Accept: CHANGE_DOCUMENT_OBJECT_CONFIGURATION_CONTENT_TYPE }
  })
  return {
    schema: parseJsonObject(schema.body, 'Change Document Object schema'),
    configuration: parseJsonObject(configuration.body, 'Change Document Object configuration')
  }
}

export async function createControlledChangeDocumentObjectShell(
  h: AdtHTTP,
  input: ControlledChangeDocumentObjectShellInput,
  contentType: string
): Promise<ControlledChangeDocumentObjectCreationResult> {
  if (normalizeBaseContentType(contentType) !== CHANGE_DOCUMENT_OBJECT_SHELL_CONTENT_TYPE) {
    throw adtException('ADT discovery did not provide the controlled Change Document Object shell content type.')
  }
  const response = await h.request(CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': contentType, Accept: contentType },
    body: buildControlledChangeDocumentObjectShellXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  const changeDocumentObject = parseControlledChangeDocumentObject(response.body)
  if (response.status !== 201 || normalizePath(location) !== controlledChangeDocumentObjectUrl(input.name)) {
    throw adtException('Change Document Object creation did not return HTTP 201 with the canonical Location header.')
  }
  if (changeDocumentObject.name !== input.name.toUpperCase()) {
    throw adtException('Change Document Object creation response identity does not match the requested object.')
  }
  return { location, changeDocumentObject }
}

export async function readControlledChangeDocumentObjectContent(
  h: AdtHTTP,
  contentUrl: string,
  contentType: string,
  version?: ObjectVersion
): Promise<ControlledChangeDocumentObjectContent> {
  ValidateObjectUrl(contentUrl)
  const normalizedContentType = normalizeChangeDocumentObjectContentType(contentType)
  const response = await h.request(contentUrl, {
    ...(version ? { qs: { version } } : {}),
    headers: { Accept: normalizedContentType }
  })
  return parseControlledChangeDocumentObjectContent(response.body)
}

export async function writeControlledChangeDocumentObjectContent(
  h: AdtHTTP,
  contentUrl: string,
  content: ControlledChangeDocumentObjectContent,
  contentType: string,
  lockHandle: string,
  transportRequest: string
): Promise<ControlledChangeDocumentObjectContent> {
  ValidateObjectUrl(contentUrl)
  ValidateStateful(h)
  const normalizedContentType = normalizeChangeDocumentObjectContentType(contentType)
  const response = await h.request(contentUrl, {
    method: 'PUT',
    qs: { lockHandle, corrNr: transportRequest },
    headers: { 'Content-Type': normalizedContentType, Accept: normalizedContentType },
    body: JSON.stringify(content, null, 2)
  })
  return String(response.body || '').trim()
    ? parseControlledChangeDocumentObjectContent(response.body)
    : content
}

export function controlledChangeDocumentObjectUrl(name: string): string {
  return `${CHANGE_DOCUMENT_OBJECT_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function buildControlledChangeDocumentObjectShellXml(input: ControlledChangeDocumentObjectShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="CHDO/CHD" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</blue:blueSource>`
}

export function parseControlledChangeDocumentObject(xml: string): ControlledChangeDocumentObjectDocument {
  const root = parseAttributes(String(xml || '').match(/<blue:blueSource\b[^>]*>/i)?.[0] || '')
  const packageRef = parseAttributes(String(xml || '').match(/<adtcore:packageRef\b[^>]*>/i)?.[0] || '')
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    packageName: packageRef['adtcore:name'],
    version: root['adtcore:version']
  }
}

export function parseControlledChangeDocumentObjectContent(value: unknown): ControlledChangeDocumentObjectContent {
  const parsed = parseJsonObject(value, 'Change Document Object content') as Record<string, unknown>
  assertAllowedKeys(parsed, ['formatVersion', 'header', 'generalInformation', 'tablesAndStructures', 'errorMessage'], 'Change Document Object content')
  const header = asObject(parsed.header, 'Change Document Object header')
  assertAllowedKeys(header, ['description', 'originalLanguage', 'abapLanguageVersion'], 'Change Document Object header')
  const generalInformation = parsed.generalInformation === undefined
    ? {}
    : asObject(parsed.generalInformation, 'Change Document Object generalInformation')
  assertAllowedKeys(generalInformation, ['category', 'generatedObject'], 'Change Document Object generalInformation')
  const errorMessage = asObject(parsed.errorMessage, 'Change Document Object errorMessage')
  assertAllowedKeys(errorMessage, ['id', 'number'], 'Change Document Object errorMessage')
  const abapLanguageVersion = header.abapLanguageVersion === undefined
    ? 'standard'
    : String(header.abapLanguageVersion)
  const category = generalInformation.category === undefined ? undefined : String(generalInformation.category)
  const generatedObject = generalInformation.generatedObject === undefined ? undefined : String(generalInformation.generatedObject)
  const tableValues = Array.isArray(parsed.tablesAndStructures) ? parsed.tablesAndStructures : undefined
  if (String(parsed.formatVersion || '') !== '1'
    || !boundedString(header.description, 60)
    || !/^[a-z]{2}$/.test(String(header.originalLanguage || ''))
    || !['standard', 'cloudDevelopment'].includes(abapLanguageVersion)
    || (category !== undefined && !['standard', 'behaviorDefiniton'].includes(category))
    || (generatedObject !== undefined && !repositoryValue(generatedObject, 30))
    || !tableValues
    || !repositoryValue(errorMessage.id, 20)
    || !/^\d{3}$/.test(String(errorMessage.number || ''))) {
    throw adtException('Change Document Object content does not match the controlled chdo-v1 contract.')
  }
  const tablesAndStructures = tableValues.map((entry, index) => parseTableEntry(entry, index))
  return {
    formatVersion: '1',
    header: {
      description: String(header.description),
      originalLanguage: String(header.originalLanguage),
      abapLanguageVersion: abapLanguageVersion as ChangeDocumentObjectAbapLanguageVersion
    },
    generalInformation: {
      ...(category ? { category: category as ChangeDocumentObjectSapCategory } : {}),
      ...(generatedObject ? { generatedObject: generatedObject.toUpperCase() } : {})
    },
    tablesAndStructures,
    errorMessage: {
      id: String(errorMessage.id).toUpperCase(),
      number: String(errorMessage.number)
    }
  }
}

export function assertControlledChangeDocumentObjectContract(
  contract: ControlledChangeDocumentObjectContract
): void {
  const schema = asObject(contract.schema, 'Change Document Object schema')
  const properties = schemaProperties(schema, 'Change Document Object schema')
  const header = schemaProperties(properties.header, 'Change Document Object header schema')
  const general = schemaProperties(properties.generalInformation, 'Change Document Object general-information schema')
  const tables = asObject(properties.tablesAndStructures, 'Change Document Object tables schema')
  const tableItems = schemaProperties(tables.items, 'Change Document Object table item schema')
  const insertions = schemaProperties(tableItems.databaseInsertions, 'Change Document Object insertion schema')
  const deletions = schemaProperties(tableItems.databaseDeletions, 'Change Document Object deletion schema')
  const errorMessage = schemaProperties(properties.errorMessage, 'Change Document Object error-message schema')
  const required = requiredValues(schema)
  const categories = enumValues(general.category)
  const languageVersions = enumValues(header.abapLanguageVersion)

  const configuration = asObject(contract.configuration, 'Change Document Object configuration')
  const configurationProperties = asObject(configuration.properties, 'Change Document Object configuration properties')
  const configuredGeneral = configurationPropertiesOf(configurationProperties.generalInformation, 'Change Document Object general-information configuration')
  const configuredTables = asObject(configurationProperties.tablesAndStructures, 'Change Document Object tables configuration')
  const configuredTableItems = configurationPropertiesOf(asObject(configuredTables.items, 'Change Document Object table-item configuration'), 'Change Document Object table-item configuration')
  const configuredErrorObject = asObject(configurationProperties.errorMessage, 'Change Document Object error-message configuration')
  const configuredError = configurationPropertiesOf(configuredErrorObject, 'Change Document Object error-message configuration')

  if (!properties.formatVersion
    || !header.description
    || !header.originalLanguage
    || !languageVersions.includes('standard')
    || !languageVersions.includes('cloudDevelopment')
    || !categories.includes('standard')
    || !categories.includes('behaviorDefiniton')
    || !general.generatedObject
    || !tableItems.name
    || !tableItems.referenceTable
    || !tableItems.multipleChanges
    || !insertions.logValues
    || !insertions.logInitialValues
    || !deletions.logValues
    || !deletions.logInitialValues
    || !errorMessage.id
    || !errorMessage.number
    || !['formatVersion', 'header', 'tablesAndStructures', 'errorMessage'].every(name => required.includes(name))
    || !typeValues(configuredGeneral.generatedObject).includes('CLAS')
    || !typeValues(configuredGeneral.generatedObject).includes('FUNC')
    || !typeValues(configuredTableItems.name).includes('TABL')
    || !typeValues(configuredTableItems.referenceTable).includes('TABL')
    || configuredErrorObject['sap.adt.hidden'] !== true
    || !typeValues(configuredError.id).includes('MSAG')) {
    throw adtException('Target Change Document Object contract is incompatible with the reviewed ADT 3.60.2 contract.')
  }
}

export function toSapChangeDocumentObjectCategory(
  category: ChangeDocumentObjectCategory
): ChangeDocumentObjectSapCategory {
  // SAP ADT 3.60.2 publishes this misspelling in the server-driven schema.
  return category === 'behaviorDefinition' ? 'behaviorDefiniton' : 'standard'
}

export function normalizeChangeDocumentObjectContentType(contentType: string): string {
  if (normalizeBaseContentType(contentType) !== CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE) {
    throw adtException('Change Document Object source link did not expose the reviewed application/json content type.')
  }
  return CHANGE_DOCUMENT_OBJECT_CONTENT_TYPE
}

function parseTableEntry(value: unknown, index: number): ControlledChangeDocumentTableEntry {
  const entry = asObject(value, `Change Document Object table entry ${index + 1}`)
  assertAllowedKeys(entry, ['name', 'referenceTable', 'multipleChanges', 'databaseInsertions', 'databaseDeletions'], `Change Document Object table entry ${index + 1}`)
  const insertions = parseLoggingOptions(entry.databaseInsertions, `Change Document Object table entry ${index + 1} insertions`)
  const deletions = parseLoggingOptions(entry.databaseDeletions, `Change Document Object table entry ${index + 1} deletions`)
  if (!repositoryValue(entry.name, 30)
    || (entry.referenceTable !== undefined && entry.referenceTable !== '' && !repositoryValue(entry.referenceTable, 30))
    || (entry.multipleChanges !== undefined && !isBoolean(entry.multipleChanges))) {
    throw adtException(`Change Document Object table entry ${index + 1} does not match the controlled chdo-v1 contract.`)
  }
  return {
    name: String(entry.name).toUpperCase(),
    referenceTable: String(entry.referenceTable || '').toUpperCase(),
    multipleChanges: entry.multipleChanges === true,
    databaseInsertions: insertions,
    databaseDeletions: deletions
  }
}

function parseLoggingOptions(value: unknown, label: string): ControlledChangeDocumentLoggingOptions {
  const options = value === undefined ? {} : asObject(value, label)
  assertAllowedKeys(options, ['logValues', 'logInitialValues'], label)
  if ((options.logValues !== undefined && !isBoolean(options.logValues))
    || (options.logInitialValues !== undefined && !isBoolean(options.logInitialValues))) {
    throw adtException(`${label} does not match the controlled chdo-v1 contract.`)
  }
  return { logValues: options.logValues === true, logInitialValues: options.logInitialValues === true }
}

function schemaProperties(value: unknown, label: string): Record<string, unknown> {
  return asObject(asObject(value, label).properties, `${label} properties`)
}

function configurationPropertiesOf(value: unknown, label: string): Record<string, unknown> {
  return asObject(asObject(value, label).properties, `${label} properties`)
}

function enumValues(value: unknown): string[] {
  const property = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Array.isArray(property.enum) ? property.enum.map(String) : []
}

function typeValues(value: unknown): string[] {
  const property = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Array.isArray(property['sap.adt.types']) ? property['sap.adt.types'].map(String) : []
}

function requiredValues(value: unknown): string[] {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Array.isArray(object.required) ? object.required.map(String) : []
}

function parseJsonObject(value: unknown, label: string): unknown {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch (error) {
    throw adtException(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw adtException(`${label} is missing.`)
  return value as Record<string, unknown>
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) throw adtException(`${label} contains unsupported property '${unexpected}'.`)
}

function boundedString(value: unknown, maximum: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\r\n\u0000-\u001f\u007f]/.test(value)
}

function repositoryValue(value: unknown, maximum: number): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && /^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/i.test(value)
}

function isBoolean(value: unknown): boolean {
  return value === true || value === false
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}

function normalizeBaseContentType(value: string): string {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function normalizePath(value: string): string {
  return String(value || '').split('?')[0].replace(/\/+$/, '').toLowerCase()
}
