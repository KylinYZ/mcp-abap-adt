import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity, fullParse, xmlArray } from '../utilities'
import type { ValidationResult } from './objectcreator'

export const PACKAGE_V2_MEDIA_TYPE = 'application/vnd.sap.adt.packages.v2+xml'
export const PACKAGE_ACCEPT = `${PACKAGE_V2_MEDIA_TYPE}, application/vnd.sap.adt.packages.v1+xml`
const SOFTWARE_COMPONENT_CONSTRAINTS_MEDIA_TYPE = 'application/softwareComponent.v1+json'
const PACKAGE_CONSTRAINTS_MEDIA_TYPE = 'application/packageConstraints.v1+json'

export interface ControlledPackageInput {
  name: string
  description: string
  parentPackageName: string
  softwareComponent: string
  transportLayer: string
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledPackageDocument {
  name: string
  description?: string
  language?: string
  masterLanguage?: string
  masterSystem?: string
  responsible?: string
  parentPackageName?: string
  softwareComponent?: string
  transportLayer?: string
  packageType?: string
  isEncapsulated?: boolean
  recordChanges?: boolean
}

export interface ControlledPackageCreationResult {
  location: string
  package: ControlledPackageDocument
}

export async function validateControlledPackage(
  h: AdtHTTP,
  input: ControlledPackageInput,
  mode: 'basic' | 'full'
): Promise<ValidationResult> {
  const qs: Record<string, string | boolean> = {
    objname: input.name,
    packagename: input.parentPackageName,
    description: input.description,
    packagetype: 'development',
    checkmode: mode
  }
  if (mode === 'full') {
    qs.swcomp = input.softwareComponent
    // SAP ADT uses this exact lower-case query key.
    qs.transportlayer = input.transportLayer
    qs.recordChanges = true
  }
  const response = await h.request('/sap/bc/adt/packages/validation', {
    method: 'POST',
    qs,
    headers: { Accept: 'application/vnd.sap.as+xml' }
  })
  return parsePackageValidation(response.body)
}

export async function getControlledPackageConstraints(
  h: AdtHTTP,
  input: Pick<ControlledPackageInput, 'name' | 'parentPackageName' | 'softwareComponent'>
): Promise<string> {
  const request = {
    qs: {
      objname: input.name,
      packagename: input.parentPackageName,
      swcomp: input.softwareComponent
    }
  }
  await h.request('/sap/bc/adt/packages/$constraints', {
    ...request,
    headers: { Accept: SOFTWARE_COMPONENT_CONSTRAINTS_MEDIA_TYPE }
  })
  const response = await h.request('/sap/bc/adt/packages/$constraints', {
    ...request,
    headers: { Accept: PACKAGE_CONSTRAINTS_MEDIA_TYPE }
  })
  return response.body
}

export async function readControlledPackage(h: AdtHTTP, packageName: string): Promise<ControlledPackageDocument> {
  const response = await h.request(`/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`, {
    headers: { Accept: PACKAGE_ACCEPT }
  })
  return parseControlledPackage(response.body)
}

export async function createControlledPackage(
  h: AdtHTTP,
  input: ControlledPackageInput
): Promise<ControlledPackageCreationResult> {
  const response = await h.request('/sap/bc/adt/packages', {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': PACKAGE_V2_MEDIA_TYPE, Accept: PACKAGE_ACCEPT },
    body: buildControlledPackageXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  if (response.status !== 201 || !location) {
    throw adtException('Package creation did not return HTTP 201 with a Location header.')
  }
  const created = parseControlledPackage(response.body)
  if (created.name !== input.name.toUpperCase()) {
    throw adtException('Package creation response identity does not match the requested package.')
  }
  return { location, package: created }
}

export function buildControlledPackageXml(input: ControlledPackageInput): string {
  const attribute = (value: string) => encodeEntity(value)
  return `<?xml version="1.0" encoding="UTF-8"?>
<pak:package xmlns:adtcore="http://www.sap.com/adt/core" xmlns:pak="http://www.sap.com/adt/packages" adtcore:description="${attribute(input.description)}" adtcore:language="${attribute(input.language)}" adtcore:name="${attribute(input.name)}" adtcore:type="DEVC/K" adtcore:version="active" adtcore:masterLanguage="${attribute(input.masterLanguage)}" adtcore:masterSystem="${attribute(input.masterSystem)}" adtcore:responsible="${attribute(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attribute(input.name)}"/>
  <pak:attributes pak:isEncapsulated="true" pak:packageType="development" pak:recordChanges="true"/>
  <pak:superPackage adtcore:name="${attribute(input.parentPackageName)}"/>
  <pak:applicationComponent/>
  <pak:transport>
    <pak:softwareComponent pak:isEditable="true" pak:name="${attribute(input.softwareComponent)}" pak:type="M"/>
    <pak:transportLayer pak:name="${attribute(input.transportLayer)}"/>
  </pak:transport>
  <pak:translation/>
  <pak:useAccesses/>
  <pak:packageInterfaces/>
  <pak:subPackages/>
</pak:package>`
}

export function parseControlledPackage(xml: string): ControlledPackageDocument {
  const root = firstTag(xml, 'pak:package')
  const attributes = parseAttributes(root)
  const packageAttributes = parseAttributes(firstTag(xml, 'pak:attributes'))
  return {
    name: String(attributes['adtcore:name'] || '').toUpperCase(),
    description: attributes['adtcore:description'],
    language: attributes['adtcore:language'],
    masterLanguage: attributes['adtcore:masterLanguage'],
    masterSystem: attributes['adtcore:masterSystem'],
    responsible: attributes['adtcore:responsible'],
    parentPackageName: parseAttributes(firstTag(xml, 'pak:superPackage'))['adtcore:name'],
    softwareComponent: parseAttributes(firstTag(xml, 'pak:softwareComponent'))['pak:name'],
    transportLayer: parseAttributes(firstTag(xml, 'pak:transportLayer'))['pak:name'],
    packageType: packageAttributes['pak:packageType'],
    isEncapsulated: parseBoolean(packageAttributes['pak:isEncapsulated']),
    recordChanges: parseBoolean(packageAttributes['pak:recordChanges'])
  }
}

export function parsePackageValidation(xml: string): ValidationResult {
  const raw = fullParse(xml)
  const records = xmlArray(raw, 'asx:abap', 'asx:values', 'DATA') as Array<Record<string, unknown>>
  const record = records[0] || {}
  const severity = String(record.SEVERITY || '')
  const shortText = String(record.SHORT_TEXT || '')
  if (severity === 'ERROR' || severity === 'E') throw adtException(shortText || 'Package validation failed.')
  return {
    SEVERITY: severity || undefined,
    SHORT_TEXT: shortText || undefined,
    success: Boolean(record.CHECK_RESULT || severity)
  }
}

function firstTag(xml: string, name: string): string {
  const match = String(xml || '').match(new RegExp(`<${name}\\b[^>]*>`, 'i'))
  return match?.[0] || ''
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}

function parseBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined
  return value.toLowerCase() === 'true'
}
