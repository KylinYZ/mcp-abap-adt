import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { activate, type ActivationResult } from './activate'
import { encodeEntity } from '../utilities'
import type { ValidationResult } from './objectcreator'
import { requireCanonicalCreationLocation } from './creationLocation'

export const TYPE_GROUP_COLLECTION_PATH = '/sap/bc/adt/ddic/typegroups'
export const TYPE_GROUP_VALIDATION_PATH = `${TYPE_GROUP_COLLECTION_PATH}/validation`

export interface ControlledTypeGroupShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledTypeGroupDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
  sourceUri?: string
}

export interface ControlledTypeGroupCreationResult {
  location: string
  typeGroup: ControlledTypeGroupDocument
  ownershipEvidence?: 'CANONICAL_LOCATION' | 'POST_CREATE_READBACK_REQUIRED'
}

export async function validateControlledTypeGroupShell(
  h: AdtHTTP,
  input: Pick<ControlledTypeGroupShellInput, 'name' | 'description' | 'packageName'>
): Promise<ValidationResult> {
  const response = await h.request(TYPE_GROUP_VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objtype: 'TYPE/DG',
      objname: input.name,
      description: input.description,
      packagename: input.packageName
    },
    headers: {
      Accept: 'application/vnd.sap.adt.ddic.typegroups.v2+xml, application/vnd.sap.adt.ddic.typegroups.v3+xml'
    }
  })
  // ADT 3.60.2 returns HTTP 200 with an empty body for a successful check.
  if (!String(response.body || '').trim()) return { success: true }
  return parseTypeGroupValidation(response.body)
}

export async function createControlledTypeGroupShell(
  h: AdtHTTP,
  input: ControlledTypeGroupShellInput,
  contentType: string
): Promise<ControlledTypeGroupCreationResult> {
  const normalizedContentType = String(contentType || '').trim()
  if (!normalizedContentType) throw adtException('ADT discovery did not provide a type group creation content type.')
  const response = await h.request(TYPE_GROUP_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': normalizedContentType, Accept: normalizedContentType },
    body: buildControlledTypeGroupShellXml(input)
  })
  const expectedLocation = controlledTypeGroupUrl(input.name)
  const responseLocation = String(response.headers.location || response.headers.Location || '').trim()
  if (response.status === 200 && !responseLocation && !String(response.body || '').trim()) {
    return {
      location: expectedLocation,
      typeGroup: { name: input.name.toUpperCase() },
      ownershipEvidence: 'POST_CREATE_READBACK_REQUIRED'
    }
  }
  const location = requireCanonicalCreationLocation(response, expectedLocation, 'DDIC type group creation')
  if (!String(response.body || '').trim()) {
    return { location, typeGroup: { name: input.name.toUpperCase() }, ownershipEvidence: 'CANONICAL_LOCATION' }
  }
  const typeGroup = parseControlledTypeGroup(response.body)
  if (typeGroup.name !== input.name.toUpperCase()) {
    throw adtException('DDIC type group creation response identity does not match the requested type group.')
  }
  return { location, typeGroup, ownershipEvidence: 'CANONICAL_LOCATION' }
}

export function controlledTypeGroupUrl(name: string): string {
  return `${TYPE_GROUP_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function controlledTypeGroupSourceUrl(name: string): string {
  return `${controlledTypeGroupUrl(name)}/source/main`
}

export function buildControlledTypeGroupShellXml(input: ControlledTypeGroupShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<atypgr:abapTypeGroup xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atypgr="http://www.sap.com/adt/ddic/typegroups" xmlns:abapsource="http://www.sap.com/adt/abapsource" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="TYPE/DG" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</atypgr:abapTypeGroup>`
}

export function parseControlledTypeGroup(xml: string): ControlledTypeGroupDocument {
  const tag = String(xml || '').match(/<atypgr:abapTypeGroup\b[^>]*>/i)?.[0] || ''
  const attributes = parseAttributes(tag)
  const packageTag = String(xml || '').match(/<adtcore:packageRef\b[^>]*>/i)?.[0] || ''
  const packageAttributes = parseAttributes(packageTag)
  return {
    name: String(attributes['adtcore:name'] || '').toUpperCase(),
    description: attributes['adtcore:description'],
    packageName: packageAttributes['adtcore:name'],
    version: attributes['adtcore:version'],
    sourceUri: attributes['abapsource:sourceUri']
  }
}

export function activateControlledTypeGroup(h: AdtHTTP, name: string): Promise<ActivationResult> {
  return activate(h, name.toUpperCase(), controlledTypeGroupUrl(name), undefined, true)
}

function parseTypeGroupValidation(xml: string): ValidationResult {
  const severity = String(xml || '').match(/<(?:SEVERITY|severity)>([^<]*)</i)?.[1] || ''
  const shortText = String(xml || '').match(/<(?:SHORT_TEXT|shortText)>([^<]*)</i)?.[1] || ''
  if (['E', 'ERROR'].includes(severity.toUpperCase())) {
    throw adtException(shortText || 'DDIC type group validation failed.')
  }
  return { SEVERITY: severity || undefined, SHORT_TEXT: shortText || undefined, success: true }
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}
