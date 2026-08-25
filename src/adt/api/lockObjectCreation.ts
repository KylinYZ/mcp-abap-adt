import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity } from '../utilities'
import type { ValidationResult } from './objectcreator'

export const LOCK_OBJECT_COLLECTION_PATH = '/sap/bc/adt/ddic/lockobjects/sources'
export const LOCK_OBJECT_VALIDATION_PATH = `${LOCK_OBJECT_COLLECTION_PATH}/validation`

export interface ControlledLockObjectShellInput {
  name: string
  description: string
  packageName: string
  primaryTable: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledLockObjectDocument {
  name: string
  description?: string
  packageName?: string
  primaryTable?: string
  version?: string
}

export interface ControlledLockObjectCreationResult {
  location: string
  lockObject: ControlledLockObjectDocument
}

export async function validateControlledLockObjectShell(
  h: AdtHTTP,
  input: Pick<ControlledLockObjectShellInput, 'name' | 'description' | 'packageName'>
): Promise<ValidationResult> {
  const response = await h.request(LOCK_OBJECT_VALIDATION_PATH, {
    method: 'POST',
    qs: { objtype: 'ENQU/DL', objname: input.name, description: input.description, packagename: input.packageName },
    headers: { Accept: 'application/vnd.sap.adt.lockobjects.v1+xml' }
  })
  return parseLockObjectValidation(response.body)
}

export async function createControlledLockObjectShell(
  h: AdtHTTP,
  input: ControlledLockObjectShellInput,
  contentType: string
): Promise<ControlledLockObjectCreationResult> {
  const normalizedContentType = String(contentType || '').trim()
  if (!normalizedContentType) throw adtException('ADT discovery did not provide a lock object creation content type.')
  const response = await h.request(LOCK_OBJECT_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': normalizedContentType, Accept: normalizedContentType },
    body: buildControlledLockObjectShellXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  const lockObject = parseControlledLockObject(response.body)
  if (response.status !== 201 || normalizePath(location) !== controlledLockObjectUrl(input.name)) {
    throw adtException('DDIC lock object creation did not return HTTP 201 with the canonical Location header.')
  }
  if (lockObject.name !== input.name.toUpperCase()) {
    throw adtException('DDIC lock object creation response identity does not match the requested lock object.')
  }
  return { location, lockObject }
}

export function controlledLockObjectUrl(name: string): string {
  return `${LOCK_OBJECT_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function buildControlledLockObjectShellXml(input: ControlledLockObjectShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<enqu:lockobject xmlns:adtcore="http://www.sap.com/adt/core" xmlns:enqu="http://www.sap.com/adt/ddic/enqu" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="ENQU/DL" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
  <enqu:content>
    <enqu:allowRFC>false</enqu:allowRFC>
    <enqu:primaryTable>
      <enqu:tableName>${attr(input.primaryTable)}</enqu:tableName>
      <enqu:lockMode/>
    </enqu:primaryTable>
    <enqu:secondaryTables/>
    <enqu:lockParameters/>
    <enqu:lockModules/>
  </enqu:content>
</enqu:lockobject>`
}

export function parseControlledLockObject(xml: string): ControlledLockObjectDocument {
  const root = parseAttributes(String(xml || '').match(/<enqu:lockobject\b[^>]*>/i)?.[0] || '')
  const packageRef = parseAttributes(String(xml || '').match(/<adtcore:packageRef\b[^>]*>/i)?.[0] || '')
  const primaryTable = String(xml || '').match(/<enqu:tableName>([^<]*)<\/enqu:tableName>/i)?.[1]
  return {
    name: String(root['adtcore:name'] || '').toUpperCase(),
    description: root['adtcore:description'],
    packageName: packageRef['adtcore:name'],
    primaryTable: primaryTable ? primaryTable.toUpperCase() : undefined,
    version: root['adtcore:version']
  }
}

function parseLockObjectValidation(xml: string): ValidationResult {
  const body = String(xml || '')
  const checkResult = body.match(/<CHECK_RESULT>([^<]*)<\/CHECK_RESULT>/i)?.[1] || ''
  const severity = body.match(/<(?:SEVERITY|severity)>([^<]*)<\/(?:SEVERITY|severity)>/i)?.[1] || ''
  const shortText = body.match(/<(?:SHORT_TEXT|shortText)>([^<]*)<\/(?:SHORT_TEXT|shortText)>/i)?.[1] || ''
  if (['E', 'ERROR'].includes(severity.toUpperCase()) || checkResult.toUpperCase() === 'E') {
    throw adtException(shortText || 'DDIC lock object validation failed.')
  }
  return { SEVERITY: severity || undefined, SHORT_TEXT: shortText || undefined, success: checkResult.toUpperCase() === 'X' }
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}

function normalizePath(value: string): string {
  return String(value || '').split('?')[0].replace(/\/+$/, '').toLowerCase()
}
