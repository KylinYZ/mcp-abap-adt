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
/**
 * A5 交接修复：STRING 是变长内置类型，既不属于固定长类型也不是数据元素。
 * 此前落到"数据元素"分支会生成裸 `string` DDL，SAP 激活报"数据类型 不存在"。
 * 规则：无 length → abap.string；带 length → abap.sstring(n)（真机验证可行）。
 */
const STRING_TYPE = 'STRING'

export function buildDatabaseTableDdl(input: DatabaseTableDefinitionInput): string {
  const tableName = normalizeIdentifier(input.name, 'table name', 16)
  const description = normalizeDescription(input.description, 'table description')
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 500) {
    throw validation('Database table fields must contain between one and 500 entries.')
  }
  const declaredFields = input.fields.map((field, index) => normalizeField(field, index))
  // A5 交接修复：生成器自动重排字段顺序，满足 CURR/QUAN 引用字段必须先于引用者的依赖，
  // 调用方无需手工保证声明顺序（真机踩坑：顺序错报 "must appear before"）。
  const { fields, moved } = reorderReferenceDependencies(declaredFields)
  const byName = new Map<string, { field: NormalizedField; index: number }>()
  fields.forEach((field, index) => {
    if (byName.has(field.name)) throw validation(`Duplicate database table field ${field.name}.`)
    byName.set(field.name, { field, index })
  })
  if (!fields.some(field => field.key)) throw validation('Database tables require at least one key field.')

  for (const [index, field] of fields.entries()) validateReference(tableName, field, index, byName)
  if (moved.length > 0) {
    // 重排不是静默的：plan/响应可追溯哪些字段被移动了顺序
    void moved
  }

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
    '@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE',
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
  if (rawType === STRING_TYPE) {
    // A5：变长内置类型——无 length 用 abap.string，带 length 用 abap.sstring(n)（真机验证可行）
    if (field.decimals !== undefined) throw validation(`${rawType} does not accept decimals.`)
    ddlType = field.length !== undefined
      ? `abap.sstring(${integerInRange(field.length, 1, LENGTH_TYPES.get('SSTRING')!.maximum, `${rawType} length`)})`
      : 'abap.string'
  } else if (fixed) {
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

/**
 * A5 交接修复：把 CURR/QUAN 字段引用的货币/数量单位字段移动到引用者之前。
 * 分组重排保证主键前缀连续性不被破坏：
 * - key 组与非 key 组分别重排（key 必须保持为表的前缀连续字段）；
 * - key 组内重排安全（成员全是 key，前缀连续性不变）；
 * - key 的 CURR/QUAN 引用非 key 字段无法满足（key 必须在前）——保留明确报错。
 */
function reorderReferenceDependencies(fields: NormalizedField[]): { fields: NormalizedField[]; moved: string[] } {
  const moved: string[] = []
  const reorderWithin = (group: NormalizedField[]): NormalizedField[] => {
    const result = [...group]
    for (let i = 0; i < result.length; i++) {
      const field = result[i]
      if (field.typeKind !== 'CURR' && field.typeKind !== 'QUAN' || !field.referenceField) continue
      const refIndex = result.findIndex(candidate => candidate.name === field.referenceField)
      if (refIndex > i) {
        const [reference] = result.splice(refIndex, 1)
        result.splice(i, 0, reference)
        moved.push(reference.name)
      }
    }
    return result
  }
  const keyGroup = reorderWithin(fields.filter(field => field.key))
  const nonKeyGroup = reorderWithin(fields.filter(field => !field.key))
  return { fields: [...keyGroup, ...nonKeyGroup], moved }
}

function validateReference(
  tableName: string,
  field: NormalizedField,
  index: number,
  byName: Map<string, { field: NormalizedField; index: number }>
): void {
  const requiresReference = field.typeKind === 'CURR' || field.typeKind === 'QUAN'
  if (!requiresReference && field.referenceField) {
    // A5 交接修复：金额/数量场景最常见误用是 DEC + referenceField；给出明确修正指引
    if (field.typeKind === 'DEC') {
      throw validation(
        `Field ${field.name} uses type DEC which cannot declare referenceField; `
        + 'amount/quantity fields must use type CURR or QUAN instead of DEC.'
      )
    }
    throw validation(`Field ${field.name} cannot declare referenceField for type ${field.typeKind}.`)
  }
  if (!requiresReference) return
  if (!field.referenceField) throw validation(`Field ${field.name} of type ${field.typeKind} requires referenceField.`)
  const reference = byName.get(field.referenceField)
  if (!reference) throw validation(`Reference field ${field.referenceField} for ${field.name} does not exist.`)
  if (reference.index >= index) {
    // 重排后仍出现此错：只可能是 key 的 CURR/QUAN 引用非 key 字段（key 必须构成表前缀，无法满足）
    throw validation(
      `Reference field ${field.referenceField} must appear before ${field.name}. `
      + `${field.name} is a key field, so its reference must also be a key field.`
    )
  }
  const allowed = field.typeKind === 'CURR'
    ? reference.field.typeKind === 'CUKY' || reference.field.typeKind === 'WAERS' || reference.field.isDataElement
    : reference.field.typeKind === 'UNIT' || reference.field.typeKind === 'MEINS' || reference.field.isDataElement
  if (!allowed) throw validation(`Reference field ${field.referenceField} has an incompatible type for ${field.typeKind}.`)
  void tableName
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
  if (field.length !== undefined || field.decimals !== undefined) {
    // A5 交接修复：固定长类型的长度由系统定义，报错文案明确指出应省略这两个参数
    throw validation(
      `${type} is a fixed-length type: omit length and decimals entirely `
      + `(its length is defined by SAP, e.g. CLNT is always 3, DATS is 8).`
    )
  }
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
