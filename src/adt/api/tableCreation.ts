import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { btoa, encodeEntity, fullParse, xmlArray } from '../utilities'
import { activate, type ActivationResult } from './activate'
import type { ValidationResult } from './objectcreator'
import { parseCheckResults, type SyntaxCheckResult } from './syntax'

export const TABLE_V2_MEDIA_TYPE = 'application/vnd.sap.adt.tables.v2+xml'
export const TABLE_ACCEPT = 'application/vnd.sap.adt.blues.v1+xml, application/vnd.sap.adt.tables.v2+xml'
export const TABLE_SETTINGS_V2_MEDIA_TYPE = 'application/vnd.sap.adt.table.settings.v2+xml'
export const TABLE_SETTINGS_ACCEPT = 'application/vnd.sap.adt.table.settings.v1+xml, application/vnd.sap.adt.table.settings.v2+xml'
export const CHECK_OBJECTS_MEDIA_TYPE = 'application/vnd.sap.adt.checkobjects+xml'
export const CHECK_MESSAGES_MEDIA_TYPE = 'application/vnd.sap.adt.checkmessages+xml'

export interface ControlledTableShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledTableDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
  sourceUri?: string
}

export interface ControlledTableCreationResult {
  location: string
  table: ControlledTableDocument
}

export type ControlledTableCheckReporter = 'tableStatusCheck' | 'abapCheckRun'

export interface ControlledTableTechnicalSettings {
  dataClass: 'APPL0' | 'APPL1' | 'APPL2' | 'APPL3' | 'USER'
  sizeCategory: number
  buffering: 'NOT_ALLOWED'
  loggingEnabled: boolean
  storageType?: 'C'
}

export interface ControlledTableSettingsDocument extends ControlledTableTechnicalSettings {
  name: string
  description?: string
  language?: string
  version?: string
  changedAt?: string
  changedBy?: string
  createdAt?: string
  createdBy?: string
}

export async function validateControlledTableShell(
  h: AdtHTTP,
  input: Pick<ControlledTableShellInput, 'name' | 'description'>
): Promise<ValidationResult> {
  const response = await h.request('/sap/bc/adt/ddic/tables/validation', {
    method: 'POST',
    qs: { objtype: 'tabldt', objname: input.name, description: input.description }
  })
  return parseTableValidation(response.body)
}

export async function createControlledTableShell(
  h: AdtHTTP,
  input: ControlledTableShellInput
): Promise<ControlledTableCreationResult> {
  const response = await h.request('/sap/bc/adt/ddic/tables', {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': TABLE_V2_MEDIA_TYPE, Accept: TABLE_ACCEPT },
    body: buildControlledTableShellXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  if (response.status !== 201 || !location) {
    throw adtException('Database table creation did not return HTTP 201 with a Location header.')
  }
  const table = parseControlledTable(response.body)
  if (table.name !== input.name.toUpperCase() || normalizePath(location) !== controlledTableUrl(input.name)) {
    throw adtException('Database table creation response identity does not match the requested table.')
  }
  return { location, table }
}

export async function readControlledTable(
  h: AdtHTTP,
  tableName: string,
  version?: 'active' | 'inactive' | 'workingArea'
): Promise<ControlledTableDocument> {
  const response = await h.request(controlledTableUrl(tableName), {
    headers: { Accept: TABLE_ACCEPT },
    ...(version ? { qs: { version } } : {})
  })
  return parseControlledTable(response.body)
}

export async function readControlledTableSource(
  h: AdtHTTP,
  tableName: string,
  version?: 'active' | 'inactive' | 'workingArea'
): Promise<string> {
  const response = await h.request(controlledTableSourceUrl(tableName), {
    headers: { Accept: 'text/plain' },
    ...(version ? { qs: { version } } : {})
  })
  return response.body
}

export async function writeControlledTableSource(
  h: AdtHTTP,
  tableName: string,
  source: string,
  lockHandle: string,
  transportRequest: string
): Promise<string> {
  const response = await h.request(controlledTableSourceUrl(tableName), {
    method: 'PUT',
    qs: { lockHandle, corrNr: transportRequest },
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' },
    body: source
  })
  return response.body
}

export async function runControlledTableCheck(
  h: AdtHTTP,
  tableName: string,
  reporter: ControlledTableCheckReporter,
  source?: string
): Promise<SyntaxCheckResult[]> {
  const tableUrl = controlledTableUrl(tableName)
  const artifact = source === undefined ? '' : `
    <chkrun:artifacts>
      <chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${controlledTableSourceUrl(tableName)}">
        <chkrun:content>${btoa(source)}</chkrun:content>
      </chkrun:artifact>
    </chkrun:artifacts>`
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:adtcore="http://www.sap.com/adt/core" xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkObject adtcore:uri="${tableUrl}" chkrun:version="active">${artifact}
  </chkrun:checkObject>
</chkrun:checkObjectList>`
  const response = await h.request('/sap/bc/adt/checkruns', {
    method: 'POST',
    qs: { reporters: reporter },
    headers: { 'Content-Type': CHECK_OBJECTS_MEDIA_TYPE, Accept: CHECK_MESSAGES_MEDIA_TYPE },
    body
  })
  return parseCheckResults(fullParse(response.body))
}

export async function readControlledTableSettings(
  h: AdtHTTP,
  tableName: string,
  version?: 'active' | 'inactive' | 'workingArea'
): Promise<ControlledTableSettingsDocument> {
  const response = await h.request(controlledTableSettingsUrl(tableName), {
    headers: { Accept: TABLE_SETTINGS_ACCEPT },
    ...(version ? { qs: { version } } : {})
  })
  return parseControlledTableSettings(response.body)
}

export async function writeControlledTableSettings(
  h: AdtHTTP,
  current: ControlledTableSettingsDocument,
  settings: ControlledTableTechnicalSettings,
  lockHandle: string,
  transportRequest: string
): Promise<ControlledTableSettingsDocument> {
  const response = await h.request(controlledTableSettingsUrl(current.name), {
    method: 'PUT',
    qs: { lockHandle, corrNr: transportRequest },
    headers: { 'Content-Type': `${TABLE_SETTINGS_V2_MEDIA_TYPE}; charset=utf-8`, Accept: TABLE_SETTINGS_ACCEPT },
    body: buildControlledTableSettingsXml(current, settings)
  })
  return parseControlledTableSettings(response.body)
}

export function activateControlledTable(
  h: AdtHTTP,
  tableName: string
): Promise<ActivationResult> {
  return activate(h, tableName.toUpperCase(), controlledTableUrl(tableName), undefined, true)
}

export function activateControlledTableSettings(
  h: AdtHTTP,
  tableName: string
): Promise<ActivationResult> {
  return activate(h, tableName.toUpperCase(), controlledTableSettingsUrl(tableName), undefined, true)
}

export function buildControlledTableShellXml(input: ControlledTableShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="TABL/DT" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</blue:blueSource>`
}

export function buildControlledTableSettingsXml(
  current: ControlledTableSettingsDocument,
  settings: ControlledTableTechnicalSettings
): string {
  assertTechnicalSettings(settings)
  const attr = (value?: string) => encodeEntity(String(value || ''))
  const tableName = current.name.toUpperCase()
  return `<?xml version="1.0" encoding="UTF-8"?>
<ts:tableSettings xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:ts="http://www.sap.com/dictionary/table/settings" adtcore:changedAt="${attr(current.changedAt)}" adtcore:changedBy="${attr(current.changedBy)}" adtcore:createdAt="${attr(current.createdAt)}" adtcore:createdBy="${attr(current.createdBy)}" adtcore:description="${attr(current.description)}" adtcore:descriptionTextLimit="-1" adtcore:language="${attr(current.language)}" adtcore:name="${attr(tableName)}" adtcore:type="TABL/DTT" adtcore:version="${attr(current.version || 'active')}">
  <adtcore:containerRef adtcore:name="${attr(tableName)}" adtcore:type="TABL/DT" adtcore:uri="${controlledTableUrl(tableName)}"/>
  <atom:link href="versions" rel="http://www.sap.com/adt/relations/versions" title="Historic versions"/>
  <atom:link href="/sap/bc/adt/vit/wb/object_type/tabldtt/object_name/${encodeURIComponent(tableName)}" rel="self" title="Representation in SAP Gui" type="application/vnd.sap.sapgui"/>
  <atom:link href="/sap/bc/adt/ddic/logs/db/ACTTABT${encodeURIComponent(tableName)}" rel="http://www.sap.com/adt/relations/ddic/activationlog" title="Activation Log" type="application/vnd.sap.adt.logs+xml"/>
  <atom:link href="./${encodeURIComponent(tableName.toLowerCase())}" rel="http://www.sap.com/adt/relations/source" title="Landing Page (HTML)" type="text/html"/>
  <ts:dataClassCategory>${settings.dataClass}</ts:dataClassCategory>
  <ts:sizeCategory>${settings.sizeCategory}</ts:sizeCategory>
  <ts:buffering>
    <ts:allowed>N</ts:allowed>
    <ts:type></ts:type>
    <ts:areaKeyFields>0</ts:areaKeyFields>
  </ts:buffering>
  <ts:storageType>${settings.storageType || 'C'}</ts:storageType>
  <ts:sharingType></ts:sharingType>
  <ts:loadUnit></ts:loadUnit>
  <ts:translation ts:value="" ts:granularity="2" ts:isVisible="false" ts:isEditable="false"/>
  <ts:loggingEnabled>${settings.loggingEnabled}</ts:loggingEnabled>
  <ts:supportsLoggingAssessment>false</ts:supportsLoggingAssessment>
</ts:tableSettings>`
}

export function parseControlledTable(xml: string): ControlledTableDocument {
  const root = parseAttributes(firstTag(xml, 'blue:blueSource'))
  const packageRef = parseAttributes(firstTag(xml, 'adtcore:packageRef'))
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    packageName: packageRef['adtcore:name'],
    version: root['adtcore:version'],
    sourceUri: root['abapsource:sourceUri']
  }
}

export function parseControlledTableSettings(xml: string): ControlledTableSettingsDocument {
  const root = parseAttributes(firstTag(xml, 'ts:tableSettings'))
  const bufferingAllowed = textTag(xml, 'ts:allowed')
  if (bufferingAllowed && bufferingAllowed !== 'N') {
    throw adtException(`Unsupported table buffering mode '${bufferingAllowed}'.`)
  }
  const settings: ControlledTableSettingsDocument = {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    language: root['adtcore:language'],
    version: root['adtcore:version'],
    changedAt: root['adtcore:changedAt'],
    changedBy: root['adtcore:changedBy'],
    createdAt: root['adtcore:createdAt'],
    createdBy: root['adtcore:createdBy'],
    dataClass: textTag(xml, 'ts:dataClassCategory') as ControlledTableTechnicalSettings['dataClass'],
    sizeCategory: Number(textTag(xml, 'ts:sizeCategory')),
    buffering: 'NOT_ALLOWED',
    storageType: (textTag(xml, 'ts:storageType') || 'C') as 'C',
    loggingEnabled: textTag(xml, 'ts:loggingEnabled').toLowerCase() === 'true'
  }
  assertTechnicalSettings(settings)
  return settings
}

export function parseTableValidation(xml: string): ValidationResult {
  const raw = fullParse(xml)
  const records = xmlArray(raw, 'asx:abap', 'asx:values', 'DATA') as Array<Record<string, unknown>>
  const record = records[0] || {}
  const severity = String(record.SEVERITY || '')
  const shortText = String(record.SHORT_TEXT || '')
  if (severity === 'ERROR' || severity === 'E') throw adtException(shortText || 'Database table validation failed.')
  return { SEVERITY: severity || undefined, SHORT_TEXT: shortText || undefined, success: Boolean(record.CHECK_RESULT || severity) }
}

export function controlledTableUrl(tableName: string): string {
  return `/sap/bc/adt/ddic/tables/${encodeURIComponent(tableName.toLowerCase())}`
}

export function controlledTableSourceUrl(tableName: string): string {
  return `${controlledTableUrl(tableName)}/source/main`
}

export function controlledTableSettingsUrl(tableName: string): string {
  return `/sap/bc/adt/ddic/db/settings/${encodeURIComponent(tableName.toLowerCase())}`
}

function assertTechnicalSettings(settings: ControlledTableTechnicalSettings): void {
  if (!['APPL0', 'APPL1', 'APPL2', 'APPL3', 'USER'].includes(settings.dataClass)) {
    throw adtException(`Unsupported table data class '${settings.dataClass}'.`)
  }
  if (!Number.isInteger(settings.sizeCategory) || settings.sizeCategory < 0 || settings.sizeCategory > 9) {
    throw adtException('Table size category must be an integer between 0 and 9.')
  }
  if (settings.buffering !== 'NOT_ALLOWED') throw adtException('Controlled table creation requires buffering to remain disabled.')
  if (settings.storageType && settings.storageType !== 'C') throw adtException('Controlled table creation requires column storage type C.')
}

function normalizePath(value: string): string {
  return value.replace(/[?#].*$/, '').toLowerCase()
}

function firstTag(xml: string, name: string): string {
  return String(xml || '').match(new RegExp(`<${name}\\b[^>]*>`, 'i'))?.[0] || ''
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}

function textTag(xml: string, name: string): string {
  return String(xml || '').match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1] || ''
}
