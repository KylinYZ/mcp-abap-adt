import { createHash } from 'crypto'
import {
  type ControlledAbapTypeCapability,
  type ControlledTableTypeProperties,
  type ControlledTableTypeRowType,
  type ControlledTableTypeShellInput,
  type ControlledTableTypeDocument
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
  assertActivation,
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  repositoryName,
  requiredString
} from './creationAdapterTools.js'

interface TableTypeCreationPayload {
  input: ControlledTableTypeShellInput
  properties: ControlledTableTypeProperties
  objectUrl: string
  packageUrl: string
  contentType: string
  abapTypeCapabilities: ControlledAbapTypeCapability[]
  capabilityHash: string
}

export class TableTypeCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'DDIC_TABLE_TYPE' as Extract<RepositoryObjectKind, 'DDIC_TABLE_TYPE'>

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 30)
    const description = requiredString(request, 'description', 60)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    const capabilities = await this.readCapabilities()
    const properties = parseProperties(request, capabilities)
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)

    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'TTYP/DA', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'TTYP/DA')
    const packageObject = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName
      && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!packageObject) throw new Error(`Package ${packageName} was not found.`)
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const input = identityInput(this.policy, packageMetadata, { name, description, packageName, transportRequest })
    assertValidation(await validateTableType(this.client, input), name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(packageObject['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    const objectUrl = controlledTableTypeUrl(name)
    return {
      target: { objectKind: this.objectKind, objectName: name, adtType: 'TTYP/DA', parentName: packageName },
      transportRequest,
      summary: `Create DDIC table type ${name} in package ${packageName}.`,
      payload: {
        input,
        properties,
        objectUrl,
        packageUrl: packageObject['adtcore:uri'],
        contentType: 'application/vnd.sap.adt.tabletype.v1+xml',
        abapTypeCapabilities: capabilities,
        capabilityHash: hashCapabilities(capabilities)
      } satisfies TableTypeCreationPayload,
      review: {
        objectKind: this.objectKind,
        name,
        description,
        packageName,
        transportRequest,
        properties,
        abapTypeCapabilities: capabilities,
        shellContract: { adtType: 'TTYP/DA', objectUrl, contentType: 'application/vnd.sap.adt.tabletype.v1+xml' }
      },
      compensationLimits: [
        'Only a table type proven to have been created by the current plan may be deleted.',
        'Unknown shell, property write, unlock, activation, or verification outcomes stop automatic compensation.'
      ]
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = tableTypePayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'TTYP/DA', 10), payload.input.name, 'TTYP/DA')
    recordStage('REVALIDATE_ABSENCE', true)
    const currentCapabilities = await this.readCapabilities()
    if (hashCapabilities(currentCapabilities) !== payload.capabilityHash) {
      throw new Error('ADT ABAP type capabilities changed after preview.')
    }
    assertValidation(await validateTableType(this.client, payload.input), payload.input.name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.input.packageName, 'I'),
      this.client.transportDetails(payload.input.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.input.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    try {
      await createTableType(this.client, payload.input)
    } catch (error) {
      throw unknownWrite('DDIC table type shell create', error)
    }
    plan.actualResources = [{ type: 'TTYP/DA', name: payload.input.name }]
    recordStage('CREATE_SHELL', true)

    let inactive: ControlledTableTypeDocument
    try {
      inactive = await readTableType(this.client, payload.input.name, 'inactive')
    } catch (error) {
      throw unknownWrite('DDIC table type creation verification read', error)
    }
    assertIdentity(inactive, payload.input)
    recordStage('RESOLVE_CREATED_OBJECT', true, payload.objectUrl)

    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      try {
        await writeTableType(this.client, payload.input.name, inactive, payload.properties, lock.LOCK_HANDLE, payload.input.transportRequest)
      } catch (error) {
        throw unknownWrite('DDIC table type property write', error)
      }
      recordStage('WRITE_PROPERTIES', true)
      let working: ControlledTableTypeDocument
      try {
        working = await readTableType(this.client, payload.input.name, 'workingArea')
      } catch (error) {
        throw unknownWrite('DDIC table type working-area verification read', error)
      }
      assertPropertiesMatch(payload.properties, working)
      recordStage('VERIFY_PROPERTIES', true)
    } catch (error) {
      operationError = error
    }
    try {
      await this.client.unLock(payload.objectUrl, lock.LOCK_HANDLE)
      recordStage('UNLOCK_RESOURCE', true)
    } catch (unlockError) {
      recordStage('UNLOCK_RESOURCE', false, errorText(unlockError))
      if (operationError instanceof RepositoryCreationOutcomeUnknownError) throw operationError
      throw unknownWrite('DDIC table type unlock', unlockError)
    }
    if (operationError) throw operationError

    let activation
    try {
      activation = await activateTableType(this.client, payload.input.name)
    } catch (error) {
      throw unknownWrite('DDIC table type activation', error)
    }
    assertActivation(activation, 'ACTIVATE_OBJECT')
    recordStage('ACTIVATE_OBJECT', true)
    let active: ControlledTableTypeDocument
    try {
      active = await readTableType(this.client, payload.input.name, 'active')
    } catch (error) {
      throw unknownWrite('DDIC table type active verification read', error)
    }
    assertIdentity(active, payload.input)
    assertPropertiesMatch(payload.properties, active)
    recordStage('VERIFY_ACTIVE_OBJECT', true)
    recordStage('VERIFY_ACTIVE_PROPERTIES', true)
    return {
      resultSummary: `Created, activated, and verified DDIC table type ${payload.input.name}.`,
      actualResources: [{ type: 'TTYP/DA', name: payload.input.name }]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = tableTypePayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'TTYP/DA' && resource.name === payload.input.name)) return false
    const lock = await this.client.lock(payload.objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(payload.objectUrl, lock.LOCK_HANDLE, payload.input.transportRequest)
    } catch (error) {
      throw new Error(`DDIC table type compensation outcome is unknown: ${errorText(error)}`)
    }
    assertTargetAbsent(await this.client.searchObject(payload.input.name, 'TTYP/DA', 10), payload.input.name, 'TTYP/DA')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }

  private async readCapabilities(): Promise<ControlledAbapTypeCapability[]> {
    if (!this.client.readControlledAbapTypeCapabilities) throw new Error('Controlled ABAP type capability discovery is unavailable.')
    const result = await this.client.readControlledAbapTypeCapabilities()
    if (!result.length) throw new Error('Target SAP did not expose any ABAP predefined types.')
    return result
  }
}

function controlledTableTypeUrl(name: string): string {
  return `/sap/bc/adt/ddic/tabletypes/${encodeURIComponent(name.toLowerCase())}`
}

function validateTableType(client: ControlledCreationAdtClient, input: ControlledTableTypeShellInput) {
  if (!client.validateControlledTableTypeShell) throw new Error('Controlled DDIC table type validation is unavailable.')
  return client.validateControlledTableTypeShell(input)
}

function createTableType(client: ControlledCreationAdtClient, input: ControlledTableTypeShellInput) {
  if (!client.createControlledTableTypeShell) throw new Error('Controlled DDIC table type creation is unavailable.')
  return client.createControlledTableTypeShell(input)
}

function readTableType(client: ControlledCreationAdtClient, name: string, version: 'active' | 'inactive' | 'workingArea') {
  if (!client.readControlledTableType) throw new Error('Controlled DDIC table type reading is unavailable.')
  return client.readControlledTableType(name, version)
}

function writeTableType(
  client: ControlledCreationAdtClient,
  name: string,
  current: ControlledTableTypeDocument,
  properties: ControlledTableTypeProperties,
  lockHandle: string,
  transportRequest: string
) {
  if (!client.writeControlledTableType) throw new Error('Controlled DDIC table type property writing is unavailable.')
  return client.writeControlledTableType(name, current, properties, lockHandle, transportRequest)
}

function activateTableType(client: ControlledCreationAdtClient, name: string) {
  if (!client.activateControlledTableType) throw new Error('Controlled DDIC table type activation is unavailable.')
  return client.activateControlledTableType(name)
}

function identityInput(
  policy: SafetyPolicy,
  packageMetadata: { language?: string; masterLanguage?: string; masterSystem?: string; responsible?: string },
  values: Pick<ControlledTableTypeShellInput, 'name' | 'description' | 'packageName' | 'transportRequest'>
): ControlledTableTypeShellInput {
  const language = packageMetadata.language || packageMetadata.masterLanguage
  const masterLanguage = packageMetadata.masterLanguage || language
  const responsible = packageMetadata.responsible || policy.sapUser
  if (!language || !masterLanguage || !packageMetadata.masterSystem || !responsible) {
    throw new Error(`Package ${values.packageName} did not expose the identity metadata required for controlled creation.`)
  }
  return { ...values, language, masterLanguage, masterSystem: packageMetadata.masterSystem, responsible }
}

function parseProperties(request: Record<string, unknown>, capabilities: ControlledAbapTypeCapability[]): ControlledTableTypeProperties {
  const rowType = parseRowType(request.rowType, capabilities)
  const initialRowCount = integer(request.initialRowCount, 'initialRowCount', 0, 99999, 0)
  const accessType = enumValue(request.accessType, 'accessType', ['standard', 'sorted', 'hashed', 'index'] as const, 'standard')
  const primaryKeyInput = record(request.primaryKey, 'primaryKey', true)
  const primaryKey = {
    definition: enumValue(primaryKeyInput.definition, 'primaryKey.definition', ['standard', 'rowType', 'keyComponents', 'empty'] as const, 'standard'),
    kind: enumValue(primaryKeyInput.kind, 'primaryKey.kind', ['unique', 'nonUnique'] as const, 'nonUnique')
  }
  const secondaryInput = record(request.secondaryKeys, 'secondaryKeys', true)
  return {
    rowType,
    initialRowCount,
    accessType,
    primaryKey,
    secondaryKeys: { allowed: enumValue(secondaryInput.allowed, 'secondaryKeys.allowed', ['allowed', 'notAllowed', 'notSpecified'] as const, 'notSpecified') }
  }
}

function parseRowType(value: unknown, capabilities: ControlledAbapTypeCapability[]): ControlledTableTypeRowType {
  const input = record(value, 'rowType')
  const typeKind = enumValue(input.typeKind, 'rowType.typeKind', [
    'predefinedAbapType', 'dictionaryType', 'referenceToPredefinedType', 'referenceToDictionaryType',
    'referenceToClassInterface', 'rangeTableOnPredefinedType', 'rangeTableOnDataElement'
  ] as const)
  const typeName = input.typeName === undefined ? undefined : repositoryValue(input.typeName, 'rowType.typeName', 30)
  const dataType = input.dataType === undefined ? undefined : token(input.dataType, 'rowType.dataType', 30).toLowerCase()
  let length = input.length === undefined ? undefined : integer(input.length, 'rowType.length', 0, 32000)
  let decimals = input.decimals === undefined ? undefined : integer(input.decimals, 'rowType.decimals', 0, 31)
  const rangeType = input.rangeType === undefined ? undefined : token(input.rangeType, 'rowType.rangeType', 30)
  if (typeKind === 'predefinedAbapType' || typeKind === 'rangeTableOnPredefinedType') {
    if (!dataType) throw new Error('rowType.dataType is required for a predefined ABAP row type.')
    const capability = capabilities.find(item => item.name === dataType)
    if (!capability) throw new Error(`ABAP predefined type ${dataType} is not advertised by the target SAP system.`)
    length = normalizeBounded(length, capability.lengthMin, capability.lengthMax, 'rowType.length')
    decimals = normalizeBounded(decimals, capability.decimalsMin, capability.decimalsMax, 'rowType.decimals', true)
  } else if (!typeName) {
    throw new Error(`rowType.typeName is required for ${typeKind}.`)
  }
  if (typeKind.startsWith('rangeTable') && !rangeType) throw new Error(`rowType.rangeType is required for ${typeKind}.`)
  return { typeKind, ...(typeName ? { typeName } : {}), ...(dataType ? { dataType: dataType.toUpperCase() } : {}), ...(length !== undefined ? { length } : {}), ...(decimals !== undefined ? { decimals } : {}), ...(rangeType ? { rangeType } : {}) }
}

function normalizeBounded(value: number | undefined, minimum: number | undefined, maximum: number | undefined, label: string, optional = false): number | undefined {
  if (minimum === undefined && maximum === undefined) return value
  const actual = value === undefined ? (optional ? minimum : minimum) : value
  if (actual === undefined) return undefined
  if (minimum !== undefined && actual < minimum || maximum !== undefined && actual > maximum) {
    throw new Error(`${label} must be between ${minimum ?? 0} and ${maximum ?? 32000}.`)
  }
  return actual
}

function assertIdentity(document: ControlledTableTypeDocument, input: ControlledTableTypeShellInput): void {
  if (document.name !== input.name.toUpperCase() || document.packageName !== input.packageName.toUpperCase()) {
    throw new Error(`Created table type ${input.name} does not match the confirmed plan.`)
  }
}

function assertPropertiesMatch(expected: ControlledTableTypeProperties, actual: ControlledTableTypeDocument): void {
  if (stableJson(expected) !== stableJson({ rowType: actual.rowType, initialRowCount: actual.initialRowCount, accessType: actual.accessType, primaryKey: actual.primaryKey, secondaryKeys: actual.secondaryKeys })) {
    throw new Error('DDIC table type properties do not match the confirmed plan.')
  }
}

function tableTypePayload(plan: RepositoryCreationPlan): TableTypeCreationPayload {
  const payload = plan.payload as TableTypeCreationPayload | undefined
  if (!payload?.input?.name || !payload.properties || !payload.capabilityHash) throw new Error('DDIC table type creation plan payload is unavailable.')
  return payload
}

function hashCapabilities(value: ControlledAbapTypeCapability[]): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function record(value: unknown, label: string, optional = false): Record<string, unknown> {
  if (value === undefined && optional) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function integer(value: unknown, label: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`)
  return result
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[], fallback?: T): T {
  const actual = value === undefined && fallback !== undefined ? fallback : String(value || '')
  if (!values.includes(actual as T)) throw new Error(`${label} must be one of ${values.join(', ')}.`)
  return actual as T
}

function repositoryValue(value: unknown, label: string, maximum: number): string {
  const actual = String(value || '').trim().toUpperCase()
  if (!actual || actual.length > maximum || !/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(actual)) throw new Error(`${label} is not a valid repository name.`)
  return actual
}

function token(value: unknown, label: string, maximum: number): string {
  const actual = String(value || '').trim()
  if (!actual || actual.length > maximum || !/^[A-Za-z][A-Za-z0-9_]*$/.test(actual)) throw new Error(`${label} must be an ABAP token.`)
  return actual
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${errorText(error)}`)
}
