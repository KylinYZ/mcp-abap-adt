import { adtException, ValidateObjectUrl, ValidateStateful } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity } from '../utilities'
import type { ObjectVersion } from './objectstructure'
import type { ValidationResult } from './objectcreator'

export const NUMBER_RANGE_OBJECT_COLLECTION_PATH = '/sap/bc/adt/numberranges/objects'
export const NUMBER_RANGE_OBJECT_VALIDATION_PATH = `${NUMBER_RANGE_OBJECT_COLLECTION_PATH}/validation`
export const NUMBER_RANGE_OBJECT_SCHEMA_PATH = `${NUMBER_RANGE_OBJECT_COLLECTION_PATH}/$schema`
export const NUMBER_RANGE_OBJECT_SHELL_CONTENT_TYPE = 'application/vnd.sap.adt.blues.v1+xml'
export const NUMBER_RANGE_OBJECT_VALIDATION_CONTENT_TYPE = 'application/vnd.sap.as+xml'
export const NUMBER_RANGE_OBJECT_SCHEMA_CONTENT_TYPE = 'application/vnd.sap.adt.serverdriven.schema.v1+json; framework=objectTypes.v1'
export const NUMBER_RANGE_OBJECT_CONTENT_TYPE = 'application/json'

export type NumberRangeObjectAbapLanguageVersion = 'standard' | 'cloudDevelopment'
export type NumberRangeObjectBuffering = 'mainBuffer' | 'parallel' | 'none'

export interface ControlledNumberRangeObjectShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledNumberRangeObjectContent {
  formatVersion: '1'
  header: {
    description: string
    originalLanguage: string
    abapLanguageVersion: NumberRangeObjectAbapLanguageVersion
  }
  interval: {
    numberLengthDomain: string
    percentWarning: number
    subType: string
    untilYear: boolean
    rolling: boolean
    prefix: boolean
  }
  configuration: {
    transactionId?: string
    buffering: NumberRangeObjectBuffering
    bufferedNumbers: number
  }
}

export interface ControlledNumberRangeObjectDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
}

export interface ControlledNumberRangeObjectCreationResult {
  location: string
  numberRangeObject: ControlledNumberRangeObjectDocument
}

export async function validateControlledNumberRangeObject(
  h: AdtHTTP,
  input: Pick<ControlledNumberRangeObjectShellInput, 'name' | 'description' | 'packageName'>
): Promise<ValidationResult> {
  const response = await h.request(NUMBER_RANGE_OBJECT_VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objtype: 'NROB/NRO',
      objname: input.name,
      description: input.description,
      packagename: input.packageName
    },
    headers: { Accept: NUMBER_RANGE_OBJECT_VALIDATION_CONTENT_TYPE }
  })
  const body = String(response.body || '').trim()
  if (!body) return { success: true }
  const checkResult = body.match(/<CHECK_RESULT>([^<]*)<\/CHECK_RESULT>/i)?.[1]?.trim().toUpperCase()
  if (checkResult !== 'X') throw adtException('SAP rejected the Number Range Object name or package assignment.')
  return { success: true }
}

export async function readControlledNumberRangeObjectSchema(h: AdtHTTP): Promise<unknown> {
  const response = await h.request(NUMBER_RANGE_OBJECT_SCHEMA_PATH, {
    headers: { Accept: NUMBER_RANGE_OBJECT_SCHEMA_CONTENT_TYPE }
  })
  return parseJsonObject(response.body, 'Number Range Object schema')
}

export async function createControlledNumberRangeObjectShell(
  h: AdtHTTP,
  input: ControlledNumberRangeObjectShellInput,
  contentType: string
): Promise<ControlledNumberRangeObjectCreationResult> {
  if (normalizeBaseContentType(contentType) !== NUMBER_RANGE_OBJECT_SHELL_CONTENT_TYPE) {
    throw adtException('ADT discovery did not provide the controlled Number Range Object shell content type.')
  }
  const response = await h.request(NUMBER_RANGE_OBJECT_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': contentType, Accept: contentType },
    body: buildControlledNumberRangeObjectShellXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  const numberRangeObject = parseControlledNumberRangeObject(response.body)
  if (response.status !== 201 || normalizePath(location) !== controlledNumberRangeObjectUrl(input.name)) {
    throw adtException('Number Range Object creation did not return HTTP 201 with the canonical Location header.')
  }
  if (numberRangeObject.name !== input.name.toUpperCase()) {
    throw adtException('Number Range Object creation response identity does not match the requested object.')
  }
  return { location, numberRangeObject }
}

export async function readControlledNumberRangeObjectContent(
  h: AdtHTTP,
  contentUrl: string,
  contentType: string,
  version?: ObjectVersion
): Promise<ControlledNumberRangeObjectContent> {
  ValidateObjectUrl(contentUrl)
  const normalizedContentType = normalizeNumberRangeObjectContentType(contentType)
  const response = await h.request(contentUrl, {
    ...(version ? { qs: { version } } : {}),
    headers: { Accept: normalizedContentType }
  })
  return parseControlledNumberRangeObjectContent(response.body)
}

export async function writeControlledNumberRangeObjectContent(
  h: AdtHTTP,
  contentUrl: string,
  content: ControlledNumberRangeObjectContent,
  contentType: string,
  lockHandle: string,
  transportRequest: string
): Promise<ControlledNumberRangeObjectContent> {
  ValidateObjectUrl(contentUrl)
  ValidateStateful(h)
  const normalizedContentType = normalizeNumberRangeObjectContentType(contentType)
  const response = await h.request(contentUrl, {
    method: 'PUT',
    qs: { lockHandle, corrNr: transportRequest },
    headers: { 'Content-Type': normalizedContentType, Accept: normalizedContentType },
    body: JSON.stringify(content, null, 2)
  })
  return String(response.body || '').trim()
    ? parseControlledNumberRangeObjectContent(response.body)
    : content
}

export function controlledNumberRangeObjectUrl(name: string): string {
  return `${NUMBER_RANGE_OBJECT_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function buildControlledNumberRangeObjectShellXml(input: ControlledNumberRangeObjectShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="NROB/NRO" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</blue:blueSource>`
}

export function parseControlledNumberRangeObject(xml: string): ControlledNumberRangeObjectDocument {
  const root = parseAttributes(String(xml || '').match(/<blue:blueSource\b[^>]*>/i)?.[0] || '')
  const packageRef = parseAttributes(String(xml || '').match(/<adtcore:packageRef\b[^>]*>/i)?.[0] || '')
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    packageName: packageRef['adtcore:name'],
    version: root['adtcore:version']
  }
}

export function parseControlledNumberRangeObjectContent(value: unknown): ControlledNumberRangeObjectContent {
  const parsed = parseJsonObject(value, 'Number Range Object content') as Record<string, unknown>
  const header = asObject(parsed.header, 'Number Range Object header')
  const interval = asObject(parsed.interval, 'Number Range Object interval')
  const configuration = asObject(parsed.configuration, 'Number Range Object configuration')
  const abapLanguageVersion = header.abapLanguageVersion === undefined
    ? 'standard'
    : String(header.abapLanguageVersion)
  const buffering = String(configuration.buffering || '')
  if (String(parsed.formatVersion || '') !== '1'
    || !boundedString(header.description, 60)
    || !/^[a-z]{2}$/.test(String(header.originalLanguage || ''))
    || !['standard', 'cloudDevelopment'].includes(abapLanguageVersion)
    || !repositoryValue(interval.numberLengthDomain, 30)
    || !boundedNumber(interval.percentWarning, 0.1, 99.9)
    || !optionalRepositoryValue(interval.subType, 30)
    || !isBoolean(interval.untilYear)
    || !isBoolean(interval.rolling)
    || !isBoolean(interval.prefix)
    || !optionalRepositoryValue(configuration.transactionId, 20)
    || !['mainBuffer', 'parallel', 'none'].includes(buffering)
    || !boundedInteger(configuration.bufferedNumbers, 0, 99999999)) {
    throw adtException('Number Range Object content does not match the controlled objectTypes.v1 contract.')
  }
  return {
    formatVersion: '1',
    header: {
      description: String(header.description),
      originalLanguage: String(header.originalLanguage),
      abapLanguageVersion: abapLanguageVersion as NumberRangeObjectAbapLanguageVersion
    },
    interval: {
      numberLengthDomain: String(interval.numberLengthDomain).toUpperCase(),
      percentWarning: Number(interval.percentWarning),
      subType: String(interval.subType || '').toUpperCase(),
      untilYear: interval.untilYear as boolean,
      rolling: interval.rolling as boolean,
      prefix: interval.prefix as boolean
    },
    configuration: {
      ...(configuration.transactionId ? { transactionId: String(configuration.transactionId).toUpperCase() } : {}),
      buffering: buffering as NumberRangeObjectBuffering,
      bufferedNumbers: Number(configuration.bufferedNumbers)
    }
  }
}

export function assertControlledNumberRangeObjectSchema(value: unknown): void {
  const schema = asObject(value, 'Number Range Object schema')
  const properties = asObject(schema.properties, 'Number Range Object schema properties')
  const header = schemaProperties(properties.header, 'Number Range Object header schema')
  const interval = schemaProperties(properties.interval, 'Number Range Object interval schema')
  const configuration = schemaProperties(properties.configuration, 'Number Range Object configuration schema')
  const versions = enumValues(header.abapLanguageVersion)
  const buffering = enumValues(configuration.buffering)
  const intervalRequired = requiredValues(properties.interval)
  const configurationRequired = requiredValues(properties.configuration)
  if (!properties.formatVersion
    || !header.description
    || !header.originalLanguage
    || !versions.includes('standard')
    || !versions.includes('cloudDevelopment')
    || !interval.numberLengthDomain
    || !interval.percentWarning
    || !interval.subType
    || !interval.untilYear
    || !interval.rolling
    || !interval.prefix
    || !configuration.transactionId
    || !buffering.includes('mainBuffer')
    || !buffering.includes('parallel')
    || !buffering.includes('none')
    || !configuration.bufferedNumbers
    || !['numberLengthDomain', 'percentWarning', 'untilYear', 'rolling', 'prefix'].every(name => intervalRequired.includes(name))
    || !['buffering', 'bufferedNumbers'].every(name => configurationRequired.includes(name))) {
    throw adtException('Target Number Range Object schema is incompatible with the reviewed ADT 3.60.2 contract.')
  }
}

export function normalizeNumberRangeObjectContentType(contentType: string): string {
  if (normalizeBaseContentType(contentType) !== NUMBER_RANGE_OBJECT_CONTENT_TYPE) {
    throw adtException('Number Range Object source link did not expose the reviewed application/json content type.')
  }
  return NUMBER_RANGE_OBJECT_CONTENT_TYPE
}

function schemaProperties(value: unknown, label: string): Record<string, unknown> {
  return asObject(asObject(value, label).properties, `${label} properties`)
}

function enumValues(value: unknown): string[] {
  const property = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Array.isArray(property.enum) ? property.enum.map(String) : []
}

function requiredValues(value: unknown): string[] {
  const property = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Array.isArray(property.required) ? property.required.map(String) : []
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

function boundedString(value: unknown, maximum: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\r\n\u0000-\u001f\u007f]/.test(value)
}

function repositoryValue(value: unknown, maximum: number): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && /^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/i.test(value)
}

function optionalRepositoryValue(value: unknown, maximum: number): boolean {
  return value === undefined || value === '' || repositoryValue(value, maximum)
}

function boundedNumber(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
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
