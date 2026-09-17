import type { AdtHTTP } from './AdtHTTP'
import { runQuery } from './api/tablecontents'

/**
 * ============================================================================
 * BAL 应用日志只读 ADT API（关闭能力矩阵缺口 diagnostics.application-log）
 * ============================================================================
 *
 * 本文件提供一个纯只读的 BAL（Business Application Log）应用日志读取能力，
 * 语义对齐 SAP SLG1（SLG1 事务码就是 BAL 日志的展示入口），对齐 VSP
 * vibing-steampunk 的 analyze(application_log) 任务：
 *
 *   readApplicationLog —— 按过滤器读取 BAL 应用日志头（BALHDR 表）
 *
 * 端点与协议来源（VSP 只读参考，本项目不修改 VSP 仓库）：
 *   - VSP pkg/adt/applog.go 第 73-111 行 Client.ApplicationLog：底层走
 *     Client.RunQuery（pkg/adt/client.go 第 1241-1266 行），即
 *       POST /sap/bc/adt/datapreview/freestyle?rowNumber=<maxRows>
 *       Content-Type: text/plain   Accept: application/*
 *       请求体：自由 SQL 文本
 *     —— BAL_* 函数组无法远程调用，但 BALHDR 是普通透明表，ADT 数据预览
 *     可以只读查询，因此整个日志头无需任何 Z 代码即可通过 HTTPS 读取
 *     （VSP applog.go 第 11-25 行注释）。
 *   - 查询列与排序逐字对齐 VSP applog.go 第 80/84 行：
 *       SELECT lognumber, log_handle, object, subobject, extnumber, aldate,
 *              altime, aluser, alprog, almode, msg_cnt_al FROM balhdr
 *       ... ORDER BY aldate DESCENDING, altime DESCENDING
 *   - SQL 行宽处理对齐 VSP client.go 第 1274-1309 行 wrapSQL：数据预览服务
 *     会把请求体塞进 255 字符的 ABAP 源代码行，超长行中的字面量/列名被硬切
 *     即成语法错误，因此必须在空白处（引号外）主动换行。
 *
 * 设计规则（业务约束）：
 *   - 只读：仅发一条 SELECT 数据预览请求，不涉及任何 SAP 写操作、锁、传输；
 *     本项目安全边界“不执行数据库写操作”由“只拼 SELECT + 只走 datapreview”
 *     结构性保证，调用方无法注入其他 SQL 动词。
 *   - 过滤字段全部可选但有界：无任何过滤时 maxResults（默认 100、上限 500）
 *     兜底行数；时间窗跨度限制在 31 天内（见 APPLICATION_LOG_MAX_WINDOW_DAYS），
 *     防止在繁忙系统上对 BALHDR 做接近全表的扫描（对齐 VSP applog.go 第
 *     53-55 行 "Limit always applies" 的保守立场）。
 *   - 输出裁剪为精简 JSON 条目数组，绝不返回原始 XML；空结果返回空数组而非
 *     抛错（对齐 CdsDependencyApi 的容错语义）。
 *   - 消息文本附加说明：VSP 的 AttachAppLogMessages（applog.go 第 182-217 行）
 *     需要第二次调用解码 BALDAT 集群表（BLob 集群格式）并回读 T100 多语言
 *     文本；本项目按任务范围简化为单次返回结构化日志头条目（含消息计数
 *     messageCount，可在读取消息前预知日志规模），BALDAT 集群解码能力留作
 *     后续独立任务，不在本文件实现。
 */

/** 应用日志查询支持的过滤输入（对齐 VSP AppLogFilter，pkg/adt/applog.go 第 55-69 行）。 */
export interface ApplicationLogFilter {
  /** SLG0 日志对象（BALHDR OBJECT 列），例如 ZMYOBJECT；内部统一转大写。 */
  object?: string
  /** SLG0 子对象（BALHDR SUBOBJECT 列）；内部统一转大写。 */
  objectSubobject?: string
  /**
   * 外部日志标识（BALHDR EXTNUMBER 列，如单据号/凭证号）；按书写原样匹配
   * （区分大小写，SAP 对话框录入通常为大写），与 object 等名称字段的大写
   * 规范化不同，见 normalizeApplicationLogFilter 内注释。
   */
  externalId?: string
  /** 时间窗起点（含），ISO 8601 日期或时间戳，例如 2026-09-01 或 2026-09-01T08:00:00。 */
  timeFrom?: string
  /** 时间窗终点（含），ISO 8601；与 timeFrom 同时提供时跨度不得超过 31 天。 */
  timeTo?: string
  /** 写日志的 SAP 用户（BALHDR ALUSER 列）；内部统一转大写。 */
  userName?: string
  /** 返回行数上限；缺省 100，硬上限 500（超出拒绝，不静默截断）。 */
  maxResults?: number
}

/** 单条 BAL 日志头（BALHDR 一行），裁剪为最小可用字段集合。 */
export interface ApplicationLogEntry {
  /**
   * 日志编号（LOGNUMBER），BAL 内部日志键之一；恒输出（对齐 VSP AppLogEntry
   * 中唯一不带 omitempty 的字段），其余字段在 SAP 未返回值时一律省略。
   */
  logNumber: string
  /**
   * 日志句柄（LOG_HANDLE）：消息在 BALDAT 集群表中的键。读取消息体（本项目
   * 尚未实现的 BALDAT 集群解码）时需以它关联，见文件头“消息文本附加说明”；
   * SAP 未返回时省略。
   */
  logHandle?: string
  /** SLG0 日志对象（OBJECT）；SAP 未返回时省略。 */
  object?: string
  /** SLG0 子对象（SUBOBJECT）；SAP 未返回时省略。 */
  subObject?: string
  /** 外部日志标识（EXTNUMBER）；SAP 未返回时省略。 */
  externalId?: string
  /**
   * 日志时间戳（ALDATE+ALTIME 合并），本地化 ISO 形式
   * YYYY-MM-DDTHH:MM:SS（SAP 系统时间，不带时区后缀）；日期列不可解析时
   * 省略该字段——一条日期异常的日志仍是日志，不能因此丢行（对齐 VSP
   * parseSAPStamp 的“零值而非报错”语义，applog.go 第 147-163 行）。
   */
  timestamp?: string
  /** 写日志的用户（ALUSER）；SAP 未返回时省略。 */
  user?: string
  /** 写日志的 ABAP 程序（ALPROG）；SAP 未返回时省略。 */
  program?: string
  /** 日志模式（ALMODE，BALHDR 原始字符）；SAP 未返回时省略。 */
  mode?: string
  /**
   * 日志头声明的消息条数（MSG_CNT_AL）：无需读取消息体即可预知日志规模；
   * 为 0 或不可解析时省略。
   */
  messageCount?: number
}

/** 规范化（校验+大写化+日期换算）后的过滤器，随结果回显便于调用方核对。 */
export interface NormalizedApplicationLogFilter {
  object?: string
  objectSubobject?: string
  externalId?: string
  userName?: string
  /** 生效的日期窗口（YYYYMMDD 天粒度）；至少一侧有界时才输出。 */
  dateWindow?: { from?: string; to?: string }
  /** 生效的行数上限。 */
  maxResults: number
}

/** readApplicationLog 的返回：精简条目数组 + 统计与回显。 */
export interface ApplicationLogResult {
  /** 命中的日志头条目，按 ALDATE/ALTIME 倒序（最新在前）；无命中时为空数组。 */
  entries: ApplicationLogEntry[]
  /** 便利计数，等于 entries.length。 */
  count: number
  /**
   * true 表示返回行数已达 maxResults 上限，可能仍有更早日志未返回；
   * 调用方应缩小过滤范围或提高上限后重查，而不是假设已见全量。
   */
  truncated: boolean
  /** 本次查询实际生效的规范化过滤条件（大写化/日期换算后），便于核对与复现。 */
  appliedFilter: NormalizedApplicationLogFilter
}

/* ==========================================================================
 * 有界常量（业务规则：全部过滤参数“可选但有界”）
 * ========================================================================== */

/** maxResults 缺省值：对齐 VSP applog.go 第 74-77 行（Limit 未给时取 100）。 */
export const APPLICATION_LOG_DEFAULT_MAX_RESULTS = 100

/** maxResults 硬上限：超出直接拒绝（不静默截断），防失控读取。 */
export const APPLICATION_LOG_MAX_RESULTS_CAP = 500

/**
 * 时间窗最大跨度（天）：BALHDR 上按 ALDATE 天粒度过滤，过宽窗口等价于
 * 接近全表扫描 busy 系统日志，超出直接拒绝并提示缩小窗口。
 */
export const APPLICATION_LOG_MAX_WINDOW_DAYS = 31

/** SLG0 日志对象/子对象长度上限（DDIC 域 BALOBJ/BALSUBOBJ 均为 CHAR20）。 */
export const APPLICATION_LOG_OBJECT_MAX_LENGTH = 20

/** SAP 用户名长度上限（SY-UNAME 为 CHAR12）。 */
export const APPLICATION_LOG_USER_MAX_LENGTH = 12

/** 外部日志标识长度上限（BALHDR EXTNUMBER 为 CHAR100）。 */
export const APPLICATION_LOG_EXTERNAL_ID_MAX_LENGTH = 100

/**
 * ISO 时间窗输入的宽松校验：YYYY-MM-DD，可带 T/空格 + 时:分[:秒[.毫秒]]
 * 与 Z/±hh:mm 时区后缀。先正则锁定形状，再由 Date 验证真实日历日期
 * （如 2026-02-30 会被拒绝）。
 */
const ISO_WINDOW_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/

/**
 * 规范化并校验应用日志过滤器（本模块的单一校验入口）：
 * - object/objectSubobject/userName：trim + 大写（SAP 名称字段大小写不敏感，
 *   统一大写便于 SQL 拼装与结果核对）；
 * - externalId：trim 后按原样保留（EXTNUMBER 内容按写入原样存储，SLG1 常见
 *   为大写但程序写入可保留小写；强行大写会造成匹配不到的静默丢结果）；
 * - timeFrom/timeTo：ISO 校验并换算为 BALHDR ALDATE 的 YYYYMMDD 天粒度边界
 *   （VSP applog.go 第 128-138 行：日期/时间是两列，窗口只能按天表达；
 *   from > to 或跨度超过 31 天直接拒绝，防全表扫描）；
 * - maxResults：正整数且不超过硬上限，缺省 100。
 * 校验失败抛 Error（消息面向调用方、不含远端细节）；空白输入视为“未提供”。
 */
export function normalizeApplicationLogFilter(filter: ApplicationLogFilter = {}): NormalizedApplicationLogFilter {
  const object = normalizeLogName(filter.object, 'object', APPLICATION_LOG_OBJECT_MAX_LENGTH)
  const objectSubobject = normalizeLogName(filter.objectSubobject, 'objectSubobject', APPLICATION_LOG_OBJECT_MAX_LENGTH)
  const userName = normalizeLogName(filter.userName, 'userName', APPLICATION_LOG_USER_MAX_LENGTH)
  const externalId = normalizeExternalId(filter.externalId)

  const dateWindow = sapDateWindowFromIso(filter.timeFrom, filter.timeTo)

  const maxResults = normalizeMaxResults(filter.maxResults)

  return {
    ...(object ? { object } : {}),
    ...(objectSubobject ? { objectSubobject } : {}),
    ...(externalId ? { externalId } : {}),
    ...(userName ? { userName } : {}),
    ...(dateWindow.from || dateWindow.to ? { dateWindow } : {}),
    maxResults
  }
}

/**
 * 校验并换算时间窗为 BALHDR 天粒度边界（YYYYMMDD）。
 * - 单侧边界合法（只给 timeFrom 或只给 timeTo 均可）；
 * - 双侧同时给出时要求 timeFrom ≤ timeTo 且跨度 ≤ APPLICATION_LOG_MAX_WINDOW_DAYS；
 * - 换算取 ISO 输入的日期部分（去连字符），不做时区换算：BALHDR ALDATE 是
 *   SAP 系统本地日期，调用方按目标系统时区给入即得预期窗口（与 VSP 一致的
 *   天粒度语义，见 applog.go 第 128-138 行注释）。
 */
export function sapDateWindowFromIso(
  timeFrom?: string,
  timeTo?: string
): { from?: string; to?: string } {
  const from = timeFrom ? isoToSapDay(timeFrom, 'timeFrom') : undefined
  const to = timeTo ? isoToSapDay(timeTo, 'timeTo') : undefined

  if (from && to) {
    // YYYYMMDD 定宽字符串可直接字典序比较
    if (from > to) {
      throw new Error('timeFrom must not be later than timeTo.')
    }
    // 跨度按日历天差计算：超过上限拒绝并提示缩小窗口（防全表扫描）
    const fromUtc = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)))
    const toUtc = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)))
    const spanDays = Math.round((toUtc - fromUtc) / 86400000)
    if (spanDays > APPLICATION_LOG_MAX_WINDOW_DAYS) {
      throw new Error(
        `time window spans ${spanDays} days; narrow it to at most ${APPLICATION_LOG_MAX_WINDOW_DAYS} days to avoid unbounded full-table scans of BALHDR.`
      )
    }
  }
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

/** ISO 日期/时间戳 → YYYYMMDD（ALDATE 天粒度）；形状或日历非法即抛错。 */
function isoToSapDay(value: string, label: string): string {
  const trimmed = value.trim()
  if (!ISO_WINDOW_PATTERN.test(trimmed)) {
    throw new Error(
      `${label} must be an ISO 8601 date or timestamp such as 2026-09-01 or 2026-09-01T08:00:00.`
    )
  }
  const dayPart = trimmed.slice(0, 10)
  // 形状合法但日历不存在的输入（如 2026-02-30）必须拒绝：Date 解析会把越界
  // 分量静默滚动到下个月，因此按分量构造 UTC 再逐项回读核对是否发生滚动
  const year = Number(dayPart.slice(0, 4))
  const month = Number(dayPart.slice(5, 7))
  const day = Number(dayPart.slice(8, 10))
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid calendar date: ${dayPart}.`)
  }
  return dayPart.replace(/-/g, '')
}

/**
 * 规范化 SAP 名称类过滤字段（object/objectSubobject/userName）：
 * - 空白输入视为未提供（返回 ''，由调用方省略）；
 * - trim + 大写后校验：不超过 DDIC 长度、不含空白与控制字符
 *   （这些列的合法取值不含空白，宽松字符集 + 引号转义双保险防 SQL 注入）。
 */
function normalizeLogName(value: unknown, label: string, maxLength: number): string {
  const name = String(value ?? '').trim().toUpperCase()
  if (!name) return ''
  if (name.length > maxLength || /\s/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(
      `${label} must be at most ${maxLength} characters without whitespace or control characters.`
    )
  }
  return name
}

/**
 * 规范化外部日志标识（EXTNUMBER）：trim 后按原样保留大小写（见
 * normalizeApplicationLogFilter 注释），拒绝控制字符并限制 CHAR100 长度；
 * 单引号由 sqlQuote 在拼 SQL 时转义。
 */
function normalizeExternalId(value: unknown): string {
  const id = String(value ?? '').trim()
  if (!id) return ''
  if (id.length > APPLICATION_LOG_EXTERNAL_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(
      `externalId must be at most ${APPLICATION_LOG_EXTERNAL_ID_MAX_LENGTH} characters without control characters.`
    )
  }
  return id
}

/** 规范化 maxResults：缺省 100；必须为 1..500 的整数，否则拒绝。 */
function normalizeMaxResults(value: unknown): number {
  if (value === undefined || value === null) return APPLICATION_LOG_DEFAULT_MAX_RESULTS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > APPLICATION_LOG_MAX_RESULTS_CAP) {
    throw new Error(
      `maxResults must be an integer between 1 and ${APPLICATION_LOG_MAX_RESULTS_CAP}.`
    )
  }
  return value
}

/**
 * sqlQuote：Open SQL 字符串字面量的唯一转义是单引号翻倍（对齐 VSP
 * applog.go 第 142-145 行）。配合名称字段的字符白名单与 externalId 的控制
 * 字符拒绝，值无法逃出字面量，结构性杜绝 SQL 注入。
 */
function sqlQuote(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * 按空白折行自由 SQL（逐行移植 VSP client.go wrapSQL，第 1274-1309 行）：
 * 数据预览服务把请求体装进 255 字符的 ABAP 源代码行，被硬切开的字面量或
 * 列名会成为语法错误；因此超过 200 字符（预留安全余量）在引号外的空白处
 * 换行，引号内的空白（字面量内容）绝不折行。行长按 UTF-8 字节数估算，避免
 * 多字节字符（如中文外部标识）低估实际行长。
 */
function wrapSqlAtBlank(query: string): string {
  const limit = 200
  const byteLength = (text: string): number => {
    // UTF-8 字节数估算：0x80 以下 1 字节，其余按 BMP/增补平面分别 2/3/4 字节
    let bytes = 0
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    }
    return bytes
  }

  let out = ''
  let lineLen = 0
  let inQuote = false
  let start = 0
  const emit = (word: string): void => {
    if (!word) return
    if (lineLen > 0 && lineLen + 1 + byteLength(word) > limit) {
      out += '\n'
      lineLen = 0
    } else if (lineLen > 0) {
      out += ' '
      lineLen += 1
    }
    out += word
    lineLen += byteLength(word)
  }
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]
    if (ch === "'") {
      // 单引号在字面量进出与翻倍转义间切换；成对出现时状态回到原位
      inQuote = !inQuote
    } else if (ch === ' ' || ch === '\n') {
      if (inQuote) continue
      emit(query.slice(start, i))
      start = i + 1
      if (ch === '\n') {
        out += '\n'
        lineLen = 0
      }
    }
  }
  emit(query.slice(start))
  return out
}

/**
 * 拼装 BALHDR 查询 SQL（列清单/排序逐字对齐 VSP applog.go 第 80/84 行，
 * WHERE 语义对齐第 116-140 行 appLogWhere；本项目按任务参数表增加 VSP 没有
 * 的 extnumber 等值条件）并做行宽折行。
 */
function buildApplicationLogQuery(filter: NormalizedApplicationLogFilter): string {
  let query =
    'SELECT lognumber, log_handle, object, subobject, extnumber, aldate, altime, aluser, alprog, almode, msg_cnt_al FROM balhdr'

  // WHERE 各条件按固定顺序拼装，全部为“列 = '值'”等值或 ALDATE 闭区间比较
  const terms: string[] = []
  const addEquals = (column: string, value?: string): void => {
    if (value) terms.push(`${column} = '${sqlQuote(value)}'`)
  }
  addEquals('object', filter.object)
  addEquals('subobject', filter.objectSubobject)
  addEquals('extnumber', filter.externalId)
  addEquals('aluser', filter.userName)
  // 日期/时间是两列，窗口只能按 ALDATE 天粒度表达（见 sapDateWindowFromIso 注释）
  if (filter.dateWindow?.from) terms.push(`aldate >= '${filter.dateWindow.from}'`)
  if (filter.dateWindow?.to) terms.push(`aldate <= '${filter.dateWindow.to}'`)

  if (terms.length > 0) query += ` WHERE ${terms.join(' AND ')}`
  // 最新日志在前（与 SLG1 的查看习惯一致）
  query += ' ORDER BY aldate DESCENDING, altime DESCENDING'
  return wrapSqlAtBlank(query)
}

/**
 * 读取 BAL 应用日志头（readApplicationLog 工具的底层实现）。
 * 发一条只读 SELECT 数据预览请求并解析为精简条目数组；HTTP 层错误原样
 * 向上传播，行解析失败不抛错（空结果容错，对齐 CdsDependencyApi 语义）。
 *
 * @param h 已登录的 AdtHTTP 会话（窄接口注入，绝不接受调用方传入的任意 URL）
 * @param filter 可选过滤条件，全部有界（见 ApplicationLogFilter 注释）
 */
export async function readApplicationLog(
  h: AdtHTTP,
  filter: ApplicationLogFilter = {}
): Promise<ApplicationLogResult> {
  // 校验与规范化在发请求前完成：非法输入在本地拒绝，不产生任何 SAP 调用
  const normalized = normalizeApplicationLogFilter(filter)
  const sql = buildApplicationLogQuery(normalized)

  // decode=false：保留 ALDATE/ALTIME 等原始字符串，由本模块自行合并时间戳
  // （runQuery 的自动解码会把 DATS 转成 Date，粒度不受控，见 tablecontents.ts）
  const response = await runQuery(h, sql, normalized.maxResults, false)

  try {
    return toApplicationLogResult(response?.values ?? [], normalized)
  } catch (error) {
    throw new Error(
      `failed to read the application log: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** 行集合 → 结果（条目裁剪 + truncated 判定 + 过滤器回显）。 */
function toApplicationLogResult(
  values: unknown[],
  filter: NormalizedApplicationLogFilter
): ApplicationLogResult {
  const rows = Array.isArray(values) ? values : []
  const entries = rows.map(rowToEntry)
  return {
    entries,
    count: entries.length,
    // 行数打满上限即保守标记可能截断（对齐 sm21Read 的 truncated 语义）
    truncated: rows.length >= filter.maxResults,
    appliedFilter: filter
  }
}

/**
 * BALHDR 查询结果一行 → 精简日志头条目（字段映射对齐 VSP applog.go 第
 * 94-109 行）：仅 logNumber 恒输出（VSP 中唯一无 omitempty 的字段），其余
 * 字段仅在 SAP 有值时输出，避免给调用方塞一堆空串。
 */
function rowToEntry(row: unknown): ApplicationLogEntry {
  const logNumber = cell(row, 'LOGNUMBER')
  const logHandle = cell(row, 'LOG_HANDLE')
  const object = cell(row, 'OBJECT')
  const subObject = cell(row, 'SUBOBJECT')
  const externalId = cell(row, 'EXTNUMBER')
  const user = cell(row, 'ALUSER')
  const program = cell(row, 'ALPROG')
  const mode = cell(row, 'ALMODE')
  const timestamp = parseSapStamp(cell(row, 'ALDATE'), cell(row, 'ALTIME'))
  // 消息计数为数值列，非数字（空/异常）按 0 处理并在输出中省略
  const rawCount = cell(row, 'MSG_CNT_AL')
  const messageCount = /^\d+$/.test(rawCount) ? parseInt(rawCount, 10) : 0

  return {
    logNumber,
    ...(logHandle ? { logHandle } : {}),
    ...(object ? { object } : {}),
    ...(subObject ? { subObject } : {}),
    ...(externalId ? { externalId } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(user ? { user } : {}),
    ...(program ? { program } : {}),
    ...(mode ? { mode } : {}),
    ...(messageCount > 0 ? { messageCount } : {})
  }
}

/**
 * SAP 分列时间戳 → ISO 本地时间字符串：ALDATE(YYYYMMDD) + ALTIME(HHMMSS)。
 * 日期非 8 位数字视为不可解析（返回 ''，条目省略 timestamp 字段）；时间位
 * 异常时按 000000 兜底——一条日期异常的日志仍是日志，不因此丢行（对齐 VSP
 * parseSAPStamp 语义，applog.go 第 147-163 行）。
 */
function parseSapStamp(date: string, clock: string): string {
  if (!/^\d{8}$/.test(date)) return ''
  if (!/^\d{6}$/.test(clock)) clock = '000000'
  return (
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
    `T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}`
  )
}

/**
 * 从查询结果行中读一列（对齐 VSP applog.go 第 165-180 行 cell）：ADT 数据
 * 预览返回的列名大小写随系统/查询书写漂移，依次尝试原样/小写/全大写键；
 * 值统一 trim 为字符串，null/undefined 视为空。
 */
function cell(row: unknown, column: string): string {
  if (!row || typeof row !== 'object') return ''
  const record = row as Record<string, unknown>
  const value = record[column] ?? record[column.toLowerCase()] ?? record[column.toUpperCase()]
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/* ==========================================================================
 * 客户端绑定（供后续集成任务接线的注入点；本任务不改动 AdtClient/index）
 * ========================================================================== */

/** readApplicationLog 能力的窄接口；ApplicationLogHandlers 以此为构造注入边界。 */
export interface ApplicationLogClient {
  readApplicationLog(filter?: ApplicationLogFilter): Promise<ApplicationLogResult>
}

/**
 * 把 AdtHTTP 会话绑定成 ApplicationLogClient。
 * 集成任务接线方式：createApplicationLogClient(client.h)（AdtClient 通过公开
 * getter `h` 暴露内部 AdtHTTP 会话）；风格对齐 CdsDependencyApi.createCdsAnalysisClient。
 */
export function createApplicationLogClient(h: AdtHTTP): ApplicationLogClient {
  return {
    readApplicationLog: filter => readApplicationLog(h, filter)
  }
}
