import type { AdtHTTP } from './AdtHTTP'
import { fullParse, xmlArray, xmlNode, xmlNodeAttr } from './utilities'

/**
 * ============================================================================
 * UI5/Fiori BSP filestore 只读 ADT API（关闭能力矩阵缺口 ui5.read）
 * ============================================================================
 *
 * 提供三个纯只读能力（对齐 VSP vibing-steampunk pkg/adt/ui5.go 的
 * UI5ListApps / UI5GetApp / UI5GetFileContent，L90/L134/L246）：
 *
 *   1. ui5ListApps      —— 列出 UI5- BSP filestore 中的应用（Atom feed）
 *   2. ui5GetApp        —— 单个应用的文件树（content feed 展平）
 *   3. ui5GetFileContent —— 读取应用内单个文件的原始内容
 *
 * 端点协议（VSP ui5.go L9-11、L98-108、L246-273）：
 *   - 列表：GET /sap/bc/adt/filestore/ui5-bsp/objects?name=<query>&maxResults=<n>
 *     （Accept: application/atom+xml）
 *   - 文件树：GET /sap/bc/adt/filestore/ui5-bsp/objects/<APP>/content
 *   - 文件内容：GET /sap/bc/adt/filestore/ui5-bsp/objects/<APP%2fPATH>/content
 *     （应用名与文件路径合并后整体做路径转义，斜杠编码为 %2f）
 *
 * 设计规则（业务约束）：
 *   - 读取方向全部只读（HTTP GET），不涉及任何 SAP 写操作、锁、传输或激活。
 *   - 写入方向（ui5.write 受控链，对齐 VSP ui5.go L273-419 的四个写操作）：
 *     ui5CreateApp / ui5UploadFile / ui5DeleteFile / ui5DeleteApp。协议为纯
 *     ADT filestore REST（POST/PUT/DELETE），不依赖 ZADT_VSP WebSocket 桥；
 *     filestore 写不走 ABAP workbench 对象锁（BSP 容器操作），传输号以
 *     corrNr 查询参数携带（仅 create/delete app 需要，VSP 同款可选）。
 *   - 应用名与文件路径在本层做白名单校验与路径穿越拒绝（'..' 段、查询串、
 *     协议分隔符），任何可疑输入在 HTTP 请求发出前即被拒绝；URL 由名称拼接、
 *     整体转义，绝不接受调用方传入的任意 URL。
 *   - 已知系统行为（2026-09-17 专用 DEV 实测）：目标系统忽略 name 查询参数
 *     （返回全量 1.59MB feed，VSP 同样受此影响）；因此 query 在客户端再做
 *     通配符过滤（* → 任意长度），这是对 VSP 的行为增强而非协议变更。
 */

/** UI5- BSP filestore 端点基路径（VSP ui5.go L10 ui5FilestoreBase）。 */
const UI5_FILESTORE_BASE = '/sap/bc/adt/filestore/ui5-bsp/objects'

/** 应用名默认/上限（对齐 VSP：maxResults 默认 100；名字长度取 BSP 应用上限口径）。 */
export const DEFAULT_MAX_RESULTS = 100
export const MAX_RESULTS_CAP = 500
const APP_NAME_MAX_LENGTH = 40
const FILE_PATH_MAX_LENGTH = 240

/**
 * 单文件上传字节上限（2 MiB）。VSP 无上限，本层防御性收紧：filestore PUT
 * 把整个内容作为请求体发送，过大内容既拖垮会话也放大误操作影响面。
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

/** 单个 UI5/Fiori BSP 应用（VSP ui5.go L15-22 UI5App 的等价精简结构）。 */
export interface Ui5App {
  /** 应用名（Atom title，可含命名空间斜杠，如 /SAM4U/DASHBRD）。 */
  name: string
  /** 应用描述（Atom summary；系统上多为标准应用描述，可空）。 */
  description?: string
  /** 应用 URI（Atom id，保持系统的 %2f 转义原样不做解码）。 */
  uri?: string
  /** 条目种类（Atom category term；列表层恒为 folder）。 */
  type?: string
}

/** 应用文件树中的一个条目（VSP ui5.go L36-43 UI5File 的等价结构）。 */
export interface Ui5FileEntry {
  /** 条目名（Atom title 原样，如 APP/.project 或 APP/WebContent）。 */
  name: string
  /** 相对应用根的路径（保证以 / 开头，如 /.project）。 */
  path: string
  /** folder 或 file（由 Atom category term 决定，未知 term 保守视为 file）。 */
  type: 'file' | 'folder'
}

/** ui5ListApps 的返回。 */
export interface Ui5ListAppsResult {
  /** 应用清单（客户端过滤 + 截断后）。 */
  apps: Ui5App[]
  /** feed 中的条目总数（截断前，含被查询过滤掉的）。 */
  feedEntries: number
  /** 是否因 maxResults 截断。 */
  truncated: boolean
  /** 生效的查询串（空表示全量）。 */
  query: string
}

/** ui5GetApp 的返回。 */
export interface Ui5GetAppResult {
  /** 规范化（大写）后的应用名。 */
  appName: string
  /** 文件树条目（folder 与 file 混排，按路径升序）。 */
  files: Ui5FileEntry[]
  /** feed 条目总数（应与 files 长度一致，保留核对用）。 */
  feedEntries: number
}

/** ui5GetFileContent 的返回。 */
export interface Ui5GetFileContentResult {
  /** 规范化后的应用名。 */
  appName: string
  /** 规范化后的文件路径（相对应用根，不以 / 开头）。 */
  filePath: string
  /** 文件内容的文本形态（filestore 以原始字节返回；按 UTF-8 解读）。 */
  content: string
  /** 内容字节数。 */
  size: number
}

/* ==========================================================================
 * 输入校验（注入与路径穿越防线：HTTP 请求发出前的唯一闸门）
 * ========================================================================== */

/**
 * 应用名规范化与白名单校验。合法形态（UI5- BSP filestore 的对象键）：
 *   - 无命名空间：ZAPP_SIMPLE
 *   - 单级命名空间：/SAM4U/DASHBRD（前导 / + 命名空间段 + / + 应用段）
 * 多级斜杠（A/B/C）、空段、引号、分号、空格、点号等一律拒绝——名字将拼入
 * 请求路径（整体 encodeURIComponent 转义），可疑输入在拼接前即被拦截。
 * VSP 在此处不做校验（Go 侧靠 url.PathEscape 兜底）；本层同时做转义与
 * 白名单，纵深防御。
 *
 * @returns 规范化（trim + 大写）后的应用名
 * @throws 名字为空、超长（>40）或不符合上述形态时抛错
 */
export function normalizeUi5AppName(value: unknown, capability: string): string {
  const name = String(value ?? '').trim().toUpperCase()
  const valid = name.length > 0 && name.length <= APP_NAME_MAX_LENGTH
    && /^(?:\/[A-Z0-9_$]{1,15}\/)?[A-Z0-9_$]+$/.test(name)
  if (!valid) {
    throw new Error(
      `${capability}: "${String(value ?? '')}" is not a UI5 BSP application name ` +
      `(allowed: A-Z 0-9 _ $ optionally with a one-level namespace like /NS/APP, ` +
      `at most ${APP_NAME_MAX_LENGTH} characters).`
    )
  }
  return name
}

/**
 * 文件路径规范化与穿越拒绝：拒绝 '..' 段（路径穿越）、查询串/协议分隔符
 * （?、#、:、%）、反斜杠与控制字符；剥离首部 /；总长 ≤240。
 *
 * @returns 规范化后的相对路径（不以 / 开头），如 WebContent/index.html
 * @throws 任何可疑形态一律在拼接 URL 之前抛错
 */
export function normalizeUi5FilePath(value: unknown, capability: string): string {
  const raw = String(value ?? '').trim()
  const path = raw.replace(/^\/+/, '')
  if (!path || path.length > FILE_PATH_MAX_LENGTH) {
    throw new Error(
      `${capability}: "${raw}" is not a valid file path ` +
      `(1..${FILE_PATH_MAX_LENGTH} characters, relative to the application root).`
    )
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new Error(`${capability}: path traversal segments are rejected ("${raw}").`)
    }
    if (!/^[A-Za-z0-9_.$\- ]+$/.test(segment)) {
      throw new Error(
        `${capability}: file path "${raw}" contains characters outside ` +
        `[A-Za-z0-9_.$\\- space]; query markers, percent signs and separators are rejected.`
      )
    }
  }
  return path
}

/**
 * 查询串的客户端通配符过滤（VSP ui5.go L96-108 只传 name 参数；实测目标系统
 * 忽略该参数，故在客户端把 '*' 翻译为正则并过滤）。其余字符按字面量处理。
 */
function queryMatcher(query: string): (name: string) => boolean {
  if (!query) return () => true
  const pattern = new RegExp(
    '^' + query.toUpperCase().split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
  )
  return name => pattern.test(name.toUpperCase())
}

/* ==========================================================================
 * Atom feed 解析（对齐 VSP ui5.go L45-88 的结构定义与 L110-131 的转换）
 * ========================================================================== */

/** 容错读取元素文本：字符串原样；带属性的对象取 #text（如 summary type="text"）。 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    const text = (node as Record<string, unknown>)['#text']
    return typeof text === 'string' ? text : String(text ?? '')
  }
  return ''
}

/** 解析 Atom feed 为条目清单（对齐 VSP UI5AtomFeed/UI5AtomEntry，ui5.go L45-68）。 */
function parseAtomEntries(body: string): Array<{ id: string; title: string; summary: string; categoryTerm: string }> {
  const raw = fullParse(body)
  const entries = xmlArray(raw, 'atom:feed', 'atom:entry')
  return entries.map(entry => {
    const category = xmlNode(entry, 'atom:category')
    const term = category ? String(xmlNodeAttr(category)['term'] ?? '') : ''
    return {
      id: textOf(xmlNode(entry, 'atom:id')),
      title: textOf(xmlNode(entry, 'atom:title')),
      summary: textOf(xmlNode(entry, 'atom:summary')),
      categoryTerm: term
    }
  })
}

/* ==========================================================================
 * 三个只读能力
 * ========================================================================== */

/**
 * 列出 UI5/Fiori BSP 应用（VSP ui5.go L90-131 UI5ListApps）。
 * name 查询参数照传（对齐 VSP），另做客户端通配符过滤与 maxResults 截断。
 */
export async function ui5ListApps(h: AdtHTTP, input: { query?: string; maxResults?: number }): Promise<Ui5ListAppsResult> {
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  const requested = Number(input?.maxResults ?? DEFAULT_MAX_RESULTS)
  const maxResults = Math.min(
    Math.max(Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_MAX_RESULTS, 1),
    MAX_RESULTS_CAP
  )

  // 查询串照 VSP 原样拼入 qs（系统可能忽略；客户端过滤兜底）
  const qs: Record<string, string | number> = { maxResults }
  if (query) qs.name = query
  const response = await h.request(UI5_FILESTORE_BASE, {
    method: 'GET',
    qs,
    headers: { Accept: 'application/atom+xml' }
  })

  const entries = parseAtomEntries(response.body)
  const matches = query ? entries.filter(entry => queryMatcher(query)(entry.title)) : entries
  const apps: Ui5App[] = matches.slice(0, maxResults).map(entry => ({
    name: entry.title,
    ...(entry.summary ? { description: entry.summary } : {}),
    ...(entry.id ? { uri: entry.id } : {}),
    ...(entry.categoryTerm ? { type: entry.categoryTerm } : {})
  }))
  return {
    apps,
    feedEntries: entries.length,
    truncated: matches.length > apps.length,
    query
  }
}

/**
 * 读取单个应用的文件树（VSP ui5.go L134-165 UI5GetApp + L167-197
 * extractFilesFromAtomFeed）：content feed 的每个条目标题形如
 * "<APP>/<相对路径>"，剥掉 "<APP>/" 前缀后补 leading /。
 */
export async function ui5GetApp(h: AdtHTTP, input: { appName: string }): Promise<Ui5GetAppResult> {
  const appName = normalizeUi5AppName(input?.appName, 'ui5GetApp')
  const response = await h.request(`${UI5_FILESTORE_BASE}/${encodeURIComponent(appName)}/content`, {
    method: 'GET',
    headers: { Accept: 'application/atom+xml' }
  })

  const entries = parseAtomEntries(response.body)
  const prefix = `${appName}/`
  const files: Ui5FileEntry[] = entries.map(entry => {
    let path = entry.title
    if (path.startsWith(prefix)) {
      path = `/${path.slice(prefix.length)}`
    } else if (!path.startsWith('/')) {
      path = `/${path}`
    }
    return {
      name: entry.title,
      path,
      type: entry.categoryTerm === 'folder' ? 'folder' : 'file'
    }
  })
  // 按路径升序：文件树的可读次序，folder 与 file 混排
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { appName, files, feedEntries: entries.length }
}

/**
 * 读取应用内单个文件的原始内容（VSP ui5.go L246-273 UI5GetFileContent）：
 * 应用名与文件路径合并后整体做路径转义（斜杠编码为 %2f），端点返回原始字节。
 */
export async function ui5GetFileContent(
  h: AdtHTTP,
  input: { appName: string; filePath: string }
): Promise<Ui5GetFileContentResult> {
  const appName = normalizeUi5AppName(input?.appName, 'ui5GetFileContent')
  const filePath = normalizeUi5FilePath(input?.filePath, 'ui5GetFileContent')
  // VSP ui5.go L267-270：fullPath 整体 PathEscape（'/' → %2f）
  const response = await h.request(
    `${UI5_FILESTORE_BASE}/${encodeURIComponent(`${appName}/${filePath}`)}/content`,
    { method: 'GET' }
  )
  const content = typeof response.body === 'string' ? response.body : String(response.body ?? '')
  return { appName, filePath, content, size: Buffer.byteLength(content, 'utf8') }
}

/* ==========================================================================
 * 写入方向（ui5.write 受控链的 ADT 层：对齐 VSP ui5.go L273-419 四个写操作）
 * ========================================================================== */

/** XML 属性值转义（VSP ui5.go L420-427 escapeXMLAttr 等价：& < > " '）。 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Content-Type 白名单形态：token/subtype（可带参数外的常用字符），防 header 注入。 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./+-]*$/

/**
 * 规范化 Content-Type：空值退 application/octet-stream（VSP 同款默认）；
 * 非法字符（分号参数、空白、控制字符）一律拒绝——该值将原样进入请求头。
 */
export function normalizeUi5ContentType(value: unknown): string {
  const contentType = String(value ?? '').trim()
  if (!contentType) return 'application/octet-stream'
  if (contentType.length > 100 || !CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new Error(`ui5UploadFile: "${contentType}" is not a valid Content-Type (token/subtype without parameters).`)
  }
  return contentType
}

/** ui5CreateApp 的入参。 */
export interface Ui5CreateAppInput {
  appName: string
  /** 应用描述（进入 adtcore:description 属性，层内做 XML 转义）。 */
  description?: string
  /** BSP 应用的开发包名（必填——包是 filestore 应用的归属锚点）。 */
  packageName: string
  /** 传输请求号（可选，corrNr；未给则由系统决定归属）。 */
  transport?: string
}

/**
 * 创建 UI5/Fiori BSP 应用（VSP ui5.go L345-385 UI5CreateApp）：
 * POST {base}?corrNr=<t>，body 为 bsp:application XML（name/description/
 * packageName 属性），Content-Type application/xml。
 */
export async function ui5CreateApp(h: AdtHTTP, input: Ui5CreateAppInput): Promise<void> {
  const appName = normalizeUi5AppName(input?.appName, 'ui5CreateApp')
  const packageName = String(input?.packageName ?? '').trim().toUpperCase()
  if (!/^\$?[A-Z][A-Z0-9_]{0,29}$/.test(packageName)) {
    throw new Error(`ui5CreateApp: "${String(input?.packageName ?? '')}" is not a valid package name.`)
  }
  const description = String(input?.description ?? '')
  const qs: Record<string, string> = {}
  if (input?.transport) qs.corrNr = String(input.transport).trim().toUpperCase()
  // bsp:application 载荷逐字对齐 VSP（ui5.go L365-371）：三个 adtcore 属性
  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<bsp:application xmlns:bsp="http://www.sap.com/adt/bsp"
    xmlns:adtcore="http://www.sap.com/adt/core"
    adtcore:name="${escapeXmlAttr(appName)}"
    adtcore:description="${escapeXmlAttr(description)}"
    adtcore:packageName="${escapeXmlAttr(packageName)}">
</bsp:application>`
  await h.request(UI5_FILESTORE_BASE, {
    method: 'POST',
    qs,
    body: xmlPayload,
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' }
  })
}

/** ui5UploadFile 的入参。 */
export interface Ui5UploadFileInput {
  appName: string
  filePath: string
  /** 文件内容（UTF-8 文本；filestore PUT 以原始字节传输）。 */
  content: string
  /** Content-Type（缺省 application/octet-stream；白名单形态校验）。 */
  contentType?: string
}

/**
 * 上传/覆盖应用内单个文件（VSP ui5.go L273-311 UI5UploadFile）：
 * PUT {base}/<APP%2fPATH>/content，body 为文件内容，Content-Type 自定。
 * filestore PUT 无对象锁、无版本协商——覆盖即替换（受控链在 preview 冻结
 * 旧内容、apply 后 readback 比对来补齐事务边界）。
 */
export async function ui5UploadFile(h: AdtHTTP, input: Ui5UploadFileInput): Promise<void> {
  const appName = normalizeUi5AppName(input?.appName, 'ui5UploadFile')
  const filePath = normalizeUi5FilePath(input?.filePath, 'ui5UploadFile')
  const content = typeof input?.content === 'string' ? input.content : ''
  if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD_BYTES) {
    throw new Error(`ui5UploadFile: content exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`)
  }
  const contentType = normalizeUi5ContentType(input?.contentType)
  await h.request(
    `${UI5_FILESTORE_BASE}/${encodeURIComponent(`${appName}/${filePath}`)}/content`,
    { method: 'PUT', body: content, headers: { 'Content-Type': contentType } }
  )
}

/**
 * 删除应用内单个文件（VSP ui5.go L312-344 UI5DeleteFile）：
 * DELETE {base}/<APP%2fPATH>（无 content 后缀、无查询参数）。
 */
export async function ui5DeleteFile(h: AdtHTTP, input: { appName: string; filePath: string }): Promise<void> {
  const appName = normalizeUi5AppName(input?.appName, 'ui5DeleteFile')
  const filePath = normalizeUi5FilePath(input?.filePath, 'ui5DeleteFile')
  await h.request(`${UI5_FILESTORE_BASE}/${encodeURIComponent(`${appName}/${filePath}`)}`, {
    method: 'DELETE'
  })
}

/**
 * 删除整个 UI5/Fiori BSP 应用（VSP ui5.go L387-419 UI5DeleteApp）：
 * DELETE {base}/<APP>?corrNr=<t>（可选传输号）。破坏面最大——受控链 preview
 * 必须先读文件树把影响面（文件数）冻结进 plan。
 */
export async function ui5DeleteApp(h: AdtHTTP, input: { appName: string; transport?: string }): Promise<void> {
  const appName = normalizeUi5AppName(input?.appName, 'ui5DeleteApp')
  const qs: Record<string, string> = {}
  if (input?.transport) qs.corrNr = String(input.transport).trim().toUpperCase()
  await h.request(`${UI5_FILESTORE_BASE}/${encodeURIComponent(appName)}`, {
    method: 'DELETE',
    qs
  })
}

/**
 * 判定 AdtHTTP 异常是否为 404（readback 的"目标不存在"判定——受控链用）。
 * 真机形态（2026-10-05 sap-demo 实测）：ADT 对不存在应用的 404 造出的
 * AdtErrorException 把状态码放在 `err` 字段（不是 status getter），且 message
 * 为服务器登录语言的本地化文本（中文环境为"应用程序 X 不存在"）。三个通道
 * 依次判定：err/status 字段 → 父链 → 多语言 message 词表。
 */
export function isAdtNotFound(error: unknown): boolean {
  for (const candidate of [error, (error as { parent?: unknown })?.parent]) {
    if (!candidate || typeof candidate !== 'object') continue
    const status = (candidate as { status?: unknown }).status
    const err = (candidate as { err?: unknown }).err
    if (status === 404 || err === 404) return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\b404\b|not\s*found|does not exist|existiert nicht|不存在|introuvable|no existe/i.test(message)
}

/** 处理器注入用的窄客户端接口（风格对齐 CdsAnalysisClient）。 */
export interface Ui5FilestoreClient {
  ui5ListApps(input: { query?: string; maxResults?: number }): Promise<Ui5ListAppsResult>
  ui5GetApp(input: { appName: string }): Promise<Ui5GetAppResult>
  ui5GetFileContent(input: { appName: string; filePath: string }): Promise<Ui5GetFileContentResult>
}

/** 把 AdtHTTP 会话绑定成处理器可注入的窄客户端（风格对齐 createCdsAnalysisClient）。 */
export function createUi5FilestoreClient(h: AdtHTTP): Ui5FilestoreClient {
  return {
    ui5ListApps: input => ui5ListApps(h, input),
    ui5GetApp: input => ui5GetApp(h, input),
    ui5GetFileContent: input => ui5GetFileContent(h, input)
  }
}

/**
 * 写链专用的窄客户端接口（受控工作流 deps——必须绑定写域 stateful 主会话，
 * 与读域 stateless client 分离；readback 复用同会话的只读函数保证同视图）。
 */
export interface Ui5WriteClient {
  ui5CreateApp(input: Ui5CreateAppInput): Promise<void>
  ui5UploadFile(input: Ui5UploadFileInput): Promise<void>
  ui5DeleteFile(input: { appName: string; filePath: string }): Promise<void>
  ui5DeleteApp(input: { appName: string; transport?: string }): Promise<void>
  /** readback：应用文件树（不存在时抛 404）。 */
  ui5GetApp(input: { appName: string }): Promise<Ui5GetAppResult>
  /** readback：文件内容（不存在时抛 404）。 */
  ui5GetFileContent(input: { appName: string; filePath: string }): Promise<Ui5GetFileContentResult>
}

/** 把写域主会话绑定成受控工作流可注入的窄客户端。 */
export function createUi5WriteClient(h: AdtHTTP): Ui5WriteClient {
  return {
    ui5CreateApp: input => ui5CreateApp(h, input),
    ui5UploadFile: input => ui5UploadFile(h, input),
    ui5DeleteFile: input => ui5DeleteFile(h, input),
    ui5DeleteApp: input => ui5DeleteApp(h, input),
    ui5GetApp: input => ui5GetApp(h, input),
    ui5GetFileContent: input => ui5GetFileContent(h, input)
  }
}
