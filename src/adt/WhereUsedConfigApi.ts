/**
 * where-used-config API（矩阵行 analysis.history 的 where_used_config 子操作；
 * VSP 来源 internal/mcp/handlers_graph.go 的 fetchConfigRefs 语义移植）。
 *
 * 语义：找出"代码里触碰 TVARVC 表"的编译单元（候选），并对每个候选的源码
 * grep 变量名以确认是否真的读取了该变量。两段式：
 *   Step 1（候选，纯 SQL 两表配对）：
 *     WBCROSSGT OTYPE='TY'（OO 类池）+ CROSS TYPE='S'（过程化）——任一单源失败
 *     可生存（gaps 记录），双源失败不是"无读者"答案而是硬错误。
 *   Step 2（确认，源码 grep）：每候选源码 grep 变量名（大小写不敏感）；grep
 *     失败记 unsearched，绝不借用"读了没找到"（confirmed=false）的语义。
 *
 * 与 VSP 的有意差异：候选确认有界（maxGrep 默认 10、上限 30——本项目源码
 * grep 走客户端正则串行读取，无界会拖垮会话），超出预算的候选按 unsearched
 * 报告；不做包回填（VSP 有 TADIR 包解析，本层 notes 声明无包信息）。
 */
import { normalizeLoadName } from './LoadGraphApi.js'
import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js'

/** 一个已确认/未确认读取该配置变量的对象。 */
export interface WhereUsedConfigReader {
  objectType: string
  objectName: string
  /** true=源码 grep 命中变量名；false=触表但未在源码中找到（或未 grep）。 */
  confirmed: boolean
}

/** getWhereUsedConfig 的返回。 */
export interface GetWhereUsedConfigResult {
  variable: string
  /** 触 TVARVC 表的候选对象（去重后全部列出，含未 grep 的）。 */
  readers: WhereUsedConfigReader[]
  /** 实际执行源码 grep 的候选数。 */
  greppedCount: number
  /** 采集与确认阶段未覆盖的缺口（单源失败/预算外/读取失败）。 */
  unsearched: Array<{ object: string; reason: string }>
  notes: string[]
}

/** SQL 窄通道（交叉表候选；行数上限逐次给定，不重试）。 */
export type WhereUsedConfigSqlRunner = (sqlQuery: string, rowLimit: number) => Promise<{ values?: Record<string, unknown>[] }>

/** 交叉引用候选的对象类型（normalizeLoadName 只产这四类源码承载类型）。 */
export type WhereUsedConfigSourceType = 'CLAS' | 'INTF' | 'PROG' | 'FUGR'

/** 源码 grep 窄通道：直通 SourceGrepApi.grepObjects 的输入输出形态。 */
export interface WhereUsedConfigGrepRunner {
  (input: {
    objects: Array<{ name: string; objectType: WhereUsedConfigSourceType }>
    pattern: string
    caseInsensitive?: boolean
  }): Promise<{
    objects: Array<{ objectName: string; objectType: string; matchCount: number }>
    skipped: Array<{ objectName: string; objectType?: string; reason: string }>
    searchedObjects: number
  }>
}

const QUERY_ROW_LIMIT = 500
const GREP_BATCH_SIZE = 20

/** TVARVC 变量名 token 校验（大写 A-Z 0-9 _，最长 40）。 */
function validateVariable(value: unknown, capability: string): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > 40 || !/^[A-Z0-9_]+$/.test(token)) {
    throw new Error(`${capability}: variable "${String(value ?? '')}" is invalid (A-Z 0-9 _, at most 40 characters).`)
  }
  return token
}

/** 单元格容错读取（同 TransportScope.cell 的真机空值语义）。 */
function cellText(row: Record<string, unknown>, columnName: string): string {
  const keys = Object.keys(row).filter(key => key.toUpperCase() === columnName)
  if (keys.length !== 1) return ''
  const value = row[keys[0]]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

/**
 * where-used-config：找出读取 TVARVC 变量的代码对象。
 * variable 白名单校验后仅作字面 grep 模式（A-Z0-9_ 无正则元字符）。
 */
export async function getWhereUsedConfig(
  deps: { runSql: WhereUsedConfigSqlRunner; grepObjects: WhereUsedConfigGrepRunner },
  input: { variable: string; grep?: boolean; maxGrep?: number }
): Promise<GetWhereUsedConfigResult> {
  const capability = 'getWhereUsedConfig'
  const variable = validateVariable(input?.variable, capability)
  const doGrep = input?.grep === undefined ? true : input.grep === true
  const maxGrep = Math.min(Math.max(Number.isInteger(input?.maxGrep) ? input!.maxGrep! : 10, 1), 30)
  const unsearched: Array<{ object: string; reason: string }> = []
  const notes = [
    'Candidates are compiled units whose cross-reference rows touch the TVARVC table (WBCROSSGT OTYPE=TY + CROSS TYPE=S).',
    'confirmed=true means the variable name was found in the object source by case-insensitive grep; false means the table was touched but the name was not found (or the source was not grepped).',
    'No package ownership metadata is resolved in this layer.'
  ]

  // Step 1：两表配对采集候选（INCLUDE = 触表编译单元，池形态需归一化）
  const candidates = new Map<string, { objectType: WhereUsedConfigSourceType; objectName: string }>()
  let wbFailed = false
  let crossFailed = false
  const collect = async (sql: string, failedFlag: () => void) => {
    try {
      const rows = (await deps.runSql(sql, QUERY_ROW_LIMIT)).values ?? []
      for (const row of rows) {
        const include = cellText(row, 'INCLUDE')
        if (!include) continue
        const node = normalizeLoadName(include)
        if (!node) continue
        // normalizeLoadName 语义上只产出 CLAS/INTF/PROG/FUGR 四类（PROG 为兜底默认）
        candidates.set(node.objectType + ':' + node.objectName, { objectType: node.objectType as WhereUsedConfigSourceType, objectName: node.objectName })
      }
    } catch {
      failedFlag()
    }
  }
  await collect(`SELECT INCLUDE FROM WBCROSSGT WHERE OTYPE = 'TY' AND NAME = 'TVARVC'`, () => { wbFailed = true })
  await collect(`SELECT INCLUDE FROM CROSS WHERE TYPE = 'S' AND NAME = 'TVARVC'`, () => { crossFailed = true })
  if (wbFailed) unsearched.push({ object: 'WBCROSSGT (object-oriented code)', reason: 'cross-reference read failed' })
  if (crossFailed) unsearched.push({ object: 'CROSS (classic procedural code)', reason: 'cross-reference read failed' })
  if (wbFailed && crossFailed) {
    throw new Error(`${capability}: neither cross-reference table could be read, so this is not an answer.`)
  }

  // Step 2：源码 grep 确认（有界；超出预算的候选记 unsearched 不静默丢弃）
  const ordered = [...candidates.values()].sort((a, b) =>
    a.objectType.localeCompare(b.objectType) || a.objectName.localeCompare(b.objectName))
  const readers: WhereUsedConfigReader[] = ordered.map(c => ({ objectType: c.objectType, objectName: c.objectName, confirmed: false }))
  const confirmedKeys = new Set<string>()
  const greppedKeys = new Set<string>()
  let greppedCount = 0
  if (doGrep) {
    const greppable = ordered.filter(c => ['CLAS', 'INTF', 'PROG', 'FUGR'].includes(c.objectType))
    for (const c of ordered) {
      if (!greppable.some(g => g.objectType === c.objectType && g.objectName === c.objectName)) {
        unsearched.push({ object: `${c.objectType} ${c.objectName}`, reason: 'no source URL for this object type; listed unconfirmed rather than grepped' })
      }
    }
    for (let start = 0; start < greppable.length && greppedKeys.size < maxGrep; start += GREP_BATCH_SIZE) {
      const batch = greppable.slice(start, start + Math.min(GREP_BATCH_SIZE, maxGrep - greppedKeys.size))
      try {
        const result = await deps.grepObjects({
          objects: batch.map(c => ({ name: c.objectName, objectType: c.objectType })),
          pattern: variable,
          caseInsensitive: true
        })
        for (const o of result.objects) {
          if (o.matchCount > 0) confirmedKeys.add(`${o.objectType}:${o.objectName}`)
        }
        // grep 通道自身把未能搜索的对象连同固定分类原因返回——对齐 unsearched 语义
        for (const sk of result.skipped) {
          unsearched.push({ object: `${sk.objectType ?? ''} ${sk.objectName}`.trim(), reason: `source grep skipped: ${sk.reason}` })
        }
        for (const c of batch) greppedKeys.add(`${c.objectType}:${c.objectName}`)
        greppedCount = greppedKeys.size
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const c of batch) {
          unsearched.push({ object: `${c.objectType} ${c.objectName}`, reason: `source grep failed: ${message.slice(0, 120)}` })
        }
      }
    }
    for (const c of greppable) {
      const key = `${c.objectType}:${c.objectName}`
      if (!greppedKeys.has(key)) unsearched.push({ object: `${c.objectType} ${c.objectName}`, reason: 'grep budget exceeded' })
    }
  }

  for (const reader of readers) {
    if (confirmedKeys.has(`${reader.objectType}:${reader.objectName}`)) reader.confirmed = true
  }
  readers.sort((a, b) => Number(b.confirmed) - Number(a.confirmed)
    || a.objectType.localeCompare(b.objectType) || a.objectName.localeCompare(b.objectName))
  return {
    variable,
    readers,
    greppedCount,
    unsearched,
    notes
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface WhereUsedConfigClient {
  getWhereUsedConfig(input: { variable: string; grep?: boolean; maxGrep?: number }): Promise<GetWhereUsedConfigResult>
}

/** 绑定 SQL 与源码 grep 两条既有通道成处理器可注入的窄客户端。 */
export function createWhereUsedConfigClient(deps: {
  runSql: WhereUsedConfigSqlRunner
  grepObjects: WhereUsedConfigGrepRunner
}): WhereUsedConfigClient {
  return { getWhereUsedConfig: input => getWhereUsedConfig(deps, input) }
}
