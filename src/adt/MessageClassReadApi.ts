import type { AdtHTTP } from './AdtHTTP'
import { fullParse, xmlArray, xmlNodeAttr, xmlRoot } from './utilities'

/**
 * ============================================================================
 * 消息类文本只读 ADT API（关闭能力矩阵缺口 read.message-class-texts）
 * ============================================================================
 *
 * 回答"这个消息类的 001 号消息文本是什么"——SE91 维护的消息类文本经 ADT
 * messageclass 资源读取（GET），对齐 VSP vibing-steampunk pkg/adt/client.go
 * GetMessageClass（L998-1021）与 pkg/adt/i18n.go GetMessageClassTexts
 * （L122-146，含 sap-language 语言覆盖）。
 *
 * 端点协议：
 *   GET /sap/bc/adt/messageclass/<name（小写、路径转义）>
 *   Accept: application/vnd.sap.adt.mc.messageclass+xml
 *   可选 qs: sap-language=<语言键>（覆盖登录语言，VSP OverrideLanguage 同义）
 *
 * 响应 XML 形态（与 safe/adapters/MessageClassCreationAdapter.ts 写入侧一致）：
 *   <mc:messageClass mc:name="ZMC" mc:description="..." ...>
 *     <mc:messages mc:msgno="001" mc:msgtext="..." .../>
 *     ...
 *   </mc:messageClass>
 * 属性名带 mc: 前缀（历史版本可能省略），解析按属性名后缀容错匹配。
 *
 * 业务规则：
 *   - 纯只读（HTTP GET），无锁、无传输、无激活；写入方向（VSP
 *     WriteMessageClassTexts L150-208）刻意不移植，属矩阵 i18n.write 缺口。
 *   - 名字白名单：消息类最长 20 位（objectcreator.ts maxLen 口径），可选单级
 *     命名空间 /NS/NAME；URL 由名字小写化后拼接并整体转义，不接受任意 URL。
 */

/** 消息类名字长度上限（对齐 objectcreator.ts 中 MESSAGE_CLASS maxLen=20）。 */
const MESSAGE_CLASS_MAX_LENGTH = 20

/** 单条消息文本（VSP MessageClassMessage，client.go L984-987 的等价结构）。 */
export interface MessageClassMessage {
  /** 消息号（msgno，3 位数字字符串，如 "001"）。 */
  number: string
  /** 消息短文本（msgtext）。 */
  text: string
}

/** getMessages 的返回。 */
export interface GetMessagesResult {
  /** 规范化（大写）后的消息类名。 */
  messageClass: string
  /** 消息类描述（根属性 description；可空）。 */
  description?: string
  /** 消息条目清单（按消息号升序）。 */
  messages: MessageClassMessage[]
  /** 消息条数（等于 messages.length，便于程序消费）。 */
  count: number
  /** 实际生效的语言键（显式传入则回显大写；未传则随登录语言，标注为默认）。 */
  language?: string
}

/**
 * 消息类名字规范化与白名单校验：合法形态为无命名空间（ZMC_TEST）或单级
 * 命名空间（/NS/NAME），总长 ≤20；多级斜杠、空格、引号等在拼接 URL 前拒绝。
 *
 * @returns 规范化（trim + 大写）后的消息类名
 * @throws 名字为空、超长或含白名单之外字符时抛错
 */
export function normalizeMessageClassName(value: unknown, capability: string): string {
  const name = String(value ?? '').trim().toUpperCase()
  const valid = name.length > 0 && name.length <= MESSAGE_CLASS_MAX_LENGTH
    && /^(?:\/[A-Z0-9_]{1,9}\/)?[A-Z0-9_]+$/.test(name)
  if (!valid) {
    throw new Error(
      `${capability}: "${String(value ?? '')}" is not a message class name ` +
      `(allowed: A-Z 0-9 _ optionally with a one-level namespace like /NS/NAME, ` +
      `at most ${MESSAGE_CLASS_MAX_LENGTH} characters).`
    )
  }
  return name
}

/**
 * 语言键校验：SAP 语言键为 1 位（经典，如 D/E）或 2 位字母（ISO，如 EN/DE/ZH）。
 *
 * @returns 规范化（大写）后的语言键
 */
export function normalizeLanguageKey(value: unknown, capability: string): string {
  const lang = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z]{1,2}$/.test(lang)) {
    throw new Error(`${capability}: "${String(value ?? '')}" is not a valid SAP language key (1-2 letters).`)
  }
  return lang
}

/** 属性名后缀容错读取：兼容 mc:msgno 与无前缀 msgno 两种历史形态。 */
function attrBySuffix(attrs: Record<string, unknown>, suffix: string): string {
  const key = Object.keys(attrs).find(k => k === suffix || k.endsWith(`:${suffix}`))
  const value = key ? attrs[key] : undefined
  return typeof value === 'string' ? value : String(value ?? '')
}

/** 根/子元素属性统一取 xmlNodeAttr 后的记录。 */
function attrsOf(node: unknown): Record<string, unknown> {
  return typeof node === 'object' && node !== null ? xmlNodeAttr(node as Record<string, unknown>) : {}
}

/**
 * 读取消息类全部消息文本（VSP GetMessageClass/GetMessageClassTexts 的只读移植）。
 *
 * @param h AdtHTTP 会话（只读 GET；与 CDS 分析同型绑定）
 * @param input messageClass 必填；language 可选（覆盖登录语言）
 */
export async function getMessages(
  h: AdtHTTP,
  input: { messageClass: string; language?: string }
): Promise<GetMessagesResult> {
  const capability = 'getMessages'
  const messageClass = normalizeMessageClassName(input?.messageClass, capability)
  // URL 用小写名字（与 MessageClassCreationAdapter L46 写入侧同口径）并整体转义
  const path = `/sap/bc/adt/messageclass/${encodeURIComponent(messageClass.toLowerCase())}`

  const qs: Record<string, string> = {}
  let language: string | undefined
  if (input?.language !== undefined && String(input.language).trim() !== '') {
    language = normalizeLanguageKey(input.language, capability)
    qs['sap-language'] = language
  }

  const response = await h.request(path, {
    method: 'GET',
    qs,
    headers: { Accept: 'application/vnd.sap.adt.mc.messageclass+xml' }
  })

  // 命名空间前缀随系统版本漂移，按键名后缀容错匹配（对齐 CdsDependencyApi
  // 的"外层包装元素名随版本漂移"容错口径）。消息号是 3 位定长字符串（001），
  // 必须关闭 fast-xml-parser 的属性数值化，否则前导零丢失。
  const root = xmlRoot(fullParse(response.body, { parseAttributeValue: false })) ?? {}
  const rootAttrs = attrsOf(root)
  const description = attrBySuffix(rootAttrs, 'description')

  const entries = [
    ...xmlArray(root as Record<string, unknown>, 'mc:messages'),
    ...xmlArray(root as Record<string, unknown>, 'messages')
  ]
  const messages: MessageClassMessage[] = entries
    .map(entry => {
      const attrs = attrsOf(entry)
      return { number: attrBySuffix(attrs, 'msgno'), text: attrBySuffix(attrs, 'msgtext') }
    })
    .filter(m => m.number !== '' || m.text !== '')
    // 消息号升序：等长数字字符串按字典序即数值序
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))

  return {
    messageClass,
    ...(description ? { description } : {}),
    messages,
    count: messages.length,
    ...(language ? { language } : {})
  }
}

/** 处理器注入用的窄客户端接口。 */
export interface MessageClassReadClient {
  getMessages(input: { messageClass: string; language?: string }): Promise<GetMessagesResult>
}

/** 把 AdtHTTP 会话绑定成处理器可注入的窄客户端（风格对齐 createCdsAnalysisClient）。 */
export function createMessageClassReadClient(h: AdtHTTP): MessageClassReadClient {
  return {
    getMessages: input => getMessages(h, input)
  }
}
