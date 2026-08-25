import { adtException, ValidateObjectUrl } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity } from '../utilities'
import type { ObjectVersion } from './objectstructure'
import type { ValidationResult } from './objectcreator'

export const SAP_OBJECT_TYPE_COLLECTION_PATH = '/sap/bc/adt/businessobjects/rontrot'
export const SAP_OBJECT_TYPE_VALIDATION_PATH = `${SAP_OBJECT_TYPE_COLLECTION_PATH}/validation`
export const SAP_OBJECT_TYPE_NEW_SCHEMA_PATH = `${SAP_OBJECT_TYPE_COLLECTION_PATH}/$new/schema`
export const SAP_OBJECT_TYPE_NEW_CONFIGURATION_PATH = `${SAP_OBJECT_TYPE_COLLECTION_PATH}/$new/configuration`
export const SAP_OBJECT_TYPE_NEW_CONTENT_PATH = `${SAP_OBJECT_TYPE_COLLECTION_PATH}/$new/content`
export const SAP_OBJECT_TYPE_SHELL_CONTENT_TYPE = 'application/vnd.sap.adt.blues.v2+xml'
export const SAP_OBJECT_TYPE_ADDITIONAL_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.content.v1+json'
export const SAP_OBJECT_TYPE_NEW_SCHEMA_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=newObjectTypes.v1'
export const SAP_OBJECT_TYPE_NEW_CONFIGURATION_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.configuration.v1+json; framework=newObjectTypes.v1'
export const SAP_OBJECT_TYPE_NEW_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.content.v1+json; framework=newObjectTypes.v1'
export const SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE = 'application/json'
export const SAP_OBJECT_TYPE_VALIDATION_CONTENT_TYPE = 'application/vnd.sap.as+xml'

export type SapObjectTypeCategory =
  | 'businessObject'
  | 'technicalObject'
  | 'analyticalObject'
  | 'configurationObject'
  | 'dependentObject'
  | 'hierarchyObject'

export type SapObjectTypeCreationCategory = 'bo' | 'to' | 'ao' | 'co' | 'do' | 'ho'

export interface ControlledSapObjectTypeShellInput {
  repositoryName: string
  semanticName: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
  typeCategory: SapObjectTypeCategory
}

export interface ControlledSapObjectTypeCreationContent {
  name: string
  typeCategory: SapObjectTypeCreationCategory
  metadata: {
    name: string
    description: string
    package: string
  }
}

export interface ControlledSapObjectTypeContent {
  formatVersion: '1'
  header: {
    description: string
    originalLanguage: string
    abapLanguageVersion?: 'standard' | 'cloudDevelopment'
  }
  typeCategory: SapObjectTypeCategory
  name: string
  objectTypeCode?: string
  interfaceBehaviorDefinition?: string
  odmEntityName?: string
}

export interface ControlledSapObjectTypeCreationContract {
  schema: Record<string, unknown>
  configuration: Record<string, unknown>
  content: Record<string, unknown>
}

export interface ControlledSapObjectTypeDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
}

export interface ControlledSapObjectTypeCreationResult {
  location: string
  sapObjectType: ControlledSapObjectTypeDocument
}

export async function validateControlledSapObjectType(
  h: AdtHTTP,
  input: ControlledSapObjectTypeShellInput,
  content: ControlledSapObjectTypeCreationContent
): Promise<ValidationResult> {
  const response = await h.request(SAP_OBJECT_TYPE_VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objtype: 'RONT/ROT',
      objname: input.semanticName,
      description: input.description,
      packagename: input.packageName,
      packageName: input.packageName
    },
    headers: {
      'Content-Type': SAP_OBJECT_TYPE_ADDITIONAL_CONTENT_TYPE,
      Accept: SAP_OBJECT_TYPE_VALIDATION_CONTENT_TYPE
    },
    body: JSON.stringify(content)
  })
  const body = String(response.body || '').trim()
  if (!body) return { success: true }
  const checkResult = body.match(/<CHECK_RESULT>([^<]*)<\/CHECK_RESULT>/i)?.[1]?.trim().toUpperCase()
  if (checkResult !== 'X') throw adtException('SAP rejected the SAP Object Type name or package assignment.')
  return { success: true }
}

export async function readControlledSapObjectTypeCreationContract(
  h: AdtHTTP
): Promise<ControlledSapObjectTypeCreationContract> {
  const schema = await readJsonObject(h, SAP_OBJECT_TYPE_NEW_SCHEMA_PATH, SAP_OBJECT_TYPE_NEW_SCHEMA_CONTENT_TYPE, 'SAP Object Type creation schema')
  const configuration = await readJsonObject(h, SAP_OBJECT_TYPE_NEW_CONFIGURATION_PATH, SAP_OBJECT_TYPE_NEW_CONFIGURATION_CONTENT_TYPE, 'SAP Object Type creation configuration')
  const content = await readJsonObject(h, SAP_OBJECT_TYPE_NEW_CONTENT_PATH, SAP_OBJECT_TYPE_NEW_CONTENT_TYPE, 'SAP Object Type initial creation content')
  return { schema, configuration, content }
}

export async function createControlledSapObjectType(
  h: AdtHTTP,
  input: ControlledSapObjectTypeShellInput,
  content: ControlledSapObjectTypeCreationContent,
  contentType: string
): Promise<ControlledSapObjectTypeCreationResult> {
  if (normalizeBaseContentType(contentType) !== SAP_OBJECT_TYPE_SHELL_CONTENT_TYPE) {
    throw adtException('ADT discovery did not provide the controlled SAP Object Type Blue v2 content type.')
  }
  const response = await h.request(SAP_OBJECT_TYPE_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': contentType, Accept: contentType },
    body: buildControlledSapObjectTypeXml(input, content)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  if (response.status !== 201 || normalizePath(location) !== controlledSapObjectTypeUrl(input.repositoryName)) {
    throw adtException('SAP Object Type creation did not return HTTP 201 with the canonical Location header.')
  }
  // Some ADT Blue endpoints acknowledge a successful shell creation with an
  // empty body. HTTP 201 plus the canonical Location is the complete success
  // contract in that case; only validate identity when SAP actually returns a
  // response document.
  const body = String(response.body || '').trim()
  if (!body) {
    return { location, sapObjectType: { name: input.repositoryName.toUpperCase() } }
  }
  const sapObjectType = parseControlledSapObjectType(body)
  if (sapObjectType.name !== input.repositoryName.toUpperCase()) {
    throw adtException('SAP Object Type creation response identity does not match the requested object.')
  }
  return { location, sapObjectType }
}

export async function readControlledSapObjectTypeContent(
  h: AdtHTTP,
  contentUrl: string,
  contentType: string,
  version?: ObjectVersion
): Promise<ControlledSapObjectTypeContent> {
  ValidateObjectUrl(contentUrl)
  if (normalizeBaseContentType(contentType) !== SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE) {
    throw adtException('SAP Object Type source link did not expose the reviewed application/json content type.')
  }
  const response = await h.request(contentUrl, {
    ...(version ? { qs: { version } } : {}),
    headers: { Accept: SAP_OBJECT_TYPE_SOURCE_CONTENT_TYPE }
  })
  return parseControlledSapObjectTypeContent(response.body)
}

export function controlledSapObjectTypeUrl(repositoryName: string): string {
  return `${SAP_OBJECT_TYPE_COLLECTION_PATH}/${encodeURIComponent(repositoryName.toLowerCase())}`
}

export function buildControlledSapObjectTypeXml(
  input: ControlledSapObjectTypeShellInput,
  content: ControlledSapObjectTypeCreationContent
): string {
  const attr = (value: string) => encodeEntity(value)
  // Eclipse ADT embeds the reviewed creation JSON as base64 in the Blue v2 shell.
  const encodedContent = Buffer.from(JSON.stringify(content), 'utf8').toString('base64')
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.repositoryName)}" adtcore:type="RONT/ROT" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
  <blue:additionalCreationProperties>
    <adtcore:content adtcore:encoding="base64" adtcore:type="${SAP_OBJECT_TYPE_ADDITIONAL_CONTENT_TYPE}">${encodedContent}</adtcore:content>
  </blue:additionalCreationProperties>
</blue:blueSource>`
}

export function buildControlledSapObjectTypeCreationContent(
  input: ControlledSapObjectTypeShellInput
): ControlledSapObjectTypeCreationContent {
  return {
    name: input.semanticName,
    typeCategory: creationCategory(input.typeCategory),
    metadata: {
      name: input.repositoryName,
      description: input.description,
      package: input.packageName
    }
  }
}

export function parseControlledSapObjectType(xml: unknown): ControlledSapObjectTypeDocument {
  const value = String(xml || '')
  const root = parseAttributes(value.match(/<blue:blueSource\b[^>]*>/i)?.[0] || '')
  const packageRef = parseAttributes(value.match(/<adtcore:packageRef\b[^>]*>/i)?.[0] || '')
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    packageName: packageRef['adtcore:name'],
    version: root['adtcore:version']
  }
}

export function parseControlledSapObjectTypeContent(value: unknown): ControlledSapObjectTypeContent {
  const parsed = parseJsonObject(value, 'SAP Object Type content')
  const header = asObject(parsed.header, 'SAP Object Type header')
  const typeCategory = String(parsed.typeCategory || '')
  const abapLanguageVersion = header.abapLanguageVersion === undefined
    ? undefined
    : String(header.abapLanguageVersion)
  if (String(parsed.formatVersion || '') !== '1'
    || !boundedString(header.description, 60)
    || !/^[a-z]{2}$/.test(String(header.originalLanguage || ''))
    || (abapLanguageVersion !== undefined && !['standard', 'cloudDevelopment'].includes(abapLanguageVersion))
    || !SAP_OBJECT_TYPE_CATEGORIES.includes(typeCategory as SapObjectTypeCategory)
    || !semanticName(parsed.name)
    || (parsed.objectTypeCode !== undefined && !boundedString(parsed.objectTypeCode, 5))
    || !optionalBoundedString(parsed.interfaceBehaviorDefinition, 30)
    || !optionalBoundedString(parsed.odmEntityName, 255)) {
    throw adtException('SAP Object Type content does not match the controlled objectTypes.v1 contract.')
  }
  return {
    formatVersion: '1',
    header: {
      description: String(header.description),
      originalLanguage: String(header.originalLanguage),
      ...(abapLanguageVersion ? { abapLanguageVersion: abapLanguageVersion as 'standard' | 'cloudDevelopment' } : {})
    },
    typeCategory: typeCategory as SapObjectTypeCategory,
    name: String(parsed.name),
    ...(parsed.objectTypeCode !== undefined ? { objectTypeCode: String(parsed.objectTypeCode) } : {}),
    ...(parsed.interfaceBehaviorDefinition ? { interfaceBehaviorDefinition: String(parsed.interfaceBehaviorDefinition).toUpperCase() } : {}),
    ...(parsed.odmEntityName ? { odmEntityName: String(parsed.odmEntityName) } : {})
  }
}

export function assertControlledSapObjectTypeCreationContract(
  contract: ControlledSapObjectTypeCreationContract
): void {
  const properties = asObject(contract.schema.properties, 'SAP Object Type creation schema properties')
  const name = asObject(properties.name, 'SAP Object Type creation name schema')
  const typeCategory = asObject(properties.typeCategory, 'SAP Object Type creation category schema')
  const metadata = asObject(properties.metadata, 'SAP Object Type creation metadata schema')
  const metadataProperties = asObject(metadata.properties, 'SAP Object Type creation metadata properties')
  const configurationProperties = asObject(contract.configuration.properties, 'SAP Object Type creation configuration properties')
  const nameConfiguration = asObject(configurationProperties.name, 'SAP Object Type name configuration')
  const metadataConfiguration = asObject(configurationProperties.metadata, 'SAP Object Type metadata configuration')
  const metadataConfigurationProperties = asObject(metadataConfiguration.properties, 'SAP Object Type metadata configuration properties')
  const metadataNameConfiguration = asObject(metadataConfigurationProperties.name, 'SAP Object Type metadata name configuration')
  const required = Array.isArray(contract.schema.required) ? contract.schema.required.map(String) : []
  const categories = Array.isArray(typeCategory.enum) ? typeCategory.enum.map(String) : []
  const sideEffect = asObject(nameConfiguration['sap.adt.sideeffect'], 'SAP Object Type name side-effect')
  const determinations = Array.isArray(sideEffect.determination) ? sideEffect.determination.map(String) : []
  if (name.maxLength !== 30
    || !required.includes('name')
    || CREATION_CATEGORIES.some(category => !categories.includes(category))
    || !metadataProperties.name
    || !metadataProperties.description
    || !metadataProperties.package
    || !determinations.includes('afterUpdate')
    || metadataNameConfiguration['sap.adt.readonly'] !== true
    || Object.keys(contract.content).length !== 0) {
    throw adtException('Target SAP Object Type creation contract is incompatible with the reviewed ADT 3.60.2 schema.')
  }
}

const SAP_OBJECT_TYPE_CATEGORIES: SapObjectTypeCategory[] = [
  'businessObject', 'technicalObject', 'analyticalObject',
  'configurationObject', 'dependentObject', 'hierarchyObject'
]

const CREATION_CATEGORIES: SapObjectTypeCreationCategory[] = ['bo', 'to', 'ao', 'co', 'do', 'ho']

function creationCategory(category: SapObjectTypeCategory): SapObjectTypeCreationCategory {
  const mapping: Record<SapObjectTypeCategory, SapObjectTypeCreationCategory> = {
    businessObject: 'bo',
    technicalObject: 'to',
    analyticalObject: 'ao',
    configurationObject: 'co',
    dependentObject: 'do',
    hierarchyObject: 'ho'
  }
  return mapping[category]
}

async function readJsonObject(
  h: AdtHTTP,
  url: string,
  contentType: string,
  label: string
): Promise<Record<string, unknown>> {
  const response = await h.request(url, { headers: { Accept: contentType } })
  return parseJsonObject(response.body, label)
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw adtException(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw adtException(`${label} is missing.`)
  return value as Record<string, unknown>
}

function semanticName(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,29}$/.test(value)
}

function boundedString(value: unknown, maximum: number): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/[\r\n\u0000-\u001f\u007f]/.test(value)
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || value === '' || boundedString(value, maximum)
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
