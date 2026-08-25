import { SafeAbapError } from './errors.js'

export interface DatabaseTableFieldInput {
  name: string
  key?: boolean
  type: string
  length?: number
  decimals?: number
  notNull?: boolean
  description?: string
  referenceField?: string
}

export interface DatabaseTableDefinitionInput {
  name: string
  description: string
  fields: DatabaseTableFieldInput[]
}

export interface DdicStructureDefinitionInput {
  name: string
  description: string
  fields: DatabaseTableFieldInput[]
}

const FIXED_TYPES = new Map<string, string>([
  ['CLNT', 'clnt'], ['LANG', 'lang'], ['CUKY', 'cuky'], ['UNIT', 'unit'],
  ['DATS', 'dats'], ['TIMS', 'tims'], ['ACCP', 'accp'], ['FLTP', 'fltp'],
  ['INT1', 'int1'], ['INT2', 'int2'], ['INT4', 'int4'], ['INT8', 'int8'],
  ['DECFLOAT16', 'decfloat16'], ['DECFLOAT34', 'decfloat34'], ['UTCLONG', 'utclong']
])
const LENGTH_TYPES = new Map<string, { ddl: string; maximum: number }>([
  ['CHAR', { ddl: 'char', maximum: 1333 }],
  ['NUMC', { ddl: 'numc', maximum: 255 }],
  ['RAW', { ddl: 'raw', maximum: 255 }],
  ['SSTRING', { ddl: 'sstring', maximum: 1333 }]
])
const DECIMAL_TYPES = new Set(['DEC', 'CURR', 'QUAN'])

export function buildDatabaseTableDdl(input: DatabaseTableDefinitionInput): string {
  const tableName = normalizeIdentifier(input.name, 'table name', 16)
  const description = normalizeDescription(input.description, 'table description')
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 500) {
    throw validation('Database table fields must contain between one and 500 entries.')
  }
  const fields = input.fields.map((field, index) => normalizeField(field, index))
  const byName = new Map<string, { field: NormalizedField; index: number }>()
  fields.forEach((field, index) => {
    if (byName.has(field.name)) throw validation(`Duplicate database table field ${field.name}.`)
    byName.set(field.name, { field, index })
  })
  if (!fields.some(field => field.key)) throw validation('Database tables require at least one key field.')

  for (const [index, field] of fields.entries()) validateReference(tableName, field, index, byName)

  const lines = fields.flatMap(field => renderField(tableName, field))
  return [
    `@EndUserText.label : '${escapeAbapText(description)}'`,
    '@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE',
    '@AbapCatalog.tableCategory : #TRANSPARENT',
    '@AbapCatalog.deliveryClass : #A',
    '@AbapCatalog.dataMaintenance : #RESTRICTED',
    `define table ${tableName.toLowerCase()} {`,
    '',
    ...lines,
    '}',
    ''
  ].join('\n')
}

export function buildDdicStructureDdl(input: DdicStructureDefinitionInput): string {
  const structureName = normalizeIdentifier(input.name, 'structure name', 30)
  const description = normalizeDescription(input.description, 'structure description')
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 500) {
    throw validation('DDIC structure fields must contain between one and 500 entries.')
  }
  const fields = input.fields.map((field, index) => normalizeField(field, index))
  const names = new Set<string>()
  for (const field of fields) {
    if (field.key) throw validation(`DDIC structure field ${field.name} cannot be a key field.`)
    if (field.referenceField) throw validation(`DDIC structure field ${field.name} cannot declare referenceField.`)
    if (field.typeKind === 'CURR' || field.typeKind === 'QUAN') {
      throw validation(`DDIC structure field ${field.name} currently requires a typed reference field and is not supported.`)
    }
    if (names.has(field.name)) throw validation(`Duplicate DDIC structure field ${field.name}.`)
    names.add(field.name)
  }
  const lines = fields.flatMap(field => renderField(structureName, { ...field, key: false, notNull: false }))
  return [
    `@EndUserText.label : '${escapeAbapText(description)}'`,
    `define structure ${structureName.toLowerCase()} {`,
    '',
    ...lines,
    '}',
    ''
  ].join('\n')
}

interface NormalizedField {
  name: string
  key: boolean
  ddlType: string
  typeKind: string
  notNull: boolean
  description?: string
  referenceField?: string
  isDataElement: boolean
}

function normalizeField(field: DatabaseTableFieldInput, index: number): NormalizedField {
  if (!field || typeof field !== 'object') throw validation(`Field ${index + 1} is invalid.`)
  const name = normalizeIdentifier(field.name, `field ${index + 1} name`, 30)
  const rawType = String(field.type || '').trim().replace(/^abap\./i, '').toUpperCase()
  const fixed = FIXED_TYPES.get(rawType)
  const lengthType = LENGTH_TYPES.get(rawType)
  let ddlType: string
  let isDataElement = false
  if (fixed) {
    rejectDimensions(field, rawType)
    ddlType = `abap.${fixed}`
  } else if (lengthType) {
    const length = integerInRange(field.length, 1, lengthType.maximum, `${rawType} length`)
    if (field.decimals !== undefined) throw validation(`${rawType} does not accept decimals.`)
    ddlType = `abap.${lengthType.ddl}(${length})`
  } else if (DECIMAL_TYPES.has(rawType)) {
    const length = integerInRange(field.length, 1, 31, `${rawType} length`)
    const decimals = integerInRange(field.decimals, 0, 14, `${rawType} decimals`)
    if (decimals >= length) throw validation(`${rawType} decimals must be smaller than its length.`)
    ddlType = `abap.${rawType.toLowerCase()}(${length},${decimals})`
  } else {
    if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]{0,29}$/.test(rawType)) {
      throw validation(`Unsupported database table field type ${rawType || '(empty)'}.`)
    }
    rejectDimensions(field, rawType)
    ddlType = rawType.toLowerCase()
    isDataElement = true
  }
  return {
    name,
    key: field.key === true,
    ddlType,
    typeKind: rawType,
    notNull: field.notNull === true || field.key === true,
    ...(field.description ? { description: normalizeDescription(field.description, `field ${name} description`) } : {}),
    ...(field.referenceField ? { referenceField: normalizeIdentifier(field.referenceField, `field ${name} reference`, 30) } : {}),
    isDataElement
  }
}

function validateReference(
  tableName: string,
  field: NormalizedField,
  index: number,
  byName: Map<string, { field: NormalizedField; index: number }>
): void {
  const requiresReference = field.typeKind === 'CURR' || field.typeKind === 'QUAN'
  if (!requiresReference && field.referenceField) throw validation(`Field ${field.name} cannot declare referenceField for type ${field.typeKind}.`)
  if (!requiresReference) return
  if (!field.referenceField) throw validation(`Field ${field.name} of type ${field.typeKind} requires referenceField.`)
  const reference = byName.get(field.referenceField)
  if (!reference) throw validation(`Reference field ${field.referenceField} for ${field.name} does not exist.`)
  if (reference.index >= index) throw validation(`Reference field ${field.referenceField} must appear before ${field.name}.`)
  const allowed = field.typeKind === 'CURR'
    ? reference.field.typeKind === 'CUKY' || reference.field.typeKind === 'WAERS' || reference.field.isDataElement
    : reference.field.typeKind === 'UNIT' || reference.field.typeKind === 'MEINS' || reference.field.isDataElement
  if (!allowed) throw validation(`Reference field ${field.referenceField} has an incompatible type for ${field.typeKind}.`)
  if (reference.field.key && !field.key) {
    // This is legal, but retaining the explicit branch documents that key references are not reordered.
    void tableName
  }
}

function renderField(tableName: string, field: NormalizedField): string[] {
  const annotation = field.typeKind === 'CURR'
    ? `  @Semantics.amount.currencyCode : '${tableName.toLowerCase()}.${field.referenceField!.toLowerCase()}'`
    : field.typeKind === 'QUAN'
      ? `  @Semantics.quantity.unitOfMeasure : '${tableName.toLowerCase()}.${field.referenceField!.toLowerCase()}'`
      : undefined
  const label = field.description ? `  @EndUserText.label : '${escapeAbapText(field.description)}'` : undefined
  const declaration = `  ${field.key ? 'key ' : ''}${field.name.toLowerCase()} : ${field.ddlType}${field.notNull ? ' not null' : ''};`
  return [...(label ? [label] : []), ...(annotation ? [annotation] : []), declaration]
}

function rejectDimensions(field: DatabaseTableFieldInput, type: string): void {
  if (field.length !== undefined || field.decimals !== undefined) throw validation(`${type} does not accept length or decimals.`)
}

function integerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw validation(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function normalizeIdentifier(value: unknown, label: string, maximum: number): string {
  const normalized = String(value || '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized) || normalized.length > maximum) {
    throw validation(`${label} is not a valid ABAP repository identifier.`)
  }
  return normalized
}

function normalizeDescription(value: unknown, label: string): string {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 120 || /[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw validation(`${label} must contain one bounded line of text.`)
  }
  return normalized
}

function escapeAbapText(value: string): string {
  return value.replace(/'/g, "''")
}

function validation(message: string): SafeAbapError {
  return new SafeAbapError('VALIDATION_FAILED', 'table-definition', message)
}
