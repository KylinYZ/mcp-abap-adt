import { AdtHTTP } from './AdtHTTP'
import { nodeContents } from './api/nodeContents'

/**
 * ============================================================================
 * 源码内容正则搜索只读 ADT API（关闭能力矩阵缺口 search.content-grep）
 * ============================================================================
 *
 * 本文件提供两个纯只读的"源码内容 grep"能力，语义对齐 VSP vibing-steampunk
 * 的 SAP(action=grep) 与 focused GrepObjects / GrepPackages 任务
 * （VSP 底层实现：pkg/adt/workflows_grep.go 的 GrepPackage / GrepObjects /
 * GrepObject / isSourceObject，包枚举来自 pkg/adt/client.go 的 GetPackage；
 * 本文件为客户端本地匹配复刻，VSP 仓库只读参考、未做任何修改）：
 *
 *   1. grepPackage —— 给定包名 + 正则，枚举包内源码对象后逐个拉源码本地匹配
 *   2. grepObjects —— 给定显式对象名列表（1..20）+ 正则，逐个拉源码本地匹配
 *
 * 与 VSP 同源的语义（业务规则）：
 *   - 匹配是"客户端本地"的：先向 ADT 读取源码文本（GET + Accept: text/plain），
 *     再按行做正则匹配；ADT 服务端不参与匹配。
 *   - 只搜索"源码对象"：包枚举结果按 VSP isSourceObject 白名单过滤
 *     （PROG/P、CLAS/OC、INTF/OI、FUGR/F、FUGR/FF、PROG/I），并按本项目矩阵
 *     扩展纳入 CDS DDL 源（DDLS）；表/结构等非源码对象一律跳过。
 *   - 容错聚合：单个对象源码读取失败不中断整体，记入 skipped（对齐 VSP
 *     GrepObjects 的 Unsearched 语义——"没搜到的不许冒充搜过了"）。
 *   - 结果只含命中对象；聚合摘要写入 message（对齐 VSP Message 语义）。
 *
 * 与 VSP 的刻意差异（本项目安全边界）：
 *   - VSP 的 GrepObjects 接受任意对象 URL；本项目绝不接受调用方传入的任意
 *     URL，对象 URI 一律由"对象名 + 类型白名单"在服务端推导（grepObjects）
 *     或直接采用 SAP nodestructure 回读的 URI（grepPackage）。
 *   - VSP 读取源码失败时把远端错误文本放进结果；本项目 skipped[].reason 只写
 *     固定分类文案，绝不外泄远端响应细节。
 *   - VSP 包枚举失败返回 Success=false；本项目让错误向上传播，由 handler
 *     统一脱敏（对齐 CdsDependencyApi 的错误传播风格）。
 *
 * 安全与有界性（重点，业务规则）：
 *   - ReDoS 边界说明：本实现不做完整的 ReDoS 防御（没有正则执行超时/步数
 *     限制），风险被以下多重有界性收敛到可接受范围：
 *       1) pattern 长度 <= SOURCE_GREP_MAX_PATTERN_LENGTH，且编译失败在发出
 *          任何 HTTP 请求之前即被拒绝；
 *       2) 匹配单元是"单行文本"（SAP 源码单行长度有限），而非任意大字符串；
 *       3) 单对象源码总量受 ADT 源码大小上限约束，行数有限；
 *       4) 每包枚举对象数、命中对象数（maxResults）、单对象返回匹配条数、
 *          返回文本长度均另有硬上限（见下方常量）。
 *     因此最坏情况是"慢"，不会造成内存放大或无界输出。
 *   - 真实 SAP 调用保持串行（AGENTS.md：SAP_MCP_MAX_CONCURRENT_TOOLS=1），
 *     对象逐个顺序读取，不做并发拉取。
 */

/* ==========================================================================
 * 有界性常量（所有输出规模上限集中在这里，注释说明各自的业务理由）
 * ========================================================================== */

/** pattern 最大长度：限制调用方可提交的正则长度，超长直接拒绝（ReDoS 第一道闸）。 */
export const SOURCE_GREP_MAX_PATTERN_LENGTH = 256
/** 每条匹配可携带的上下文行数上限（默认 0 = 不带上下文）。 */
export const SOURCE_GREP_MAX_CONTEXT_LINES = 5
/** grepPackage 命中对象数默认上限（对齐项目内其它搜索类工具的默认 100）。 */
export const SOURCE_GREP_DEFAULT_MAX_RESULTS = 100
/** grepPackage 命中对象数硬上限。 */
export const SOURCE_GREP_MAX_MAX_RESULTS = 500
/** 每包最多枚举并搜索的源码对象数：包可以极大（如 $TMP），必须封顶防止
 *  一次工具调用演变成无界长事务；超出部分置 truncated=true 如实告知。 */
export const SOURCE_GREP_MAX_OBJECTS_PER_PACKAGE = 200
/** grepObjects 显式对象名列表长度上限（工具入参边界，超出拒绝而非截断）。 */
export const SOURCE_GREP_MAX_OBJECTS = 20
/** 匹配行 / 上下文行文本的最大回显长度：防止超长源码行撑爆结果体积。 */
export const SOURCE_GREP_MAX_LINE_LENGTH = 200
/** 单对象最多返回的匹配条数：源码里命中再多也只回显前 N 条明细
 *  （matchCount 仍如实统计全部命中，见 matchSourceLines）。 */
export const SOURCE_GREP_MAX_MATCHES_PER_OBJECT = 200
/** 包名 / 对象名长度上限（SAP 名称标准上限 30，留出命名空间/本地包余量）。 */
export const SOURCE_GREP_NAME_MAX_LENGTH = 40

/* ==========================================================================
 * 输入 / 输出类型
 * ========================================================================== */

/** grepObjects 支持的源码对象类型（基础类型，服务端据此推导 ADT URI）。 */
export type SourceGrepObjectType = 'PROG' | 'CLAS' | 'INTF' | 'FUGR' | 'INCL' | 'DDLS'

/** grepObjects 的对象类型白名单（handler schema enum 与校验共用）。 */
export const SOURCE_GREP_OBJECT_TYPES: SourceGrepObjectType[] = [
  'PROG',
  'CLAS',
  'INTF',
  'FUGR',
  'INCL',
  'DDLS'
]

/** grepObjects 输入中的单个对象引用：对象名 + 允许清单内的类型。 */
export interface SourceGrepObjectRef {
  /** 对象名，例如 ZCL_FOO / ZREPORT / ZC_TRAVEL_U；内部统一规范为大写。 */
  name: string
  /** 对象类型（决定服务端推导的 ADT URI 模板）。 */
  objectType: SourceGrepObjectType
}

/** grepPackage 输入。 */
export interface GrepPackageInput {
  /** 包名（可为 $TMP 等本地包或含命名空间的包），内部统一大写。 */
  packageName: string
  /** JavaScript 正则表达式（不加标志；caseInsensitive 时内部加 i）。 */
  pattern: string
  /** 可选对象类型过滤；条目可与 nodestructure 类型全等或按前缀匹配（如 PROG 匹配 PROG/P）。 */
  objectTypes?: string[]
  /** 是否忽略大小写，默认 false。 */
  caseInsensitive?: boolean
  /** 命中对象数上限，默认 100、最大 500。 */
  maxResults?: number
  /** 每条匹配携带的上下文行数，默认 0、最大 5。 */
  contextLines?: number
}

/** grepObjects 输入。 */
export interface GrepObjectsInput {
  /** 显式对象引用列表（1..20 个），URI 由服务端从 name+objectType 推导。 */
  objects: SourceGrepObjectRef[]
  /** JavaScript 正则表达式。 */
  pattern: string
  /** 是否忽略大小写，默认 false。 */
  caseInsensitive?: boolean
  /** 每条匹配携带的上下文行数，默认 0、最大 5。 */
  contextLines?: number
}

/** 单条匹配：1 起始行号 + 匹配行文本（截断）+ 可选上下文行。 */
export interface SourceGrepMatch {
  /** 1 起始的行号（对齐 VSP GrepMatch.LineNumber）。 */
  lineNumber: number
  /** 匹配行文本（去除行尾 CR 后截断至 SOURCE_GREP_MAX_LINE_LENGTH）。 */
  matchedLine: string
  /** 匹配行之前的上下文（contextLines>0 且存在时输出）。 */
  contextBefore?: string[]
  /** 匹配行之后的上下文（contextLines>0 且存在时输出）。 */
  contextAfter?: string[]
}

/** 单个对象的命中结果（只回显对象名/类型/URI 与匹配明细，绝不返回全量源码）。 */
export interface SourceGrepObjectResult {
  /** 对象名。 */
  objectName: string
  /** 对象类型（包枚举场景为 nodestructure 原值如 PROG/P；grepObjects 为调用方指定基础类型）。 */
  objectType: string
  /** 对象主 ADT URI（SAP 回读或服务端推导，非调用方输入；不含 /source/main 后缀）。 */
  objectUri: string
  /** 该对象命中的总条数（含因上限未回显明细的命中）。 */
  matchCount: number
  /** 匹配明细（最多 SOURCE_GREP_MAX_MATCHES_PER_OBJECT 条）。 */
  matches: SourceGrepMatch[]
  /** 命中数超出明细上限时为 true（明细被截断）。 */
  matchesTruncated?: boolean
}

/** 被跳过（未能搜索）的对象：reason 只写固定分类文案，不透传远端细节。 */
export interface SourceGrepSkipped {
  /** 对象名。 */
  objectName: string
  /** 对象类型（可得时输出）。 */
  objectType?: string
  /** 固定分类原因：'missing object URI' 或 'failed to read source'。 */
  reason: string
}

/** 两个 grep 工具共享的聚合结果（对齐 VSP GrepPackageResult/GrepObjectsResult）。 */
export interface SourceGrepResult {
  /** 搜索范围：单个包（package）或显式对象列表（objects）。 */
  scope: 'package' | 'objects'
  /** scope=package 时的规范化包名。 */
  packageName?: string
  /** 回显生效的正则与大小写设置，便于调用方核对。 */
  pattern: string
  caseInsensitive: boolean
  /** 命中对象列表（只含有匹配的对象，对齐 VSP 语义）。 */
  objects: SourceGrepObjectResult[]
  /** 全部对象命中条数之和。 */
  totalMatches: number
  /** 实际成功读取源码并匹配的对象数（不含 skipped）。 */
  searchedObjects: number
  /** 未能搜索的对象清单（对齐 VSP Unsearched）。 */
  skipped: SourceGrepSkipped[]
  /** 枚举截断（包内源码对象超上限）或命中对象达 maxResults 截断时为 true。 */
  truncated: boolean
  /** 聚合摘要（对齐 VSP Message）。 */
  message: string
}

/* ==========================================================================
 * 源码对象类型过滤（对齐 VSP isSourceObject）
 * ========================================================================== */

/**
 * VSP isSourceObject 白名单（pkg/adt/workflows_grep.go 第 387-397 行逐字对齐）：
 * 仅这些 nodestructure OBJECT_TYPE 被视为"含可搜索源码"的对象。
 */
const VSP_SOURCE_OBJECT_TYPES = new Set([
  'PROG/P', // Reports（报表程序）
  'CLAS/OC', // Classes（类）
  'INTF/OI', // Interfaces（接口）
  'FUGR/F', // Function groups（函数组）
  'FUGR/FF', // Function modules（函数模块）
  'PROG/I' // Includes（包含程序）
])

/**
 * 判断 nodestructure 返回的对象类型是否为可搜索源码对象。
 * - 精确命中 VSP isSourceObject 白名单；
 * - 本项目扩展：CDS DDL 源（DDLS / DDLS/DDLS 等形式）同样是可读源码对象，
 *   VSP 的 GrepPackage 未纳入 CDS，矩阵缺口描述明确要求覆盖，故在此补齐。
 */
export function isSourceObjectType(objectType: string): boolean {
  const type = String(objectType || '').toUpperCase()
  if (VSP_SOURCE_OBJECT_TYPES.has(type)) return true
  return type === 'DDLS' || type.startsWith('DDLS/')
}

/**
 * objectTypes 过滤匹配规则：条目与对象类型全等，或作为类型前缀（"X" 匹配
 * "X/任何子类型"，例如 PROG 同时命中 PROG/P 与 PROG/I；"FUGR/FF" 只精确命中）。
 */
export function matchesTypeFilter(objectType: string, filters: string[]): boolean {
  const type = String(objectType || '').toUpperCase()
  return filters.some(filter => type === filter || type.startsWith(`${filter}/`))
}

/**
 * 由对象主 URI 与类型推导实际 GET 的源码 URL：
 * - CDS DDL 源码挂在对象 URI 本身（GET + Accept: text/plain 直接返回 DDL 文本）；
 * - ABAP 源对象的主源码在 <对象URI>/source/main（对齐 VSP GrepObject 的
 *   sourceURL 规则：不以 /source/main 结尾则追加）。
 */
export function sourceReadUrl(objectUri: string, objectType: string): string {
  if (/^DDLS(\/|$)/.test(String(objectType || '').toUpperCase())) return objectUri
  return objectUri.endsWith('/source/main') ? objectUri : `${objectUri}/source/main`
}

/* ==========================================================================
 * 输入规范化（对齐 CdsDependencyApi 的 normalize 风格：大写 + 白名单字符）
 * ========================================================================== */

/** 对象名字符白名单：字母/数字/下划线，命名空间对象允许斜杠（/FOO/CL_BAR）。 */
const SAP_OBJECT_NAME_PATTERN = /^[A-Z0-9_/]+$/
/** 包名字符白名单：额外允许 $（本地包如 $TMP）与命名空间斜杠。 */
const SAP_PACKAGE_NAME_PATTERN = /^[A-Z0-9_$/]+$/

/**
 * 规范化 SAP 包名/对象名：去空白、统一大写；非空、长度受限、字符命中
 * SAP 命名白名单，否则直接抛错（绝不静默截断），保证后续拼 URL 的安全性。
 */
function normalizeSapName(value: unknown, capability: string, kind: 'object' | 'package'): string {
  const name = String(value ?? '').trim().toUpperCase()
  const field = kind === 'package' ? 'packageName' : 'objectName'
  const allowed =
    kind === 'package'
      ? 'letters, digits, underscore, $ (local packages) and / (namespaces)'
      : 'letters, digits, underscore and / (namespaces)'
  if (
    !name
    || name.length > SOURCE_GREP_NAME_MAX_LENGTH
    || !(kind === 'package' ? SAP_PACKAGE_NAME_PATTERN : SAP_OBJECT_NAME_PATTERN).test(name)
  ) {
    throw new Error(
      `${capability}: ${field} must be a non-empty SAP name of at most ${SOURCE_GREP_NAME_MAX_LENGTH} characters (${allowed}).`
    )
  }
  return name
}

/** 规范化 objectTypes 过滤条目：大写 + 字符白名单 + 数量/长度有界。 */
function normalizeTypeFilter(value: unknown, capability: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error(`${capability}: objectTypes must be an array of at most 10 type strings.`)
  }
  return value.map(entry => {
    const type = String(entry ?? '').trim().toUpperCase()
    if (!type || type.length > 30 || !/^[A-Z0-9_/]+$/.test(type)) {
      throw new Error(
        `${capability}: each objectTypes entry must be 1-30 characters of letters, digits, underscore or slash.`
      )
    }
    return type
  })
}

/** 夹取 contextLines 到 0..SOURCE_GREP_MAX_CONTEXT_LINES（非数字按默认 0）。 */
function clampContextLines(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
  return Math.min(Math.max(raw, 0), SOURCE_GREP_MAX_CONTEXT_LINES)
}

/** 夹取 maxResults 到 1..SOURCE_GREP_MAX_MAX_RESULTS（缺省按默认 100）。 */
function clampMaxResults(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : SOURCE_GREP_DEFAULT_MAX_RESULTS
  return Math.min(Math.max(raw, 1), SOURCE_GREP_MAX_MAX_RESULTS)
}

/**
 * 编译正则 pattern（业务规则）：
 * - 非空、长度 <= SOURCE_GREP_MAX_PATTERN_LENGTH；
 * - 编译失败转为友好失败（带原始语法错误摘要），在任何 HTTP 请求之前抛出；
 * - 不加 g 标志：逐行 regex.test 不依赖 lastIndex，避免全局标志的状态残留问题；
 *   caseInsensitive 时仅加 i 标志（等价 VSP 的 "(?i)" 前缀）。
 */
function compileSourceGrepPattern(pattern: unknown, capability: string, caseInsensitive: boolean): RegExp {
  const raw = typeof pattern === 'string' ? pattern : ''
  if (!raw || raw.length > SOURCE_GREP_MAX_PATTERN_LENGTH) {
    throw new Error(
      `${capability}: pattern must be a non-empty regular expression of at most ${SOURCE_GREP_MAX_PATTERN_LENGTH} characters.`
    )
  }
  try {
    return new RegExp(raw, caseInsensitive ? 'i' : '')
  } catch (error) {
    throw new Error(
      `${capability}: invalid regex pattern (${error instanceof Error ? error.message : String(error)}).`
    )
  }
}

/* ==========================================================================
 * 内部结构：待搜索候选（grepPackage 与 grepObjects 归一化后的统一形状）
 * ========================================================================== */

interface GrepCandidate {
  /** 展示用对象名。 */
  objectName: string
  /** 展示用对象类型。 */
  objectType: string
  /** 对象主 URI（结果回显；不含 /source/main）。 */
  objectUri: string
  /** 实际 GET 的源码 URL。 */
  sourceUrl: string
}

/** grepObjects 的 URI 模板：服务端从对象名+类型推导，绝不接受调用方传 URL。
 *  注：函数模块（FUGR/FF）需父函数组名才能定位 URI，因此不在显式列表类型中；
 *  函数模块源码可改用 grepPackage 在其函数组/包内搜索（包枚举含 FUGR/FF）。 */
const GREP_OBJECT_URI_TEMPLATES: Record<SourceGrepObjectType, (name: string) => string> = {
  PROG: name => `/sap/bc/adt/programs/programs/${name.toLowerCase()}`,
  CLAS: name => `/sap/bc/adt/oo/classes/${name.toLowerCase()}`,
  INTF: name => `/sap/bc/adt/oo/interfaces/${name.toLowerCase()}`,
  FUGR: name => `/sap/bc/adt/functions/groups/${name.toLowerCase()}`,
  INCL: name => `/sap/bc/adt/programs/includes/${name.toLowerCase()}`,
  DDLS: name => `/sap/bc/adt/ddic/ddl/sources/${name.toLowerCase()}`
}

/* ==========================================================================
 * 核心匹配逻辑：单对象源码读取 + 逐行正则匹配
 * ========================================================================== */

/** 行文本截断：去除行尾 CR 后限制回显长度（对超长源码行保持输出有界）。 */
function truncateLine(line: string): string {
  const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line
  return cleaned.length > SOURCE_GREP_MAX_LINE_LENGTH
    ? cleaned.slice(0, SOURCE_GREP_MAX_LINE_LENGTH)
    : cleaned
}

/**
 * 在源码文本中逐行匹配正则（对齐 VSP GrepObject 的匹配语义）：
 * - 按 "\n" 切行，行号 1 起始；
 * - matchCount 如实统计全部命中（完整扫描源码），但明细只保留前
 *   SOURCE_GREP_MAX_MATCHES_PER_OBJECT 条，超出置 matchesTruncated=true，
 *   保证结果体积有界；
 * - contextLines>0 时携带前后上下文（同样截断，越界自动收缩）。
 */
function matchSourceLines(
  source: string,
  regex: RegExp,
  contextLines: number
): { matches: SourceGrepMatch[]; matchCount: number; matchesTruncated: boolean } {
  const lines = source.split('\n')
  const matches: SourceGrepMatch[] = []
  let matchCount = 0
  let matchesTruncated = false

  for (let i = 0; i < lines.length; i++) {
    // 业务规则：正则必须对"完整行"（仅去行尾 CR）做 test，保证截断展示
    // 不影响命中判定；SOURCE_GREP_MAX_LINE_LENGTH 只用于结果回显裁剪
    const cleaned = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]
    if (!regex.test(cleaned)) continue
    matchCount++

    if (matches.length >= SOURCE_GREP_MAX_MATCHES_PER_OBJECT) {
      // 明细已满：只计数，不再累积上下文，避免无界输出
      matchesTruncated = true
      continue
    }

    const match: SourceGrepMatch = { lineNumber: i + 1, matchedLine: truncateLine(cleaned) }
    if (contextLines > 0) {
      const before = lines.slice(Math.max(0, i - contextLines), i).map(truncateLine)
      const after = lines.slice(i + 1, i + 1 + contextLines).map(truncateLine)
      if (before.length > 0) match.contextBefore = before
      if (after.length > 0) match.contextAfter = after
    }
    matches.push(match)
  }

  return { matches, matchCount, matchesTruncated }
}

/**
 * 读取单个对象的源码并匹配（VSP 来源：pkg/adt/workflows_grep.go GrepObject）：
 *   GET <源码URL>   Accept: text/plain
 * 源码读取失败返回 undefined（不抛出），由调用方记入 skipped——
 * 单对象失败不中断整体（对齐 VSP 容错聚合语义）。
 */
async function grepSingleObject(
  h: AdtHTTP,
  candidate: GrepCandidate,
  regex: RegExp,
  contextLines: number
): Promise<SourceGrepObjectResult | undefined> {
  try {
    const response = await h.request(candidate.sourceUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' }
    })
    const source = String(response?.body ?? '')
    const { matches, matchCount, matchesTruncated } = matchSourceLines(source, regex, contextLines)
    return {
      objectName: candidate.objectName,
      objectType: candidate.objectType,
      objectUri: candidate.objectUri,
      matchCount,
      matches,
      ...(matchesTruncated ? { matchesTruncated } : {})
    }
  } catch {
    // 源码读取失败（404/403/网络等）：跳过并记录，原因使用固定文案，
    // 绝不把远端错误细节写进结果（结果经 handler 原样返回，无法二次脱敏）
    return undefined
  }
}

/**
 * 顺序搜索候选对象并聚合（grepPackage / grepObjects 共用）：
 * - 串行 await（真实 SAP 调用保持串行，项目安全边界）；
 * - 只保留命中对象（对齐 VSP：无匹配对象不进入结果列表）；
 * - 命中对象数达到 maxResults 且仍有未检查候选时立即停止并置 truncated=true
 *   （对齐 VSP maxResults break 语义：不多读一个；grepObjects 传入
 *   maxResults=候选总数，全命中也不会误报截断）；
 * - 读取失败对象记入 skipped，不影响其余对象。
 */
async function searchCandidates(
  h: AdtHTTP,
  candidates: GrepCandidate[],
  regex: RegExp,
  contextLines: number,
  maxResults: number
): Promise<{ objects: SourceGrepObjectResult[]; skipped: SourceGrepSkipped[]; totalMatches: number; searchedObjects: number; truncated: boolean }> {
  const objects: SourceGrepObjectResult[] = []
  const skipped: SourceGrepSkipped[] = []
  let totalMatches = 0
  let searchedObjects = 0
  let truncated = false

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]

    // 缺 URI 的枚举节点无法读取源码：记入 skipped 而不是静默丢弃
    if (!candidate.sourceUrl) {
      skipped.push({ objectName: candidate.objectName, objectType: candidate.objectType, reason: 'missing object URI' })
      continue
    }

    const result = await grepSingleObject(h, candidate, regex, contextLines)
    if (!result) {
      skipped.push({
        objectName: candidate.objectName,
        objectType: candidate.objectType,
        reason: 'failed to read source'
      })
      continue
    }

    searchedObjects++
    if (result.matchCount > 0) {
      objects.push(result)
      totalMatches += result.matchCount
      // 已达命中对象上限且后面还有候选未检查：如实告知截断（对齐 VSP break 语义）
      if (objects.length >= maxResults && index < candidates.length - 1) {
        truncated = true
        break
      }
    }
  }

  return { objects, skipped, totalMatches, searchedObjects, truncated }
}

/** 聚合 message 追加项：skipped 与截断提示（VSP UnsearchedNote 的等价语义）。 */
function appendNotes(message: string, skippedCount: number, truncated: boolean): string {
  let result = message
  if (skippedCount > 0) {
    result += `; skipped ${skippedCount} object(s) that could not be searched`
  }
  if (truncated) {
    result += '; results truncated'
  }
  return result
}

/* ==========================================================================
 * 1. grepPackage —— 包内源码内容正则搜索
 * ==========================================================================
 * VSP 来源：pkg/adt/workflows_grep.go 的 GrepPackage（包枚举来自
 * pkg/adt/client.go 的 GetPackage）。
 *
 * 包枚举端点（与 VSP GetPackage 一致，也复用本项目 api/nodeContents.ts）：
 *   POST /sap/bc/adt/repository/nodestructure
 *        ?parent_type=DEVC/K&parent_name=<包名>&withShortDescriptions=true
 * 返回 asx:abap > asx:values > DATA > TREE_CONTENT 下的
 * SEU_ADT_REPOSITORY_OBJ_NODE 节点（OBJECT_TYPE/OBJECT_NAME/OBJECT_URI）。
 * DEVC/K 节点是子包：与 VSP GrepPackage 一致不递归（递归属 GrepPackages
 * 语义，本工具不覆盖，避免单次调用放大为无界遍历）。
 */
export async function grepPackage(h: AdtHTTP, input: GrepPackageInput): Promise<SourceGrepResult> {
  // 输入规范化失败（名字/正则非法）在发出任何请求前抛错
  const packageName = normalizeSapName(input?.packageName, 'grepPackage', 'package')
  const caseInsensitive = input?.caseInsensitive === true
  const regex = compileSourceGrepPattern(input?.pattern, 'grepPackage', caseInsensitive)
  const contextLines = clampContextLines(input?.contextLines)
  const maxResults = clampMaxResults(input?.maxResults)
  const typeFilter = normalizeTypeFilter(input?.objectTypes, 'grepPackage')

  // 1. 枚举包内容（VSP GetPackage 端点，解析复用本项目 nodeContents）
  const tree = await nodeContents(h, 'DEVC/K', packageName)

  // 2. 收集源码对象候选：跳过子包与非源码类型，再叠加 objectTypes 过滤；
  //    候选数量封顶 SOURCE_GREP_MAX_OBJECTS_PER_PACKAGE，超出置 truncated
  const candidates: GrepCandidate[] = []
  let enumeratedTruncated = false
  for (const node of tree.nodes) {
    if (node.OBJECT_TYPE === 'DEVC/K') continue // 子包不递归（对齐 VSP GrepPackage）
    if (!isSourceObjectType(node.OBJECT_TYPE)) continue // 表/结构等非源码对象跳过
    if (typeFilter.length > 0 && !matchesTypeFilter(node.OBJECT_TYPE, typeFilter)) continue
    if (candidates.length >= SOURCE_GREP_MAX_OBJECTS_PER_PACKAGE) {
      enumeratedTruncated = true
      break
    }
    candidates.push({
      objectName: String(node.OBJECT_NAME || ''),
      objectType: String(node.OBJECT_TYPE || ''),
      objectUri: String(node.OBJECT_URI || ''),
      sourceUrl: sourceReadUrl(String(node.OBJECT_URI || ''), String(node.OBJECT_TYPE || ''))
    })
  }

  // 3. 逐个串行读取源码并本地匹配
  const { objects, skipped, totalMatches, searchedObjects, truncated: hitsTruncated } =
    await searchCandidates(h, candidates, regex, contextLines, maxResults)
  const truncated = enumeratedTruncated || hitsTruncated

  const message =
    totalMatches === 0
      ? `No matches found in package ${packageName}`
      : `Found ${totalMatches} match(es) across ${objects.length} object(s) in package ${packageName}`

  return {
    scope: 'package',
    packageName,
    pattern: String(input?.pattern ?? ''),
    caseInsensitive,
    objects,
    totalMatches,
    searchedObjects,
    skipped,
    truncated,
    message: appendNotes(message, skipped.length, truncated)
  }
}

/* ==========================================================================
 * 2. grepObjects —— 显式对象名列表的源码内容正则搜索
 * ==========================================================================
 * VSP 来源：pkg/adt/workflows_grep.go 的 GrepObjects / GrepObject。
 * 与 VSP 的差异：VSP 接受任意对象 URL；本项目只接受"对象名 + 类型白名单"，
 * URI 由服务端按 GREP_OBJECT_URI_TEMPLATES 推导（项目安全边界：不接受任意 URL）。
 */
export async function grepObjects(h: AdtHTTP, input: GrepObjectsInput): Promise<SourceGrepResult> {
  const caseInsensitive = input?.caseInsensitive === true
  const regex = compileSourceGrepPattern(input?.pattern, 'grepObjects', caseInsensitive)
  const contextLines = clampContextLines(input?.contextLines)

  // 对象列表校验：1..20 个；每个对象名走 SAP 命名白名单，类型必须在白名单内
  const refs = Array.isArray(input?.objects) ? input.objects : []
  if (refs.length === 0 || refs.length > SOURCE_GREP_MAX_OBJECTS) {
    throw new Error(
      `grepObjects: objects must contain between 1 and ${SOURCE_GREP_MAX_OBJECTS} object references.`
    )
  }
  const candidates: GrepCandidate[] = refs.map(ref => {
    const name = normalizeSapName(ref?.name, 'grepObjects', 'object')
    const objectType = ref?.objectType
    if (!objectType || !SOURCE_GREP_OBJECT_TYPES.includes(objectType)) {
      throw new Error(
        `grepObjects: objectType must be one of ${SOURCE_GREP_OBJECT_TYPES.join(', ')}.`
      )
    }
    // URI 由服务端从对象名+类型推导；ADT 对象 URL 惯例用小写。
    // 源码 URL 与 grepPackage 同规则：ABAP 源对象读 <URI>/source/main，
    // DDLS 源码直接挂在对象 URI 上
    const objectUri = GREP_OBJECT_URI_TEMPLATES[objectType](name)
    return {
      objectName: name,
      objectType,
      objectUri,
      sourceUrl: sourceReadUrl(objectUri, objectType)
    }
  })

  const { objects, skipped, totalMatches, searchedObjects, truncated } = await searchCandidates(
    h,
    candidates,
    regex,
    contextLines,
    // 显式对象列表已由 1..20 上限约束，命中对象无需再按 maxResults 截断：
    // 上限取候选总数即可保证全部命中对象都能返回
    candidates.length
  )

  const message =
    totalMatches === 0
      ? `No matches found in ${searchedObjects} object(s)`
      : `Found ${totalMatches} match(es) across ${objects.length} object(s)`

  return {
    scope: 'objects',
    pattern: String(input?.pattern ?? ''),
    caseInsensitive,
    objects,
    totalMatches,
    searchedObjects,
    skipped,
    truncated,
    message: appendNotes(message, skipped.length, truncated)
  }
}

/* ==========================================================================
 * 客户端绑定（供后续集成任务接线的注入点）
 * ==========================================================================
 * 两个能力共享的窄接口；SourceGrepHandlers（src/handlers/SourceGrepHandlers.ts）
 * 以此为构造注入边界（风格对齐 CdsAnalysisHandlers）。
 */
export interface SourceGrepClient {
  grepPackage(input: GrepPackageInput): Promise<SourceGrepResult>
  grepObjects(input: GrepObjectsInput): Promise<SourceGrepResult>
}

/**
 * 把 AdtHTTP 会话绑定成 SourceGrepClient。
 * 集成任务接线方式：createSourceGrepClient(client.h)（AdtClient 通过公开
 * getter `h` 暴露内部 AdtHTTP 会话）；本任务不改动 AdtClient/index 接线。
 */
export function createSourceGrepClient(h: AdtHTTP): SourceGrepClient {
  return {
    grepPackage: input => grepPackage(h, input),
    grepObjects: input => grepObjects(h, input)
  }
}
