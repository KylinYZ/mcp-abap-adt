import { adtException } from '../AdtException'
import type { AdtHTTP } from '../AdtHTTP'
import { encodeEntity, fullParse, xmlArray } from '../utilities'

export type ControlledServiceBindingType =
  | 'ODATA_V2_UI'
  | 'ODATA_V2_WEB_API'
  | 'ODATA_V4_UI'
  | 'ODATA_V4_WEB_API'

export interface ControlledServiceBindingInput {
  objectKind: 'SERVICE_BINDING'
  adtType: 'SRVB/SVB'
  name: string
  description: string
  packageName: string
  serviceDefinition: string
  bindingType: ControlledServiceBindingType
  bindingCategory: '0' | '1'
  transportRequest: string
  language: string
  masterLanguage: string
  masterSystem: string
  responsible: string
}

export interface ControlledServiceBindingCreationResult {
  location: string
  name: string
  adtType: 'SRVB/SVB'
}

const COLLECTION_PATH = '/sap/bc/adt/businessservices/bindings'
const VALIDATION_PATH = `${COLLECTION_PATH}/validation`
const CONTENT_TYPE = 'application/vnd.sap.adt.businessservices.servicebinding.v1+xml'

export async function validateControlledServiceBinding(
  h: AdtHTTP,
  input: ControlledServiceBindingInput
): Promise<{ success: boolean; SEVERITY?: string; SHORT_TEXT?: string }> {
  const response = await h.request(VALIDATION_PATH, {
    method: 'POST',
    qs: {
      objname: input.name,
      description: input.description,
      objtype: input.adtType,
      serviceBindingVersion: bindingVersion(input.bindingType),
      serviceDefinition: input.serviceDefinition,
      package: input.packageName
    },
    headers: { Accept: CONTENT_TYPE }
  })
  if (response.status >= 400) throw adtException('Service binding validation failed.')
  const raw = fullParse(response.body)
  const records = xmlArray(raw, 'asx:abap', 'asx:values', 'DATA') as Array<Record<string, unknown>>
  const record = records[0] || {}
  const severity = String(record.SEVERITY || '')
  const shortText = String(record.SHORT_TEXT || '')
  if (['E', 'ERROR'].includes(severity.toUpperCase())) throw adtException(shortText || 'Service binding validation failed.')
  return {
    success: Boolean(record.CHECK_RESULT || severity),
    SEVERITY: severity || undefined,
    SHORT_TEXT: shortText || undefined
  }
}

export async function createControlledServiceBinding(
  h: AdtHTTP,
  input: ControlledServiceBindingInput
): Promise<ControlledServiceBindingCreationResult> {
  const response = await h.request(COLLECTION_PATH, {
    method: 'POST',
    qs: { corrNr: input.transportRequest },
    headers: { 'Content-Type': CONTENT_TYPE, Accept: CONTENT_TYPE },
    body: buildControlledServiceBindingXml(input)
  })
  const location = String(response.headers.location || response.headers.Location || '')
  const identity = parseServiceBindingIdentity(response.body)
  const expectedLocation = controlledServiceBindingUrl(input.name)
  if (response.status !== 201 || normalizePath(location) !== expectedLocation) {
    throw adtException('Service binding creation did not return HTTP 201 with the canonical Location header.')
  }
  if (identity.name !== input.name || identity.adtType !== input.adtType) {
    throw adtException('Service binding creation response identity does not match the requested object.')
  }
  return { location, name: identity.name, adtType: identity.adtType }
}

export function controlledServiceBindingUrl(name: string): string {
  return `${COLLECTION_PATH}/${encodeURIComponent(name.toLowerCase())}`
}

export function buildControlledServiceBindingXml(input: ControlledServiceBindingInput): string {
  const attr = (value: string) => encodeEntity(value)
  const binding = bindingParts(input.bindingType)
  return `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:adtcore="http://www.sap.com/adt/core" xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" adtcore:description="${attr(input.description)}" adtcore:language="${attr(input.language)}" adtcore:name="${attr(input.name)}" adtcore:type="SRVB/SVB" adtcore:masterLanguage="${attr(input.masterLanguage)}" adtcore:masterSystem="${attr(input.masterSystem)}" adtcore:responsible="${attr(input.responsible)}">
  <adtcore:packageRef adtcore:name="${attr(input.packageName)}"/>
  <srvb:services srvb:name="${attr(input.name)}">
    <srvb:content srvb:version="0001">
      <srvb:serviceDefinition adtcore:name="${attr(input.serviceDefinition)}"/>
    </srvb:content>
  </srvb:services>
  <srvb:binding srvb:category="${binding.category}" srvb:type="ODATA" srvb:version="${binding.version}">
    <srvb:implementation adtcore:name=""/>
  </srvb:binding>
</srvb:serviceBinding>`
}

export function parseServiceBindingIdentity(xml: string): { name: string; adtType: string } {
  const tag = String(xml || '').match(/<(?:srvb:serviceBinding|serviceBinding)\b[^>]*>/i)?.[0] || ''
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return {
    name: String(attributes['adtcore:name'] || '').toUpperCase(),
    adtType: String(attributes['adtcore:type'] || '').toUpperCase()
  }
}

export function parseServiceBindingConfiguration(xml: string): {
  serviceDefinition: string
  bindingType: string
  bindingVersion: string
  bindingCategory: string
} {
  const body = String(xml || '')
  const serviceDefinition = body.match(/<srvb:serviceDefinition\b[^>]*adtcore:name="([^"]+)"/i)?.[1] || ''
  const binding = body.match(/<srvb:binding\b([^>]*)>/i)?.[1] || ''
  const read = (name: string) => binding.match(new RegExp(`srvb:${name}="([^"]*)"`, 'i'))?.[1] || ''
  return {
    serviceDefinition: serviceDefinition.toUpperCase(),
    bindingType: read('type').toUpperCase(),
    bindingVersion: read('version').toUpperCase(),
    bindingCategory: read('category')
  }
}

function bindingVersion(type: ControlledServiceBindingType): 'ODATA\\V2' | 'ODATA\\V4' {
  return type.startsWith('ODATA_V2') ? 'ODATA\\V2' : 'ODATA\\V4'
}

function bindingParts(type: ControlledServiceBindingType): { version: 'V2' | 'V4'; category: '0' | '1' } {
  return {
    version: type.startsWith('ODATA_V2') ? 'V2' : 'V4',
    category: type.endsWith('_UI') ? '0' : '1'
  }
}

function normalizePath(value: string): string {
  return String(value || '').split('?')[0].replace(/\/+$/, '').toLowerCase()
}
