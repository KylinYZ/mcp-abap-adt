import { normalizeRepositoryName } from './CrossReferenceApi.js'

/**
 * ============================================================================
 * 知识查询只读 API（关闭能力矩阵缺口 diagnostics.knowledge-queries 的
 * documentation + img_search 子集）
 * ============================================================================
 *
 * 两个只读工具，数据源为 SAP 文档与 IMG 自定义活动表（自由 SQL，与
 * spool-jobs/callees 同通道）：
 *
 *   1. getAbapDocumentation ← VSP handlers_docs.go handleDocumentation +
 *      pkg/adt/docs.go docLines（L56-76）/ DocumentationIndex（L90-105）：
 *      - 正文模式：DOKTL 按 id/object/langu 取最新 dokversion 的
 *        line/dokformat/doktext 行序列（SAP 文档一行一条记录）；
 *      - 索引模式（mode='index'）：DOKIL 列出该对象全部 id/langu/version。
 *   2. searchImgActivities ← handleIMGSearch + pkg/adt/docs.go IMGSearch
 *      （L160-200）的简化移植：CUS_IMGACT 活动文本（LIKE %text%）+（可选）
 *      TNODEIMGT 文件夹文本；与 VSP 的差异为不递归 IMG 路径、不用 JOIN
 *      （tcode 经 CUS_IMGACH 单表二次查询补齐）。
 *
 * 已知边界（notes 如实返回）：
 *   - fm_test_data（函数模块测试数据）、cluster_read（簇数据）、img_activity
 *     的完整详情（IMG 路径递归）不在本子集内。
 *
 * 业务规则：
 *   - 全部只读 SELECT；文本入参（docObject/docClass/text）经引号转义与
 *     控制字符拒绝后进入 LIKE/等值字面量（注入防线）。
 *   - 正文行数上限（maxLines）默认 500，超出截断并标注。
 */

/** 文档类（DOKIL.ID/DOKTL.ID）：SAP 文档类的常用子集。 */
export const DOCUMENTATION_CLASSES = [
  'DE', 'RE', 'FU', 'CL', 'TB', 'NA', 'TX', 'HY', 'CO', 'PD'
] as const

/** getAbapDocumentation 的输入。 */
export interface GetAbapDocumentationInput {
  /** 文档类（DOKIL.ID），如 DE（数据元素文档）、TX（一般文本）、RE（报表文档）。 */
  docClass: string
  /** 文档对象名（如数据元素名/程序名）。 */
  docObject: string
  /** 文档语言（1-2 位字母，默认 EN）。 */
  language?: string
  /** index 模式：只返回该对象全部文档条目的索引（跨类/跨语言）。 */
  mode?: 'content' | 'index'
  /** 正文行数上限：默认 500。 */
  maxLines?: number
}

/** 一行文档正文。 */
export interface DocumentationLine {
  /** 行号。 */
  line: number
  /** SAP 文档格式码（U1=标题、AS=段落、空=普通文本等）。 */
  format: string
  /** 行文本。 */
  text: string
}

/** getAbapDocumentation 的返回。 */
export interface GetAbapDocumentationResult {
  docClass: string
  docObject: string
  language: string
  mode: 'content' | 'index'
  /** 正文模式：最新版本号。 */
  version?: number
  /** 正文模式：文档行。 */
  lines?: DocumentationLine[]
  /** 正文被截断时的说明。 */
  truncated?: boolean
  /** 索引模式：条目清单。 */
  index?: Array<{ docClass: string; language: string; version: number; lines: number }>
  notes: string[]
}

/** searchImgActivities 的输入。 */
export interface SearchImgActivitiesInput {
  /** 检索文本（* 通配；无通配时自动包成 %text%）。 */
  text: string
  /** 语言（1-2 位字母，默认 EN）。 */
  language?: string
  /** 返回条数上限：默认 40，上限 100。 */
  limit?: number
}

/** 一条 IMG 检索结果。 */
export interface ImgSearchNode {
  /** activity=自定义活动（可带 tcode）；folder=IMG 文件夹节点。 */
  type: 'activity' | 'folder'
  text: string
  /** 活动的技术名（type=activity）。 */
  activity?: string
  /** 关联事务码（有则附）。 */
  tcode?: string
  /** IMG 节点 ID（type=folder）。 */
  nodeId?: string
}

/** searchImgActivities 的返回。 */
export interface SearchImgActivitiesResult {
  text: string
  language: string
  nodes: ImgSearchNode[]
  count: number
  notes: string[]
}

/** 自由 SQL 执行通道（行数上限由 API 逐次给定）。 */
export type KnowledgeQueryRunner = (
  sqlQuery: string,
  rowLimit: number
) => Promise<{ values?: Record<string, unknown>[] }>

/** 文本字面量引用：控制字符拒绝 + 单引号转义（注入防线）。 */
function quoteText(value: string, capability: string): string {
  const raw = String(value ?? '')
  if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) {
    throw new Error(`${capability}: text contains control characters and is not put into a query.`)
  }
  return `'${raw.replace(/'/g, "''")}'`
}

/** 文档类/对象名/语言键校验。 */
function validateToken(value: unknown, capability: string, label: string, max: number): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > max || !/^[A-Z0-9_/]+$/.test(token)) {
    throw new Error(`${capability}: ${label} "${String(value ?? '')}" is invalid (A-Z 0-9 _ /, at most ${max} characters).`)
  }
  return token
}

function validateLanguage(value: unknown, capability: string): string {
  const lang = String(value ?? 'EN').trim().toUpperCase()
  if (!/^[A-Z]{1,2}$/.test(lang)) {
    throw new Error(`${capability}: language "${String(value ?? '')}" is not a valid SAP language key (1-2 letters).`)
  }
  return lang
}

/** 单元格容错读取（保留右端空格差异不敏感；文档行首空格由 dokformat 表达）。 */
function cellText(row: Record<string, unknown>, suffix: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase().endsWith(suffix.toUpperCase()))
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return String(value)
}

function cellInt(row: Record<string, unknown>, suffix: string): number {
  const n = parseInt(cellText(row, suffix), 10)
  return Number.isFinite(n) ? n : 0
}

/** maxLines 边界收敛：默认 500，上限 2000（VSP 单次查询上限 20000 行的防御性收敛）。 */
function normalizeMaxLines(value: unknown): number {
  const requested = Number(value ?? 500)
  const finite = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 500
  return Math.min(finite, 2000)
}

/**
 * ISO 语言键 → SAP 1 位内部语言键（SPRAS）。
 * DOKTL.LANGU/CUS_IMGACT.SPRAS/TNODEIMGT.SPRAS 都是 1 位内部码（DE→D、EN→E、
 * ZH→1），直接用 2 位 ISO 查询永远查空。映射表逐项对齐 VSP spras
 * （applog_messages.go L200-216）；1 位输入原样通过；未知 2 位码回退 E
 * （与 VSP 相同的兜底，note/结果中回显转换后的键）。
 */
export function sapInternalLanguageKey(value: unknown, capability: string): string {
  const lang = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z]{1,2}$/.test(lang)) {
    throw new Error(`${capability}: language "${String(value ?? '')}" is not a valid SAP language key (1-2 letters).`)
  }
  if (lang.length === 1) return lang
  const table: Record<string, string> = {
    EN: 'E', DE: 'D', FR: 'F', ES: 'S', IT: 'I', PT: 'P', NL: 'N', RU: 'R',
    JA: 'J', ZH: '1', ZF: 'M', KO: '3', PL: 'L', CS: 'C', SK: 'Q', TR: 'T',
    SV: 'V', DA: 'K', FI: 'U', NO: 'O', HU: 'H', EL: 'G', UK: '8', AR: 'A',
    HE: 'B', TH: '2', RO: '4', HR: '6', SL: '5', BG: 'W', LT: 'X', LV: 'Y',
    ET: '9', SR: '0', CA: 'c', ID: 'i', MS: '7', VI: 'v', KK: 'k', AF: 'a'
  }
  return table[lang] ?? 'E'
}

/** limit 边界收敛：默认 40，上限 100（对齐 VSP IMGSearch L162-164）。 */
function normalizeLimit(value: unknown): number {
  const requested = Number(value ?? 40)
  const finite = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 40
  return Math.min(finite, 100)
}

/**
 * 读取 ABAP 文档（正文或索引）。
 * 正文：先查最新 dokversion，再读该版本行序列；行数超 maxLines 截断标注。
 */
export async function getAbapDocumentation(
  runQuery: KnowledgeQueryRunner,
  input: GetAbapDocumentationInput
): Promise<GetAbapDocumentationResult> {
  const capability = 'getAbapDocumentation'
  const docClass = validateToken(input?.docClass, capability, 'docClass', 4)
  const docObject = validateToken(input?.docObject, capability, 'docObject', 40)
  const language = validateLanguage(input?.language, capability)
  const sapLang = sapInternalLanguageKey(language, capability)
  const mode = input?.mode === 'index' ? 'index' : 'content'
  const maxLines = normalizeMaxLines(input?.maxLines)
  const notes = [
    'subset: fm_test_data, cluster_read and the full img_activity path recursion are not part of this tool'
  ]
  const objectLiteral = quoteText(docObject, capability)
  const sapLangLiteral = quoteText(sapLang, capability)
  const languageLiteral = quoteText(language, capability)

  if (mode === 'index') {
    // 索引模式：DOKIL 列出该对象全部文档条目（VSP DocumentationIndex L90-105）
    const rows = (await runQuery(
      `SELECT id, object, langu, version, txtlines FROM dokil WHERE object = ${objectLiteral} ORDER BY id, langu`,
      200
    )).values ?? []
    const index = rows.map(row => ({
      docClass: cellText(row, 'ID'),
      language: cellText(row, 'LANGU'),
      version: cellInt(row, 'VERSION'),
      lines: cellInt(row, 'TXTLINES')
    }))
    return { docClass, docObject, language, mode, index, notes }
  }

  // 正文模式：最新版本（VSP docLines L57 的 ORDER BY dokversion DESCENDING limit 1）
  const versionRows = (await runQuery(
    `SELECT dokversion FROM doktl WHERE id = ${quoteText(docClass, capability)}`
    + ` AND object = ${objectLiteral} AND langu = ${sapLangLiteral} ORDER BY dokversion DESCENDING`,
    1
  )).values ?? []
  if (versionRows.length === 0) {
    throw new Error(
      `${capability}: no ${docClass} documentation for ${docObject} in language ${language}.`
    )
  }
  const version = cellInt(versionRows[0], 'DOKVERSION')
  const versionLiteral = quoteText(String(version).padStart(4, '0'), capability)

  // 正文行序列（VSP docLines L62-67 的 SELECT line, dokformat, doktext ... ORDER BY line）
  const rows = (await runQuery(
    `SELECT line, dokformat, doktext FROM doktl WHERE id = ${quoteText(docClass, capability)}`
    + ` AND object = ${objectLiteral} AND langu = ${sapLangLiteral} AND dokversion = ${versionLiteral} ORDER BY line`,
    maxLines + 1
  )).values ?? []

  const truncated = rows.length > maxLines
  const lines: DocumentationLine[] = rows.slice(0, maxLines).map(row => ({
    line: cellInt(row, 'LINE'),
    format: cellText(row, 'DOKFORMAT'),
    text: cellText(row, 'DOKTEXT').replace(/\s+$/, '')
  }))
  if (truncated) {
    notes.push(`documentation truncated to ${maxLines} lines (the full document is longer)`)
  }
  return {
    docClass,
    docObject,
    language,
    mode,
    version,
    lines,
    ...(truncated ? { truncated } : {}),
    notes
  }
}

/**
 * 检索 IMG 自定义活动与文件夹节点（VSP IMGSearch L160-200 的简化移植：
 * 两次单表查询，无 JOIN、无路径递归）。
 */
export async function searchImgActivities(
  runQuery: KnowledgeQueryRunner,
  input: SearchImgActivitiesInput
): Promise<SearchImgActivitiesResult> {
  const capability = 'searchImgActivities'
  const text = String(input?.text ?? '').trim()
  if (!text) {
    throw new Error(`${capability}: text is required (a word or * pattern from the node's title).`)
  }
  const language = validateLanguage(input?.language, capability)
  const sapLang = sapInternalLanguageKey(language, capability)
  const limit = normalizeLimit(input?.limit)
  // VSP docs.go L165-168：* 转 %，无通配自动包 %text%
  let like = text.replace(/\*/g, '%')
  if (!like.includes('%')) like = `%${like}%`
  const likeLiteral = quoteText(like, capability)
  const sapLangLiteral = quoteText(sapLang, capability)
  const notes: string[] = [
    'subset: img_activity full detail (path recursion) is not part of this tool'
  ]
  const nodes: ImgSearchNode[] = []

  // 活动文本（CUS_IMGACT；VSP docs.go L171 用 JOIN 取 tcode，这里拆成第二次
  // 单表查询以规避 datapreview 对 JOIN 的兼容风险）
  const actRows = (await runQuery(
    `SELECT activity, text FROM cus_imgact WHERE spras = ${sapLangLiteral}`
    + ` AND text LIKE ${likeLiteral} ORDER BY text`,
    limit
  )).values ?? []
  const activities = actRows
    .map(row => cellText(row, 'ACTIVITY'))
    .filter(a => a !== '')
    .slice(0, limit)
  let tcodeByActivity = new Map<string, string>()
  if (activities.length > 0) {
    const literals = activities.map(a => quoteText(a, capability)).join(', ')
    try {
      // CUS_IMGACH 数据读取在部分系统受 datapreview 限制（专用 DEV 实测
      // Internal server error）：失败容错为"无 tcode"，不影响活动检索主语义。
      const tcodeRows = (await runQuery(
        `SELECT activity, tcode FROM cus_imgach WHERE spras = ${sapLangLiteral}`
        + ` AND activity IN (${literals})`,
        activities.length
      )).values ?? []
      for (const row of tcodeRows ?? []) {
        const activity = cellText(row, 'ACTIVITY')
        const tcode = cellText(row, 'TCODE')
        if (activity && tcode) tcodeByActivity.set(activity, tcode)
      }
    } catch {
      notes.push('transaction codes unavailable: reading CUS_IMGACH failed on this system (datapreview restriction)')
    }
  }
  for (const row of actRows) {
    const activity = cellText(row, 'ACTIVITY')
    if (!activity) continue
    const tcode = tcodeByActivity.get(activity)
    nodes.push({
      type: 'activity',
      text: cellText(row, 'TEXT'),
      activity,
      ...(tcode ? { tcode } : {})
    })
  }

  // 文件夹文本（TNODEIMGT；VSP docs.go L192-200，仅在还有余量时补齐）
  if (nodes.length < limit) {
    const folderRows = (await runQuery(
      `SELECT node_id, text FROM tnodeimgt WHERE spras = ${sapLangLiteral}`
      + ` AND text LIKE ${likeLiteral} ORDER BY text`,
      limit - nodes.length
    )).values ?? []
    for (const row of folderRows) {
      const nodeId = cellText(row, 'NODE_ID')
      if (!nodeId) continue
      nodes.push({ type: 'folder', text: cellText(row, 'TEXT'), nodeId })
    }
  }

  return { text, language, nodes, count: nodes.length, notes }
}

/** 处理器注入用的窄客户端接口。 */
export interface KnowledgeQueriesClient {
  getAbapDocumentation(input: GetAbapDocumentationInput): Promise<GetAbapDocumentationResult>
  searchImgActivities(input: SearchImgActivitiesInput): Promise<SearchImgActivitiesResult>
}

/** 把 runQuery 通道绑定成处理器可注入的窄客户端（decode 由绑定固定为 true）。 */
export function createKnowledgeQueriesClient(client: {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}): KnowledgeQueriesClient {
  const runner: KnowledgeQueryRunner = async (sql, rowLimit) =>
    (await client.runQuery(sql, rowLimit, true)) ?? { values: [] }
  return {
    getAbapDocumentation: input => getAbapDocumentation(runner, input),
    searchImgActivities: input => searchImgActivities(runner, input)
  }
}
