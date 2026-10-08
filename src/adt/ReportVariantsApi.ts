/**
 * 报表变体读取 API（矩阵行 report.variants 收编）。
 *
 * 与 VSP 的差异（有意增强）：VSP getVariants 走 ZADT_VSP 桥（只回 name+protected）；
 * 本实现走纯 ADT 只读 SQL（VARID 变体目录 + VARIT 按语言文本），无需 helper、
 * 任意 profile 可用，且比 VSP 多返回文本与保护标记。
 *
 * 只读（SELECT）；报表名 token 校验零查询拒绝；引号转义纵深防御。
 */
import type { FmTestDataQueryRunner } from './FmTestDataApi.js'

/** 一条报表变体（VARID 目录行 + VARIT 文本）。 */
export interface ReportVariant {
  name: string
  /** 保护变体（只有创建者/授权人可改）。 */
  protected: boolean
  /** 变体描述（VARIT.VTEXT；按语言合并——优先 EN，否则首条）。 */
  text?: string
}

export interface GetReportVariantsResult {
  report: string
  variants: ReportVariant[]
  notes: string[]
}

/** 报表名 token 校验（A-Z 0-9 _ / = $，≤40——TRDIR-NAME 命名界）。 */
export function validateReportName(value: unknown, capability: string): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > 40 || !/^[A-Z0-9_/=$]+$/.test(token)) {
    throw new Error(`${capability}: report "${String(value ?? '')}" is invalid (A-Z 0-9 _ / = $, at most 40 characters).`)
  }
  return token
}

/** 单元格容错读取。 */
function cellText(row: Record<string, unknown>, columnName: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase() === columnName)
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : String(value).trim()
}

/**
 * 列出一个报表的全部变体（VARID 目录，按变体名升序；VARIT 文本合并，
 * 优先英文）。无变体返回空清单——这是有效回答而非错误。
 */
export async function getReportVariants(
  runQuery: FmTestDataQueryRunner,
  input: { report: string }
): Promise<GetReportVariantsResult> {
  const capability = 'getReportVariants'
  const report = validateReportName(input?.report, capability)
  const notes: string[] = []
  const quoted = `'${report.replace(/'/g, "''")}'`

  let dirRows: Record<string, unknown>[]
  try {
    dirRows = (await runQuery(
      `SELECT report, variant, protected FROM varid WHERE report = ${quoted} ORDER BY variant`,
      500
    )).values ?? []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${capability}: reading VARID for ${report}: ${message.slice(0, 160)}`)
  }

  // 文本按语言合并（VARIT：REPORT/LANGU/VARIANT/VTEXT）；优先英文，否则首条
  const texts = new Map<string, string>()
  try {
    const textRows = (await runQuery(
      `SELECT langu, variant, vtext FROM varit WHERE report = ${quoted}`,
      1000
    )).values ?? []
    for (const row of textRows) {
      const variant = cellText(row, 'VARIANT')
      const text = cellText(row, 'VTEXT')
      if (!variant || !text) continue
      const sprsl = cellText(row, 'LANGU').toUpperCase()
      const existing = texts.get(variant)
      if (existing === undefined || (sprsl === 'E' && existing !== undefined)) {
        texts.set(variant, text)
      }
    }
  } catch (error) {
    // 文本通道失败不拖垮目录主语义：记 notes 降级
    const message = error instanceof Error ? error.message : String(error)
    notes.push(`VARIT text lookup failed and was skipped: ${message.slice(0, 120)}`)
  }

  const variants: ReportVariant[] = dirRows.map(row => {
    const name = cellText(row, 'VARIANT')
    const protectedFlag = cellText(row, 'PROTECTED').toUpperCase() === 'X'
    const text = texts.get(name)
    return {
      name,
      protected: protectedFlag,
      ...(text !== undefined ? { text } : {})
    }
  })

  return { report, variants, notes }
}

/** 处理器注入用的窄客户端接口。 */
export interface ReportVariantsClient {
  getReportVariants(input: { report: string }): Promise<GetReportVariantsResult>
}

/** 把 runQuery 通道绑定成窄客户端（decode=true——VARIT 文本列受益于解码）。 */
export function createReportVariantsClient(client: {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}): ReportVariantsClient {
  const runner: FmTestDataQueryRunner = async (sql, rowLimit) =>
    (await client.runQuery(sql, rowLimit, true)) ?? { values: [] }
  return {
    getReportVariants: input => getReportVariants(runner, input)
  }
}
