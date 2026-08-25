import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity, fullParse, xmlArray } from '../utilities'
import { activate, type ActivationResult } from './activate'
import type { ValidationResult } from './objectcreator'
import { requireCanonicalCreationLocation } from './creationLocation'

export const STRUCTURE_COLLECTION_PATH = '/sap/bc/adt/ddic/structures'
export const STRUCTURE_VALIDATION_PATH = '/sap/bc/adt/ddic/structures/validation'

export interface ControlledStructureShellInput {
  name: string
  description: string
  packageName: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledStructureDocument {
  name: string
  description?: string
  packageName?: string
  version?: string
  sourceUri?: string
}

export interface ControlledStructureCreationResult {
  location: string
  structure: ControlledStructureDocument
}

export async function validateControlledStructureShell(
  h: AdtHTTP,
  input: Pick<ControlledStructureShellInput, 'name' | 'description'>
): Promise<ValidationResult> {
  const response = await h.request(STRUCTURE_VALIDATION_PATH, {
    method: 'POST',
    qs: { objtype: 'tabl/ds', objname: input.name, description: input.description }
  })
  return parseStructureValidation(response.body)
}

export async function createControlledStructureShell(
  h: AdtHTTP,
  input: ControlledStructureShellInput,
  contentType: string
): Promise<ControlledStructureCreationResult> {
  const normalizedContentType = String(contentType || '').trim()
  if (!normalizedContentType) throw adtException('ADT discovery did not provide a structure creation content type.')
  const response = await h.request(STRUCTURE_COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': normalizedContentType, Accept: normalizedContentType },
    body: buildControlledStructureShellXml(input)
  })
  const location = requireCanonicalCreationLocation(
    response,
    controlledStructureUrl(input.name),
    'DDIC structure creation'
  )
  if (!String(response.body || '').trim()) {
    return { location, structure: { name: input.name.toUpperCase() } }
  }
  const structure = parseControlledStructure(response.body)
  if (structure.name !== input.name.toUpperCase()) {
    throw adtException('DDIC structure creation response identity does not match the requested structure.')
  }
  return { location, structure }
}

export function controlledStructureUrl(name: string): string {
  return `${STRUCTURE_COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function controlledStructureSourceUrl(name: string): string {
  return `${controlledStructureUrl(name)}/source/main`
}

export function buildControlledStructureShellXml(input: ControlledStructureShellInput): string {
  const attr = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:adtcore="http://www.sap.com/adt/core" xmlns:blue="http://www.sap.com/wbobj/blue" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="TABL/DS" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
</blue:blueSource>`
}

export function parseControlledStructure(xml: string): ControlledStructureDocument {
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

export function activateControlledStructure(h: AdtHTTP, name: string): Promise<ActivationResult> {
  return activate(h, name.toUpperCase(), controlledStructureUrl(name), undefined, true)
}

function parseStructureValidation(xml: string): ValidationResult {
  const raw = fullParse(xml)
  const records = xmlArray(raw, 'asx:abap', 'asx:values', 'DATA') as Array<Record<string, unknown>>
  const record = records[0] || {}
  const severity = String(record.SEVERITY || '')
  const shortText = String(record.SHORT_TEXT || '')
  if (['ERROR', 'E'].includes(severity.toUpperCase())) throw adtException(shortText || 'DDIC structure validation failed.')
  return { SEVERITY: severity || undefined, SHORT_TEXT: shortText || undefined, success: Boolean(record.CHECK_RESULT || severity) }
}

function firstTag(xml: string, name: string): string {
  return String(xml || '').match(new RegExp(`<${name}\\b[^>]*>`, 'i'))?.[0] || ''
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}
