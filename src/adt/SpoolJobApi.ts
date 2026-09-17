import { normalizeRepositoryName, type CrossReferenceRow } from './CrossReferenceApi.js'

/**
 * ============================================================================
 * SPOOL 请求与后台作业只读 SQL API（关闭能力矩阵缺口 diagnostics.spool-jobs
 * 的只读子集：作业清单 + spool 清单）
 * ============================================================================
 *
 * 回答"夜跑作业失败了"这类事后排查的第一段问题：哪些作业、哪些步骤、各自
 * 产生了哪些 spool 请求。数据来源是三张普通透明表 + 两张作业表，走本项目
 * 既有的自由 SQL 通道（runQuery/datapreview），与 getCallees 同型：
 *
 *   - TSP01：spool 请求（号、属主、标题、创建时间、文档类型、目标设备）
 *   - TST01：spool 指向的 TemSe 对象头（存储位置 D=数据库 / F=文件、码页、
 *     行数、字节数）
 *   - TBTCP：作业步骤表——既把 spool 请求关联到写它的作业步骤（LISTIDENT），
 *     也承载每个作业的程序/变体清单
 *   - TBTCO：作业头（状态、计划/实际起止时间、周期、服务器）
 *
 * 参考实现：VSP vibing-steampunk pkg/adt/spool.go（SpoolRequests L73-165、
 * spoolJobRefs L171-190、temseHeaders L192-216）与 pkg/adt/jobs.go（Jobs
 * L69-191、jobStatusText L53-55）；SQL 语句与 WHERE 谓词逐条注明行号。
 *
 * 本轮刻意不移植（边界，写进每个结果的 notes）——此边界随 RFC 基座落地可解除：
 *   - spool 内容读取（TST03 块的 TemSe 解码 + 码页/列表格式转换，VSP
 *     pkg/temse 约 209 行）：文件型存储（TST01.DSTOTYP<>'D'）在 VSP 里也要
 *     回退到 RFC/XBP 才能读，属 RFC 方向的邻域。
 *   - 作业日志（job log）：TemSe 对象大多存文件，VSP 经 RFC/XBP 读取
 *     （handlers_spool.go L19-21 noteJobLogViaRFC），依赖直接 RFC 网关，
 *     本项目暂无 RFC 传输（rfc-transport-spike 阶段 1 基座定为 open-rfc，
 *     见矩阵 rfc.* 行 liftCondition）。
 * 因此本 API 是 diagnostics.spool-jobs 的只读子集，矩阵行以 PARTIAL 记录。
 */

/** 单行查询结果：列名 -> 单元格值（datapreview 返回，容错字符串化后使用）。 */
export type SpoolJobRow = Record<string, unknown>

/**
 * 注入的自由 SQL 执行通道：sql 为已拼装的 ABAP SQL，rowLimit 为该次查询的
 * 行数上限（与 CrossReferenceApi.AdtFreestyleQueryCapability 同构，但逐次
 * 传入限额——VSP 对主查询/步骤表/头表使用不同的限额口径）。
 */
export type SpoolJobQueryRunner = (sql: string, rowLimit: number) => Promise<readonly SpoolJobRow[]>

/** 处理器注入用的窄客户端接口。 */
export interface SpoolJobClient {
  listSpoolRequests(input: SpoolFilterInput): Promise<SpoolListResult>
  listJobs(input: JobFilterInput): Promise<JobListResult>
}

/** 默认与上限行数（对齐 VSP：主查询默认 50，spool.go L74-77）。 */
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 500
/** TBTCP 反查的行数上限（VSP spool.go L99：按作业名反查时给 5000）。 */
const JOB_REF_LIMIT = 5000

/* ==========================================================================
 * 输入校验与字面量引用（SQL 注入防线：拼进 WHERE 之前的唯一闸门）
 * ========================================================================== */

/**
 * SQL 字面量引用（对齐 VSP spool.go/jobs.go 的 sqlQuote 用法）：单引号成对
 * 转义，控制字符/换行在转义前即拒绝——datapreview 执行自由 SQL，换行可以
 * 拆语句，只靠引号转义不够。
 */
function quoteLiteral(value: string, capability: string): string {
  const raw = String(value ?? '')
  if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) {
    throw new Error(`${capability}: value contains control characters and is not put into a query.`)
  }
  return `'${raw.replace(/'/g, "''")}'`
}

/** 名字类输入（owner/program/job/user）：走仓库名白名单（大写 + [A-Z0-9_/$]）。 */
function nameLiteral(value: unknown, capability: string, label: string): string {
  return `'${normalizeRepositoryName(value, `${capability}.${label}`)}'`
}

/**
 * LIKE 模式字面量：title/jobname 允许 * 通配（转成 %），其余字符由
 * quoteLiteral 防线处理（VSP spool.go L82-84、jobs.go L76-78 同语义）。
 */
function likeLiteral(value: string, capability: string): string {
  return quoteLiteral(value.replace(/\*/g, '%'), capability)
}

/**
 * 日期边界解析：接受 YYYYMMDD 或 YYYY-MM-DD，返回 (plain, withTime) 形态。
 *   - 作业表日期列为 8 位（sdldate/strtdate...）
 *   - spool 时间戳列为 14 位 + 亚秒（rqcretime，VSP 对 to 边界追加 '99'，
 *     spool.go L92-95）
 */
function parseDateBoundary(value: unknown, capability: string, label: string): { plain: string; spool: string } {
  const raw = String(value ?? '').trim()
  const m = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})$/)
  if (!m) {
    throw new Error(
      `${capability}: ${label} must be a date (YYYY-MM-DD or YYYYMMDD), got "${raw}".`
    )
  }
  const plain = `${m[1]}${m[2]}${m[3]}`
  return { plain, spool: plain }
}

/** 行内单元格容错字符串化（对齐 CrossReferenceApi.rowString 语义）。 */
function cell(row: SpoolJobRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 容错整数化。 */
function cellInt(row: SpoolJobRow, column: string): number | undefined {
  const n = parseInt(cell(row, column), 10)
  return Number.isFinite(n) ? n : undefined
}

/** 行数边界收敛：默认 50，钳到 [1, 500]。 */
function normalizeLimit(value: unknown): number {
  const requested = Number(value ?? DEFAULT_LIST_LIMIT)
  const finite = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_LIST_LIMIT
  return Math.min(finite, MAX_LIST_LIMIT)
}

/**
 * 带排序回退的查询执行（专用 DEV 实测的端点缺陷）：
 * datapreview 对 tbtco 的 WHERE + ORDER BY 组合确定性报错（"DES" is not
 * allowed here——解析器在 WHERE 之后丢弃了 ORDER BY 段的残段），而对 tsp01
 * 同型查询正常。因此先按 VSP 原样（WHERE + ORDER BY）尝试；失败且存在 WHERE
 * 时回退为仅 WHERE 查询 + 客户端排序，并在 notes 里如实标注（此时排序作用于
 * 取回的 limit 行内，不是全表 top-N）。
 */
async function runWithOrderFallback(
  runQuery: SpoolJobQueryRunner,
  baseSql: string,
  where: string,
  orderBy: string,
  limit: number,
  notes: string[]
): Promise<readonly SpoolJobRow[]> {
  const withOrder = baseSql + (where ? ` WHERE ${where}` : '') + (orderBy ? ` ORDER BY ${orderBy}` : '')
  try {
    return await runQuery(withOrder, limit)
  } catch (firstError) {
    if (!where) throw firstError
    const withoutOrder = baseSql + ` WHERE ${where}`
    try {
      const rows = await runQuery(withoutOrder, limit)
      notes.push('ORDER BY after WHERE was rejected by the datapreview endpoint; rows were sorted client-side over the fetched rows')
      return rows
    } catch {
      throw firstError
    }
  }
}

/** SAP 14 位时间戳 → ISO 字符串（VSP parseSpoolTime，spool.go L348-358）。 */
function parseSpoolStamp(raw: string): string | undefined {
  const s = raw.trim()
  if (s.length < 14) return undefined
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`
  if (Number.isNaN(Date.parse(iso))) return undefined
  return iso
}

/** SAP 日期 + 时间列 → ISO 字符串（VSP parseSAPStamp，jobs.go）。 */
function parseSapStamp(dateRaw: string, timeRaw: string): string | undefined {
  const date = parseSpoolStamp(`${dateRaw.trim()}${(timeRaw.trim() + '000000').slice(0, 6)}`)
  return date
}

/* ==========================================================================
 * spool 清单（VSP spool.go SpoolRequests L73-165 的移植）
 * ========================================================================== */

/** listSpoolRequests 的过滤输入（全部可选；limit 恒生效）。 */
export interface SpoolFilterInput {
  /** 属主（精确，自动大写）。 */
  owner?: string
  /** 标题 LIKE 模式，* 通配。 */
  title?: string
  /** 写入程序（匹配 RQ2NAME 的前 12 位，VSP spool.go L85-90）。 */
  program?: string
  /** 只看该作业步骤写出的 spool（经 TBTCP.LISTIDENT 反查）。 */
  job?: string
  /** 创建日期下界（YYYY-MM-DD）。 */
  from?: string
  /** 创建日期上界（YYYY-MM-DD）。 */
  to?: string
  /** 返回条数上限：默认 50，上限 500。 */
  limit?: number
}

/** TBTCP 里的作业步骤引用（VSP SpoolJobRef，spool.go L59-66）。 */
export interface SpoolJobRef {
  name: string
  count: string
  step?: number
  program?: string
  variant?: string
  user?: string
}

/** 一个 spool 请求：TSP01 行 + TST01/TBTCP 增补（VSP SpoolRequest 等价）。 */
export interface SpoolRequest {
  number?: number
  client?: string
  owner?: string
  created?: string
  title?: string
  /** TSP01 的三段名字（RQ0/1/2NAME）：通常是清单种类、设备与写入程序。 */
  suffixes?: string[]
  docType?: string
  device?: string
  pages?: number
  copies?: number
  /** 持有内容的 TemSe 对象名（TSP01.RQO1NAME）。 */
  temse?: string
  /** 存储位置：D=数据库（TST03），F=应用服务器文件。 */
  storage?: string
  codepage?: string
  lines?: number
  bytes?: number
  /** 产出该请求的作业步骤（有则附）。 */
  job?: SpoolJobRef
}

/** listSpoolRequests 的返回（对齐 VSP spoolListResult）。 */
export interface SpoolListResult {
  requests: SpoolRequest[]
  count: number
  /** 边界说明：本子集不含 spool 内容读取与作业日志。 */
  notes: string[]
}

/**
 * 列出 spool 请求，创建时间倒序（VSP spool.go L73-165）。
 * 三段查询：TSP01 主查询 → TST01 头增补（存储/码页/行数/字节）→ TBTCP
 * 作业步骤反查（listident 补零到 10 位，VSP padSpoolIDs L151-157）。
 */
export async function listSpoolRequests(runQuery: SpoolJobQueryRunner, input: SpoolFilterInput): Promise<SpoolListResult> {
  const capability = 'listSpoolRequests'
  const limit = normalizeLimit(input?.limit)
  const terms: string[] = []

  if (input?.owner !== undefined && String(input.owner).trim() !== '') {
    terms.push(`rqowner = ${nameLiteral(input.owner, capability, 'owner')}`)
  }
  if (input?.title !== undefined && String(input.title).trim() !== '') {
    terms.push(`rqtitle LIKE ${likeLiteral(String(input.title).trim(), capability)}`)
  }
  if (input?.program !== undefined && String(input.program).trim() !== '') {
    // RQ2NAME 只存程序名前 12 位（VSP spool.go L86-88 的截断口径）
    const program = normalizeRepositoryName(String(input.program).trim().toUpperCase(), `${capability}.program`).slice(0, 12)
    terms.push(`rq2name = ${quoteLiteral(program, capability)}`)
  }
  if (input?.from !== undefined && String(input.from).trim() !== '') {
    const { spool } = parseDateBoundary(input.from, capability, 'from')
    terms.push(`rqcretime >= ${quoteLiteral(`${spool}000000`, capability)}`)
  }
  if (input?.to !== undefined && String(input.to).trim() !== '') {
    // to 边界追加 '99' 覆盖亚秒段（VSP spool.go L95）
    const { spool } = parseDateBoundary(input.to, capability, 'to')
    terms.push(`rqcretime <= ${quoteLiteral(`${spool}23595999`, capability)}`)
  }

  // 按作业名过滤：先经 TBTCP 反查该作业步骤写出的 spool 号（VSP L98-113）
  let byJob: Map<number, SpoolJobRef> | undefined
  if (input?.job !== undefined && String(input.job).trim() !== '') {
    const job = normalizeRepositoryName(input.job, `${capability}.job`)
    const refs = await spoolJobRefs(runQuery, `jobname = ${quoteLiteral(job, capability)} AND listident <> '0000000000'`, JOB_REF_LIMIT, capability)
    if (refs.size === 0) {
      return { requests: [], count: 0, notes: spoolNotes() }
    }
    byJob = refs
    const ids = [...refs.keys()].map(n => String(n)).sort()
    terms.push(`rqident IN (\n${ids.join(',\n')} )`)
  }

  const mainSql = 'SELECT rqident, rqclient, rqowner, rqcretime, rqtitle, rq0name, rq1name, rq2name, rqdoctype, rqdest, rqcopies, rqpjreq, rqo1name FROM tsp01'
  const orderBy = 'rqcretime DESCENDING'
  const notes = spoolNotes()
  const rows = await runWithOrderFallback(runQuery, mainSql, terms.join(' AND '), orderBy, limit, notes)

  const out: SpoolRequest[] = (rows ?? []).map(row => ({
    number: cellInt(row, 'RQIDENT'),
    client: cell(row, 'RQCLIENT'),
    owner: cell(row, 'RQOWNER'),
    created: parseSpoolStamp(cell(row, 'RQCRETIME')),
    title: cell(row, 'RQTITLE'),
    suffixes: [cell(row, 'RQ0NAME'), cell(row, 'RQ1NAME'), cell(row, 'RQ2NAME')],
    docType: cell(row, 'RQDOCTYPE'),
    device: cell(row, 'RQDEST'),
    copies: cellInt(row, 'RQCOPIES'),
    pages: cellInt(row, 'RQPJREQ'),
    temse: cell(row, 'RQO1NAME')
  }))
  // 回退场景的客户端排序：创建时间倒序（ISO 字符串可直接比较）
  if (out.length > 1) {
    out.sort((a, b) => {
      const byCreated = (b.created ?? '').localeCompare(a.created ?? '')
      if (byCreated !== 0) return byCreated
      return (b.number ?? 0) - (a.number ?? 0)
    })
  }

  if (out.length > 0) {
    // TST01 头（存储/码页/行数/字节）与 TBTCP 作业引用增补（VSP L136-150）
    const temseNames = [...new Set(out.map(r => r.temse).filter((n): n is string => Boolean(n)))]
    const headers = await temseHeaders(runQuery, temseNames, capability)
    // listident 谓词需要补零到 10 位（VSP padSpoolIDs L151-157）
    let refs = byJob
    if (!refs) {
      refs = await spoolJobRefs(
        runQuery,
        `listident IN (\n${out.map(r => quoteLiteral(String(r.number ?? 0).padStart(10, '0'), capability)).join(',\n')} )`,
        out.length * 2,
        capability
      )
    }
    for (const r of out) {
      const header = headers.get(r.temse ?? '')
      if (header) {
        r.storage = header.storage
        r.codepage = header.codepage
        r.lines = header.lines
        r.bytes = header.bytes
      }
      const ref = refs.get(r.number ?? -1)
      if (ref) r.job = ref
    }
  }
  return { requests: out, count: out.length, notes }
}

/** 本子集的固定边界说明（对齐 VSP handlers_spool.go 的 notes 语义）。 */
function spoolNotes(): string[] {
  return [
    'read-only SQL subset: spool content (TemSe/TST03 decode) and job logs (RFC/XBP) are not part of this tool'
  ]
}

/** TBTCP 反查：按 WHERE 谓词取作业步骤引用，按 spool 号键控（VSP L171-190）。 */
async function spoolJobRefs(
  runQuery: SpoolJobQueryRunner,
  where: string,
  limit: number,
  capability: string
): Promise<Map<number, SpoolJobRef>> {
  const rows = await runQuery(
    `SELECT jobname, jobcount, stepcount, progname, variant, authcknam, listident FROM tbtcp WHERE ${where}`,
    limit
  )
  const out = new Map<number, SpoolJobRef>()
  for (const row of rows ?? []) {
    const n = cellInt(row, 'LISTIDENT') ?? 0
    if (n === 0) continue
    out.set(n, {
      name: cell(row, 'JOBNAME'),
      count: cell(row, 'JOBCOUNT'),
      step: cellInt(row, 'STEPCOUNT'),
      program: cell(row, 'PROGNAME'),
      variant: cell(row, 'VARIANT'),
      user: cell(row, 'AUTHCKNAM')
    })
  }
  return out
}

/** TST01 头表读取：dname IN (...) → 存储/码页/行数/字节（VSP temseHeaders L192-216）。 */
async function temseHeaders(
  runQuery: SpoolJobQueryRunner,
  names: readonly string[],
  capability: string
): Promise<Map<string, { storage: string; codepage: string; lines?: number; bytes?: number }>> {
  const out = new Map<string, { storage: string; codepage: string; lines?: number; bytes?: number }>()
  if (names.length === 0) return out
  const quoted = names.map(n => quoteLiteral(n, capability))
  const rows = await runQuery(
    'SELECT dname, dtype, drectyp, dcharcod, dstotyp, drows, dsize, dlinelen, dnoparts, dcreater FROM tst01'
    + ` WHERE dname IN (\n${quoted.join(',\n')} )`,
    names.length * 2
  )
  for (const row of rows ?? []) {
    out.set(cell(row, 'DNAME'), {
      storage: cell(row, 'DSTOTYP'),
      codepage: cell(row, 'DCHARCOD'),
      lines: cellInt(row, 'DROWS'),
      bytes: cellInt(row, 'DSIZE')
    })
  }
  return out
}

/* ==========================================================================
 * 后台作业清单（VSP jobs.go Jobs L69-191 的移植）
 * ========================================================================== */

/** listJobs 的过滤输入（全部可选；limit 恒生效）。 */
export interface JobFilterInput {
  /** 作业名：精确，或带 * 通配的 LIKE 模式。 */
  name?: string
  /** 计划者用户（精确，自动大写）。 */
  user?: string
  /** 状态码一个或多个，如 F/R/A（TBTCO.STATUS）。 */
  status?: string
  /** 只看含运行该程序的步骤的作业（经 TBTCP 反查）。 */
  program?: string
  /** 计划日期下界（YYYY-MM-DD，按 sdldate）。 */
  from?: string
  /** 计划日期上界（YYYY-MM-DD）。 */
  to?: string
  /** 返回条数上限：默认 50，上限 500。 */
  limit?: number
}

/** 作业步骤（TBTCP 行，VSP JobStep 等价）。 */
export interface JobStep {
  step?: number
  program?: string
  variant?: string
  user?: string
  lang?: string
  status?: string
  /** 该步骤写出的 spool 请求号（TBTCP.LISTIDENT）。 */
  spool?: number
  /** 外部命令（EXTCMD/XPGPROG，当步骤不是 ABAP 程序时）。 */
  external?: string
}

/** 一个后台作业：TBTCO 行 + TBTCP 步骤增补（VSP Job 等价）。 */
export interface Job {
  name: string
  count: string
  status?: string
  /** 状态码的英文释义（VSP jobStatusText L53-55）。 */
  statusText?: string
  user?: string
  jobClass?: string
  periodic?: boolean
  server?: string
  scheduled?: string
  released?: string
  started?: string
  ended?: string
  /** 实际运行时长（started→ended 的秒数，有起止才给）。 */
  durationSeconds?: number
  steps?: JobStep[]
}

/** TBTCO.STATUS → 英文释义（VSP jobs.go L53-55 逐项对齐）。 */
const JOB_STATUS_TEXT: Record<string, string> = {
  P: 'scheduled', S: 'released', Y: 'ready', R: 'active', F: 'finished', A: 'cancelled', Z: 'put active'
}

/** listJobs 的返回（对齐 VSP jobListResult，附边界说明）。 */
export interface JobListResult {
  jobs: Job[]
  count: number
  /** 边界说明：作业日志读取（RFC/XBP）不在本子集内。 */
  notes: string[]
}

/**
 * 列出后台作业，实际开始时间倒序，附步骤清单（VSP jobs.go L69-191）。
 * 步骤增补与作业日志边界说明随结果返回——日志本体在 VSP 也走 RFC/XBP。
 */
export async function listJobs(runQuery: SpoolJobQueryRunner, input: JobFilterInput): Promise<JobListResult> {
  const capability = 'listJobs'
  const limit = normalizeLimit(input?.limit)
  const notes = jobNotes()
  const terms: string[] = []

  if (input?.name !== undefined && String(input.name).trim() !== '') {
    const name = String(input.name).trim().toUpperCase()
    // 含 * 或 % 走 LIKE，否则精确等值（VSP jobs.go L75-81）
    if (name.includes('*') || name.includes('%')) {
      terms.push(`jobname LIKE ${likeLiteral(name, capability)}`)
    } else {
      terms.push(`jobname = ${nameLiteral(name, capability, 'name')}`)
    }
  }
  if (input?.user !== undefined && String(input.user).trim() !== '') {
    terms.push(`sdluname = ${nameLiteral(input.user, capability, 'user')}`)
  }
  if (input?.status !== undefined && String(input.status).trim() !== '') {
    // 状态码白名单：只接受已知字母（防注入且防脏码）
    const codes = String(input.status).toUpperCase().split(/[\s,]+/).filter(code => code in JOB_STATUS_TEXT)
    if (codes.length > 0) {
      terms.push(`status IN ( ${codes.map(code => `'${code}'`).join(', ')} )`)
    }
  }
  if (input?.from !== undefined && String(input.from).trim() !== '') {
    const { plain } = parseDateBoundary(input.from, capability, 'from')
    terms.push(`sdldate >= ${quoteLiteral(plain, capability)}`)
  }
  if (input?.to !== undefined && String(input.to).trim() !== '') {
    const { plain } = parseDateBoundary(input.to, capability, 'to')
    terms.push(`sdldate <= ${quoteLiteral(plain, capability)}`)
  }
  if (input?.program !== undefined && String(input.program).trim() !== '') {
    // 程序过滤：先查 TBTCP 拿 (jobname, jobcount) 键，再拼 OR 组（VSP L100-113）。
    // tbtcp 与 tbtco 同受 WHERE+ORDER BY 缺陷影响，走排序回退通道；键序在
    // 回退时不保证，仅影响超限场景下选中哪些作业。
    const program = normalizeRepositoryName(String(input.program).trim().toUpperCase(), `${capability}.program`)
    const preNotes: string[] = []
    const stepRows = await runWithOrderFallback(
      runQuery,
      'SELECT jobname, jobcount FROM tbtcp',
      `progname = ${quoteLiteral(program, capability)}`,
      'sdldate DESCENDING, sdltime DESCENDING',
      limit * 4,
      preNotes
    )
    notes.push(...preNotes)
    if (!stepRows || stepRows.length === 0) {
      return { jobs: [], count: 0, notes }
    }
    const keys = (stepRows ?? []).map(row =>
      `( jobname = ${quoteLiteral(cell(row, 'JOBNAME'), capability)} AND jobcount = ${quoteLiteral(cell(row, 'JOBCOUNT'), capability)} )`
    )
    terms.push(`(\n${keys.join('\nOR ')} )`)
  }

  const mainSql = 'SELECT jobname, jobcount, status, sdldate, sdltime, reldate, reltime, strtdate, strttime, enddate, endtime, sdluname, reaxserver, execserver, periodic, jobclass, joblog FROM tbtco'
  const orderBy = 'strtdate DESCENDING, strttime DESCENDING, sdldate DESCENDING, sdltime DESCENDING'
  const rows = await runWithOrderFallback(runQuery, mainSql, terms.join(' AND '), orderBy, limit, notes)

  const jobs: Job[] = (rows ?? []).map(row => {
    const started = parseSapStamp(cell(row, 'STRTDATE'), cell(row, 'STRTTIME'))
    const ended = parseSapStamp(cell(row, 'ENDDATE'), cell(row, 'ENDTIME'))
    const status = cell(row, 'STATUS')
    const job: Job = {
      name: cell(row, 'JOBNAME'),
      count: cell(row, 'JOBCOUNT'),
      status,
      user: cell(row, 'SDLUNAME'),
      jobClass: cell(row, 'JOBCLASS'),
      periodic: cell(row, 'PERIODIC') === 'X',
      scheduled: parseSapStamp(cell(row, 'SDLDATE'), cell(row, 'SDLTIME')),
      released: parseSapStamp(cell(row, 'RELDATE'), cell(row, 'RELTIME')),
      started,
      ended
    }
    if (JOB_STATUS_TEXT[status]) job.statusText = JOB_STATUS_TEXT[status]
    const server = cell(row, 'EXECSERVER') || cell(row, 'REAXSERVER')
    if (server) job.server = server
    if (started && ended) {
      const seconds = Math.round((Date.parse(ended) - Date.parse(started)) / 1000)
      if (Number.isFinite(seconds)) job.durationSeconds = seconds
    }
    return job
  })
  // 回退场景的客户端排序：实际开始倒序，其次计划时间倒序（对齐 VSP 的
  // ORDER BY 意图；ISO 字符串可直接比较）
  if (jobs.length > 1) {
    jobs.sort((a, b) => {
      const byStarted = (b.started ?? '').localeCompare(a.started ?? '')
      if (byStarted !== 0) return byStarted
      const byScheduled = (b.scheduled ?? '').localeCompare(a.scheduled ?? '')
      if (byScheduled !== 0) return byScheduled
      return a.name.localeCompare(b.name)
    })
  }

  if (jobs.length > 0) {
    // 步骤增补（VSP L154-186）：按 (jobname, jobcount) 键控合并。tbtcp 同样
    // 走排序回退通道；无论哪条路径，合并前都按 (jobname, jobcount, stepcount)
    // 客户端重排，保证步骤顺序确定。
    const keys = jobs.map(j =>
      `( jobname = ${quoteLiteral(j.name, capability)} AND jobcount = ${quoteLiteral(j.count, capability)} )`
    )
    const stepNotes: string[] = []
    const stepRows = await runWithOrderFallback(
      runQuery,
      'SELECT jobname, jobcount, stepcount, progname, variant, authcknam, language, status, listident, xpgprog, extcmd FROM tbtcp',
      `(\n${keys.join('\nOR ')} )`,
      'jobname, jobcount, stepcount',
      jobs.length * 20,
      stepNotes
    )
    notes.push(...stepNotes)
    const index = new Map(jobs.map((j, i) => [`${j.name}\u0000${j.count}`, i]))
    const sorted = [...(stepRows ?? [])].sort((a, b) => {
      const key = (row: SpoolJobRow) =>
        `${cell(row, 'JOBNAME')}\u0000${cell(row, 'JOBCOUNT')}\u0000${cell(row, 'STEPCOUNT').padStart(4, '0')}`
      return key(a).localeCompare(key(b))
    })
    for (const row of sorted) {
      const i = index.get(`${cell(row, 'JOBNAME')}\u0000${cell(row, 'JOBCOUNT')}`)
      if (i === undefined) continue
      const step: JobStep = {
        program: cell(row, 'PROGNAME'),
        variant: cell(row, 'VARIANT'),
        user: cell(row, 'AUTHCKNAM'),
        lang: cell(row, 'LANGUAGE'),
        status: cell(row, 'STATUS'),
        spool: cellInt(row, 'LISTIDENT')
      }
      step.step = cellInt(row, 'STEPCOUNT')
      if (!step.program) {
        const external = `${cell(row, 'EXTCMD')} ${cell(row, 'XPGPROG')}`.trim()
        if (external) step.external = external
      }
      ;(jobs[i].steps ??= []).push(step)
    }
  }
  return { jobs, count: jobs.length, notes }
}

/** 作业子集的固定边界说明。 */
function jobNotes(): string[] {
  return [
    'read-only SQL subset: job logs are TemSe objects most systems keep in files; reading them needs RFC/XBP (VSP parity) which this tool does not do'
  ]
}

/* ==========================================================================
 * 客户端绑定（窄接口注入，风格对齐 CrossReferenceApi.bind 模式）
 * ========================================================================== */

/**
 * 项目底层自由 SQL 能力的最小结构视图（duck typing，与
 * CrossReferenceApi.AdtFreestyleQueryCapability 同构）。
 */
export interface AdtFreestyleQueryCapability {
  runQuery(
    sqlQuery: string,
    rowNumber?: number,
    decode?: boolean
  ): Promise<{ values?: SpoolJobRow[] }>
}

/**
 * 把项目 runQuery 底层能力绑定成逐次限额的查询通道。
 * decode 必须为 true（状态码/补零标识依赖解码后的字符值）。
 */
export function bindSpoolJobQueryRunner(client: AdtFreestyleQueryCapability): SpoolJobQueryRunner {
  return async (sql, rowLimit) => {
    const result = await client.runQuery(sql, rowLimit, true)
    return result?.values ?? []
  }
}

/** 把查询通道绑定成处理器可注入的窄客户端。 */
export function createSpoolJobClient(runner: SpoolJobQueryRunner): SpoolJobClient {
  return {
    listSpoolRequests: input => listSpoolRequests(runner, input),
    listJobs: input => listJobs(runner, input)
  }
}

/** 兼容导出：行类型与 CrossReferenceApi 的一致（同一 datapreview 通道）。 */
export type { CrossReferenceRow as SpoolJobSqlRow }
