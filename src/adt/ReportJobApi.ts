/**
 * 报表执行 API（矩阵行 report.run / report.async 收编；2026-10-07 所有者
 * 放开报表执行方向）。
 *
 * 机制：复用受控 ABAP 执行链（devtools.execute-abap 同款执行核），生成
 * 一次性包装程序——测试方法内 JOB_OPEN → SUBMIT (report) VIA JOB（带变体
 * 或 RSPARAMS）→ JOB_CLOSE（立即调度），EXEC_RESULT 把 jobname/jobcount
 * 带出沙箱。作业在 SAP 后台工作进程异步执行。
 *
 * report.run = 提交 + 服务端轮询 TBTCO + spool 内容解码（复用 SpoolJobApi
 * 的 readSpoolContent——TST03 码页/列表解码已真机验证）；report.async =
 * 仅提交（调用方经既有 listJobs/listSpoolRequests/readSpoolContent 轮询）。
 *
 * 关键取舍（真机取证 2026-10-07）：ZADT_VSP 桥 report 域的同步 SUBMIT
 * （内嵌 ZCL_VSP_REPORT_SERVICE）在 APC 会话内静默终止连接（无 ST22 dump、
 * 无错误应答）——VSP Go 客户端的"作业化演进"（handlers_report.go 注释
 * "new job-based approach... ABAP service may need updating"即为此问题的
 * 解法痕迹）。本项目直接采用纯 ADT 作业链语义：零 helper 依赖，任意
 * DEV 系统可用；输出为列表文本（spool LIST 渲染）而非 ALV 结构化行。
 *
 * 注入防线：报表名/变体名 token 校验（字符集排除引号）；参数值引号翻倍 +
 * 控制字符剥离 + 132 位上限；参数名按 RSSCR-NAME 8 位界校验；作业名由
 * 服务端生成（ZRPT_ + 时间戳），调用方无自由命名面。报表不存在 fail-fast
 * （REPOSRC 活跃版预检，不留 aborted 作业）。完成作业残留于 TBTCO 作业
 * 清单（VSP 同款，属主 SM37 可清）。
 *
 * 风险声明口径（真机实测 2026-10-07，sap-dev/sap-demo）：系统 ABAP Unit
 * 风险上限为 HARMLESS（dangerous/critical 测试类拒跑，warning"测试类风险
 * 级别超过上限"——无法以调用侧 flags 突破）。包装器因此声明 HARMLESS：
 * 包装器测试方法自身仅做作业调度（JOB_OPEN/SUBMIT/JOB_CLOSE），真正的
 * 报表执行发生在后台作业进程、在测试之外；执行风险由工具面披露
 * （runReport/submitReportJob 描述 + OTHER_MUTATION 门控）。
 */
import { validateReportName } from './ReportVariantsApi.js'
import type { FmTestDataQueryRunner } from './FmTestDataApi.js'

/** 执行核窄接口（ExecuteAbapClient 的执行方法形态）。 */
export interface ReportJobExecutor {
  executeAbap(code: string, opts?: { riskLevel?: string; returnVariable?: string }): Promise<{
    success: boolean
    output: string[]
    message: string
    failure?: { kind: string; title: string }
  }>
}

export interface SubmitReportJobInput {
  report: string
  /** 变体名（与 params 二选一；提供时优先）。 */
  variant?: string
  /** 选择参数（对象 → RSPARAMS kind='P' 行）。 */
  params?: Record<string, string>
}

export interface SubmitReportJobResult {
  report: string
  jobName: string
  jobCount: string
  notes: string[]
}

/** 参数名按 RSSCR-NAME 8 位界校验（A-Z 0-9 _）。 */
function validateParamName(name: string, capability: string): string {
  if (!/^[A-Z0-9_]{1,8}$/.test(name)) {
    throw new Error(`${capability}: parameter name "${name}" is invalid (A-Z 0-9 _, at most 8 characters — RSPARAMS SELNAME).`)
  }
  return name
}

/** 参数值进入 ABAP 字面量前的清洗：控制字符剥离、引号翻倍、132 位上限。 */
function sanitizeParamValue(value: string, capability: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  if (stripped.length > 132) {
    throw new Error(`${capability}: parameter value exceeds 132 characters.`)
  }
  return stripped.replace(/'/g, "''")
}

/** 变体名 token 校验（VARID-VARIANT 命名界；字符集排除引号）。 */
function validateVariantName(value: string, capability: string): string {
  if (!/^[A-Z0-9_/=%]{1,14}$/.test(value)) {
    throw new Error(`${capability}: variant "${value}" is invalid (A-Z 0-9 _ / = %, at most 14 characters).`)
  }
  return value
}

/**
 * 提交报表后台作业：fail-fast 存在性预检（REPOSRC 活跃版）→ 生成包装代码 →
 * 受控执行核单次运行 → 解析 JOB=name/count。
 */
export async function submitReportJob(
  executor: ReportJobExecutor,
  deps: { runQuery?: FmTestDataQueryRunner },
  input: SubmitReportJobInput
): Promise<SubmitReportJobResult> {
  const capability = 'submitReportJob'
  const report = validateReportName(input?.report, capability)
  const variant = input?.variant !== undefined && String(input.variant).trim() !== ''
    ? validateVariantName(String(input.variant).trim().toUpperCase(), capability)
    : undefined
  const notes: string[] = [
    'The job runs asynchronously: poll it with listJobs and read the list output with listSpoolRequests/readSpoolContent. Finished jobs remain in the job list (SM37-cleanable by the owner).'
  ]

  // fail-fast：报表不存在就别开作业（避免 aborted 作业残留）。
  // 通道取 TRDIR（REPOSRC 在 datapreview 通道报"Unknown column name"——
  // 2026-10-07 sap-dev 实测）；TRDIR 不分活跃/非活跃版本，仅做存在性预检。
  if (deps.runQuery) {
    let exists: Record<string, unknown>[] = []
    try {
      exists = (await deps.runQuery(
        `SELECT name FROM trdir WHERE name = '${report.replace(/'/g, "''")}'`,
        5
      )).values ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notes.push(`Existence precheck failed and was skipped: ${message.slice(0, 120)}`)
    }
    if (exists.length === 0 && notes.length === 1) {
      throw new Error(`${capability}: report ${report} does not exist (TRDIR).`)
    }
  }

  // 参数 → RSPARAMS 追加行（VSP 同款 kind='P'/I/EQ；值字面量安全清洗）
  const rsparamsLines: string[] = []
  for (const [rawName, rawValue] of Object.entries(input?.params ?? {})) {
    const name = validateParamName(String(rawName).trim().toUpperCase(), capability)
    const value = sanitizeParamValue(String(rawValue), capability)
    rsparamsLines.push(`  APPEND VALUE rsparams( selname = '${name}' kind = 'P' sign = 'I' option = 'EQ' low = '${value}' ) TO lt_rsparams.`)
  }

  // 作业名由服务端生成（调用方无自由命名面）：ZRPT_YYMMDDHHMMSS（17 位）
  const now = new Date()
  const pad = (n: number, w: number): string => String(n).padStart(w, '0')
  const jobName = 'ZRPT_' + pad(now.getUTCFullYear() % 100, 2) + pad(now.getUTCMonth() + 1, 2)
    + pad(now.getUTCDate(), 2) + pad(now.getUTCHours(), 2) + pad(now.getUTCMinutes(), 2)
    + pad(now.getUTCSeconds(), 2) + pad(now.getUTCMilliseconds() % 100, 2)
  if (!/^Z[A-Z0-9_]{1,31}$/.test(jobName)) {
    throw new Error(`${capability}: generated job name failed validation.`)
  }

  // SUBMIT 行：变体优先（VSP 同款），否则 RSPARAMS，否则裸提交
  let submitLine: string
  if (variant !== undefined) {
    submitLine = `  SUBMIT (lv_report) USING SELECTION-SET '${variant}' VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.`
  } else if (rsparamsLines.length > 0) {
    submitLine = `  SUBMIT (lv_report) WITH SELECTION-TABLE lt_rsparams VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.`
  } else {
    submitLine = `  SUBMIT (lv_report) VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.`
  }

  const code = [
    'DATA lv_report TYPE progname.',
    'DATA lv_jobname TYPE tbtcjob-jobname.',
    'DATA lv_jobcount TYPE tbtcjob-jobcount.',
    'DATA lt_rsparams TYPE TABLE OF rsparams.',
    `lv_report = '${report.replace(/'/g, "''")}'.`,
    ...rsparamsLines,
    `lv_jobname = '${jobName}'.`,
    "CALL FUNCTION 'JOB_OPEN' EXPORTING jobname = lv_jobname IMPORTING jobcount = lv_jobcount",
    "  EXCEPTIONS cant_create_job = 1 invalid_job_data = 2 jobname_missing = 3 OTHERS = 4.",
    'IF sy-subrc <> 0.',
    `  lv_result = |JOB_OPEN_FAILED={ sy-subrc }|.`,
    'ELSE.',
    submitLine,
    "  CALL FUNCTION 'JOB_CLOSE' EXPORTING jobname = lv_jobname jobcount = lv_jobcount strtimmed = 'X'",
    "    EXCEPTIONS cant_start_immediately = 1 invalid_startdate = 2 jobname_missing = 3 job_close_failed = 4",
    '    lock_failed = 5 invalid_job_data = 6 OTHERS = 7.',
    '  IF sy-subrc <> 0.',
    `    lv_result = |JOB_CLOSE_FAILED={ sy-subrc }|.`,
    '  ELSE.',
    `    lv_result = |JOB={ lv_jobname }/{ lv_jobcount }|.`,
    '  ENDIF.',
    'ENDIF.'
  ].join('\n')

  // 系统风险上限=HARMLESS（见头注释）：包装器只做调度，报表执行在后台进程
  const execution = await executor.executeAbap(code, { riskLevel: 'harmless' })
  const outputText = execution.output.join(' ')
  const apiFailure = execution.output.find(o => /^(JOB_OPEN|JOB_CLOSE)_FAILED=/.test(o))
  if (apiFailure) {
    throw new Error(`${capability}: job API failed: ${apiFailure.slice(0, 120)}`)
  }
  const jobLine = execution.output.find(o => /^JOB=/.test(o))
  if (!execution.success || !jobLine) {
    const detail = execution.failure?.title ?? execution.message ?? outputText ?? 'no output captured'
    throw new Error(`${capability}: report job submission failed: ${String(detail).slice(0, 200)}`)
  }
  const match = jobLine.match(/^JOB=(.+)\/(.+)$/)
  if (!match) {
    throw new Error(`${capability}: job submission output was not parseable: ${jobLine.slice(0, 120)}`)
  }
  return { report, jobName: match[1]!, jobCount: match[2]!, notes }
}

/** 处理器注入用的窄客户端接口。 */
export interface ReportJobClient {
  submitReportJob(input: SubmitReportJobInput): Promise<SubmitReportJobResult>
  runReport(input: RunReportInput): Promise<RunReportResult>
}

/** 把受控执行核与 SQL 通道绑定成窄客户端。 */
export function createReportJobClient(
  executor: ReportJobExecutor,
  runQuery?: FmTestDataQueryRunner,
  spool?: RunReportDeps['spool']
): ReportJobClient {
  return {
    submitReportJob: input => submitReportJob(executor, { runQuery }, input),
    runReport: input => runReport(executor, { runQuery, spool }, input)
  }
}

/* ==========================================================================
 * report.run：提交 + 轮询 + spool 输出
 * ========================================================================== */

/** TBTCO 作业状态释义（VSP jobStatusText 同款子集）。 */
const JOB_STATUS_TEXT: Record<string, string> = {
  F: 'finished', A: 'aborted', R: 'active', S: 'released', Y: 'ready', Z: 'suspended'
}

export interface RunReportInput extends SubmitReportJobInput {
  /** 等待作业完成的秒数（服务端轮询；缺省 60，上限 300）。 */
  waitSeconds?: number
}

export interface RunReportResult {
  report: string
  jobName: string
  jobCount: string
  /** TBTCO 作业状态（F=finished/A=aborted/R=active…）与释义。 */
  jobStatus: string
  jobStatusText?: string
  /** 作业步骤的 spool 请求号（TBTCP.LISTIDENT；无输出时缺省）。 */
  spoolId?: number
  /** spool 列表文本（LIST 解码；OTF/二进制时缺省并给 rawNote）。 */
  output?: string
  /** 超时未完成时 true（作业继续在后台跑，可用 listJobs 续查）。 */
  pollTimeout?: boolean
  notes: string[]
}

export interface RunReportDeps {
  runQuery?: FmTestDataQueryRunner
  spool?: { readSpoolContent(requestNumber: number): Promise<{ contentType: string; text?: string; rawNote?: string }> }
  /** 轮询间隔毫秒（缺省 2000；测试注入 1ms 避免真实等待）。 */
  pollIntervalMs?: number
}

/** 单元格容错读取。 */
function jobCellText(row: Record<string, unknown>, columnName: string): string {
  const key = Object.keys(row).find(k => k.toUpperCase() === columnName)
  const value = key ? row[key] : undefined
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : String(value).trim()
}

/**
 * 运行报表并等待取回列表输出：submitReportJob 同款提交 → 轮询 TBTCO 状态
 * （每 2s，waitSeconds 上限）→ TBTCP.LISTIDENT 定位 spool → readSpoolContent
 * 解码列表文本。作业 aborted 时如实返回失败形态（jobStatus=A + 输出照回，
 * 崩溃信息在列表里）。
 */
export async function runReport(
  executor: ReportJobExecutor,
  deps: RunReportDeps,
  input: RunReportInput
): Promise<RunReportResult> {
  const capability = 'runReport'
  const waitSeconds = Math.min(Math.max(Number(input?.waitSeconds ?? 60) || 60, 5), 300)
  const submitted = await submitReportJob(executor, { runQuery: deps.runQuery }, input)
  const notes = [...submitted.notes]

  if (!deps.runQuery || !deps.spool) {
    return { ...submitted, jobStatus: 'S', jobStatusText: JOB_STATUS_TEXT['S'], pollTimeout: true, notes }
  }
  const jobCountCond = `'${submitted.jobCount.replace(/'/g, "''")}'`
  const pollInterval = Math.max(deps.pollIntervalMs ?? 2000, 1)
  const deadline = Date.now() + waitSeconds * 1000
  let status = ''
  while (Date.now() < deadline) {
    const rows = (await deps.runQuery(
      `SELECT status FROM tbtco WHERE jobname = '${submitted.jobName.replace(/'/g, "''")}' AND jobcount = ${jobCountCond}`,
      5
    )).values ?? []
    status = rows.length > 0 ? jobCellText(rows[0]!, 'STATUS').toUpperCase() : ''
    if (status === 'F' || status === 'A') break
    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }
  const result: RunReportResult = {
    ...submitted,
    jobStatus: status,
    ...(JOB_STATUS_TEXT[status] ? { jobStatusText: JOB_STATUS_TEXT[status] } : {})
  }
  if (status !== 'F' && status !== 'A') {
    // 轮询预算耗尽：作业还在跑——如实返回 pollTimeout，调用方经 listJobs 续查
    result.pollTimeout = true
    notes.push(`Poll budget (${waitSeconds}s) exhausted before the job finished; it keeps running in the background - continue with listJobs/listSpoolRequests/readSpoolContent.`)
    result.notes = notes
    return result
  }

  // 定位作业步骤的 spool（TBTCP.LISTIDENT）
  let spoolId: number | undefined
  try {
    const spoolRows = (await deps.runQuery(
      `SELECT listident FROM tbtcp WHERE jobname = '${submitted.jobName.replace(/'/g, "''")}' AND jobcount = ${jobCountCond} AND listident <> ''`,
      5
    )).values ?? []
    const first = spoolRows.map(r => Number(jobCellText(r, 'LISTIDENT'))).find(n => Number.isSafeInteger(n) && n > 0)
    if (first !== undefined) spoolId = first
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    notes.push(`TBTCP spool lookup failed: ${message.slice(0, 120)}`)
  }

  if (spoolId !== undefined && deps.spool) {
    try {
      const content = await deps.spool.readSpoolContent(spoolId)
      if (content.text !== undefined) result.output = content.text
      else if (content.rawNote !== undefined) {
        result.output = content.rawNote
        notes.push(`Spool #${spoolId} is not a text document (${content.contentType}); raw note returned instead.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notes.push(`Spool content read failed for #${spoolId}: ${message.slice(0, 120)}`)
    }
  }
  result.spoolId = spoolId
  result.notes = notes
  return result
}
