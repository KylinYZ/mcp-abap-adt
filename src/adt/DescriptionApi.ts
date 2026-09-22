/**
 * 对象描述修改 ADT API（矩阵行 crud.set-description 的受控写链底层）。
 *
 * VSP 来源（只读对照）：pkg/adt/description.go——GetDescription/SetDescription
 * （第 65/83 行）与 DescriptionObjectURL（第 38 行）。协议：
 *   1. GET 对象主 URL（Accept: *\/*，stateful）→ 对象主 XML：
 *      `adtcore:description="..."`（现描述）与 `adtcore:descriptionTextLimit="N"`
 *      （长度上限）；
 *   2. 锁（MODIFY）→ 锁下重读（整个文档回写，必须取当前版本）→
 *      正则替换 description 属性 → PUT（lockHandle + corrNr 参数，body 回传
 *      原 Content-Type）→ 解锁（defer，异常路径也解锁）；
 *   3. 同值短路（old == new 不写）；长度超限拒绝（不截断）。
 *
 * 与 VSP 的差异：VSP 在 SetDescription 内部直调锁与传输；本项目把这些拆为
 * 显式端口（由受控工作流编排），保持 ADT 层为纯协议函数。
 */

/** 对象主 URL 映射（对齐 VSP DescriptionObjectURL，第 38-52 行的常用子集）。 */
export type DescriptionObjectType = 'PROG' | 'CLAS' | 'INTF' | 'INCL';

export function descriptionObjectURL(objectType: DescriptionObjectType, name: string): string {
  const encoded = encodeURIComponent(name.trim().toLowerCase());
  switch (objectType) {
    case 'PROG': return `/sap/bc/adt/programs/programs/${encoded}`;
    case 'INCL': return `/sap/bc/adt/programs/includes/${encoded}`;
    case 'CLAS': return `/sap/bc/adt/oo/classes/${encoded}`;
    case 'INTF': return `/sap/bc/adt/oo/interfaces/${encoded}`;
  }
}

/** 描述属性正则（对齐 VSP descriptionAttr，第 32 行）。 */
const DESCRIPTION_ATTR = /\sadtcore:description="([^"]*)"/;
/** 长度上限属性（对齐 VSP descriptionLimit，第 33 行）。 */
const DESCRIPTION_LIMIT = /\sadtcore:descriptionTextLimit="(\d+)"/;

/** 对象主 XML 的读取结果（body 与 Content-Type 需原样回传给 PUT）。 */
export interface ObjectMetadata {
  body: string;
  contentType: string;
}

/** 描述提取结果。 */
export interface DescriptionInfo {
  description: string;
  /** 长度上限（元数据未声明时为 0 = 未知/不限）。 */
  limit: number;
}

/** ADT HTTP 端口（本项目 AdtHTTP 的窄视图）。 */
export interface DescriptionHttp {
  request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }>;
}

/** 读对象主 XML（Accept 通配；PUT 需要回传原 Content-Type）。 */
export async function readObjectMetadata(h: DescriptionHttp, objectURL: string): Promise<ObjectMetadata> {
  const response = await h.request(objectURL, { method: 'GET', headers: { Accept: '*/*' } });
  let contentType = response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? '';
  const semi = contentType.indexOf(';');
  if (semi >= 0) contentType = contentType.slice(0, semi).trim();
  return { body: response.body, contentType };
}

/** 从对象主 XML 提取描述与长度上限（对齐 VSP descriptionOf，第 164 行）。 */
export function descriptionOf(body: string): DescriptionInfo {
  const match = DESCRIPTION_ATTR.exec(body);
  if (!match) {
    throw new Error('the metadata carries no adtcore:description');
  }
  const limitMatch = DESCRIPTION_LIMIT.exec(body);
  return { description: match[1], limit: limitMatch ? Number(limitMatch[1]) : 0 };
}

/** XML 属性转义（对齐 VSP html.EscapeString 的属性上下文语义）。 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 在对象主 XML 中替换 description 属性（整文档回写）。 */
export function replaceDescriptionAttribute(body: string, description: string): string {
  return body.replace(DESCRIPTION_ATTR, ` adtcore:description="${escapeXmlAttribute(description)}"`);
}

/** 锁端口（复用本项目 ADTClient 的 lock/unLock 原子能力）。 */
export interface DescriptionLockPort {
  lock(objectURL: string, accessMode: string): Promise<{ lockHandle?: string; err?: unknown } & Record<string, unknown>>;
  unLock(objectURL: string, lockHandle: string): Promise<unknown>;
}

/** 修改描述的单次执行（协议层：锁/改/PUT/解锁的完整一次调用）。
 *  受控编排（预检/确认/审计）由 safe 工作流承担，本函数不含确认语义。 */
export async function setDescription(
  h: DescriptionHttp,
  locks: DescriptionLockPort,
  input: {
    objectType: DescriptionObjectType;
    name: string;
    description: string;
    transport?: string;
  }
): Promise<{ objectURL: string; oldDescription: string; newDescription: string; limit: number; sameValue: boolean }> {
  const objectURL = descriptionObjectURL(input.objectType, input.name);
  const description = input.description.trim();
  if (!description) {
    // 对齐 VSP：空描述不写（清空描述是另一个显式决策）
    throw new Error('an empty description is not written');
  }

  // 预读：取旧描述与长度限制
  const before = await readObjectMetadata(h, objectURL);
  const info = descriptionOf(before.body);
  if (info.limit > 0 && [...description].length > info.limit) {
    throw new Error(`the description is ${[...description].length} characters; ${objectURL} allows ${info.limit}`);
  }
  if (info.description === description) {
    // 同值短路：不锁不写（对齐 VSP 第 107-109 行）
    return { objectURL, oldDescription: info.description, newDescription: description, limit: info.limit, sameValue: true };
  }

  // 锁（MODIFY）→ 锁下重读（整文档回写必须取当前版本）→ 替换 → PUT → 解锁
  // 锁句柄提取失败也必须解锁：原始返回行是大写列名（真机实测 LOCK_HANDLE），
  // 保留 raw 引用以便兜底释放，避免 ENQ 锁泄漏（真机教训）。
  const lock = await locks.lock(objectURL, 'MODIFY');
  const rawLock = (lock ?? {}) as Record<string, unknown>;
  const lockHandle = String(rawLock.lockHandle ?? rawLock.LOCK_HANDLE ?? '');
  try {
    if (!lockHandle) {
      throw new Error(`locking ${objectURL} did not yield a lock handle`);
    }
    const underLock = await readObjectMetadata(h, objectURL);
    const current = descriptionOf(underLock.body);
    const updated = replaceDescriptionAttribute(underLock.body, description);
    const params = new URLSearchParams({ lockHandle });
    if (input.transport) params.set('corrNr', input.transport);
    await h.request(`${objectURL}?${params.toString()}`, {
      method: 'PUT',
      headers: { 'Content-Type': underLock.contentType || 'application/vnd.sap.as+xml' },
      body: updated
    });
    return { objectURL, oldDescription: current.description, newDescription: description, limit: info.limit, sameValue: false };
  } finally {
    // 异常路径也解锁（对齐 VSP 的 defer unlock）
    try { await locks.unLock(objectURL, lockHandle); } catch { /* 解锁失败不掩盖主结果 */ }
  }
}

/** 把 AdtClient 的 HTTP 会话与锁能力绑定为描述修改端口（index.ts 装配用）。 */
export function bindDescriptionPorts(client: {
  h: DescriptionHttp;
  lock(objectURL: string, accessMode: string): Promise<Record<string, unknown>>;
  unLock(objectURL: string, lockHandle: string): Promise<unknown>;
}): { http: DescriptionHttp; locks: DescriptionLockPort } {
  return {
    http: client.h,
    locks: {
      // ADTClient.lock 的原始行是大写列名（LOCK_HANDLE/CORRNR...），归一化为
      // 协议层的 lockHandle 键（真机实测：该 DEV 的返回即大写形态）
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
