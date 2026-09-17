import type { AdtHTTP } from './AdtHTTP'
import { fullParse } from './utilities.js'
import { resolveObjectSourceUrl, type RevisionSourceKind } from './RevisionSourceApi.js'
import { normalizeLanguageKey } from './MessageClassReadApi.js'

/**
 * ============================================================================
 * i18n 按语言只读 ADT API（关闭能力矩阵缺口 i18n.read 的语言覆盖部分）
 * ============================================================================
 *
 * 回答"这个对象/标签/文本池在指定语言下长什么样、两种语言差在哪"——对齐
 * VSP vibing-steampunk pkg/adt/i18n.go 的四个只读函数：
 *   1. getObjectContentInLanguage  ← GetObjectTextsInLanguage（L61-78）
 *   2. getDataElementLabels        ← GetDataElementLabels（L80-120）
 *   3. getTextPoolInLanguage       ← GetTextPoolInLanguage（L255-329）
 *   4. compareObjectLanguages      ← CompareObjectLanguages（L356-421）
 * 消息类文本的语言读取已由 getMessages（read.message-class-texts 轮）覆盖。
 *
 * 端点协议：
 *   - 对象内容：源 URL GET + qs sap-language=<键>（登录语言覆盖）
 *   - 数据元素标签：GET /sap/bc/adt/ddic/dataelements/<名>，Accept
 *     application/vnd.sap.adt.dataelements.v2+xml——必须用版本化词汇类型，
 *     通用 application/xml 会被 406 拒绝（VSP i18n.go L92-99 实测注释）；
 *     解析 root(wbobj) → dataElement → short/medium/long/headingFieldLabel
 *   - 文本池：/sap/bc/adt/textelements/programs/<名>/source/{symbols,
 *     selections,headings}，Accept vnd.sap.adt.textelements.<子>.v1，响应为
 *     key=value 行文本（@ 开头为指令）；单子资源 404 不致命（无选屏的程序
 *     没有 S 段，"缺失"本身就是答案，VSP L303-312）
 *
 * 业务规则：
 *   - 全部只读（GET），无锁无传输无写入；VSP 的写入方向（WriteMessageClassTexts/
 *     WriteDataElementLabels）不移植，属 i18n.write 缺口。
 *   - 语言键校验 1-2 位字母；对象源 URL 由 objectType+objectName 服务端解析
 *     （复用 RevisionSourceApi.resolveObjectSourceUrl），不接受任意 URL。
 *   - ADT 行为差异如实透出：数据元素在目标语言无翻译时以主语言应答而非空
 *     （VSP i18n.go L109-112 注释），调用方无法从应答本身区分"未翻译"。
 */

/** 语言覆盖的请求形态（datapreview/源 URL GET 共用）。 */
export interface I18nLanguageRequest {
  language?: string
}

/** 数据元素四段标签（VSP DataElementLabels，i18n.go L28-33）。 */
export interface DataElementLabels {
  short?: string
  medium?: string
  long?: string
  heading?: string
}

/** getDataElementLabels 的返回。 */
export interface GetDataElementLabelsResult {
  dataElement: string
  language: string
  labels: DataElementLabels
  /** 提示：目标语言无翻译时 ADT 以主语言应答（行为差异透出）。 */
  note?: string
}

/** 文本池条目（VSP TextPoolEntry，i18n.go L36-40）。 */
export interface TextPoolEntry {
  /** 文本池种类：I=文本符号，S=选择文本，H=列/列表标题（READ TEXTPOOL id）。 */
  id: 'I' | 'S' | 'H'
  /** 键（TEXT 符号名/选择屏幕参数名/列名）。 */
  key: string
  /** 文本（可为空串——存在但未翻译同样是有用的答案）。 */
  text: string
}

/** getTextPoolInLanguage 的返回。 */
export interface GetTextPoolResult {
  program: string
  language: string
  entries: TextPoolEntry[]
  /** 各子资源读取情况（404 的子资源列在此处而非报错）。 */
  missing: string[]
}

/** 单键的语言对比条目（VSP ComparisonEntry，i18n.go L50-55）。 */
export interface LanguageComparisonEntry {
  key: string
  sourceText: string
  targetText?: string
  /** 目标语言缺该行。 */
  missing?: boolean
}

/** compareObjectLanguages 的返回。只含差异/缺失条目。 */
export interface CompareObjectLanguagesResult {
  objectType: RevisionSourceKind
  objectName: string
  sourceLanguage: string
  targetLanguage: string
  entries: LanguageComparisonEntry[]
  /** 对比的源码总行数。 */
  totalLines: number
  /** 差异/缺失条目数（= entries.length）。 */
  differing: number
}

/**
 * 按语言读取对象内容（VSP GetObjectTextsInLanguage L61-78）：
 * 源 URL 由 objectType+objectName 服务端解析（复用 resolveObjectSourceUrl），
 * GET 时以 sap-language 覆盖登录语言。
 */
export async function getObjectContentInLanguage(
  h: AdtHTTP,
  resolveSourceUrl: I18nSourceUrlResolver,
  input: { objectType: RevisionSourceKind; objectName: string; language: string }
): Promise<{ objectType: RevisionSourceKind; objectName: string; language: string; content: string; lines: number }> {
  const language = normalizeLanguageKey(input?.language, 'getObjectContentInLanguage')
  if (!input?.objectType || !input?.objectName) {
    throw new Error('getObjectContentInLanguage: objectType and objectName are required.')
  }
  const sourceUrl = await resolveSourceUrl(input.objectType, String(input.objectName).trim().toUpperCase(), 'getObjectContentInLanguage')
  const response = await h.request(sourceUrl, {
    method: 'GET',
    qs: { 'sap-language': language }
  })
  const content = typeof response.body === 'string' ? response.body : String(response.body ?? '')
  return {
    objectType: input.objectType,
    objectName: String(input.objectName).trim().toUpperCase(),
    language,
    content,
    lines: content.split('\n').length
  }
}

/**
 * 读取数据元素在指定语言下的四段标签（VSP GetDataElementLabels L80-120）。
 * Accept 必须是版本化词汇类型 vnd.sap.adt.dataelements.v2+xml（通用类型在
 * 7.58 上 406，VSP L92-99 实测）。
 */
export async function getDataElementLabels(
  h: AdtHTTP,
  input: { dataElement: string; language?: string }
): Promise<GetDataElementLabelsResult> {
  const capability = 'getDataElementLabels'
  const dataElement = normalizeRepositoryNameLike(input?.dataElement, capability, 30)
  const language = normalizeLanguageKey(input?.language ?? 'EN', capability)

  const response = await h.request(
    `/sap/bc/adt/ddic/dataelements/${encodeURIComponent(dataElement)}`,
    {
      method: 'GET',
      qs: { 'sap-language': language },
      headers: { Accept: 'application/vnd.sap.adt.dataelements.v2+xml' }
    }
  )

  const root = fullParse(response.body, { parseAttributeValue: false })
  const rootKey = Object.keys(root).find(k => k === 'wbobj' || k.endsWith(':wbobj'))
  if (!rootKey) {
    throw new Error(`${capability}: response is not a data element document (wbobj).`)
  }
  const doc = root[rootKey]
  const dataElementKey = Object.keys(doc).find(k => k === 'dataElement' || k.endsWith(':dataElement'))
  const properties = dataElementKey ? doc[dataElementKey] : undefined
  if (!properties || typeof properties !== 'object') {
    throw new Error(`${capability}: data element document is missing dataElement.`)
  }
  const pick = (suffix: string): string | undefined => {
    const key = Object.keys(properties).find(k => k === suffix || k.endsWith(`:${suffix}`))
    if (!key) return undefined
    const node = properties[key]
    const text = typeof node === 'string' ? node : typeof node === 'object' && node !== null && '#text' in (node as Record<string, unknown>)
      ? String((node as Record<string, unknown>)['#text'] ?? '')
      : undefined
    return text !== undefined && text !== '' ? text : undefined
  }
  const labels: DataElementLabels = {}
  for (const [suffix, target] of [
    ['shortFieldLabel', 'short'],
    ['mediumFieldLabel', 'medium'],
    ['longFieldLabel', 'long'],
    ['headingFieldLabel', 'heading']
  ] as const) {
    const value = pick(suffix)
    if (value !== undefined) labels[target] = value
  }
  return {
    dataElement,
    language,
    labels,
    note: 'ADT answers in the master language when the requested language has no translation; an answer does not prove the translation exists.'
  }
}

/** 名字校验（数据元素/程序共用）：白名单同口径，长度按参数传入。 */
function normalizeRepositoryNameLike(value: unknown, capability: string, maxLength: number): string {
  const name = String(value ?? '').trim().toUpperCase()
  if (!name || name.length > maxLength || !/^(?:\/[A-Z0-9_]{1,9}\/)?[A-Z0-9_/]+$/.test(name)) {
    throw new Error(`${capability}: "${String(value ?? '')}" is not a valid repository name (at most ${maxLength} characters).`)
  }
  return name
}

/**
 * 按语言读取程序文本池（VSP GetTextPoolInLanguage L255-329）：三个子资源
 * （symbols/selections/headings）各自 GET，key=value 行文本；单子资源 404
 * 记入 missing 而不报错；@ 开头指令行跳过。
 */
export async function getTextPoolInLanguage(
  h: AdtHTTP,
  input: { program: string; language?: string }
): Promise<GetTextPoolResult> {
  const capability = 'getTextPoolInLanguage'
  const program = normalizeRepositoryNameLike(input?.program, capability, 40)
  const language = normalizeLanguageKey(input?.language ?? 'EN', capability)

  const entries: TextPoolEntry[] = []
  const missing: string[] = []
  for (const sub of [
    { name: 'symbols', id: 'I' as const },
    { name: 'selections', id: 'S' as const },
    { name: 'headings', id: 'H' as const }
  ]) {
    const path = `/sap/bc/adt/textelements/programs/${encodeURIComponent(program)}/source/${sub.name}`
    let body: string
    try {
      const response = await h.request(path, {
        method: 'GET',
        qs: { 'sap-language': language },
        headers: { Accept: `application/vnd.sap.adt.textelements.${sub.name}.v1` }
      })
      body = typeof response.body === 'string' ? response.body : String(response.body ?? '')
    } catch (error) {
      // 单个子资源 404 不是"没有文本池"：无选屏的程序没有 S 段（VSP L303-312）。
      // 404 识别兼容 AdtHttpException 的 status getter 与 message 文本两种形态。
      const status = (error as { status?: unknown })?.status
      const message = error instanceof Error ? error.message : String(error)
      if (status === 404 || /\b404\b/.test(message)) {
        missing.push(sub.name)
        continue
      }
      throw error
    }
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.trim() === '') continue
      // @MaxLength 等是文档指令，不是条目
      if (line.trim().startsWith('@')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      if (key === '') continue
      entries.push({ id: sub.id, key, text: line.slice(eq + 1) })
    }
  }
  return { program, language, entries, missing }
}

/**
 * 对比对象在两种语言下的内容（VSP CompareObjectLanguages L356-421）：按行
 * 对齐（line-N 为键），只返回差异或目标语言缺失的条目。
 */
export async function compareObjectLanguages(
  h: AdtHTTP,
  resolveSourceUrl: I18nSourceUrlResolver,
  input: { objectType: RevisionSourceKind; objectName: string; sourceLanguage: string; targetLanguage: string }
): Promise<CompareObjectLanguagesResult> {
  const source = await getObjectContentInLanguage(h, resolveSourceUrl, {
    objectType: input?.objectType,
    objectName: input?.objectName,
    language: input?.sourceLanguage
  })
  const target = await getObjectContentInLanguage(h, resolveSourceUrl, {
    objectType: input?.objectType,
    objectName: input?.objectName,
    language: input?.targetLanguage
  })

  const sourceLines = source.content.split('\n')
  const targetLines = target.content.split('\n')
  const entries: LanguageComparisonEntry[] = []
  for (let i = 0; i < sourceLines.length; i++) {
    const sourceText = sourceLines[i]
    const targetText = i < targetLines.length ? targetLines[i] : undefined
    if (targetText === undefined || sourceText !== targetText) {
      entries.push({
        key: `line-${i + 1}`,
        sourceText,
        ...(targetText !== undefined ? { targetText } : {}),
        ...(targetText === undefined ? { missing: true } : {})
      })
    }
  }
  return {
    objectType: input.objectType,
    objectName: String(input.objectName).trim().toUpperCase(),
    sourceLanguage: source.language,
    targetLanguage: target.language,
    entries,
    totalLines: sourceLines.length,
    differing: entries.length
  }
}

/* ==========================================================================
 * 客户端绑定
 * ========================================================================== */

/** 对象源 URL 解析通道（i18n 需要按名字解析源 URL；注入点与实现解耦）。 */
export type I18nSourceUrlResolver = (
  objectType: RevisionSourceKind,
  objectName: string,
  capability: string
) => Promise<string>

/** 处理器注入用的窄客户端接口。 */
export interface I18nReadClient {
  getObjectContentInLanguage(input: {
    objectType: RevisionSourceKind
    objectName: string
    language: string
  }): Promise<{ objectType: RevisionSourceKind; objectName: string; language: string; content: string; lines: number }>
  getDataElementLabels(input: { dataElement: string; language?: string }): Promise<GetDataElementLabelsResult>
  getTextPoolInLanguage(input: { program: string; language?: string }): Promise<GetTextPoolResult>
  compareObjectLanguages(input: {
    objectType: RevisionSourceKind
    objectName: string
    sourceLanguage: string
    targetLanguage: string
  }): Promise<CompareObjectLanguagesResult>
}

/**
 * 项目 ADT 客户端的最小结构视图：httpClient 发 i18n 请求，
 * searchObject/objectStructure 供源 URL 解析。
 */
export interface I18nAdtCapability {
  searchObject(query: string, objType?: string, max?: number): Promise<Array<Record<string, any>>>
  objectStructure(objectUrl: string, version?: string): Promise<any>
  httpClient: {
    request(path: string, options?: {
      method?: string
      qs?: Record<string, string>
      headers?: Record<string, string>
    }): Promise<{ body: unknown }>
  }
}

/**
 * 把 ADT 客户端绑定成 i18n 只读客户端：源 URL 解析复用
 * RevisionSourceApi.resolveObjectSourceUrl，请求经 httpClient.request 转发。
 */
export function createI18nReadClient(client: I18nAdtCapability): I18nReadClient {
  const resolver: I18nSourceUrlResolver = (objectType, objectName, capability) =>
    resolveObjectSourceUrl(client, objectType, objectName, capability)
  const h = {
    request: async (path: string, options?: { qs?: Record<string, string>; headers?: Record<string, string>; method?: string }) =>
      client.httpClient.request(path, options)
  }
  return {
    async getObjectContentInLanguage(input) {
      return getObjectContentInLanguage(h as unknown as AdtHTTP, resolver, input)
    },
    getDataElementLabels: input => getDataElementLabels(h as unknown as AdtHTTP, input),
    getTextPoolInLanguage: input => getTextPoolInLanguage(h as unknown as AdtHTTP, input),
    compareObjectLanguages: input => compareObjectLanguages(h as unknown as AdtHTTP, resolver, input)
  }
}

/** 类型透出：对象种类复用版本源码 API 的定义。 */
export type { RevisionSourceKind as I18nObjectKind }
