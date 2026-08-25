import { adtException, ValidateObjectUrl, ValidateStateful } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity } from '../utilities'
import type { ObjectVersion } from './objectstructure'
import type { ValidationResult } from './objectcreator'

export const LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH = '/sap/bc/adt/ddic/desd'
export const LOGICAL_EXTERNAL_SCHEMA_VALIDATION_PATH = `${LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH}/validation`
export const LOGICAL_EXTERNAL_SCHEMA_SCHEMA_PATH = `${LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH}/$schema`
export const LOGICAL_EXTERNAL_SCHEMA_SHELL_CONTENT_TYPE = 'application/vnd.sap.adt.blues.v1+xml'
export const LOGICAL_EXTERNAL_SCHEMA_SCHEMA_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=objectTypes.v1'
export const LOGICAL_EXTERNAL_SCHEMA_CONTENT_TYPE = 'application/json'

export type LogicalExternalSchemaAbapLanguageVersion = 'standard' | 'cloudDevelopment'

export interface ControlledLogicalExternalSchemaShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledLogicalExternalSchemaContent {
  formatVersion: '1'
  header: {
    description: string
    originalLanguage: string
    abapLanguageVersion?: LogicalExternalSchemaAbapLanguageVersion
  }
  generalInformation: {
    defaultRemoteSchemaName?: string
    usesRouting?: boolean
  }
}

export interface ControlledLogicalExternalSchemaDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
}

export interface ControlledLogicalExternalSchemaCreationResult {
  location: string
  logicalExternalSchema: ControlledLogicalExternalSchemaDocument
}

export async function validateControlledLogicalExternalSchema(
  h: AdtHTTP,
  input: Pick<ControlledLogicalExternalSchemaShellInput, 'name' | 'description' | 'packageName'>
): Promise<ValidationResult> {
  const response = await h.request(LOGICAL_EXTERNAL_SCHEMA_VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objtype: 'DESD/TYP',
      objname: input.name,
      description: input.description,
      packagename: input.packageName
    },
    headers: { Accept: 'application/vnd.sap.as+xml' }
  })
  // Server-driven name checks may acknowledge success with an empty body.
  if (!String(response.body || '').trim()) return { success: true }
  return parseLogicalExternalSchemaValidation(response.body)
}

export async function readControlledLogicalExternalSchemaSchema(h: AdtHTTP): Promise<unknown> {
  const response = await h.request(LOGICAL_EXTERNAL_SCHEMA_SCHEMA_PATH, {
    headers: { Accept: LOGICAL_EXTERNAL_SCHEMA_SCHEMA_CONTENT_TYPE }
  })
  return parseJsonObject(response.body, 'Logical External Schema schema')
}

export async function createControlledLogicalExternalSchemaShell(
  h: AdtHTTP,
  input: ControlledLogicalExternalSchemaShellInput,
  contentType: string
): Promise<ControlledLogicalExternalSchemaCreationResult> {
  if (normalizeBaseContentType(contentType) !== LOGICAL_EXTERNAL_SCHEMA_SHELL_CONTENT_TYPE) {
    throw adtException('ADT discovery did not provide the controlled Logical External Schema shell content type.')
  }
  const response = await h.request(LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': contentType, Accept: contentType },
    body: buildControlledLogicalExternalSchemaShellXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  const logicalExternalSchema = parseControlledLogicalExternalSchema(response.body)
  if (response.status !== 201 || normalizePath(location) !== controlledLogicalExternalSchemaUrl(input.name)) {
    throw adtException('Logical External Schema creation did not return HTTP 201 with the canonical Location header.')
  }
  if (logicalExternalSchema.name !== input.name.toUpperCase()) {
    throw adtException('Logical External Schema creation response identity does not match the requested object.')
  }
  return { location, logicalExternalSchema }
}

export async function readControlledLogicalExternalSchemaContent(
  h: AdtHTTP,
  contentUrl: string,
  contentType: string,
  version?: ObjectVersion
): Promise<ControlledLogicalExternalSchemaContent> {
  ValidateObjectUrl(contentUrl)
  const normalizedContentType = normalizeLogicalExternalSchemaContentType(contentType)
  const response = await h.request(contentUrl, {
    ...(version ? { qs: { version } } : {}),
    headers: { Accept: normalizedContentType }
  })
  return parseControlledLogicalExternalSchemaContent(response.body)
}

export async function writeControlledLogicalExternalSchemaContent(
  h: AdtHTTP,
  contentUrl: string,
  content: ControlledLogicalExternalSchemaContent,
  contentType: string,
  lockHandle: string,
  transportRequest: string
): Promise<ControlledLogicalExternalSchemaContent> {
  ValidateObjectUrl(contentUrl)
  ValidateStateful(h)
  const normalizedContentType = normalizeLogicalExternalSchemaContentType(contentType)
  const response = await h.request(contentUrl, {
    method: 'PUT',
    qs: { lockHandle, corrNr: transportRequest },
    headers: { 'Content-Type': normalizedContentType, Accept: normalizedContentType },
    body: JSON.stringify(content, null, 2)
  })
  return String(response.body || '').trim()
    ? parseControlledLogicalExternalSchemaContent(response.body)
    : content
}

export function controlledLogicalExternalSchemaUrl(name: string): string {
  return `${LOGICAL_EXTERNAL_SCHEMA_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function buildControlledLogicalExternalSchemaShellXml(input: ControlledLogicalExternalSchemaShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="DESD/TYP" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</blue:blueSource>`
}

export function parseControlledLogicalExternalSchema(xml: string): ControlledLogicalExternalSchemaDocument {
  const root = parseAttributes(String(xml || '').match(/<blue:blueSource\b[^>]*>/i)?.[0] || '')
  const packageRef = parseAttributes(String(xml || '').match(/<adtcore:packageRef\b[^>]*>/i)?.[0] || '')
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    packageName: packageRef['adtcore:name'],
    version: root['adtcore:version']
  }
}

export function parseControlledLogicalExternalSchemaContent(value: unknown): ControlledLogicalExternalSchemaContent {
  const parsed = parseJsonObject(value, 'Logical External Schema content') as Record<string, unknown>
  const header = asObject(parsed.header, 'Logical External Schema header')
  const generalInformation = parsed.generalInformation === undefined
    ? undefined
    : asObject(parsed.generalInformation, 'Logical External Schema generalInformation')
  const abapLanguageVersion = header.abapLanguageVersion === undefined
    ? undefined
    : String(header.abapLanguageVersion)
  if (String(parsed.formatVersion || '') !== '1'
    || !String(header.description || '')
    || !/^[a-z]{2}$/.test(String(header.originalLanguage || ''))
    || (abapLanguageVersion !== undefined && !['standard', 'cloudDevelopment'].includes(abapLanguageVersion))) {
    throw adtException('Logical External Schema content does not match the controlled objectTypes.v1 contract.')
  }
  return {
    formatVersion: '1',
    header: {
      description: String(header.description),
      originalLanguage: String(header.originalLanguage),
      ...(abapLanguageVersion ? { abapLanguageVersion: abapLanguageVersion as LogicalExternalSchemaAbapLanguageVersion } : {})
    },
    generalInformation: {
      ...(generalInformation?.defaultRemoteSchemaName !== undefined
        ? { defaultRemoteSchemaName: String(generalInformation.defaultRemoteSchemaName) }
        : {}),
      ...(generalInformation?.usesRouting !== undefined
        ? { usesRouting: parseBoolean(generalInformation.usesRouting, 'Logical External Schema usesRouting') }
        : {})
    }
  }
}

export function assertControlledLogicalExternalSchemaSchema(value: unknown): void {
  const schema = asObject(value, 'Logical External Schema schema')
  const properties = asObject(schema.properties, 'Logical External Schema schema properties')
  const header = asObject(properties.header, 'Logical External Schema header schema')
  const headerProperties = asObject(header.properties, 'Logical External Schema header properties')
  const languageVersion = asObject(headerProperties.abapLanguageVersion, 'Logical External Schema language-version schema')
  const general = asObject(properties.generalInformation, 'Logical External Schema general-information schema')
  const generalProperties = asObject(general.properties, 'Logical External Schema general-information properties')
  const allowedVersions = Array.isArray(languageVersion.enum) ? languageVersion.enum.map(String) : []
  if (!properties.formatVersion
    || !headerProperties.description
    || !headerProperties.originalLanguage
    || !allowedVersions.includes('standard')
    || !allowedVersions.includes('cloudDevelopment')
    || !generalProperties.defaultRemoteSchemaName
    || !generalProperties.usesRouting) {
    throw adtException('Target Logical External Schema schema is incompatible with the reviewed ADT 3.60.2 contract.')
  }
}

export function normalizeLogicalExternalSchemaContentType(contentType: string): string {
  const value = String(contentType || '').trim()
  const base = normalizeBaseContentType(value)
  if (base !== normalizeBaseContentType(LOGICAL_EXTERNAL_SCHEMA_CONTENT_TYPE)) {
    throw adtException('Logical External Schema source link did not expose the reviewed application/json content type.')
  }
  const parameters = value.split(';').slice(1).map(parameter => parameter.trim()).filter(Boolean)
  if (parameters.length > 1 || parameters.some(parameter => !/^charset\s*=\s*"?utf-8"?$/i.test(parameter))) {
    throw adtException('Logical External Schema source link exposed unsupported application/json parameters.')
  }
  return LOGICAL_EXTERNAL_SCHEMA_CONTENT_TYPE
}

function parseLogicalExternalSchemaValidation(xml: string): ValidationResult {
  const severity = String(xml || '').match(/<(?:SEVERITY|severity)>([^<]*)</i)?.[1] || ''
  const shortText = String(xml || '').match(/<(?:SHORT_TEXT|shortText)>([^<]*)</i)?.[1] || ''
  if (['E', 'ERROR'].includes(severity.toUpperCase())) {
    throw adtException(shortText || 'Logical External Schema validation failed.')
  }
  return { SEVERITY: severity || undefined, SHORT_TEXT: shortText || undefined, success: true }
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

function parseBoolean(value: unknown, label: string): boolean {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw adtException(`${label} is not boolean.`)
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
