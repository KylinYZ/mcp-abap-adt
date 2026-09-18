import { normalizeRepositoryName } from './CrossReferenceApi.js'
import { sapInternalLanguageKey } from './KnowledgeQueriesApi.js'

/**
 * ============================================================================
 * 事务码元数据只读 API（关闭能力矩阵缺口 read.transaction）
 * ============================================================================
 *
 * 回答"这个事务码对应哪个程序、描述是什么"。对齐 VSP vibing-steampunk
 * pkg/adt/client.go GetTransaction（L1384-1412）的任务语义：name/description/
 * program 三要素。
 *
 * 通道差异（重要，真机实测 2026-09-17）：VSP 走 ADT vit/wb 端点
 * /sap/bc/adt/vit/wb/object_type/TRAN/object_name/<tcode>，专用 DEV（7.58）
 * 返回 "No URI-Mapping defined for URI .../object_name/SE"——该系统没有
 * TRAN 的 vit 映射（截断形态的回显也是端点缺陷的一部分）。本实现改走
 * 经典表 TSTC（事务码 → 程序）+ TSTCT（多语言描述）的自由 SQL，与
 * spool-jobs/callees 同通道，在目标系统实际可用。
 *
 * 业务规则：
 *   - 全部只读 SELECT；无锁无传输无写入。
 *   - 事务码白名单：1-20 位大写字母数字（normalizeRepositoryName 同口径）。
 *   - 描述语言：TSTCT.SPRSL，可选覆盖（默认 EN）；目标语言无翻译时描述为空
 *     而非回退主语言（与数据元素标签的 ADT 行为不同，如实透出）。
 */

/** getTransaction 的返回（对齐 VSP Transaction：name/description/program）。 */
export interface GetTransactionResult {
  /** 事务码（大写）。 */
  transaction: string
  /** 事务描述（TSTCT.TTEXT；目标语言无翻译或描述通道受限时缺失）。 */
  description?: string
  /** 承载程序（TSTC.PGMNA；报表/对话框事务才有）。 */
  program?: string
  /** 描述语言（显式传入则回显大写）。 */
  language?: string
  /** 描述通道受限等边界说明（如 TSTCT datapreview 受限）。 */
  note?: string
}

/** 自由 SQL 执行通道（与 CrossReferenceApi.AdtFreestyleQueryCapability 同构）。 */
export interface TransactionQueryCapability {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}

/** 单元格容错字符串化。 */
function cell(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 事务码规范化：1-20 位大写字母数字（TSTC.TCODE 为 CHAR(20)）。 */
export function normalizeTransactionCode(value: unknown, capability: string): string {
  const tcode = String(value ?? '').trim().toUpperCase()
  if (!tcode || tcode.length > 20 || !/^[A-Z0-9_/]+$/.test(tcode)) {
    throw new Error(
      `${capability}: "${String(value ?? '')}" is not a transaction code ` +
      `(allowed: A-Z 0-9 _, at most 20 characters).`
    )
  }
  return tcode
}

/**
 * 读取事务码元数据：TSTC 取程序，TSTCT 按语言取描述（两条 SELECT，串行；
 * TSTCT 无翻译行为空——该语言确实没有描述）。
 */
export async function getTransaction(
  runQuery: (sql: string, rowLimit?: number) => Promise<{ values?: Record<string, unknown>[] }>,
  input: { transaction: string; language?: string }
): Promise<GetTransactionResult> {
  const capability = 'getTransaction'
  const tcode = normalizeTransactionCode(input?.transaction, capability)
  const language = String(input?.language ?? 'EN').trim().toUpperCase()
  if (!/^[A-Z]{1,2}$/.test(language)) {
    throw new Error(`${capability}: "${language}" is not a valid SAP language key (1-2 letters).`)
  }

  // TSTC：事务码 → 程序（VSP 的 program 字段同源语义）
  const tcodeLiteral = `'${tcode.replace(/'/g, "''")}'`
  const tcodeRows = (await runQuery(`SELECT tcode, pgmna FROM tstc WHERE tcode = ${tcodeLiteral}`, 1)).values ?? []
  if (tcodeRows.length === 0) {
    throw new Error(`${capability}: transaction ${tcode} does not exist in TSTC.`)
  }
  const program = cell(tcodeRows[0], 'PGMNA')

  // TSTCT：多语言描述（独立查询：TSTC 存在但无该语言描述时 description 缺失）。
  // 关键修正（2026-09-18）：TSTCT.SPRSL 是 1 位 SAP 内部语言键——2 位 ISO
  // 字面量（'EN'）超出列宽会直接 400（真机实测；第十七轮记录的"TSTCT
  // datapreview 受限"实为此因 + 会话查询预算耗尽的叠加假象）。查询前经
  // sapInternalLanguageKey 转内部键（EN→E、DE→D、ZH→1）。查询失败仍容错
  // 为"描述缺失 + note"，不让它拖垮 program 主语义。
  let description: string | undefined
  let note: string | undefined
  try {
    const sprsl = sapInternalLanguageKey(language, capability)
    const textRows = (await runQuery(
      `SELECT ttext FROM tstct WHERE sprsl = '${sprsl}' AND tcode = ${tcodeLiteral}`,
      1
    )).values ?? []
    description = textRows.length > 0 ? cell(textRows[0], 'TTEXT') || undefined : undefined
  } catch {
    note = 'description unavailable: reading TSTCT failed on this system (datapreview restriction)'
  }

  return {
    transaction: tcode,
    ...(description ? { description } : {}),
    ...(program ? { program } : {}),
    ...(input?.language !== undefined ? { language } : {}),
    ...(note ? { note } : {})
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface TransactionReadClient {
  getTransaction(input: { transaction: string; language?: string }): Promise<GetTransactionResult>
}

/** 把 runQuery 通道绑定成处理器可注入的窄客户端（decode=true 由绑定固定）。 */
export function createTransactionReadClient(client: TransactionQueryCapability): TransactionReadClient {
  return {
    getTransaction: input => getTransaction(
      async (sql, rowLimit) => (await client.runQuery(sql, rowLimit, true)) ?? { values: [] },
      input
    )
  }
}
