/**
 * 受控传输请求清理工作流（TransportCleanup）的类型定义。
 *
 * 业务背景（所有者 2026-09-29 边界调整）：
 * - 空请求允许删除：传输创建链创建出的请求（以及同类空请求）不应在系统里
 *   无限堆积，AI 可以在"未释放 + 零对象 + 本人属主"三条红线同时满足时
 *   经受控链删除该请求。
 * - 明确不做的事：
 *   - 非空请求（E071 有对象）绝不删除——删除非空请求意味着丢弃开发成果；
 *   - 已释放请求绝不删除；他人属主的请求绝不删除；
 *   - 释放（release）、改属主、加用户与直改 E071/E071K 仍一律禁止。
 * - 安全规则（与受控创建链同构）：
 *   - preview 只读核验三条红线并冻结 plan；任何红线不满足时拒绝且不建 plan；
 *   - apply 仅接受 server 生成 planId；form elicitation 原生确认后单次删除；
 *   - 删除后必须读回验证"缺席"（transportDetails 应报错/不存在）才算
 *     SUCCEEDED；删除调用异常或请求仍可读时置 UNKNOWN_OUTCOME 并终结，
 *     绝不自动重试（请求是否真的已删只能人工只读复核）。
 */
import type { TransportRequest } from '../adt/index.js';
import type { ToolProfile } from './types.js';

/**
 * 清理 plan 的生命周期状态（与创建链一致）：
 * - PREVIEWED：preview 已冻结目标请求快照，等待原生确认与 apply。
 * - RUNNING：已确认，删除正在执行（同一 plan 不允许重复 apply）。
 * - SUCCEEDED：删除完成且读回验证请求已缺席。
 * - UNKNOWN_OUTCOME：删除调用异常或请求仍可读——结果未知/未达成，
 *   plan 终结且禁止重试。
 * - FAILED：本地前置步骤（审计写入等）失败，远端从未被调用。
 * - EXPIRED：plan 超过 TTL 未被 apply，自动终结。
 */
export type TransportCleanupStatus =
  | 'PREVIEWED' | 'RUNNING' | 'SUCCEEDED' | 'UNKNOWN_OUTCOME' | 'FAILED' | 'EXPIRED';

/**
 * plan 绑定的 SAP 上下文。apply/status 时会重新校验当前会话上下文与
 * preview 时的上下文完全一致，防止跨系统/跨客户端重放 plan。
 */
export interface TransportCleanupContext {
  systemHost: string;        // SAP 主机（小写规范化）
  client: string;            // SAP 集团号
  sapUser: string;           // SAP 用户（大写规范化）——必须与请求属主一致
  systemRole: string;        // 系统角色：受控清理仅允许 DEV
  toolProfile: ToolProfile;  // 工具 profile：仅 development / development-workbench
}

/**
 * preview 阶段冻结的目标请求快照（展示与审计用）。
 * 全部字段来自 preview 时的只读 transportDetails 读回，不接受调用方断言。
 */
export interface TransportCleanupTarget {
  transportNumber: string;  // 目标请求号（10 位，已规范化为大写）
  owner: string;            // 读回的请求属主（已剥前导零）
  requestStatus: string;    // 读回的请求状态（必须为 D=可修改/未释放）
  taskCount: number;        // 读回的子任务数
  objectCount: number;      // 读回的对象总数（请求本体 + 全部子任务，必须为 0）
}

/** apply 阶段实际发送给 ADT transportDelete 的精确载荷。 */
export interface TransportCleanupPayload {
  transportNumber: string;  // 仅此一个字段：删除目标由 plan 冻结
}

/** 单个执行阶段记录（时间戳由 store 写入）。 */
export interface TransportCleanupStage {
  stage: string;      // 阶段名：PREVIEW / CONFIRM / EXECUTE / READBACK
  success: boolean;   // 该阶段是否成功
  timestamp: string;  // ISO 时间戳
  message?: string;   // 可选补充说明
}

/** 结构化错误信息（写入 plan，避免堆栈等敏感细节外泄）。 */
export interface TransportCleanupError {
  code: string;    // SafeErrorCode
  stage: string;   // 失败阶段
  message: string; // 已脱敏的错误描述
}

/** 清理结果摘要（SUCCEEDED 后写入 plan 的有界结果）。 */
export interface TransportCleanupResultSummary {
  kind: 'TRANSPORT_CLEANUP';
  transportNumber: string;   // 已删除并验证缺席的请求号
  absenceVerified: true;     // 读回验证：transportDetails 不再返回该请求
}

/** 清理 plan（服务端内部完整形态，含执行载荷；绝不整份回显给调用方）。 */
export interface TransportCleanupPlan {
  transportCleanupPlanId: string;   // server 生成的 plan 唯一 id（apply 的唯一凭据）
  createdAt: number;                // 创建时间（epoch ms）
  expiresAt: number;                // 过期时间（epoch ms，createdAt + TTL）
  terminalAt?: number;              // 进入终态的时间
  status: TransportCleanupStatus;
  context: TransportCleanupContext; // preview 时的 SAP 上下文快照
  target: TransportCleanupTarget;   // 目标请求快照（展示/审计用）
  payloadHash: string;              // payload 的 SHA-256 指纹（审计比对用）
  payload?: TransportCleanupPayload; // 执行载荷；进入终态后立即清除
  stages: TransportCleanupStage[];  // 阶段轨迹
  confirmationMode?: 'elicitation' | 'auto-config'; // 确认方式：仅支持 MCP form elicitation
  result?: TransportCleanupResultSummary; // 有界结果摘要
  primaryError?: TransportCleanupError;   // 首个错误
}

/** store.create 的输入。 */
export interface CreateTransportCleanupPlanInput {
  context: TransportCleanupContext;
  target: TransportCleanupTarget;
  payload: TransportCleanupPayload;
}

/** preview 工具的输入（仅请求号一个字段）。 */
export interface PreviewTransportCleanupInput {
  transportNumber?: unknown; // 目标请求号，10 位
}

/** preview 成功结果（携带 plan 视图）。 */
export interface TransportCleanupPreviewResult {
  status: 'preview';
  plan: TransportCleanupPlanView;
  confirmationRequired: true;
}

/**
 * plan 对外只读视图。与内部 plan 的差异：时间为 ISO 字符串、
 * 绝不包含执行载荷（payload 仅以 payloadHash 指纹出现）。
 */
export interface TransportCleanupPlanView {
  transportCleanupPlanId: string;
  createdAt: string;
  expiresAt: string;
  terminalAt?: string;
  status: TransportCleanupStatus;
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: ToolProfile;
  target: TransportCleanupTarget;
  payloadHash: string;
  stages: TransportCleanupStage[];
  confirmationMode?: 'elicitation' | 'auto-config';
  result?: TransportCleanupResultSummary;
  primaryError?: TransportCleanupError;
}

/** transportDetails 读回的最小字段集合（结构子集，便于测试 mock）。 */
export type TransportDetailsResult = TransportRequest;
