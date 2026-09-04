import type {
  ControlledPackageDocument,
  ControlledTableSettingsDocument,
  ControlledTableTechnicalSettings
} from '../../adt/index.js'
import { RepositoryCreationOutcomeUnknownError } from '../RepositoryObjectCreationWorkflow.js'
import type {
  PreparedRepositoryCreation,
  RepositoryCreationExecutionResult,
  RepositoryCreationPlan,
  RepositoryObjectCreationAdapter
} from '../repositoryCreationTypes.js'
import type { SafetyPolicy } from '../SafetyPolicy.js'
import {
  buildDatabaseTableDdl,
  type DatabaseTableDefinitionInput,
  type DatabaseTableFieldInput
} from '../tableDefinition.js'
import { compareSources } from '../sourceTools.js'
import type { ControlledCreationAdtClient } from './controlledCreationTools.js'
import {
  assertActivation,
  assertNoCheckErrors,
  assertTargetAbsent,
  assertTransportAvailable,
  assertValidation,
  repositoryName,
  requiredString
} from './creationAdapterTools.js'

interface DatabaseTableCreationPayload {
  name: string
  description: string
  packageName: string
  packageUrl: string
  transportRequest: string
  source: string
  shellIdentity: Pick<ControlledPackageDocument, 'language' | 'masterLanguage' | 'masterSystem' | 'responsible'>
  settings: ControlledTableTechnicalSettings
}

export class DatabaseTableCreationAdapter implements RepositoryObjectCreationAdapter {
  readonly objectKind = 'DATABASE_TABLE' as const

  constructor(
    private readonly client: ControlledCreationAdtClient,
    private readonly policy: SafetyPolicy
  ) {}

  async prepare(request: Record<string, unknown>): Promise<PreparedRepositoryCreation> {
    const name = repositoryName(request, 'name', 16)
    const description = requiredString(request, 'description', 120)
    const packageName = repositoryName(request, 'packageName', 30)
    const transportRequest = this.policy.assertTransportFormat(String(request.transportRequest || ''))
    this.policy.assertMutationAllowed(name)
    this.policy.assertTransportablePackage(packageName)
    const fields = request.fields as DatabaseTableFieldInput[]
    const source = buildDatabaseTableDdl({ name, description, fields } satisfies DatabaseTableDefinitionInput)
    const settings = normalizeSettings(request.technicalSettings)

    const [targetMatches, packageMatches] = await Promise.all([
      this.client.searchObject(name, 'TABL/DT', 10),
      this.client.searchObject(packageName, 'DEVC/K', 10)
    ])
    assertTargetAbsent(targetMatches, name, 'TABL/DT')
    const parent = packageMatches.find(item => item['adtcore:name'].toUpperCase() === packageName && item['adtcore:type'].toUpperCase() === 'DEVC/K')
    if (!parent) throw new Error(`Package ${packageName} was not found.`)
    const packageMetadata = await this.client.readControlledPackage(packageName)
    const shellIdentity = {
      language: packageMetadata.language || packageMetadata.masterLanguage,
      masterLanguage: packageMetadata.masterLanguage || packageMetadata.language,
      masterSystem: packageMetadata.masterSystem,
      responsible: packageMetadata.responsible || this.policy.sapUser
    }
    if (!shellIdentity.language || !shellIdentity.masterLanguage || !shellIdentity.masterSystem || !shellIdentity.responsible) {
      throw new Error(`Package ${packageName} did not expose the identity metadata required for controlled creation.`)
    }
    assertValidation(await this.client.validateControlledTableShell({ name, description }), name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(parent['adtcore:uri'], packageName, 'I'),
      this.client.transportDetails(transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, transportRequest)
    return {
      target: { objectKind: 'DATABASE_TABLE', objectName: name, adtType: 'TABL/DT', parentName: packageName },
      transportRequest,
      summary: `Create transparent database table ${name} with ${fields.length} controlled fields.`,
      payload: { name, description, packageName, packageUrl: parent['adtcore:uri'], transportRequest, source, shellIdentity, settings } satisfies DatabaseTableCreationPayload,
      review: {
        objectKind: 'DATABASE_TABLE', name, description, packageName, transportRequest,
        generatedSource: source, technicalSettings: settings
      },
      compensationLimits: ['Unknown create, source-write, settings-write, or activation outcomes forbid automatic retry and deletion.']
    }
  }

  async execute(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<RepositoryCreationExecutionResult> {
    const payload = tablePayload(plan)
    assertTargetAbsent(await this.client.searchObject(payload.name, 'TABL/DT', 10), payload.name, 'TABL/DT')
    recordStage('REVALIDATE_ABSENCE', true)
    assertValidation(await this.client.validateControlledTableShell(payload), payload.name)
    const [transportInfo, transportDetails] = await Promise.all([
      this.client.transportInfo(payload.packageUrl, payload.packageName, 'I'),
      this.client.transportDetails(payload.transportRequest)
    ])
    assertTransportAvailable(transportInfo, transportDetails, payload.transportRequest)
    recordStage('VALIDATE_TRANSPORT', true)

    try {
      await this.client.createControlledTableShell({
        name: payload.name,
        description: payload.description,
        packageName: payload.packageName,
        transportRequest: payload.transportRequest,
        language: payload.shellIdentity.language!,
        masterLanguage: payload.shellIdentity.masterLanguage!,
        masterSystem: payload.shellIdentity.masterSystem!,
        responsible: payload.shellIdentity.responsible!
      })
    } catch (error) {
      throw unknownWrite('Database table shell create', error)
    }
    plan.actualResources = [{ type: 'TABL/DT', name: payload.name }]
    recordStage('CREATE_SHELL', true)
    const created = await this.client.readControlledTable(payload.name, 'inactive')
    if (created.name !== payload.name || created.packageName !== payload.packageName) {
      throw new Error(`Created table shell ${payload.name} does not match the confirmed plan.`)
    }
    recordStage('RESOLVE_CREATED_OBJECT', true)

    await this.withLockedResource(
      `/sap/bc/adt/ddic/tables/${payload.name.toLowerCase()}`,
      recordStage,
      async lockHandle => {
        assertNoCheckErrors(await this.client.runControlledTableCheck(payload.name, 'tableStatusCheck', payload.source), 'table-status-check')
        assertNoCheckErrors(await this.client.runControlledTableCheck(payload.name, 'abapCheckRun', payload.source), 'abap-check')
        recordStage('RUN_CHECKS', true, 'In-memory source passed table status and ABAP checks.')
        try {
          await this.client.writeControlledTableSource(payload.name, payload.source, lockHandle, payload.transportRequest)
        } catch (error) {
          throw unknownWrite('Database table source write', error)
        }
        recordStage('WRITE_SOURCE', true)
        assertNoCheckErrors(await this.client.runControlledTableCheck(payload.name, 'tableStatusCheck'), 'table-status-check')
        recordStage('RUN_CHECKS', true, 'Persisted inactive source passed table status check.')
      }
    )
    let tableActivation
    try {
      tableActivation = await this.client.activateControlledTable(payload.name)
    } catch (error) {
      throw unknownWrite('Database table activation', error)
    }
    assertActivation(tableActivation, 'table-activation')
    recordStage('ACTIVATE_OBJECT', true)
    const activeSource = await this.client.readControlledTableSource(payload.name, 'active')
    const sourceComparison = compareDatabaseTableSources(payload.source, activeSource)
    if (!sourceComparison.matches) {
      recordStage('VERIFY_SOURCE', false, JSON.stringify(sourceComparison.diagnostics))
      throw new Error(`Active source for ${payload.name} does not match the confirmed plan.`)
    }
    recordStage('VERIFY_SOURCE', true)

    const currentSettings = await this.client.readControlledTableSettings(payload.name)
    await this.withLockedResource(
      `/sap/bc/adt/ddic/db/settings/${payload.name.toLowerCase()}`,
      recordStage,
      async lockHandle => {
        try {
          await this.client.writeControlledTableSettings(currentSettings, payload.settings, lockHandle, payload.transportRequest)
        } catch (error) {
          throw unknownWrite('Database table technical settings write', error)
        }
        recordStage('WRITE_TECHNICAL_SETTINGS', true)
      }
    )
    let settingsActivation
    try {
      settingsActivation = await this.client.activateControlledTableSettings(payload.name)
    } catch (error) {
      throw unknownWrite('Database table technical settings activation', error)
    }
    assertActivation(settingsActivation, 'settings-activation')
    recordStage('ACTIVATE_RESOURCE', true)
    assertSettingsMatch(await this.client.readControlledTableSettings(payload.name, 'active'), payload.settings)
    recordStage('VERIFY_TECHNICAL_SETTINGS', true)
    return {
      resultSummary: `Created, activated, and verified database table ${payload.name}.`,
      actualResources: [
        { type: 'TABL/DT', name: payload.name },
        { type: 'TABL/DTT', name: payload.name }
      ]
    }
  }

  async compensate(
    plan: RepositoryCreationPlan,
    recordStage: (stage: string, success: boolean, message?: string) => void
  ): Promise<boolean> {
    const payload = tablePayload(plan)
    if (!plan.actualResources?.some(resource => resource.type === 'TABL/DT' && resource.name === payload.name)) return false
    const objectUrl = `/sap/bc/adt/ddic/tables/${payload.name.toLowerCase()}`
    const lock = await this.client.lock(objectUrl, 'MODIFY')
    recordStage('COMPENSATION_LOCK_RESOURCE', true)
    try {
      await this.client.deleteObject(objectUrl, lock.LOCK_HANDLE, payload.transportRequest)
    } catch (error) {
      // A failed DELETE response is not retried because its remote outcome may be unknown.
      throw new Error(`Database table compensation outcome is unknown: ${error instanceof Error ? error.message : String(error)}`)
    }
    const remaining = await this.client.searchObject(payload.name, 'TABL/DT', 10)
    assertTargetAbsent(remaining, payload.name, 'TABL/DT')
    recordStage('COMPENSATE_CREATED_OBJECT', true)
    return true
  }

  private async withLockedResource(
    url: string,
    recordStage: (stage: string, success: boolean, message?: string) => void,
    operation: (lockHandle: string) => Promise<void>
  ): Promise<void> {
    const lock = await this.client.lock(url, 'MODIFY')
    recordStage('LOCK_RESOURCE', true)
    let operationError: unknown
    try {
      await operation(lock.LOCK_HANDLE)
    } catch (error) {
      operationError = error
    }
    try {
      await this.client.unLock(url, lock.LOCK_HANDLE)
      recordStage('UNLOCK_RESOURCE', true)
    } catch (unlockError) {
      recordStage('UNLOCK_RESOURCE', false, unlockError instanceof Error ? unlockError.message : String(unlockError))
      if (!operationError) throw unlockError
    }
    if (operationError) throw operationError
  }
}

function tablePayload(plan: RepositoryCreationPlan): DatabaseTableCreationPayload {
  const payload = plan.payload as DatabaseTableCreationPayload | undefined
  if (!payload?.name || !payload.source) throw new Error('Database table creation plan payload is unavailable.')
  return payload
}

function normalizeSettings(value: unknown): ControlledTableTechnicalSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const dataClass = String(input.dataClass || 'APPL1').toUpperCase() as ControlledTableTechnicalSettings['dataClass']
  const sizeCategory = input.sizeCategory === undefined ? 0 : Number(input.sizeCategory)
  const buffering = String(input.buffering || 'NOT_ALLOWED').toUpperCase() as 'NOT_ALLOWED'
  const loggingEnabled = input.loggingEnabled === true
  if (!['APPL0', 'APPL1', 'APPL2', 'APPL3', 'USER'].includes(dataClass)) throw new Error(`Unsupported data class ${dataClass}.`)
  if (!Number.isInteger(sizeCategory) || sizeCategory < 0 || sizeCategory > 9) throw new Error('Size category must be an integer from 0 to 9.')
  if (buffering !== 'NOT_ALLOWED') throw new Error('Controlled table creation keeps buffering disabled.')
  if (input.loggingEnabled !== undefined && typeof input.loggingEnabled !== 'boolean') throw new Error('loggingEnabled must be a boolean.')
  return { dataClass, sizeCategory, buffering, loggingEnabled, storageType: 'C' }
}

function assertSettingsMatch(actual: ControlledTableSettingsDocument, expected: ControlledTableTechnicalSettings): void {
  if (actual.dataClass !== expected.dataClass
    || actual.sizeCategory !== expected.sizeCategory
    || actual.buffering !== expected.buffering
    || actual.loggingEnabled !== expected.loggingEnabled
    || actual.storageType !== (expected.storageType || 'C')) {
    throw new Error(`Active technical settings for ${actual.name} do not match the confirmed plan.`)
  }
}

function unknownWrite(stage: string, error: unknown): RepositoryCreationOutcomeUnknownError {
  const detail = error instanceof Error ? error.message : String(error)
  return new RepositoryCreationOutcomeUnknownError(`${stage} outcome is unknown: ${detail}`)
}

interface DatabaseTableDdlToken {
  kind: 'COMMENT' | 'IDENTIFIER' | 'NUMBER' | 'OPERATOR' | 'STRING' | 'SYMBOL'
  value: string
}

function compareDatabaseTableSources(
  expectedSource: string,
  actualSource: string
): { matches: boolean; diagnostics?: Record<string, unknown> } {
  const strict = compareSources(expectedSource, actualSource)
  if (strict.matches) return { matches: true }
  const expectedTokens = tokenizeDatabaseTableDdl(expectedSource)
  const actualTokens = tokenizeDatabaseTableDdl(actualSource)
  const firstMismatchIndex = firstDatabaseTableTokenMismatch(expectedTokens, actualTokens)
  if (firstMismatchIndex === -1) return { matches: true }
  return {
    matches: false,
    diagnostics: {
      expectedHash: strict.expectedHash,
      actualHash: strict.actualHash,
      expectedTokenCount: expectedTokens.length,
      actualTokenCount: actualTokens.length,
      firstMismatchIndex,
      expectedTokenKind: expectedTokens[firstMismatchIndex]?.kind || 'MISSING',
      actualTokenKind: actualTokens[firstMismatchIndex]?.kind || 'MISSING'
    }
  }
}

function firstDatabaseTableTokenMismatch(
  expectedTokens: DatabaseTableDdlToken[],
  actualTokens: DatabaseTableDdlToken[]
): number {
  const maximum = Math.max(expectedTokens.length, actualTokens.length)
  for (let index = 0; index < maximum; index += 1) {
    if (expectedTokens[index]?.kind !== actualTokens[index]?.kind
      || expectedTokens[index]?.value !== actualTokens[index]?.value) return index
  }
  return -1
}

function tokenizeDatabaseTableDdl(source: string): DatabaseTableDdlToken[] {
  const normalized = source.replace(/\r\n?/g, '\n')
  const tokens: DatabaseTableDdlToken[] = []
  let offset = 0

  while (offset < normalized.length) {
    const character = normalized[offset]
    if (/\s/.test(character)) {
      offset += 1
      continue
    }

    const lineCommentLength = normalized.startsWith('//', offset) || normalized.startsWith('--', offset)
      ? 2
      : character === '"' ? 1 : 0
    if (lineCommentLength > 0) {
      const end = normalized.indexOf('\n', offset + lineCommentLength)
      const commentEnd = end === -1 ? normalized.length : end
      tokens.push({ kind: 'COMMENT', value: normalized.slice(offset, commentEnd) })
      offset = commentEnd
      continue
    }

    if (normalized.startsWith('/*', offset)) {
      const closingOffset = normalized.indexOf('*/', offset + 2)
      const commentEnd = closingOffset === -1 ? normalized.length : closingOffset + 2
      tokens.push({ kind: 'COMMENT', value: normalized.slice(offset, commentEnd) })
      offset = commentEnd
      continue
    }

    if (character === "'" || character === '`') {
      const end = quotedTokenEnd(normalized, offset, character)
      tokens.push({ kind: 'STRING', value: normalized.slice(offset, end) })
      offset = end
      continue
    }

    const namespaceIdentifier = normalized.slice(offset).match(/^\/[A-Za-z0-9_]+\/[A-Za-z][A-Za-z0-9_]*/)?.[0]
    if (namespaceIdentifier) {
      tokens.push({ kind: 'IDENTIFIER', value: namespaceIdentifier })
      offset += namespaceIdentifier.length
      continue
    }

    const identifier = normalized.slice(offset).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0]
    if (identifier) {
      tokens.push({ kind: 'IDENTIFIER', value: identifier })
      offset += identifier.length
      continue
    }

    const number = normalized.slice(offset).match(/^\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?/)?.[0]
    if (number) {
      tokens.push({ kind: 'NUMBER', value: number })
      offset += number.length
      continue
    }

    const operator = DATABASE_TABLE_DDL_OPERATORS.find(candidate => normalized.startsWith(candidate, offset))
    if (operator) {
      tokens.push({ kind: 'OPERATOR', value: operator })
      offset += operator.length
      continue
    }

    tokens.push({ kind: 'SYMBOL', value: character })
    offset += 1
  }

  return tokens
}

const DATABASE_TABLE_DDL_OPERATORS = [
  '=>', '->', '<=', '>=', '<>', '!=', '&&', '||', '..', '::', '?=', '+=', '-=', '*=', '/='
] as const

function quotedTokenEnd(source: string, start: number, delimiter: "'" | '`'): number {
  let offset = start + 1
  while (offset < source.length) {
    if (source[offset] !== delimiter) {
      offset += 1
      continue
    }
    if (source[offset + 1] === delimiter) {
      offset += 2
      continue
    }
    return offset + 1
  }
  return source.length
}
