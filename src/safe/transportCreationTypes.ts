/**
 * 受控传输请求创建工作流（TransportCreation）的类型定义。
 *
 * 业务背景：
 * - 放开"由 AI 创建传输请求"这一个动作：当用户明确要求建请求时，AI 可经
 *   preview → 原生确认 → apply 的受控链创建一个新的工作台请求（workbench
 *   request，锚定到一个既有包）。
 * - 明确不做的事（与 AGENTS.md 安全边界一致）：
 *   - 不释放传输（release）、不删除传输（delete）、不改传输属主/加用户；
 *   - 不直接读写 E071/E071K 等传输表（创建动作仅经由 ADT CTS 创建端点，
 *     其表条目由 SAP CTS 框架自己维护）；
 *   - 不自动复用既有请求、不向请求里添加对象（那是受控对象创建链在
 *     transportRequest 维度已有的职责）。
 * - 安全规则（与 ObjectActivation/QualityCheck 同构）：
 *   - 仅接受 server 生成 plan 的 id；plan 之外不接受任何 ADT URL/XML/JSON；
 *   - 创建异常或返回请求号不可读回时，plan 置 UNKNOWN_OUTCOME 并停止，
 *     绝不自动重试、绝不自动删除（请求可能已创建，删除只能人工完成）。
 */
import type { TransportRequest } from '../adt/index.js';
import type { ToolProfile } from './types.js';

/**
 * 创建 plan 的生命周期状态。语义与激活链一致：
 * - PREVIEWED：preview 已冻结创建载荷，等待原生确认与 apply。
 * - RUNNING：已确认，创建请求正在执行（同一 plan 不允许重复 apply）。
 * - SUCCEEDED：创建成功且请求号经 transportDetails 读回验证一致。
 * - UNKNOWN_OUTCOME：创建调用异常、返回号为空或读回不一致——请求可能已
 *   创建，本地无法判定真实状态，plan 终结且禁止重试。
 * - FAILED：本地前置步骤（审计写入等）失败，远端从未被调用。
 * - EXPIRED：plan 超过 TTL 未被 apply，自动终结。
 */
export type TransportCreationStatus =
  | 'PREVIEWED' | 'RUNNING' | 'SUCCEEDED' | 'UNKNOWN_OUTCOME' | 'FAILED' | 'EXPIRED';

/**
 * plan 绑定的 SAP 上下文。apply/status 时会重新校验当前会话上下文与
 * preview 时的上下文完全一致，防止跨系统/跨客户端重放 plan。
 */
export interface TransportCreationContext {
  systemHost: string;        // SAP 主机（小写规范化）
  client: string;            // SAP 集团号
  sapUser: string;           // SAP 用户（大写规范化），即创建请求的属主
  systemRole: string;        // 系统角色：受控创建仅允许 DEV
  toolProfile: ToolProfile;  // 工具 profile：仅 development / development-workbench
}

/**
 * preview 阶段冻结的目标快照（展示与审计用）。
 * anchorUri 由 server 从 devClass 推导（/sap/bc/adt/packages/<devClass>），
 * 调用方不可直接提供任何 URL。
 */
export interface TransportCreationTarget {
  devClass: string;      // 目标开发包（已规范化为大写）
  requestText: string;   // 请求描述（SAP AS4TEXT，≤60 字符）
  transportLayer?: string; // 可选传输层（DEVLAYER）
  anchorUri: string;     // 包锚点 URI（server 推导，只读）
}

/**
 * apply 阶段实际发送给 ADT createTransport 的精确载荷。
 * 全部字段只能来自 preview 冻结值。
 */
export interface TransportCreationPayload {
  anchorUri: string;        // CreateCorrectionRequest 的 REF
  requestText: string;      // REQUEST_TEXT
  devClass: string;         // DEVCLASS
  transportLayer?: string;  // 可选 transportLayer 查询参数
}

/** 单个执行阶段记录（时间戳由 store 写入）。 */
export interface TransportCreationStage {
  stage: string;      // 阶段名：PREVIEW / CONFIRM / EXECUTE / READBACK
  success: boolean;   // 该阶段是否成功
  timestamp: string;  // ISO 时间戳
  message?: string;   // 可选补充说明
}

/** 结构化错误信息（写入 plan，避免堆栈等敏感细节外泄）。 */
export interface TransportCreationError {
  code: string;    // SafeErrorCode
  stage: string;   // 失败阶段
  message: string; // 已脱敏的错误描述
}

/**
 * 创建结果摘要（SUCCEEDED 后写入 plan 的有界结果）。
 * 请求号读回自 ADT transportDetails，属主/描述/状态均为读回值而非输入回显。
 */
export interface TransportCreationResultSummary {
  kind: 'TRANSPORT_CREATION';
  transportNumber: string;          // 创建并读回验证过的新请求号（如 S4HK9xxxxx）
  owner: string;                    // 读回的请求属主（tm:owner）
  description: string;              // 读回的请求描述（tm:desc）
  status: string;                   // 读回的请求状态（tm:status，D=可修改）
  taskCount: number;                // 读回的子任务数（新建请求通常为 0）
}

/** 创建 plan（服务端内部完整形态，含执行载荷；绝不整份回显给调用方）。 */
export interface TransportCreationPlan {
  transportCreationPlanId: string;  // server 生成的 plan 唯一 id（apply 的唯一凭据）
  createdAt: number;                // 创建时间（epoch ms）
  expiresAt: number;                // 过期时间（epoch ms，createdAt + TTL）
  terminalAt?: number;              // 进入终态的时间
  status: TransportCreationStatus;
  context: TransportCreationContext;   // preview 时的 SAP 上下文快照
  target: TransportCreationTarget;     // 目标快照（展示/审计用）
  payloadHash: string;                 // payload 的 SHA-256 指纹（审计比对用）
  payload?: TransportCreationPayload;  // 执行载荷；进入终态后立即清除
  stages: TransportCreationStage[];    // 阶段轨迹
  confirmationMode?: 'elicitation' | 'auto-config';    // 确认方式：仅支持 MCP form elicitation
  result?: TransportCreationResultSummary; // 有界结果摘要
  primaryError?: TransportCreationError;   // 首个错误
}

/** store.create 的输入。 */
export interface CreateTransportCreationPlanInput {
  context: TransportCreationContext;
  target: TransportCreationTarget;
  payload: TransportCreationPayload;
}

/** preview 工具的输入（仅两个字段，无任何 URL/引用）。 */
export interface PreviewTransportCreationInput {
  requestText?: unknown;     // 请求描述，1..60 字符
  devClass?: unknown;        // 目标开发包名
  transportLayer?: unknown;  // 可选传输层
}

/** preview 成功结果（携带 plan 视图）。 */
export interface TransportCreationPreviewResult {
  status: 'preview';
  plan: TransportCreationPlanView;
  confirmationRequired: true;
}

/**
 * plan 对外只读视图。与内部 plan 的差异：时间为 ISO 字符串、
 * 绝不包含执行载荷（payload 仅以 payloadHash 指纹出现）。
 */
export interface TransportCreationPlanView {
  transportCreationPlanId: string;
  createdAt: string;
  expiresAt: string;
  terminalAt?: string;
  status: TransportCreationStatus;
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: ToolProfile;
  target: TransportCreationTarget;
  payloadHash: string;
  stages: TransportCreationStage[];
  confirmationMode?: 'elicitation' | 'auto-config';
  result?: TransportCreationResultSummary;
  primaryError?: TransportCreationError;
}

/** transportDetails 读回的最小字段集合（结构子集，便于测试 mock）。 */
export type TransportDetailsResult = TransportRequest;
