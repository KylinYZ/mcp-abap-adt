/**
 * 对象克隆改名 ADT API（矩阵行 crud.clone-object 的受控克隆工作流底层）。
 *
 * VSP 来源（只读对照）：pkg/adt/workflows_source.go CloneObject（第 1586-1653 行）。
 * VSP 协议：GetSource 读源 → 按对象类型正则替换声明行（REPORT/CLASS/INTERFACE）
 * → WriteSource 以新名创建。VSP 的一站式做法绕过了受控确认与身份证明；
 * 本项目把"读源+改名"拆为纯协议函数，受控创建（壳创建/锁/写/校验/激活/
 * readback/补偿）全部复用既有 RepositoryObjectCreationWorkflow 受控链。
 *
 * 与 VSP 的语义差异（有意收窄）：
 * - 仅支持受控创建链已覆盖的三个可克隆类型：PROGRAM（REPORT）、
 *   ABAP_CLASS（CLASS）、ABAP_INTERFACE（INTERFACE）；
 * - 类源码改名要求 DEFINITION 与 IMPLEMENTATION 两处声明同步替换
 *   （VSP 只替换第一个匹配，多声明场景会漏改）；
 * - 源 URL 由 objectType+objectName 服务端解析（对齐 controlledSourceObjectUrl
 *   契约），不接受调用方提供的任意 URL。
 */

/** 可克隆对象类型（受控创建链已覆盖的三个源对象类型）。 */
export type CloneableObjectType = 'PROGRAM' | 'ABAP_CLASS' | 'ABAP_INTERFACE';

/** 类型到 ADT 源对象 URL 前缀的映射（与受控创建链 CONTRACTS 集合路径一致）。 */
const SOURCE_COLLECTION_BY_TYPE: Record<CloneableObjectType, string> = {
  PROGRAM: '/sap/bc/adt/programs/programs',
  ABAP_CLASS: '/sap/bc/adt/oo/classes',
  ABAP_INTERFACE: '/sap/bc/adt/oo/interfaces'
};

/** 类型到声明关键字的映射（对齐 VSP CloneObject 第 1610-1624 行分支）。 */
const DECLARATION_KEYWORD_BY_TYPE: Record<CloneableObjectType, string> = {
  PROGRAM: 'REPORT',
  ABAP_CLASS: 'CLASS',
  ABAP_INTERFACE: 'INTERFACE'
};

/**
 * 解析克隆源码的读取 URL（服务端拼装，不接受任意 URL）。
 * 类/接口的主源码在 /source/main；程序同路径（受控创建链已验证该契约）。
 */
export function cloneSourceUrl(objectType: CloneableObjectType, name: string): string {
  return `${SOURCE_COLLECTION_BY_TYPE[objectType]}/${encodeURIComponent(name.trim().toLowerCase())}/source/main`;
}

/**
 * 在源码中把对象声明行的旧名替换为新名（对齐 VSP CloneObject 改名语义并加固）。
 *
 * 规则：
 * - PROGRAM：恰好一处 `REPORT <old>`（大小写不敏感、词边界）；
 * - ABAP_CLASS：`CLASS <old> DEFINITION` 与 `CLASS <old> IMPLEMENTATION`
 *   各恰好一处（受控创建链 assertSourceFrame 要求两块齐全，因此克隆改名
 *   也必须两处同步，漏改会导致目标创建校验失败）；
 * - ABAP_INTERFACE：恰好一处 `INTERFACE <old>`。
 *
 * 返回改名后的源码；声明行数量不符（0 处或多处）按 VALIDATION_FAILED 语义
 * 抛错——受控链不允许"猜"，改名结果必须确定。
 */
export function renameCloneDeclarations(
  source: string,
  objectType: CloneableObjectType,
  sourceName: string,
  targetName: string
): string {
  const keyword = DECLARATION_KEYWORD_BY_TYPE[objectType];
  const oldName = sourceName.trim().toUpperCase();
  const newName = targetName.trim().toUpperCase();
  // 词边界 + 声明关键字锚定（i 标志对齐 VSP 的 (?i)；SAP 名字本身大小写不敏感）
  const pattern = new RegExp(`\\b${keyword}\\s+${escapeRegExp(oldName)}\\b`, 'gi');
  const matches = source.match(pattern);
  const expected = objectType === 'ABAP_CLASS' ? 2 : 1;
  if (!matches || matches.length !== expected) {
    throw new Error(
      `Source of ${sourceName} contains ${matches?.length ?? 0} ${keyword} declaration(s) for ${oldName}; expected exactly ${expected}.`
    );
  }
  return source.replace(pattern, `${keyword} ${newName}`);
}

/**
 * 读取克隆源对象当前源码（只读；错误由调用方按 UNKNOWN/VALIDATION 语义归类）。
 * 返回原始文本（与受控创建链 setObjectSource 的 text/plain 契约一致）。
 * 非 2xx 抛出的错误携带 status 属性（缺席复核等调用方按状态码分类，消息
 * 文本可能本地化不可靠——真机实测出现过中文"没有找到角色"）。
 */
export async function readCloneSource(
  http: CloneHttp,
  objectType: CloneableObjectType,
  name: string
): Promise<string> {
  const response = await http.request(cloneSourceUrl(objectType, name), {
    method: 'GET',
    headers: { Accept: 'text/plain' }
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Reading source of ${name} returned HTTP ${response.status}.`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.body;
}

/** ADT HTTP 端口（与 DescriptionHttp 同形的窄视图）。 */
export interface CloneHttp {
  request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }>;
}

/** 正则元字符转义（对象名通常无元字符，防御性处理）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
