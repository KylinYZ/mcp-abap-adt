import { adtException, ValidateObjectUrl } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity } from '../utilities'
import type { ObjectVersion } from './objectstructure'
import type { ValidationResult } from './objectcreator'

export const SAP_OBJECT_NODE_TYPE_COLLECTION_PATH = '/sap/bc/adt/businessobjects/nontnot'
export const SAP_OBJECT_NODE_TYPE_VALIDATION_PATH = `${SAP_OBJECT_NODE_TYPE_COLLECTION_PATH}/validation`
export const SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_PATH = `${SAP_OBJECT_NODE_TYPE_COLLECTION_PATH}/$new/schema`
export const SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_PATH = `${SAP_OBJECT_NODE_TYPE_COLLECTION_PATH}/$new/configuration`
export const SAP_OBJECT_NODE_TYPE_NEW_CONTENT_PATH = `${SAP_OBJECT_NODE_TYPE_COLLECTION_PATH}/$new/content`
export const SAP_OBJECT_NODE_TYPE_SHELL_CONTENT_TYPE = 'application/vnd.sap.adt.blues.v2+xml'
export const SAP_OBJECT_NODE_TYPE_ADDITIONAL_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.content.v1+json'
export const SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=newObjectTypes.v1'
export const SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.configuration.v1+json; framework=newObjectTypes.v1'
export const SAP_OBJECT_NODE_TYPE_NEW_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.content.v1+json; framework=newObjectTypes.v1'
export const SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE = 'application/json'
export const SAP_OBJECT_NODE_TYPE_VALIDATION_CONTENT_TYPE = 'application/vnd.sap.as+xml'

export interface ControlledSapObjectNodeTypeShellInput {
  repositoryName: string
  semanticName: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
  sapObjectTypeName: string
  rootNode: boolean
}

export interface ControlledSapObjectNodeTypeCreationContent {
  name: string
  sapObjectType: string
  rootNode: boolean
  metadata: {
    name: string
    description: string
    package: string
  }
}

export interface ControlledSapObjectNodeTypeContent {
  formatVersion: '1'
  header: {
    description: string
    originalLanguage: string
    abapLanguageVersion?: 'standard' | 'cloudDevelopment'
  }
  name: string
  sapObjectType: string
  rootNode?: boolean
}

export interface ControlledSapObjectNodeTypeCreationContract {
  schema: Record<string, unknown>
  configuration: Record<string, unknown>
  content: Record<string, unknown>
}

export interface ControlledSapObjectNodeTypeDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
}

export interface ControlledSapObjectNodeTypeCreationResult {
  location: string
  sapObjectNodeType: ControlledSapObjectNodeTypeDocument
}

export async function validateControlledSapObjectNodeType(
  h: AdtHTTP,
  input: ControlledSapObjectNodeTypeShellInput,
  content: ControlledSapObjectNodeTypeCreationContent
): Promise<ValidationResult> {
  const response = await h.request(SAP_OBJECT_NODE_TYPE_VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objtype: 'NONT/NOT',
      objname: input.semanticName,
      description: input.description,
      packagename: input.packageName,
      packageName: input.packageName
    },
    headers: {
      'Content-Type': SAP_OBJECT_NODE_TYPE_ADDITIONAL_CONTENT_TYPE,
      Accept: SAP_OBJECT_NODE_TYPE_VALIDATION_CONTENT_TYPE
    },
    body: JSON.stringify(content)
  })
  const body = String(response.body || '').trim()
  if (!body) return { success: true }
  const checkResult = body.match(/<CHECK_RESULT>([^<]*)<\/CHECK_RESULT>/i)?.[1]?.trim().toUpperCase()
  if (checkResult !== 'X') throw adtException('SAP rejected the SAP Object Node Type name, package, or SAP Object Type reference.')
  return { success: true }
}

export async function readControlledSapObjectNodeTypeCreationContract(
  h: AdtHTTP
): Promise<ControlledSapObjectNodeTypeCreationContract> {
  const schema = await readJsonObject(h, SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_PATH, SAP_OBJECT_NODE_TYPE_NEW_SCHEMA_CONTENT_TYPE, 'SAP Object Node Type creation schema')
  const configuration = await readJsonObject(h, SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_PATH, SAP_OBJECT_NODE_TYPE_NEW_CONFIGURATION_CONTENT_TYPE, 'SAP Object Node Type creation configuration')
  const content = await readJsonObject(h, SAP_OBJECT_NODE_TYPE_NEW_CONTENT_PATH, SAP_OBJECT_NODE_TYPE_NEW_CONTENT_TYPE, 'SAP Object Node Type initial creation content')
  return { schema, configuration, content }
}

export async function createControlledSapObjectNodeType(
  h: AdtHTTP,
  input: ControlledSapObjectNodeTypeShellInput,
  content: ControlledSapObjectNodeTypeCreationContent,
  contentType: string
): Promise<ControlledSapObjectNodeTypeCreationResult> {
  if (normalizeBaseContentType(contentType) !== SAP_OBJECT_NODE_TYPE_SHELL_CONTENT_TYPE) {
    throw adtException('ADT discovery did not provide the controlled SAP Object Node Type Blue v2 content type.')
  }
  const response = await h.request(SAP_OBJECT_NODE_TYPE_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': contentType, Accept: contentType },
    body: buildControlledSapObjectNodeTypeXml(input, content)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  const sapObjectNodeType = parseControlledSapObjectNodeType(response.body)
  if (response.status !== 201 || normalizePath(location) !== controlledSapObjectNodeTypeUrl(input.repositoryName)) {
    throw adtException('SAP Object Node Type creation did not return HTTP 201 with the canonical Location header.')
  }
  if (sapObjectNodeType.name !== input.repositoryName.toUpperCase()) {
    throw adtException('SAP Object Node Type creation response identity does not match the requested object.')
  }
  return { location, sapObjectNodeType }
}

export async function readControlledSapObjectNodeTypeContent(
  h: AdtHTTP,
  contentUrl: string,
  contentType: string,
  version?: ObjectVersion
): Promise<ControlledSapObjectNodeTypeContent> {
  ValidateObjectUrl(contentUrl)
  if (normalizeBaseContentType(contentType) !== SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE) {
    throw adtException('SAP Object Node Type source link did not expose the reviewed application/json content type.')
  }
  const response = await h.request(contentUrl, {
    ...(version ? { qs: { version } } : {}),
    headers: { Accept: SAP_OBJECT_NODE_TYPE_SOURCE_CONTENT_TYPE }
  })
  return parseControlledSapObjectNodeTypeContent(response.body)
}

export function controlledSapObjectNodeTypeUrl(repositoryName: string): string {
  return `${SAP_OBJECT_NODE_TYPE_COLLECTION_PATH}/${encodeURIComponent(repositoryName.toLowerCase())}`
}

export function buildControlledSapObjectNodeTypeXml(
  input: ControlledSapObjectNodeTypeShellInput,
  content: ControlledSapObjectNodeTypeCreationContent
): string {
  const attr = (value: string) => encodeEntity(value)
  // Eclipse ADT embeds the reviewed creation JSON as base64 in the Blue v2 shell.
  const encodedContent = Buffer.from(JSON.stringify(content), 'utf8').toString('base64')
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.repositoryName)}" adtcore:type="NONT/NOT" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
  <blue:additionalCreationProperties>
    <adtcore:content adtcore:encoding="base64" adtcore:type="${SAP_OBJECT_NODE_TYPE_ADDITIONAL_CONTENT_TYPE}">${encodedContent}</adtcore:content>
  </blue:additionalCreationProperties>
</blue:blueSource>`
}

export function buildControlledSapObjectNodeTypeCreationContent(
  input: ControlledSapObjectNodeTypeShellInput
): ControlledSapObjectNodeTypeCreationContent {
  return {
    name: input.semanticName,
    sapObjectType: input.sapObjectTypeName,
    rootNode: input.rootNode,
    metadata: {
      name: input.repositoryName,
      description: input.description,
      package: input.packageName
    }
  }
}

export function parseControlledSapObjectNodeType(xml: unknown): ControlledSapObjectNodeTypeDocument {
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

export function parseControlledSapObjectNodeTypeContent(value: unknown): ControlledSapObjectNodeTypeContent {
  const parsed = parseJsonObject(value, 'SAP Object Node Type content')
  const header = asObject(parsed.header, 'SAP Object Node Type header')
  const abapLanguageVersion = header.abapLanguageVersion === undefined
    ? undefined
    : String(header.abapLanguageVersion)
  if (!onlyKeys(parsed, ['formatVersion', 'header', 'name', 'sapObjectType', 'rootNode'])
    || !onlyKeys(header, ['description', 'originalLanguage', 'abapLanguageVersion'])
    || String(parsed.formatVersion || '') !== '1'
    || !boundedString(header.description, 60)
    || !/^[a-z]{2}$/.test(String(header.originalLanguage || ''))
    || (abapLanguageVersion !== undefined && !['standard', 'cloudDevelopment'].includes(abapLanguageVersion))
    || !semanticName(parsed.name)
    || !semanticName(parsed.sapObjectType)
    || (parsed.rootNode !== undefined && typeof parsed.rootNode !== 'boolean')) {
    throw adtException('SAP Object Node Type content does not match the controlled nont-v1 contract.')
  }
  return {
    formatVersion: '1',
    header: {
      description: String(header.description),
      originalLanguage: String(header.originalLanguage),
      ...(abapLanguageVersion ? { abapLanguageVersion: abapLanguageVersion as 'standard' | 'cloudDevelopment' } : {})
    },
    name: String(parsed.name),
    sapObjectType: String(parsed.sapObjectType),
    ...(parsed.rootNode !== undefined ? { rootNode: parsed.rootNode as boolean } : {})
  }
}

export function assertControlledSapObjectNodeTypeCreationContract(
  contract: ControlledSapObjectNodeTypeCreationContract
): void {
  const properties = asObject(contract.schema.properties, 'SAP Object Node Type creation schema properties')
  const name = asObject(properties.name, 'SAP Object Node Type creation name schema')
  const sapObjectType = asObject(properties.sapObjectType, 'SAP Object Node Type reference schema')
  const rootNode = asObject(properties.rootNode, 'SAP Object Node Type root-node schema')
  const metadata = asObject(properties.metadata, 'SAP Object Node Type creation metadata schema')
  const metadataProperties = asObject(metadata.properties, 'SAP Object Node Type creation metadata properties')
  const configurationProperties = asObject(contract.configuration.properties, 'SAP Object Node Type creation configuration properties')
  const nameConfiguration = asObject(configurationProperties.name, 'SAP Object Node Type name configuration')
  const referenceConfiguration = asObject(configurationProperties.sapObjectType, 'SAP Object Node Type reference configuration')
  const metadataConfiguration = asObject(configurationProperties.metadata, 'SAP Object Node Type metadata configuration')
  const metadataConfigurationProperties = asObject(metadataConfiguration.properties, 'SAP Object Node Type metadata configuration properties')
  const metadataNameConfiguration = asObject(metadataConfigurationProperties.name, 'SAP Object Node Type metadata name configuration')
  const required = Array.isArray(contract.schema.required) ? contract.schema.required.map(String) : []
  const referenceTypes = Array.isArray(referenceConfiguration['sap.adt.types'])
    ? referenceConfiguration['sap.adt.types'].map(String)
    : []
  const sideEffect = asObject(nameConfiguration['sap.adt.sideeffect'], 'SAP Object Node Type name side-effect')
  const determinations = Array.isArray(sideEffect.determination) ? sideEffect.determination.map(String) : []
  if (name.maxLength !== 30
    || sapObjectType.maxLength !== 30
    || rootNode.type !== 'boolean'
    || !required.includes('name')
    || !required.includes('sapObjectType')
    || !metadataProperties.name
    || !metadataProperties.description
    || !metadataProperties.package
    || !determinations.includes('afterUpdate')
    || !referenceTypes.includes('RONT')
    || metadataNameConfiguration['sap.adt.readonly'] !== true
    || Object.keys(contract.content).length !== 0) {
    throw adtException('Target SAP Object Node Type creation contract is incompatible with the reviewed ADT 3.60.2 schema.')
  }
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

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
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
