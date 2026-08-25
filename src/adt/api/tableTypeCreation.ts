import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { activate, type ActivationResult } from './activate'
import type { ValidationResult } from './objectcreator'
import { encodeEntity } from '../utilities'

export const TABLE_TYPE_COLLECTION_PATH = '/sap/bc/adt/ddic/tabletypes'
export const TABLE_TYPE_VALIDATION_PATH = `${TABLE_TYPE_COLLECTION_PATH}/validation`
export const TABLE_TYPE_CONTENT_TYPE = 'application/vnd.sap.adt.tabletype.v1+xml'
export const ABAP_TYPE_COMPLETION_PATH = '/sap/bc/adt/ddic/codecompletion'

export type ControlledTableTypeKind =
  | 'predefinedAbapType'
  | 'dictionaryType'
  | 'referenceToPredefinedType'
  | 'referenceToDictionaryType'
  | 'referenceToClassInterface'
  | 'rangeTableOnPredefinedType'
  | 'rangeTableOnDataElement'

export interface ControlledTableTypeShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledAbapTypeCapability {
  name: string
  pattern: string
  lengthMin?: number
  lengthMax?: number
  decimalsMin?: number
  decimalsMax?: number
}

export interface ControlledTableTypeRowType {
  typeKind: ControlledTableTypeKind
  typeName?: string
  dataType?: string
  length?: number
  decimals?: number
  rangeType?: string
}

export interface ControlledTableTypeProperties {
  rowType: ControlledTableTypeRowType
  initialRowCount: number
  accessType: 'standard' | 'sorted' | 'hashed' | 'index'
  primaryKey: {
    definition: 'standard' | 'rowType' | 'keyComponents' | 'empty'
    kind: 'unique' | 'nonUnique'
  }
  secondaryKeys: {
    allowed: 'allowed' | 'notAllowed' | 'notSpecified'
  }
}

export interface ControlledTableTypeDocument extends ControlledTableTypeProperties {
  name: string
  description: string
  packageName: string
  version?: string
  rawXml: string
}

export interface ControlledTableTypeCreationResult {
  location: string
  tableType: ControlledTableTypeDocument
}

export async function validateControlledTableTypeShell(
  h: AdtHTTP,
  input: Pick<ControlledTableTypeShellInput, 'name' | 'description'>
): Promise<ValidationResult> {
  const response = await h.request(TABLE_TYPE_VALIDATION_PATH, {
    method: 'POST',
    qs: { objtype: 'ttypda', objname: input.name, description: input.description },
    // The validation endpoint returns an ABAP XML checklist, not a table-type document.
    headers: { Accept: 'application/vnd.sap.as+xml' }
  })
  return parseTableTypeValidation(response.body)
}

export async function createControlledTableTypeShell(
  h: AdtHTTP,
  input: ControlledTableTypeShellInput
): Promise<ControlledTableTypeCreationResult> {
  const response = await h.request(TABLE_TYPE_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': TABLE_TYPE_CONTENT_TYPE, Accept: TABLE_TYPE_CONTENT_TYPE },
    body: buildControlledTableTypeShellXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  if (response.status !== 201 || normalizePath(location) !== controlledTableTypeUrl(input.name)) {
    throw adtException('DDIC table type creation did not return HTTP 201 with the canonical Location header.')
  }
  const tableType = parseControlledTableType(response.body)
  if (tableType.name !== input.name.toUpperCase()) {
    throw adtException('DDIC table type creation response identity does not match the requested table type.')
  }
  return { location, tableType }
}

export async function readControlledTableType(
  h: AdtHTTP,
  name: string,
  version?: 'active' | 'inactive' | 'workingArea'
): Promise<ControlledTableTypeDocument> {
  const response = await h.request(controlledTableTypeUrl(name), {
    method: 'GET',
    ...(version ? { qs: { version } } : {}),
    headers: { Accept: TABLE_TYPE_CONTENT_TYPE, 'Cache-Control': 'no-cache' }
  })
  return parseControlledTableType(response.body)
}

export async function writeControlledTableType(
  h: AdtHTTP,
  name: string,
  current: ControlledTableTypeDocument,
  properties: ControlledTableTypeProperties,
  lockHandle: string,
  transportRequest: string
): Promise<ControlledTableTypeDocument> {
  const body = patchTableTypeXml(current.rawXml, properties)
  const response = await h.request(controlledTableTypeUrl(name), {
    method: 'PUT',
    qs: { lockHandle, corrNr: transportRequest },
    headers: { 'Content-Type': TABLE_TYPE_CONTENT_TYPE, Accept: TABLE_TYPE_CONTENT_TYPE },
    body
  })
  if (response.status !== 200) throw adtException('DDIC table type property write did not return HTTP 200.')
  return parseControlledTableType(response.body)
}

export function controlledTableTypeUrl(name: string): string {
  return `${TABLE_TYPE_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function activateControlledTableType(h: AdtHTTP, name: string): Promise<ActivationResult> {
  return activate(h, name.toUpperCase(), controlledTableTypeUrl(name), undefined, true)
}

export async function readControlledAbapTypeCapabilities(h: AdtHTTP): Promise<ControlledAbapTypeCapability[]> {
  const response = await h.request(ABAP_TYPE_COMPLETION_PATH, {
    method: 'GET',
    qs: { path: '*', type: 'abapType' },
    headers: { Accept: 'application/vnd.sap.adt.elementinfo+xml' }
  })
  return parseAbapTypeCapabilities(response.body)
}

export function buildControlledTableTypeShellXml(input: ControlledTableTypeShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<ttyp:tableType xmlns:adtcore="http://www.sap.com/adt/core" xmlns:ttyp="http://www.sap.com/dictionary/tabletype" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="TTYP/DA" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</ttyp:tableType>`
}

export function parseControlledTableType(xml: string): ControlledTableTypeDocument {
  const rawXml = String(xml || '')
  const root = parseAttributes(firstTag(rawXml, 'ttyp:tableType'))
  const packageRef = parseAttributes(firstTag(rawXml, 'adtcore:packageRef'))
  const rowType = section(rawXml, 'ttyp:rowType')
  const primaryKey = section(rawXml, 'ttyp:primaryKey')
  const secondaryKeys = section(rawXml, 'ttyp:secondaryKeys')
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: String(root['adtcore:description'] || ''),
    packageName: String(packageRef['adtcore:name'] || '').toUpperCase(),
    version: root['adtcore:version'],
    rowType: {
      typeKind: text(rowType, 'ttyp:typeKind') as ControlledTableTypeKind,
      typeName: text(rowType, 'ttyp:typeName') || undefined,
      dataType: text(rowType, 'ttyp:dataType') || undefined,
      length: numberOrUndefined(text(rowType, 'ttyp:length')),
      decimals: numberOrUndefined(text(rowType, 'ttyp:decimals')),
      rangeType: text(rowType, 'ttyp:rangeType') || undefined
    },
    initialRowCount: numberOrDefault(text(rawXml, 'ttyp:initialRowCount'), 0),
    accessType: (text(rawXml, 'ttyp:accessType') || 'standard') as ControlledTableTypeProperties['accessType'],
    primaryKey: {
      definition: (text(primaryKey, 'ttyp:definition') || 'standard') as ControlledTableTypeProperties['primaryKey']['definition'],
      kind: (text(primaryKey, 'ttyp:kind') || 'nonUnique') as ControlledTableTypeProperties['primaryKey']['kind']
    },
    secondaryKeys: {
      allowed: (text(secondaryKeys, 'ttyp:allowed') || 'notSpecified') as ControlledTableTypeProperties['secondaryKeys']['allowed']
    },
    rawXml
  }
}

function patchTableTypeXml(xml: string, properties: ControlledTableTypeProperties): string {
  let result = xml
  result = replaceText(result, 'ttyp:typeKind', properties.rowType.typeKind)
  result = replaceText(result, 'ttyp:typeName', properties.rowType.typeName || '')
  result = replaceText(result, 'ttyp:dataType', properties.rowType.dataType ? properties.rowType.dataType.toUpperCase() : '')
  result = replaceText(result, 'ttyp:length', properties.rowType.length === undefined ? '' : pad(properties.rowType.length, 6))
  result = replaceText(result, 'ttyp:decimals', properties.rowType.decimals === undefined ? '' : pad(properties.rowType.decimals, 6))
  result = replaceText(result, 'ttyp:rangeType', properties.rowType.rangeType || '')
  result = replaceText(result, 'ttyp:initialRowCount', pad(properties.initialRowCount, 5))
  result = replaceText(result, 'ttyp:accessType', properties.accessType)
  result = replaceTextInSection(result, 'ttyp:primaryKey', 'ttyp:definition', properties.primaryKey.definition)
  result = replaceTextInSection(result, 'ttyp:primaryKey', 'ttyp:kind', properties.primaryKey.kind)
  result = replaceTextInSection(result, 'ttyp:secondaryKeys', 'ttyp:allowed', properties.secondaryKeys.allowed)
  return result
}

function parseAbapTypeCapabilities(xml: string): ControlledAbapTypeCapability[] {
  const result: ControlledAbapTypeCapability[] = []
  for (const match of String(xml || '').matchAll(/<abapsource:elementInfo\b(?=[^>]*\badtcore:name=)([^>]*)>([\s\S]*?)<\/abapsource:elementInfo>/gi)) {
    const attributes = parseAttributes(match[1])
    const body = match[2]
    const name = String(attributes['adtcore:name'] || '').trim().toLowerCase()
    if (!name) continue
    const entries = new Map<string, string>()
    for (const entry of body.matchAll(/<abapsource:entry\b([^>]*)>([\s\S]*?)<\/abapsource:entry>/gi)) {
      const entryAttributes = parseAttributes(entry[1])
      entries.set(String(entryAttributes['abapsource:key'] || ''), decodeXml(entry[2]).trim())
    }
    result.push({
      name,
      pattern: entries.get('ddicPattern') || name,
      lengthMin: integer(entries.get('ddicLengthMin')),
      lengthMax: integer(entries.get('ddicLengthMax')),
      decimalsMin: integer(entries.get('ddicDecimalsMin')),
      decimalsMax: integer(entries.get('ddicDecimalsMax'))
    })
  }
  return result.filter((item, index, all) => all.findIndex(candidate => candidate.name === item.name) === index)
}

function parseTableTypeValidation(xml: string): ValidationResult {
  const severity = String(xml || '').match(/<(?:SEVERITY|severity)>([^<]*)</i)?.[1] || ''
  const shortText = String(xml || '').match(/<(?:SHORT_TEXT|shortText)>([^<]*)</i)?.[1] || ''
  if (['E', 'ERROR'].includes(severity.toUpperCase())) throw adtException(shortText || 'DDIC table type validation failed.')
  return { SEVERITY: severity || undefined, SHORT_TEXT: shortText || undefined, success: true }
}

function section(xml: string, tag: string): string {
  return String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'i'))?.[0] || ''
}

function text(xml: string, tag: string): string {
  return decodeXml(String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '').trim()
}

function replaceText(xml: string, tag: string, value: string): string {
  const encoded = encodeEntity(value)
  const pattern = new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(</${tag}>)`, 'i')
  if (pattern.test(xml)) return xml.replace(pattern, `$1${encoded}$2`)
  return xml.replace(new RegExp(`<${tag}\\b([^>]*)/>`, 'i'), encoded ? `<${tag}$1>${encoded}</${tag}>` : `<${tag}$1/>`)
}

function replaceTextInSection(xml: string, parentTag: string, tag: string, value: string): string {
  const parentPattern = new RegExp(`(<${parentTag}\\b[^>]*>[\\s\\S]*?</${parentTag}>)`, 'i')
  return xml.replace(parentPattern, parent => replaceText(parent, tag, value))
}

function firstTag(xml: string, tag: string): string {
  return String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>`, 'i'))?.[0] || ''
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of String(tag || '').matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = decodeXml(match[2])
  return attributes
}

function normalizePath(value: string): string {
  return String(value || '').split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase()
}

function numberOrUndefined(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function numberOrDefault(value: string, fallback: number): number {
  return numberOrUndefined(value) ?? fallback
}

function integer(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function decodeXml(value: string): string {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
