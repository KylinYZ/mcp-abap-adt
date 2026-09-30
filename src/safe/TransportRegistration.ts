import type { TransportObject, TransportRequest } from '../adt/index.js';
import { errorMessage } from './errors.js';

/**
 * ============================================================================
 * 传输门禁与归属证明的纯函数层（7.51 兼容改造，2026-09-29 排查定论）
 * ============================================================================
 *
 * 背景：ED1 等 7.51 系统的 ADT 对部分 URI 缺少映射，受控创建链原本的传输
 * 预检（POST /sap/bc/adt/cts/transportchecks，传自拼包 URI）在这类系统上以
 * "No URI-Mapping defined for URI ..." 失败并被包装成硬门禁错误，导致创建
 * 流程必然卡死；GET /sap/bc/adt/cts/transportrequests/{tr}（请求详情）存在
 * 同类风险（与 transportchecks 同在 validateTransport 的一个 try 里，报错
 * 文本形态一致，无法从错误码区分）。7.52+ 实测（sap-demo，Basis 816 行为侧）
 * 两个资源都可用。
 *
 * 受控创建链据此改为三层语义（VSP vibing-steampunk 同源经验）：
 *
 *   1. transportchecks 降级为"软检查"：成功时给出包/请求兼容性判定；失败只
 *      记录诊断，绝不因它拒绝创建——创建 POST（corrNr）由 SAP 服务端做权威
 *      传输登记，检查失败不是拒绝写入的理由（VSP transport_choice.go 同语义）。
 *   2. 请求门禁双通道：先走 ADT transportDetails；非权威判定失败（如 URI
 *      映射缺失）时降级 E070 只读 SQL（datapreview 通道，与 TransportHistoryApi
 *      同款）；两路都失败才拒绝。"已释放"是权威判定，任何通道给出即拒绝。
 *   3. 创建后归属证明：用 E071 只读 SQL（主）/ ADT 请求对象清单（备）证明
 *      新建对象已登记进指定请求（含其全部任务）；证明不了按"结果未知"处理，
 *      禁止自动补偿删除。
 *
 * 本模块只放纯函数、SQL 构造器与类型，不做 IO；token 一律先过白名单再进
 * SQL 字面量（与 TransportHistoryApi 相同的注入防线）。
 */

/** 一次失败的传输相关调用的诊断记录（只含端点、URI、分类与已清洗的消息）。 */
export interface TransportAttempt {
  /** 尝试的端点标识（ADT 路径或 SQL 通道名）。 */
  endpoint: string
  /** 参与判定的对象/包 URI（如自拼包 URI 或请求详情路径）。 */
  uri?: string
  /** 错误分类（用于 7.51 兼容判定与排障）。 */
  classification: TransportErrorClassification
  /** 已清洗的服务端/客户端错误消息（不含原始响应体）。 */
  message: string
}

export type TransportErrorClassification =
  | 'URI_MAPPING_UNAVAILABLE'
  | 'RESOURCE_NOT_FOUND'
  | 'AUTHORIZATION'
  | 'TIMEOUT'
  | 'OTHER';

/**
 * 按错误文本粗分类。7.51 的特征错误是 "No URI-Mapping defined for URI ..."，
 * 据此可把"系统能力缺口"与普通失败区分开；分类只用于诊断展示，不参与门禁
 * 判定（门禁靠双通道兜底，不靠版本号或错误分类白名单）。
 */
export function classifyTransportError(error: unknown): TransportErrorClassification {
  const message = errorMessage(error);
  if (/uri[-_ ]?mapping/i.test(message)) return 'URI_MAPPING_UNAVAILABLE';
  if (/\b404\b|not\s*found/i.test(message)) return 'RESOURCE_NOT_FOUND';
  if (/\b40[13]\b|unauthorized|forbidden|authorization/i.test(message)) return 'AUTHORIZATION';
  if (/timeout|timed?\s*-?\s*out|etimedout|econnreset/i.test(message)) return 'TIMEOUT';
  return 'OTHER';
}

/** 预览/计划里透出的传输校验摘要（软检查结论 + 门禁通道 + 诊断）。 */
export interface TransportValidationSummary {
  /** 请求存在性与可修改性检查（双通道之一）。 */
  requestCheck: {
    transportRequest: string
    channel: 'ADT_TRANSPORT_DETAILS' | 'E070_SQL'
    /** 恒为 true（否则门禁已拒绝）；保留字段便于读取方显式判断。 */
    modifiable: boolean
    /** 请求状态码（ADT tm:status 或 E070.TRSTATUS，如 D）。 */
    status?: string
  }
  /**
   * 包/请求兼容性：SAP_CONFIRMED = transportchecks 成功且请求在候选清单；
   * NOT_CONFIRMED_BY_SAP = 检查成功但候选不含该请求（创建 POST 仍权威）；
   * CHECK_UNAVAILABLE = 检查资源不可用（7.51 特征），兼容性未经 SAP 确认。
   */
  packageCompatibility: 'SAP_CONFIRMED' | 'NOT_CONFIRMED_BY_SAP' | 'CHECK_UNAVAILABLE'
  /** 面向人的说明（含降级原因与权威语义提示）。 */
  notes: string[]
  /** 失败调用的诊断明细（端点/URI/分类/消息）。 */
  attempts: TransportAttempt[]
}

/** 归属证明结论。UNKNOWN = 两个读取通道都不可用，区别于"读到了但没有"。 */
export type TransportRegistrationOutcome = 'PROVEN' | 'PROVEN_VIA_GROUP' | 'UNPROVEN' | 'UNKNOWN';

/** 归一化的传输对象条目（E071 行或 ADT tm:abap_object 属性）。 */
export interface TransportObjectEntry {
  pgmid: string
  object: string
  name: string
}

/**
 * 把 ADT transportDetails 返回的对象清单（请求级 + 各任务级）展平为大写
 * 条目列表。ADT 通道是 E071 SQL 通道的备选：7.51 上该资源可能同样无法
 * 映射 URI，调用方须容忍其失败。
 */
export function flattenAdtTransportObjects(request: TransportRequest | undefined): TransportObjectEntry[] {
  const entries: TransportObjectEntry[] = [];
  const collect = (objects: TransportObject[] | undefined) => {
    for (const object of objects ?? []) {
      const name = String(object['tm:name'] ?? '').trim().toUpperCase();
      if (!name) continue;
      entries.push({
        pgmid: String(object['tm:pgmid'] ?? '').trim().toUpperCase(),
        object: String(object['tm:type'] ?? '').trim().toUpperCase(),
        name
      });
    }
  };
  collect(request?.objects);
  for (const task of request?.tasks ?? []) collect(task.objects);
  return entries;
}

/**
 * 各对象类型的严格登记条目（E071.OBJECT / ADT tm:type）：
 * 程序=R3TR PROG；函数组=R3TR FUGR；函数模块=LIMU FUNC；函数组包含=LIMU INC。
 * 严格匹配宁缺毋滥：匹配不到时错误详情会列出实际读到的条目，真机反馈可直接纠偏。
 */
const STRICT_OBJECTS: Record<string, string[]> = {
  PROGRAM: ['PROG'],
  FUNCTION_GROUP: ['FUGR'],
  FUNCTION_MODULE: ['FUNC'],
  FUNCTION_GROUP_INCLUDE: ['INC']
};

/**
 * 在请求（含任务）的对象条目中证明一个新建对象的登记：
 * - 严格命中（对象名 + 允许的条目类型）→ PROVEN；
 * - 函数模块/函数组包含放宽为"父函数组已整组登记"（R3TR FUGR 父组）→
 *   PROVEN_VIA_GROUP：成员对象创建时在父组锁下登记，个别系统只见组条目；
 * - 其余 → UNPROVEN（读取成功但找不到证明条目）。
 */
export function matchTransportRegistration(
  rawEntries: TransportObjectEntry[],
  objectType: string,
  objectName: string,
  parentFunctionGroup?: string
): Exclude<TransportRegistrationOutcome, 'UNKNOWN'> {
  // 条目名归一化：datapreview/ADT 返回的名字可能带小写或前后空白，统一大写后比较。
  const entries = rawEntries.map(entry => ({
    pgmid: String(entry?.pgmid ?? '').trim().toUpperCase(),
    object: String(entry?.object ?? '').trim().toUpperCase(),
    name: String(entry?.name ?? '').trim().toUpperCase()
  }));
  const name = String(objectName ?? '').trim().toUpperCase();
  const allowed = STRICT_OBJECTS[objectType] ?? [];
  const strict = entries.some(entry => entry.name === name
    && (entry.pgmid === 'R3TR' || entry.pgmid === 'LIMU')
    && allowed.includes(entry.object));
  if (strict) return 'PROVEN';
  const parent = String(parentFunctionGroup ?? '').trim().toUpperCase();
  if (parent
    && (objectType === 'FUNCTION_MODULE' || objectType === 'FUNCTION_GROUP_INCLUDE')
    && entries.some(entry => entry.pgmid === 'R3TR' && entry.object === 'FUGR' && entry.name === parent)) {
    return 'PROVEN_VIA_GROUP';
  }
  return 'UNPROVEN';
}

/**
 * 请求"已释放"判定：ADT tm:status 或 E070.TRSTATUS 均适用。
 * R（已释放）与含 RELEASE 字样的文本形态都拒绝；其余状态（D/L 等可修改态）
 * 交给创建 POST 由 SAP 权威校验，与既有门禁语义保持一致。
 */
export function isReleasedStatus(status: string): boolean {
  const normalized = String(status ?? '').trim().toUpperCase();
  return normalized === 'R' || normalized.includes('RELEASE');
}

/** 单元格容错读取（datapreview 列名大小写/前后缀差异不敏感）。 */
export function cellText(row: Record<string, unknown>, suffix: string): string {
  const key = Object.keys(row).find(candidate => candidate.toUpperCase().endsWith(suffix.toUpperCase()));
  const value = key ? row[key] : undefined;
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** SQL 字面量引用（调用方已过 token 白名单，此处仅做引号转义的纵深防御）。 */
export function quoteSqlToken(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 传输号 token 防线：仅接受 10 位大写字母数字（assertTransportFormat 的同款
 * 约束，此处兜底），防止任何路径把未校验文本送进 SQL 字面量。
 */
export function assertTrkorrToken(transportRequest: string): string {
  const normalized = String(transportRequest ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(normalized)) {
    throw new Error(`Transport number "${String(transportRequest ?? '')}" is not a valid TRKORR token.`);
  }
  return normalized;
}

/** E070 请求头查询（门禁 SQL 通道：存在性 + TRSTATUS）。 */
export function e070HeaderQuery(transportRequest: string): string {
  return `SELECT trkorr, trstatus, as4user FROM e070 WHERE trkorr = ${quoteSqlToken(assertTrkorrToken(transportRequest))}`;
}

/** E070 任务清单查询（归属证明用：请求下的全部子任务）。 */
export function e070TaskQuery(transportRequest: string): string {
  return `SELECT trkorr FROM e070 WHERE strkorr = ${quoteSqlToken(assertTrkorrToken(transportRequest))}`;
}

/** E071 对象条目查询（归属证明用：请求 + 任务集合内的全部登记行）。 */
export function e071EntriesQuery(trkorrList: string[]): string {
  const tokens = trkorrList.map(trkorr => quoteSqlToken(assertTrkorrToken(trkorr)));
  return `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN (${tokens.join(', ')})`;
}
