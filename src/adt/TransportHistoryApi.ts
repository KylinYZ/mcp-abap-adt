/**
 * ============================================================================
 * 传输历史只读 API（analysis.history 行：cr_history + co_change 子集）
 * ============================================================================
 *
 * 数据源为传输控制表（E071 对象清单 / E070 传输头与任务→请求层级）的自由
 * SQL SELECT，与知识查询同通道。真机前提（2026-09-18 复测确认）：E071/E070
 * 的 datapreview 数据读取可用——第十八轮记录的"受限"实为 datapreview 按会话
 * 查询预算耗尽的叠加假象，非表级限制。
 *
 * 两个只读工具（VSP internal/mcp/handlers_transport_analysis.go 与
 * handlers_graph.go handleCoChange 的子集移植）：
 *
 *   1. getCrHistory ← handleCRHistory（L35-168）：E071 找包含目标对象的
 *      传输（R3TR 精确 + LIMU 前缀）→ E070 解析任务→请求层级（STRKORR）
 *      与用户/日期。差异：VSP 还会用 E070A 传输属性做 CR 分组（需服务端
 *      配置 TransportAttribute），本项目无该配置——cr 分组缺省并记 notes。
 *   2. getCoChange ← handleCoChange（handlers_graph.go L594-627）的简化移植：
 *      目标对象所在传输 → 解析父请求 + 全部兄弟任务 → 这些请求内全部对象
 *      → 按共现传输数频次排序取 TopN。差异：VSP 走完整传输图引擎
 *      （pkg/graph BuildTransportGraph/WhatChangesWith），本实现按"同请求
 *      共现频次"直接统计（不含多跳图遍历），语义以 notes 声明。
 *
 * 业务规则：
 *   - 全部只读 SELECT；对象类型/名字经 token 白名单校验后进入等值/LIKE
 *     字面量（注入防线）；IN 列表由内部拼装（数据来自 E071/E070 返回值，
 *     仍逐项引号转义）。
 *   - co-change 频次是审查线索不是结论（VSP 同款 note 语义）。
 */

/** getCrHistory 的输入。 */
export interface GetCrHistoryInput {
  /** R3TR 对象类型（如 PROG、CLAS、TABL）。 */
  objectType: string
  /** 对象名（如 ZCL_FOO）。 */
  objectName: string
}

/** 一个传输的元信息。 */
export interface TransportHistoryEntry {
  /** 传输/任务号（E070.TRKORR）。 */
  trkorr: string
  /** 父请求号（任务是 STRKORR；请求自身为空）。 */
  parentRequest?: string
  /** 最后修改用户（E070.AS4USER）。 */
  user?: string
  /** 最后修改日期（E070.AS4DATE，YYYYMMDD）。 */
  date?: string
}

/** getCrHistory 的返回。 */
export interface GetCrHistoryResult {
  objectType: string
  objectName: string
  /** 包含该对象的传输/任务清单（升序）。 */
  transports: string[]
  /** 解析后的传输元信息（含父请求/用户/日期，按 trkorr 升序）。 */
  details: TransportHistoryEntry[]
  /** 解析出的顶层变更请求（升序去重）。 */
  requests: string[]
  notes: string[]
}

/** getCoChange 的输入。 */
export interface GetCoChangeInput {
  /** R3TR 对象类型。 */
  objectType: string
  /** 对象名。 */
  objectName: string
  /** 返回条数上限：默认 20，上限 50。 */
  topN?: number
}

/** 一条共同变更统计。 */
export interface CoChangeEntry {
  /** PGMID（R3TR/LIMU 等）。 */
  pgmid: string
  /** 对象类型。 */
  object: string
  /** 对象名。 */
  objName: string
  /** 与目标对象共现的传输/任务数。 */
  count: number
}

/** getCoChange 的返回。 */
export interface GetCoChangeResult {
  objectType: string
  objectName: string
  /** 目标对象出现的传输/任务数。 */
  transportsScanned: number
  /** 覆盖的顶层请求数。 */
  requestsCovered: number
  /** 共同变更排行（频次降序，TopN）。 */
  coChanges: CoChangeEntry[]
  notes: string[]
}

/** 自由 SQL 执行通道（行数上限由 API 逐次给定）。 */
export type TransportHistoryQueryRunner = (
  sqlQuery: string,
  rowLimit: number
) => Promise<{ values?: Record<string, unknown>[] }>

/** 对象类型/名字 token 校验（大写 A-Z 0-9 _ /）。 */
function validateToken(value: unknown, capability: string, label: string, max: number): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > max || !/^[A-Z0-9_/]+$/.test(token)) {
    throw new Error(`${capability}: ${label} "${String(value ?? '')}" is invalid (A-Z 0-9 _ /, at most ${max} characters).`)
  }
  return token
}

/** 单元格容错读取（datapreview 列名大小写/前后缀差异不敏感）。 */
function cellText(row: Record<string, unknown>, suffix: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase().endsWith(suffix.toUpperCase()))
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** SQL 字面量引用（token 已过白名单，此处仅做引号包裹的纵深防御）。 */
function quoteToken(token: string): string {
  return `'${token.replace(/'/g, "''")}'`
}

/** IN 列表拼装（输入来自表返回值，逐项引号转义）。 */
function quoteInList(values: Iterable<string>): string {
  return [...values].map(v => quoteToken(v)).join(', ')
}

const QUERY_ROW_LIMIT = 500

/**
 * 查找一个对象的传输历史（VSP handleCRHistory 子集移植；E070A CR 属性
 * 分组未配置，记 notes）。
 */
export async function getCrHistory(
  runQuery: TransportHistoryQueryRunner,
  input: GetCrHistoryInput
): Promise<GetCrHistoryResult> {
  const capability = 'getCrHistory'
  const objectType = validateToken(input?.objectType, capability, 'objectType', 4)
  const objectName = validateToken(input?.objectName, capability, 'objectName', 40)
  const notes: string[] = [
    'cr grouping via the E070A transport attribute is not configured on this server'
  ]

  // 1. E071：R3TR 精确匹配 + LIMU 前缀（子对象条目，尽力而为可容错）
  const trSet = new Set<string>()
  const r3trRows = (await runQuery(
    `SELECT trkorr FROM e071 WHERE pgmid = 'R3TR' AND object = ${quoteToken(objectType)}`
    + ` AND obj_name = ${quoteToken(objectName)}`,
    QUERY_ROW_LIMIT
  )).values ?? []
  for (const row of r3trRows) {
    const tr = cellText(row, 'TRKORR')
    if (tr !== '') trSet.add(tr)
  }
  try {
    const limuRows = (await runQuery(
      `SELECT trkorr FROM e071 WHERE pgmid = 'LIMU' AND obj_name LIKE ${quoteToken(objectName + '%')}`,
      QUERY_ROW_LIMIT
    )).values ?? []
    for (const row of limuRows) {
      const tr = cellText(row, 'TRKORR')
      if (tr !== '') trSet.add(tr)
    }
  } catch {
    notes.push('LIMU prefix lookup failed and was skipped (R3TR results are authoritative)')
  }

  if (trSet.size === 0) {
    return { objectType, objectName, transports: [], details: [], requests: [], notes }
  }

  // 2. E070：任务→请求层级 + 用户/日期
  const e070Rows = (await runQuery(
    `SELECT trkorr, strkorr, as4user, as4date FROM e070 WHERE trkorr IN (${quoteInList(trSet)})`,
    QUERY_ROW_LIMIT
  )).values ?? []
  const details: TransportHistoryEntry[] = []
  const requestSet = new Set<string>()
  for (const row of e070Rows) {
    const trkorr = cellText(row, 'TRKORR')
    if (trkorr === '') continue
    const parent = cellText(row, 'STRKORR')
    const user = cellText(row, 'AS4USER')
    const date = cellText(row, 'AS4DATE')
    details.push({
      trkorr,
      ...(parent !== '' ? { parentRequest: parent } : {}),
      ...(user !== '' ? { user } : {}),
      ...(date !== '' ? { date } : {})
    })
    requestSet.add(parent !== '' ? parent : trkorr)
  }
  const transports = [...trSet].sort()
  const requests = [...requestSet].sort()
  return { objectType, objectName, transports, details, requests, notes }
}

/**
 * 共同变更频次排行（VSP handleCoChange 的"同请求共现"简化移植）：
 * 目标对象所在传输 → 父请求 + 兄弟任务 → 这些请求内全部对象 → 共现计数。
 */
export async function getCoChange(
  runQuery: TransportHistoryQueryRunner,
  input: GetCoChangeInput
): Promise<GetCoChangeResult> {
  const capability = 'getCoChange'
  const objectType = validateToken(input?.objectType, capability, 'objectType', 4)
  const objectName = validateToken(input?.objectName, capability, 'objectName', 40)
  const topN = Math.min(Math.max(Math.floor(Number(input?.topN ?? 20)) || 20, 1), 50)
  const notes: string[] = [
    'co-change counts are an argument for review, not a verdict (same-request co-occurrence, no multi-hop graph)'
  ]

  // 1. 目标对象的传输（R3TR 精确；LIMU 子对象不参与共现统计——避免放大）
  const e071Rows = (await runQuery(
    `SELECT trkorr FROM e071 WHERE pgmid = 'R3TR' AND object = ${quoteToken(objectType)}`
    + ` AND obj_name = ${quoteToken(objectName)}`,
    QUERY_ROW_LIMIT
  )).values ?? []
  const trSet = new Set<string>()
  for (const row of e071Rows) {
    const tr = cellText(row, 'TRKORR')
    if (tr !== '') trSet.add(tr)
  }
  if (trSet.size === 0) {
    return { objectType, objectName, transportsScanned: 0, requestsCovered: 0, coChanges: [], notes }
  }

  // 2. 传输头：解析父请求（任务是 STRKORR；请求自身无父）
  const e070Rows = (await runQuery(
    `SELECT trkorr, strkorr FROM e070 WHERE trkorr IN (${quoteInList(trSet)})`,
    QUERY_ROW_LIMIT
  )).values ?? []
  const requestSet = new Set<string>()
  for (const row of e070Rows) {
    const parent = cellText(row, 'STRKORR')
    const trkorr = cellText(row, 'TRKORR')
    requestSet.add(parent !== '' ? parent : trkorr)
  }

  // 3. 兄弟任务：父请求下的全部子任务
  const taskRows = (await runQuery(
    `SELECT trkorr FROM e070 WHERE strkorr IN (${quoteInList(requestSet)})`,
    QUERY_ROW_LIMIT
  )).values ?? []
  const scopeSet = new Set<string>(requestSet)
  for (const row of taskRows) {
    const trkorr = cellText(row, 'TRKORR')
    if (trkorr !== '') scopeSet.add(trkorr)
  }

  // 4. 请求范围内全部对象 → 共现计数（排除目标自身）
  const scopeRows = (await runQuery(
    `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN (${quoteInList(scopeSet)})`,
    QUERY_ROW_LIMIT
  )).values ?? []
  const seenInTransport = new Map<string, Set<string>>()
  for (const row of scopeRows) {
    const trkorr = cellText(row, 'TRKORR')
    const pgmid = cellText(row, 'PGMID')
    const object = cellText(row, 'OBJECT')
    const objName = cellText(row, 'OBJ_NAME')
    if (trkorr === '' || objName === '') continue
    const target = pgmid === 'R3TR' && object === objectType && objName === objectName
    if (target) continue
    const key = `${pgmid}|${object}|${objName}`
    if (!seenInTransport.has(key)) seenInTransport.set(key, new Set())
    seenInTransport.get(key)!.add(trkorr)
  }
  const coChanges: CoChangeEntry[] = [...seenInTransport.entries()]
    .map(([key, transports]) => {
      const [pgmid, object, objName] = key.split('|')
      return { pgmid, object, objName, count: transports.size }
    })
    .sort((left, right) => right.count - left.count || left.objName.localeCompare(right.objName))
    .slice(0, topN)

  return {
    objectType,
    objectName,
    transportsScanned: trSet.size,
    requestsCovered: requestSet.size,
    coChanges,
    notes
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface TransportHistoryClient {
  getCrHistory(input: GetCrHistoryInput): Promise<GetCrHistoryResult>
  getCoChange(input: GetCoChangeInput): Promise<GetCoChangeResult>
}

/** 把 runQuery 通道绑定成处理器可注入的窄客户端（decode 固定 true；不重试）。 */
export function createTransportHistoryClient(client: {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}): TransportHistoryClient {
  const runner: TransportHistoryQueryRunner = async (sql, rowLimit) =>
    (await client.runQuery(sql, rowLimit, true)) ?? { values: [] }
  return {
    getCrHistory: input => getCrHistory(runner, input),
    getCoChange: input => getCoChange(runner, input)
  }
}
