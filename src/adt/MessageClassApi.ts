/**
 * 消息类文本读写 ADT API（矩阵行 i18n.write 的 write_message_texts 底层）。
 *
 * VSP 来源（只读对照）：pkg/adt/i18n.go——GetMessageClassTexts（第 122 行）与
 * WriteMessageClassTexts（第 150 行）。协议：
 *   - 读：GET /sap/bc/adt/messageclass/<name>（Accept mc.messageclass+xml，
 *     Accept-Language 覆盖）→ mc:messageClass XML，messages 的 msgno/msgtext
 *     为属性；
 *   - 写：PUT 同路径（corrNr 参数；无显式锁——SAP 端 stateful 隐式锁，body = XML 头 +
 *     namespaced <mc:messageClass>（messages 属性形态），Content-Type 同，
 *     Accept-Language 覆盖，**Stateful: true**——锁句柄绑定会话，VSP 注释
 *     issue #91：stateless PUT 永远匹配不到自己的锁）。
 *
 * 与 VSP 的差异：锁/解锁为显式端口（受控工作流编排），ADT 层为纯协议函数。
 */
import { fullParse } from './utilities.js';

/** ADT HTTP 端口（本项目 AdtHTTP 的窄视图；headers 直传）。 */
export interface MessageClassHttp {
  request(url: string, init: {
    method: string;
    headers?: Record<string, string>;
    qs?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
}

/** 锁端口（复用 ADTClient.lock/unLock；原始行键归一化由绑定层承担）。 */
export interface MessageClassLockPort {
  lock(objectURL: string, accessMode: string): Promise<Record<string, unknown>>;
  unLock(objectURL: string, lockHandle: string): Promise<unknown>;
}

/** 一条消息（编号三位数字 + 文本）。 */
export interface MessageClassEntry {
  number: string;
  text: string;
}

/** 消息类 URL（对齐 VSP i18n.go 第 130/178 行，小写 PathEscape）。 */
export function messageClassURL(name: string): string {
  return `/sap/bc/adt/messageclass/${encodeURIComponent(name.trim().toLowerCase())}`;
}

/** 从 messageclass XML 提取消息清单（removeNSPrefix 后按本地名取属性）。 */
export function parseMessageClassTexts(body: string): MessageClassEntry[] {
  // parseAttributeValue 必须禁用：msgno 是带前导零的三位编号（'001'），
  // fast-xml-parser 默认数值化会把它变成 1（历史数据丢失教训）
  const parsed = fullParse(body, { removeNSPrefix: true, parseAttributeValue: false }) as Record<string, unknown>;
  const root = (parsed?.messageClass ?? parsed?.MessageClass) as Record<string, unknown> | undefined;
  const rawMessages = root?.messages;
  // fast-xml-parser 单子元素折叠为对象而非数组——单消息消息类必须归一化，
  // 否则 Array.isArray 守卫把唯一一条消息当成空清单（真机读回核验踩坑）
  const messages = Array.isArray(rawMessages) ? rawMessages : (rawMessages ? [rawMessages] : []);
  if (messages.length === 0) return [];
  return messages
    .map(message => {
      const record = message as Record<string, unknown>;
      return {
        number: String(record?.['@_msgno'] ?? record?.msgno ?? ''),
        text: String(record?.['@_msgtext'] ?? record?.msgtext ?? '')
      };
    })
    .filter(entry => entry.number);
}

/** XML 属性转义。 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 构造单条消息行 XML——真机已验证形态（MESSAGE_CLASS 受控创建链
 *  appendMessages 同源）：富属性 + 两条 atom:link 子元素（长文本与消息资源关系）。
 *  注意行内不携带锁句柄；锁以 query lockHandle（对象级）传给 PUT。 */
export function messageClassRowXml(className: string, entry: MessageClassEntry): string {
  const classUpper = escapeXmlAttribute(className.trim().toUpperCase());
  const classLower = className.trim().toLowerCase();
  return [
    `<mc:messages mc:msgno="${escapeXmlAttribute(entry.number)}" mc:msgtext="${escapeXmlAttribute(entry.text)}"` +
      ' mc:selfexplainatory="false" mc:documented="false" mc:lastchangedby="" mc:lastmodified="" adtcore:name="">',
    `  <atom:link href="/sap/bc/adt/vit/docu/object_type/NA/object_name/${classUpper}${entry.number}" rel="http://www.sap.com/adt/relations/longtext" xmlns:atom="http://www.w3.org/2005/Atom"/>`,
    `  <atom:link href="/sap/bc/adt/messageclass/${classLower}/messages/${entry.number}" rel="http://www.sap.com/adt/relations/messageclasses/messages" xmlns:atom="http://www.w3.org/2005/Atom"/>`,
    '</mc:messages>'
  ].join('\n');
}

/** 构造完整 messageclass XML 文档（用于全新文档场景；受控写路径走读-改-写注入）。 */
export function buildMessageClassXml(name: string, texts: MessageClassEntry[]): string {
  const rows = texts.map(entry => messageClassRowXml(name, entry)).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${escapeXmlAttribute(name.trim().toUpperCase())}">${rows}</mc:messageClass>`
  ].join('');
}

/** 读消息类文本（指定语言）。资源不存在（新消息类/未维护该语言）时返回空清单。 */
export async function readMessageClassTexts(
  h: MessageClassHttp,
  name: string,
  language: string
): Promise<MessageClassEntry[]> {
  let response: { status: number; body: string; headers: Record<string, string> };
  try {
    response = await h.request(messageClassURL(name), {
      method: 'GET',
      headers: { Accept: 'application/vnd.sap.adt.mc.messageclass+xml', 'Accept-Language': language }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // ADT 客户端把非 2xx 转为业务 Error（文本为 "消息类 ... does not exist"
    // 之类，真机实测无状态码）——资源不存在语义返回空清单（新消息类尚未
    // 维护文本属正常），其余错误照常传播
    if (/404/.test(message) || /does not exist|not found/i.test(message)) return [];
    throw error;
  }
  return parseMessageClassTexts(response.body);
}

/** 写消息类文本（读-改-写整文档回传；真机锁协议实证 2026-09-24）：
 *  前置条件——调用方已持有该消息类的对象级锁（_action=LOCK 句柄）。
 *  消息级 LOCK_MSG 与对象锁双向 EU510 互斥，不得混用。
 *  PUT 契约（对齐本仓库受控创建链已真机验证的 setObjectSource 路径）：
 *  Content-Type 必须是 application/*（mc 专用媒体类型会被服务端静默忽略），
 *  query 携带 lockHandle/corrNr，body 为在原文上注入富属性消息行的完整文档。 */
export async function writeMessageClassTexts(
  h: MessageClassHttp,
  input: {
    name: string;
    language: string;
    texts: MessageClassEntry[];
    /** 对象级锁句柄（_action=LOCK 取得）。 */
    lockHandle: string;
    transport?: string;
  }
): Promise<void> {
  const url = `${messageClassURL(input.name)}`;
  // GET Accept 必须为裸媒体类型（带 charset 会 4xx "content is not acceptable"）
  const getResp = await h.request(url, {
    method: 'GET',
    headers: { Accept: 'application/vnd.sap.adt.mc.messageclass+xml', 'Accept-Language': input.language }
  });

  // 在原文上替换 mc:messages（保留全部 adtcore: 元数据属性与子元素）：
  // 先剥离既有消息行——自闭合与带子元素的成对行两种形态都覆盖
  // （SAP 原生文档为成对行），防止改写时残留旧条目。
  const stripped = getResp.body
    .replace(/<mc:messages\b[^>]*\/>/g, '')
    .replace(/<mc:messages\b[^>]*>[\s\S]*?<\/mc:messages>/g, '');
  if (!/<\/mc:messageClass>/.test(stripped)) {
    throw new Error(`messageclass document for ${input.name} has no recognizable root element`);
  }
  const rows = input.texts.map(entry => messageClassRowXml(input.name, entry)).join('\n');
  const body = stripped.replace('</mc:messageClass>', `${rows}</mc:messageClass>`);

  const qs: Record<string, string> = { lockHandle: input.lockHandle };
  if (input.transport) qs.corrNr = input.transport;
  await h.request(url, {
    method: 'PUT',
    // 真机实证：mc 专用媒体类型 PUT 200 但服务端静默忽略；application/* 才会被解析
    headers: { 'Content-Type': 'application/*' },
    qs,
    body
  });
}

/** 把 AdtClient 的 HTTP 会话与锁能力绑定为消息类端口。 */
export function bindMessageClassPorts(client: {
  h: MessageClassHttp;
  lock(objectURL: string, accessMode: string): Promise<Record<string, unknown>>;
  unLock(objectURL: string, lockHandle: string): Promise<unknown>;
}): { http: MessageClassHttp; locks: MessageClassLockPort } {
  return {
    http: client.h,
    locks: {
      // 原始行大写列名归一化（真机实测 LOCK_HANDLE，同 DescriptionApi 教训）
      lock: async (objectURL, accessMode) => {
        const raw = await client.lock(objectURL, accessMode);
        const record = (raw ?? {}) as Record<string, unknown>;
        const handle = record.lockHandle ?? record.LOCK_HANDLE;
        return handle ? { lockHandle: String(handle) } : (raw ?? {});
      },
      unLock: async (objectURL, lockHandle) => client.unLock(objectURL, lockHandle)
    }
  };
}
