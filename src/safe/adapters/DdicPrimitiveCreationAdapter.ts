import type {
  DataElementMetaData,
  DataElementProperties,
  DomainMetaData,
  DomainProperties,
  NewObjectOptions,
  ValidateOptions
} from '../../adt/index.js'
import { RepositoryCreationOutcomeUnknownError } from '../RepositoryObjectCreationWorkflow.js'
import type {
  PreparedRepositoryCreation,
  RepositoryCreationExecutionResult,
  RepositoryCreationPlan,
  RepositoryObjectCreationAdapter,
  RepositoryObjectKind
} from '../repositoryCreationTypes.js'
import type { SafetyPolicy } from '../SafetyPolicy.js'
import type { ControlledCreationAdtClient } from './controlledCreationTools.js'
import {
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  repositoryName,
  requiredString
} from './creationAdapterTools.js'

type DdicPrimitiveKind = 'DDIC_DOMAIN' | 'DATA_ELEMENT'
type DdicPrimitiveAdtType = 'DOMA/DD' | 'DTEL/DE'
type PrimitiveProperties = DomainProperties | DataElementProperties
type PrimitiveMetaData = DomainMetaData | DataElementMetaData

interface DdicPrimitivePayload {
  kind: DdicPrimitiveKind
  adtType: DdicPrimitiveAdtType
  name: string
  description: string
  packageName: string
  transportRequest: string
  packageUrl: string
  objectUrl: string
  contentType: string
  properties: PrimitiveProperties
  metadata: PrimitiveMetaData
}

export class DdicPrimitiveCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind: RepositoryObjectKind

  constructor(
    private readonly kind: DdicPrimitiveKind,
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {
    this.objectKind = kind
  }

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const definition = definitionFor(this.kind)
    const name = repositoryName(request, 'name', 30)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    const properties = parseProperties(this.kind, request.properties)
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)

    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, definition.adtType, 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, definition.adtType)
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)

    const packageMetadata = await this.client.readControlledPackage(packageName)
    if (this.kind === 'DATA_ELEMENT' && (properties as DataElementProperties).typeName) {
      await assertDomainReference(this.client, (properties as DataElementProperties).typeName)
    }
    const metadata = primitiveMetadata(this.policy, packageMetadata, name, description, packageName)
    if (!this.client.validateNewObject) throw new Error('Controlled DDIC primitive validation is unavailable in this ADT client.')
    const validation = await this.client.validateNewObject(validationOptions(definition, name, description, packageName))
    assertValidation(validation, name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)

    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: definition.adtType, parentName: packageName },
      transportRequest,
      summary: `Create ${definition.label} ${name} in package ${packageName}.`,
      payload: {
        kind: this.kind,
        adtType: definition.adtType,
        name,
        description,
        packageName,
        transportRequest,
        packageUrl: packageObject['adtcore:uri'],
        objectUrl: definition.objectUrl(name),
        contentType: 'application/*',
        properties,
        metadata
      } satisfies DdicPrimitivePayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        transportRequest,
        properties,
        shellContract: { adtType: definition.adtType, objectUrl: definition.objectUrl(name), contentType: 'application/*' }
      },
      compensationLimits: [
        'Only the newly created DDIC object proven to belong to this plan may be deleted.',
        'Unknown create, property write, unlock, activation, or verification outcomes stop automatic compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = primitivePayload(plan, this.kind)
    const definition = definitionFor(this.kind)
    assertTargetAbsent(await this.client.searchObject(payload.name, payload.adtType, 10), payload.name, payload.adtType)
    recordStage('REVALIDATE_ABSENCE', true)
    if (!this.client.validateNewObject) throw new Error('Controlled DDIC primitive validation is unavailable in this ADT client.')
    assertValidation(await this.client.validateNewObject(validationOptions(definition, payload.name, payload.description, payload.packageName)), payload.name)
    if (payload.kind === 'DATA_ELEMENT' && (payload.properties as DataElementProperties).typeName) {
      await assertDomainReference(this.client, (payload.properties as DataElementProperties).typeName)
    }
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.packageName, 'I'),
      this.client.transportDetails(payload.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    try {
      if (!this.client.createObject) throw new Error('Controlled DDIC primitive creation is unavailable in this ADT client.')
      await this.client.createObject({
        objtype: payload.adtType,
        name: payload.name,
        parentName: payload.packageName,
        description: payload.description,
        parentPath: payload.packageUrl,
        responsible: payload.metadata.responsible,
        language: payload.metadata.language,
        masterLanguage: payload.metadata.masterLanguage,
        masterSystem: payload.metadata.masterSystem,
        transport: payload.transportRequest,
        contentType: payload.contentType
      } satisfies NewObjectOptions)
    } catch (error) {
      throw unknownWrite(`${definition.label} create`, error)
    }
    plan.actualResources = [{ type: payload.adtType, name: payload.name }]
    recordStage('CREATE_SHELL', true)

    const created = await this.client.objectStructure(payload.objectUrl, 'inactive')
    assertIdentity(created.metaData as unknown as Record<string, unknown>, payload)
    recordStage('RESOLVE_CREATED_OBJECT', true, payload.objectUrl)

    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    try {
      try {
        await writeProperties(this.client, payload, lock.LOCK_HANDLE)
      } catch (error) {
        throw unknownWrite(`${definition.label} property write`, error)
      }
      recordStage('WRITE_PROPERTIES', true)
    } finally {
      try {
        await this.client.unLock(payload.objectUrl, lock.LOCK_HANDLE)
        recordStage('UNLOCK_RESOURCE', true)
      } catch (error) {
        recordStage('UNLOCK_RESOURCE', false, errorText(error))
        throw unknownWrite(`${definition.label} unlock`, error)
      }
    }

    let activation
    try {
      activation = await this.client.activate(payload.name, payload.objectUrl, undefined, true)
    } catch (error) {
      throw unknownWrite(`${definition.label} activation`, error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)

    let active: PrimitiveProperties
    try {
      active = await readProperties(this.client, payload)
    } catch (error) {
      throw unknownWrite(`${definition.label} verification read`, error)
    }
    if (!propertiesMatch(payload.properties, active)) {
      throw unknownWrite(`${definition.label} verification`, new Error('Activated DDIC properties do not match the confirmed plan.'))
    }
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_PROPERTIES', true)
    return {
      resultSummary: `Created, activated, and verified ${definition.label} ${payload.name}.`,
      actualResources: [{ type: payload.adtType, name: payload.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = primitivePayload(plan, this.kind)
    if (!plan.actualResources?.some(resource => resource.type === payload.adtType && resource.name === payload.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.transportRequest)
    } catch (error) {
      throw new Error(`${definitionFor(this.kind).label} compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.name, payload.adtType, 10), payload.name, payload.adtType)
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }
}

export class DomainCreationAdapter extends DdicPrimitiveCreationAdapter {
  constructor(client: ControlledCreationAdtClient, policy: SafetyPolicy) {
    super('DDIC_DOMAIN', client, policy)
  }
}

export class DataElementCreationAdapter extends DdicPrimitiveCreationAdapter {
  constructor(client: ControlledCreationAdtClient, policy: SafetyPolicy) {
    super('DATA_ELEMENT', client, policy)
  }
}

function definitionFor(kind: DdicPrimitiveKind): {
  label: string
  adtType: DdicPrimitiveAdtType
  objectUrl: (name: string) => string
} {
  return kind === 'DDIC_DOMAIN'
    ? { label: 'DDIC domain', adtType: 'DOMA/DD', objectUrl: name => `/sap/bc/adt/ddic/domains/${name.toLowerCase()}` }
    : { label: 'DDIC data element', adtType: 'DTEL/DE', objectUrl: name => `/sap/bc/adt/ddic/dataelements/${name.toLowerCase()}` }
}

function validationOptions(
  definition: ReturnType<typeof definitionFor>,
  name: string,
  description: string,
  packageName: string
): ValidateOptions {
  return { objtype: definition.adtType, objname: name, description, packagename: packageName }
}

function primitiveMetadata(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  name: string,
  description: string,
  packageName: string
): PrimitiveMetaData {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return {
    name,
    description,
    language,
    masterLanguage,
    masterSystem: packageMetadata.masterSystem,
    responsible,
    packageName,
    packageDescription: packageName === '$TMP' ? 'Temporary Objects (never transported!)' : undefined,
    packageUri: `/sap/bc/adt/packages/${packageName.toLowerCase()}`
  }
}

function parseProperties(kind: DdicPrimitiveKind, value: unknown): PrimitiveProperties {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('properties must be an object.')
  const input = value as Record<string, unknown>
  return kind === 'DDIC_DOMAIN' ? parseDomainProperties(input) : parseDataElementProperties(input)
}

function parseDomainProperties(input: Record<string, unknown>): DomainProperties {
  const typeInformation = boundedRecord(input.typeInformation, 'typeInformation')
  const outputInformation = boundedRecord(input.outputInformation, 'outputInformation')
  const datatype = boundedToken(typeInformation.datatype, 'typeInformation.datatype', 30)
  const length = boundedInteger(typeInformation.length, 'typeInformation.length', 1, 5000)
  const decimals = boundedInteger(typeInformation.decimals, 'typeInformation.decimals', 0, 31)
  const output: DomainProperties['outputInformation'] = {
    length: boundedInteger(outputInformation.length, 'outputInformation.length', 1, 5000),
    style: optionalText(outputInformation.style, 'outputInformation.style', 30),
    conversionExit: optionalToken(outputInformation.conversionExit, 'outputInformation.conversionExit', 5),
    signExists: booleanValue(outputInformation.signExists, 'outputInformation.signExists'),
    lowercase: booleanValue(outputInformation.lowercase, 'outputInformation.lowercase'),
    ampmFormat: booleanValue(outputInformation.ampmFormat, 'outputInformation.ampmFormat')
  }
  const rawValue = input.valueInformation
  let valueInformation: DomainProperties['valueInformation']
  if (rawValue !== undefined) {
    const valueInput = boundedRecord(rawValue, 'valueInformation')
    valueInformation = {
      valueTableRef: valueInput.valueTableRef ? repositoryName({ value: valueInput.valueTableRef }, 'value', 30) : '',
      appendExists: booleanValue(valueInput.appendExists, 'valueInformation.appendExists'),
      fixValues: Array.isArray(valueInput.fixValues) ? valueInput.fixValues.map((item, index) => {
        const fix = boundedRecord(item, `valueInformation.fixValues[${index}]`)
        return {
          low: requiredBoundedText(fix.low, `valueInformation.fixValues[${index}].low`, 60),
          ...(fix.high !== undefined ? { high: requiredBoundedText(fix.high, `valueInformation.fixValues[${index}].high`, 60) } : {}),
          ...(fix.text !== undefined ? { text: requiredBoundedText(fix.text, `valueInformation.fixValues[${index}].text`, 60) } : {})
        }
      }) : undefined
    }
  }
  return { typeInformation: { datatype, length, decimals }, outputInformation: output, ...(valueInformation ? { valueInformation } : {}) }
}

function parseDataElementProperties(input: Record<string, unknown>): DataElementProperties {
  const labels = boundedRecord(input.fieldLabels, 'fieldLabels')
  const typeName = input.typeName ? repositoryName({ value: input.typeName }, 'value', 30) : ''
  const dataType = boundedToken(input.dataType, 'dataType', 30)
  const dataTypeLength = boundedInteger(input.dataTypeLength, 'dataTypeLength', 1, 5000)
  const dataTypeDecimals = input.dataTypeDecimals === undefined ? 0 : boundedInteger(input.dataTypeDecimals, 'dataTypeDecimals', 0, 31)
  return {
    typeName,
    dataType,
    dataTypeLength,
    dataTypeDecimals,
    fieldLabels: {
      shortFieldLabel: requiredBoundedText(labels.shortFieldLabel, 'fieldLabels.shortFieldLabel', 10),
      ...(labels.shortFieldLength === undefined ? {} : { shortFieldLength: boundedInteger(labels.shortFieldLength, 'fieldLabels.shortFieldLength', 1, 10) }),
      mediumFieldLabel: requiredBoundedText(labels.mediumFieldLabel, 'fieldLabels.mediumFieldLabel', 20),
      ...(labels.mediumFieldLength === undefined ? {} : { mediumFieldLength: boundedInteger(labels.mediumFieldLength, 'fieldLabels.mediumFieldLength', 1, 20) }),
      longFieldLabel: requiredBoundedText(labels.longFieldLabel, 'fieldLabels.longFieldLabel', 40),
      ...(labels.longFieldLength === undefined ? {} : { longFieldLength: boundedInteger(labels.longFieldLength, 'fieldLabels.longFieldLength', 1, 40) }),
      headingFieldLabel: requiredBoundedText(labels.headingFieldLabel, 'fieldLabels.headingFieldLabel', 55),
      ...(labels.headingFieldLength === undefined ? {} : { headingFieldLength: boundedInteger(labels.headingFieldLength, 'fieldLabels.headingFieldLength', 1, 55) })
    },
    searchHelp: optionalText(input.searchHelp, 'searchHelp', 30),
    searchHelpParameter: optionalText(input.searchHelpParameter, 'searchHelpParameter', 30),
    setGetParameter: optionalText(input.setGetParameter, 'setGetParameter', 20),
    defaultComponentName: optionalText(input.defaultComponentName, 'defaultComponentName', 30),
    deactivateInputHistory: optionalBoolean(input.deactivateInputHistory, 'deactivateInputHistory'),
    changeDocument: optionalBoolean(input.changeDocument, 'changeDocument'),
    leftToRightDirection: optionalBoolean(input.leftToRightDirection, 'leftToRightDirection'),
    deactivateBIDIFiltering: optionalBoolean(input.deactivateBIDIFiltering, 'deactivateBIDIFiltering')
  }
}

async function writeProperties(client: ControlledCreationAdtClient, payload: DdicPrimitivePayload, lockHandle: string): Promise<void> {
  if (payload.kind === 'DDIC_DOMAIN') {
    if (!client.setDomainProperties) throw new Error('Controlled DDIC domain property writing is unavailable in this ADT client.')
    await client.setDomainProperties(payload.objectUrl, payload.properties as DomainProperties, payload.metadata as DomainMetaData, lockHandle, payload.transportRequest)
  } else {
    if (!client.setDataElementProperties) throw new Error('Controlled DDIC data element property writing is unavailable in this ADT client.')
    await client.setDataElementProperties(payload.objectUrl, payload.properties as DataElementProperties, payload.metadata as DataElementMetaData, lockHandle, payload.transportRequest)
  }
}

async function readProperties(client: ControlledCreationAdtClient, payload: DdicPrimitivePayload): Promise<PrimitiveProperties> {
  if (payload.kind === 'DDIC_DOMAIN') {
    if (!client.getDomainProperties) throw new Error('Controlled DDIC domain property reading is unavailable in this ADT client.')
    return (await client.getDomainProperties(payload.objectUrl, 'active')).properties
  }
  if (!client.getDataElementProperties) throw new Error('Controlled DDIC data element property reading is unavailable in this ADT client.')
  return (await client.getDataElementProperties(payload.objectUrl, 'active')).properties
}

function propertiesMatch(expected: PrimitiveProperties, actual: PrimitiveProperties): boolean {
  return JSON.stringify(normalizeProperties(expected)) === JSON.stringify(normalizeProperties(actual))
}

function normalizeProperties(properties: PrimitiveProperties): unknown {
  if ('typeInformation' in properties) {
    const valueInformation = properties.valueInformation
    return normalize({
      ...properties,
      // SAP materializes an omitted optional value block as the same empty domain defaults.
      valueInformation: {
        valueTableRef: valueInformation?.valueTableRef || '',
        appendExists: valueInformation?.appendExists === true,
        ...(valueInformation?.fixValues?.length ? { fixValues: valueInformation.fixValues } : {})
      }
    })
  }
  const labels = properties.fieldLabels
  return normalize({
    ...properties,
    fieldLabels: {
      ...labels,
      shortFieldLength: labels.shortFieldLength ?? 10,
      mediumFieldLength: labels.mediumFieldLength ?? 20,
      longFieldLength: labels.longFieldLength ?? 40,
      headingFieldLength: labels.headingFieldLength ?? 55
    },
    searchHelp: properties.searchHelp || '',
    searchHelpParameter: properties.searchHelpParameter || '',
    setGetParameter: properties.setGetParameter || '',
    defaultComponentName: properties.defaultComponentName || '',
    deactivateInputHistory: properties.deactivateInputHistory === true,
    changeDocument: properties.changeDocument === true,
    leftToRightDirection: properties.leftToRightDirection === true,
    deactivateBIDIFiltering: properties.deactivateBIDIFiltering === true
  })
}

async function assertDomainReference(client: ControlledCreationAdtClient, domainName: string): Promise<void> {
  const matches = await client.searchObject(domainName, 'DOMA/DD', 10)
  const exact = matches.find(item => item['adtcore:name'].toUpperCase() === domainName.toUpperCase()
    && item['adtcore:type'].toUpperCase() === 'DOMA/DD')
  if (!exact) throw new Error(`Referenced domain ${domainName} was not found.`)
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalize(item)]))
}

function primitivePayload(plan: RepositoryCreationPlan, kind: DdicPrimitiveKind): DdicPrimitivePayload {
  const payload = plan.payload as DdicPrimitivePayload | undefined
  if (!payload || payload.kind !== kind || !payload.name || !payload.objectUrl || !payload.properties) {
    throw new Error('DDIC primitive creation plan payload is unavailable.')
  }
  return payload
}

function assertIdentity(metaData: Record<string, unknown>, payload: DdicPrimitivePayload): void {
  if (String(metaData['adtcore:name'] || '').toUpperCase() !== payload.name
    || String(metaData['adtcore:type'] || '').toUpperCase() !== payload.adtType) {
    throw new Error(`Created ${payload.adtType} ${payload.name} does not match the confirmed plan.`)
  }
}

function assertActivation(result: { success: boolean; messages: Array<{ shortText?: string }> }, stage: string): void {
  if (!result.success) throw new Error(`${stage} failed: ${result.messages.map(message => message.shortText).filter(Boolean).join('; ') || 'SAP activation failed.'}`)
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`)
  return result
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  return booleanValue(value, label)
}

function requiredBoundedText(value: unknown, label: string, maximum: number): string {
  const result = String(value || '').trim()
  if (!result || result.length > maximum || /[\r\n\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} is required and bounded.`)
  return result
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === '') return undefined
  return requiredBoundedText(value, label, maximum)
}

function boundedToken(value: unknown, label: string, maximum: number): string {
  const result = requiredBoundedText(value, label, maximum).toUpperCase()
  if (!/^[A-Z][A-Z0-9_]*$/.test(result)) throw new Error(`${label} must be an ABAP token.`)
  return result
}

function optionalToken(value: unknown, label: string, maximum: number): string | undefined {
  const result = optionalText(value, label, maximum)
  if (!result) return undefined
  if (!/^[A-Z][A-Z0-9_]*$/i.test(result)) throw new Error(`${label} must be an ABAP token.`)
  return result.toUpperCase()
}
