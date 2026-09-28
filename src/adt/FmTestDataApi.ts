/**
 * 函数模块测试数据目录 API（矩阵行 diagnostics.knowledge-queries 的
 * fm_test_data 目录层子集；VSP 来源 pkg/adt/fmtest.go 的 EUFUNC 读取口径）。
 *
 * Function Builder 的测试数据存于 EUFUNC 集群表，key 为 RELID('FL')/函数名/
 * 集编号（NUMMER='999' 是目录行 TE_DATADIR/FDESC_COPY 所在，其余编号是保存
 * 的测试集；同编号多行是 EXPORT 续块 SRTF2）。本 API 只读 **key 与元数据列**
 * （GRUPPE/NUMMER/AUTOR/DATUM/ZEIT）产出"保存了哪些测试集"的目录视图；
 * payload（CLUSTD，EXPORT 数据集群）**不解析**——内容级 inputs/outputs 需要
 * S/2 集群二进制解码器（VSP pkg/datacluster，约 2.2k 行），属独立工程轮。
 *
 * 真机形态（2026-09-25，sap-demo datapreview 取证）：表可读、列名大写、
 * NUMMER 存在空串行（按原样报告）、标准 FM（如 C162_SPEC_GET_BY_ID）有
 * 999 目录行与数据行。
 */
import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js'

/** 一条已保存测试集的目录条目（不含 payload 内容）。 */
export interface FmTestDataSetEntry {
  /** 集编号（三位字符；'999' 是 Function Builder 目录行，空串按原样报告）。 */
  number: string
  author?: string
  date?: string
  time?: string
}

/** getFmTestDataSets 的返回。 */
export interface GetFmTestDataSetsResult {
  function: string
  /** 所属函数组（GRUPPE 列）。 */
  group?: string
  /** 已保存测试集条目（不含 999 目录行；同编号续块去重）。 */
  sets: FmTestDataSetEntry[]
  /** 目录行（NUMMER='999'）的元数据；缺失时为 undefined（标题/接口快照不可得）。 */
  directory?: FmTestDataSetEntry
  notes: string[]
}

/** 窄 SQL 通道（行数上限由调用逐次给定；不重试——datapreview 会话预算有限）。 */
export type FmTestDataQueryRunner = (sqlQuery: string, rowLimit: number) => Promise<{ values?: Record<string, unknown>[] }>

const QUERY_ROW_LIMIT = 500

/** FM 名 token 校验（大写 A-Z 0-9 _，最长 30——与 Function Builder 命名界一致）。 */
function validateFunctionName(value: unknown, capability: string): string {
  const token = String(value ?? '').trim().toUpperCase()
  if (!token || token.length > 30 || !/^[A-Z0-9_]+$/.test(token)) {
    throw new Error(`${capability}: function "${String(value ?? '')}" is invalid (A-Z 0-9 _, at most 30 characters).`)
  }
  return token
}

/** 单元格容错读取（datapreview 列名大小写差异不敏感；undefined/null 按空串）。 */
function cellText(row: Record<string, unknown>, columnName: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase() === columnName)
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim().toUpperCase() : String(value).trim()
}

/**
 * 列出函数模块已保存的测试数据集目录（VSP fm_test_data 的目录层子集）：
 * 只读 EUFUNC key 与元数据列；payload 内容解码不在本层。
 */
export async function getFmTestDataSets(
  runQuery: FmTestDataQueryRunner,
  input: { function: string }
): Promise<GetFmTestDataSetsResult> {
  const capability = 'getFmTestDataSets'
  const fmName = validateFunctionName(input?.function, capability)
  const notes: string[] = [
    'Directory view only: EUFUNC.CLUSTD payloads are EXPORT data clusters; decoding inputs/outputs requires the S/2 cluster decoder, which is not implemented here.'
  ]

  let rows: Record<string, unknown>[]
  try {
    rows = (await runQuery(
      `SELECT name, gruppe, nummer, autor, datum, zeit FROM eufunc`
      + ` WHERE relid = 'FL' AND name = '${fmName.replace(/'/g, "''")}'`,
      QUERY_ROW_LIMIT
    )).values ?? []
  } catch (error) {
    // datapreview 通道异常不拖垮主语义：记 notes 返回空目录（无失败重试——预算宝贵）
    const message = error instanceof Error ? error.message : String(error)
    notes.push(`EUFUNC lookup failed and was skipped: ${message.slice(0, 160)}`)
    return { function: fmName, sets: [], notes }
  }

  let group: string | undefined
  let directory: FmTestDataSetEntry | undefined
  const byNumber = new Map<string, FmTestDataSetEntry>()
  for (const row of rows) {
    const groupName = cellText(row, 'GRUPPE')
    if (groupName && !group) group = groupName
    const number = cellText(row, 'NUMMER')
    const entry: FmTestDataSetEntry = {
      number,
      ...(cellText(row, 'AUTOR') ? { author: cellText(row, 'AUTOR') } : {}),
      ...(cellText(row, 'DATUM') ? { date: cellText(row, 'DATUM') } : {}),
      ...(cellText(row, 'ZEIT') ? { time: cellText(row, 'ZEIT') } : {})
    }
    if (number === '999') {
      // 目录行（TE_DATADIR/FDESC_COPY 所在集群）；续块覆盖时保留首行元数据
      if (!directory) directory = entry
      continue
    }
    if (!byNumber.has(number)) byNumber.set(number, entry)
  }
  if (rows.length >= QUERY_ROW_LIMIT) {
    notes.push(`EUFUNC result hit the ${QUERY_ROW_LIMIT}-row cap; the listing may be incomplete.`)
  }
  if (!directory) {
    notes.push('No directory row (NUMMER=999): titles and the saved interface snapshot are not available without it.')
  }
  const sets = [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number))
  return {
    function: fmName,
    ...(group ? { group } : {}),
    sets,
    ...(directory ? { directory } : {}),
    notes
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface FmTestDataClient {
  getFmTestDataSets(input: { function: string }): Promise<GetFmTestDataSetsResult>
}

/** 把 runQuery 通道绑定成处理器可注入的窄客户端（不重试）。
 *  decode 固定 false：真机取证（2026-09-28，fm-test-data-clustd-real-dev-verified）
 *  证实 datapreview 对 DATS 列（EUFUNC.DATUM，type='D'）在 decode=true 时转成
 *  JS Date，date 元数据会退化成英文日期串；decode=false 下全部列原样字符串
 *  （INT 列带尾随空格，cellText 的 trim 已吸收），与本 API 的 cellText 语义一致。 */
export function createFmTestDataClient(client: {
  runQuery(sqlQuery: string, rowNumber?: number, decode?: boolean): Promise<{ values?: Record<string, unknown>[] }>
}): FmTestDataClient {
  const runner: FmTestDataQueryRunner = async (sql, rowLimit) =>
    (await client.runQuery(sql, rowLimit, false)) ?? { values: [] }
  return {
    getFmTestDataSets: input => getFmTestDataSets(runner, input)
  }
}
