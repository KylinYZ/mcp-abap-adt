/**
 * 函数模块测试数据 API（矩阵行 diagnostics.knowledge-queries 的 fm_test_data
 * 子集；VSP 来源 pkg/adt/fmtest.go 的 EUFUNC 读取口径）。
 *
 * Function Builder 的测试数据存于 EUFUNC 集群表，key 为 RELID('FL')/函数名/
 * 集编号（NUMMER='999' 是目录行 TE_DATADIR/FDESC_COPY 所在，其余编号是保存
 * 的测试集；同编号多行是 EXPORT 续块 SRTF2）。
 *
 * 两层能力：
 * - 目录层（默认）：只读 key 与元数据列（GRUPPE/NUMMER/AUTOR/DATUM/ZEIT），
 *   产出"保存了哪些测试集"的目录视图；
 * - 内容层（includePayload=true，2026-10-07 工程轮）：追加查询 SRTF2/CLUSTR/
 *   CLUSTD 三列，按集编号分组续块 → ClusterDataDecoder（VSP pkg/datacluster
 *   全语义移植）解码 EXPORT 集群 → 按对象名归类 %_I<param>=inputs、
 *   %_V<param>=outputs、TIME1/V_RC/VEXCEPTION、其余 others。EXPORT 不含
 *   DDIC 字段名——inputs/outputs 的键是参数名，值内字段按位置编号（内核写
 *   的是类型不是 DDIC），知道结构的调用方自行覆盖名字（VSP 同款边界）。
 *
 * 真机形态（2026-09-25，sap-demo datapreview 取证）：表可读、列名大写、
 * NUMMER 存在空串行（按原样报告）、CLUSTD 为连续 hex 文本（decode=false）。
 */
import { joinFragments, decodeClusterHex, parseCluster, type ClusterObject } from './ClusterDataDecoder.js'

/** 一条已保存测试集的条目。includePayload=false 时只有目录字段。 */
export interface FmTestDataSetEntry {
  /** 集编号（三位字符；'999' 是 Function Builder 目录行，空串按原样报告）。 */
  number: string
  author?: string
  date?: string
  time?: string
  title?: string
  /** includePayload=true：%_I<param> 对象（导入参数）按参数名归一。 */
  inputs?: Record<string, unknown>
  /** includePayload=true：%_V<param> 对象（回传值）按参数名归一。 */
  outputs?: Record<string, unknown>
  /** includePayload=true：其余对象（TIME1/V_RC/VEXCEPTION 与新版本新增）。 */
  others?: Record<string, unknown>
  /** TIME1 对象：运行耗时（微秒）。 */
  runtime?: string
  /** V_RC 对象：返回码。 */
  rc?: string
  /** VEXCEPTION 对象：异常名。 */
  exception?: string
}

/** FDESC_COPY 的一行：保存时刻的接口参数快照。 */
export interface FmTestParam {
  name: string
  ddic?: string
  type?: string
  length?: string
  kind?: string
}

/** getFmTestDataSets 的返回。 */
export interface GetFmTestDataSetsResult {
  function: string
  /** 所属函数组（GRUPPE 列）。 */
  group?: string
  /** 已保存测试集条目（不含 999 目录行；同编号续块去重）。 */
  sets: FmTestDataSetEntry[]
  /** 目录行（NUMMER='999'）的元数据；缺失时为 undefined。 */
  directory?: FmTestDataSetEntry
  /** includePayload=true：保存时刻的接口参数快照（FDESC_COPY）。 */
  interface?: FmTestParam[]
  notes: string[]
}

/** 窄 SQL 通道（行数上限由调用逐次给定；不重试——datapreview 会话预算有限）。 */
export type FmTestDataQueryRunner = (sqlQuery: string, rowLimit: number) => Promise<{ values?: Record<string, unknown>[] }>

/** 目录模式行上限（行小；payload 模式另用更大上限——行含 LRAW hex 大格）。 */
const QUERY_ROW_LIMIT = 500
/** payload 模式行上限（datapreview 单查询硬上限 1000；截断记 notes 不装完整）。 */
const PAYLOAD_ROW_LIMIT = 1000

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

/** 数值列容错读取（SRTF2 等 INT 列真机带尾随空格；非法按 NaN 交由调用方兜底）。 */
function cellNumber(row: Record<string, unknown>, columnName: string): number {
  const raw = cellText(row, columnName)
  return raw === '' ? Number.NaN : Number.parseInt(raw, 10)
}

/**
 * 列出函数模块已保存的测试数据集。默认目录视图；includePayload=true 时解码
 * 各集的 EXPORT 集群（inputs/outputs/接口快照），单集解码失败记 notes 继续
 * （不让一个坏集拖垮目录），绝不静默丢弃也不冒充成功。
 */
export async function getFmTestDataSets(
  runQuery: FmTestDataQueryRunner,
  input: { function: string; includePayload?: boolean }
): Promise<GetFmTestDataSetsResult> {
  const capability = 'getFmTestDataSets'
  const fmName = validateFunctionName(input?.function, capability)
  const includePayload = input?.includePayload === true
  const notes: string[] = includePayload
    ? ['Payload decoding enabled: inputs/outputs keys are parameter names (from object names %_I*/%_V*); fields inside values are numbered by position because EXPORT clusters carry types, not DDIC names. Per-set decode failures are reported in notes.']
    : ['Directory view only: pass includePayload=true to decode EXPORT payloads (inputs/outputs) via the S/2 cluster decoder.']

  const rowLimit = includePayload ? PAYLOAD_ROW_LIMIT : QUERY_ROW_LIMIT
  const columns = includePayload
    ? 'name, gruppe, nummer, autor, datum, zeit, srtf2, clustr, clustd'
    : 'name, gruppe, nummer, autor, datum, zeit'
  let rows: Record<string, unknown>[]
  try {
    rows = (await runQuery(
      `SELECT ${columns} FROM eufunc WHERE relid = 'FL' AND name = '${fmName.replace(/'/g, "''")}'`,
      rowLimit
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
  // payload 模式：按集编号收集续块（SRTF2 序 + CLUSTR 有效长 + CLUSTD hex）
  const fragmentsByNumber = new Map<string, Array<{ srtf2: number; clustr: number; clustd: string }>>()
  for (const row of rows) {
    const groupName = cellText(row, 'GRUPPE')
    if (groupName && !group) group = groupName
    const number = cellText(row, 'NUMMER')
    if (includePayload) {
      const list = fragmentsByNumber.get(number) ?? []
      list.push({
        srtf2: cellNumber(row, 'SRTF2'),
        clustr: cellNumber(row, 'CLUSTR'),
        clustd: typeof row[Object.keys(row).find(k => k.toUpperCase() === 'CLUSTD') ?? ''] === 'string'
          ? String(row[Object.keys(row).find(k => k.toUpperCase() === 'CLUSTD')!])
          : ''
      })
      fragmentsByNumber.set(number, list)
    }
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
  if (rows.length >= rowLimit) {
    notes.push(`EUFUNC result hit the ${rowLimit}-row cap; the listing may be incomplete.`)
  }
  if (!directory) {
    notes.push('No directory row (NUMMER=999): titles and the saved interface snapshot are not available without it.')
  }

  // 内容层：999 目录集群出 titles/interface，其余编号解码为测试集内容
  const interfaceParams: FmTestParam[] = []
  if (includePayload) {
    const titles = new Map<string, { title?: string; date?: string; time?: string }>()
    for (const [number, fragments] of fragmentsByNumber) {
      let cluster
      try {
        const joined = joinFragments(fragments.map(f => ({
          seq: f.srtf2,
          length: f.clustr,
          data: decodeClusterHex(f.clustd)
        })))
        // 对象级容错：部分对象解不动的集群，失败点之前的对象照常呈现
        // （如 999 目录集群的 TE_DATADIR 标题表），失败诊断并入 notes——
        // 部分成功显式可见，绝不冒充完整
        cluster = parseCluster(joined, { tolerant: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`set ${number}: cluster decode failed: ${message.slice(0, 200)}`)
        continue
      }
      for (const pe of cluster.partialErrors) notes.push(`set ${number}: ${pe}`)
      if (number === '999') {
        const dir = cluster.object('TE_DATADIR')
        if (dir) {
          for (const row of dir.rows) {
            if (row.length >= 6) {
              titles.set(String(row[0]).trim(), {
                ...(cellTextDate(row[3]) ? { date: cellTextDate(row[3]) } : {}),
                ...(cellTextDate(row[4]) ? { time: cellTextDate(row[4]) } : {}),
                ...(cellTextDate(row[5]) ? { title: cellTextDate(row[5]) } : {})
              })
            }
          }
        }
        const iface = cluster.object('FDESC_COPY')
        if (iface) {
          for (const row of iface.rows) {
            if (row.length >= 3) {
              const name = String(row[0]).trim()
              if (!name || name === '*') continue
              interfaceParams.push({
                name,
                ...(cellTextDate(row[1]) ? { ddic: cellTextDate(row[1]) } : {}),
                ...(cellTextDate(row[2]) ? { type: cellTextDate(row[2]) } : {}),
                ...(row.length >= 4 && String(row[3]).trim() !== '' ? { length: String(row[3]).trim() } : {}),
                ...(row.length >= 7 && String(row[6]).trim() !== '' ? { kind: String(row[6]).trim() } : {})
              })
            }
          }
        }
        continue
      }
      // 测试集：对象按名归类（VSP fmtest.go 同款语义）
      const set = byNumber.get(number)
      if (!set) continue
      const inputs: Record<string, unknown> = {}
      const outputs: Record<string, unknown> = {}
      const others: Record<string, unknown> = {}
      for (const obj of cluster.objects) {
        const value = clusterObjectValue(obj)
        if (obj.name.startsWith('%_I')) inputs[obj.name.slice(3)] = value
        else if (obj.name.startsWith('%_V')) outputs[obj.name.slice(3)] = value
        else if (obj.name === 'TIME1') set.runtime = String(value) + ' µs'
        else if (obj.name === 'V_RC') set.rc = String(value)
        else if (obj.name === 'VEXCEPTION') set.exception = String(value).trim()
        else others[obj.name] = value
      }
      if (Object.keys(inputs).length) set.inputs = inputs
      if (Object.keys(outputs).length) set.outputs = outputs
      if (Object.keys(others).length) set.others = others
    }
    // 目录集群的 title/date/time 合并进对应测试集条目（目录行可能先于/后于集行处理）
    if (titles.size > 0) {
      for (const set of byNumber.values()) {
        const t = titles.get(set.number.replace(/^0+/, '')) ?? titles.get(set.number)
        if (t) {
          if (t.title) set.title = t.title
          if (t.date && !set.date) set.date = t.date
          if (t.time && !set.time) set.time = t.time
        }
      }
    }
  }

  const sets = [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number))
  return {
    function: fmName,
    ...(group ? { group } : {}),
    sets,
    ...(directory ? { directory } : {}),
    ...(includePayload && interfaceParams.length ? { interface: interfaceParams } : {}),
    notes
  }
}

/** 集群对象值呈现（VSP fmtest.go：表=行数组、单字段=标量、结构=值数组）。 */
function clusterObjectValue(obj: ClusterObject): unknown {
  if (obj.rows.length === 0) return null
  if (obj.kind === 'table') return obj.rows
  if (obj.rows[0]!.length === 1) return obj.rows[0]![0]
  return obj.rows[0]
}

/** TE_DATADIR/FDESC_COPY 的字符列（可能是 string 或 number 形态，归一文本）。 */
function cellTextDate(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return text.replace(/ +$/, '').toUpperCase()
}

/** 处理器注入用的窄客户端接口。 */
export interface FmTestDataClient {
  getFmTestDataSets(input: { function: string; includePayload?: boolean }): Promise<GetFmTestDataSetsResult>
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
