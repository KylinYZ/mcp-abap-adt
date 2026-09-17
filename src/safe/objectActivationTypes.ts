/**
 * 受控对象激活工作流（ObjectActivation）的类型定义。
 *
 * 业务背景：
 * - 关闭能力矩阵缺口 `devtools.activate`：VSP 有独立的对象重新激活任务
 *   （Activate / ActivatePackage），本项目此前仅专家 legacy-full 暴露原子
 *   activateObjects/activateByName，受控 profiles 没有独立激活任务。
 * - 本工作流提供与 QualityCheck 一致的受控链路：
 *   preview（只读收集未激活对象并冻结 plan）→ 原生确认 → apply（单次激活）→ status。
 * - 安全规则：
 *   - 仅接受 server 生成 plan 的 id，不接受调用方拼装的任意对象引用（ADT URI、
 *     XML、JSON 均不可作为输入），杜绝 legacy 原子工具的任意 URL 攻击面。
 *   - 激活失败或远端结果未知时，plan 置 UNKNOWN_OUTCOME 并停止：
 *     不自动重试、不自动删除、不得创建替代 plan 前不先人工只读取证。
 */
import type { ActivationResult, InactiveObject } from '../adt/index.js';
import type { ToolProfile } from './types.js';

/**
 * 激活 plan 的生命周期状态。
 * - PREVIEWED：preview 已冻结目标集合，等待原生确认与 apply。
 * - RUNNING：已确认，激活请求正在执行（同一 plan 不允许并发/重复 apply）。
 * - SUCCEEDED：ADT 明确返回 success=true，激活完成。
 * - UNKNOWN_OUTCOME：激活请求异常或 ADT 返回 success=false；此时部分对象可能
 *   已激活，本地无法判定真实状态，plan 终结且禁止重试（RESULT_UNKNOWN 语义）。
 * - FAILED：本地前置步骤（审计写入等）失败，远端从未被调用。
 * - EXPIRED：plan 超过 TTL 未被 apply，自动终结。
 */
export type ObjectActivationStatus =
  | 'PREVIEWED' | 'RUNNING' | 'SUCCEEDED' | 'UNKNOWN_OUTCOME' | 'FAILED' | 'EXPIRED';

/**
 * plan 绑定的 SAP 上下文。apply/status 时会重新校验当前会话上下文与
 * preview 时的上下文完全一致，防止跨系统/跨客户端重放 plan。
 */
export interface ObjectActivationContext {
  systemHost: string;   // SAP 主机（小写规范化）
  client: string;       // SAP 集团号（3 位数字）
  sapUser: string;      // SAP 用户（大写规范化）
  systemRole: string;   // 系统角色：受控激活仅允许 DEV
  toolProfile: ToolProfile; // 工具 profile：受控激活仅允许 development / development-workbench
}

/**
 * 单个未激活对象的候选快照（preview 阶段从 inactiveObjects 只读结果中提取）。
 * 字段来自 ADT InactiveObjectElement 的 adtcore 属性。
 */
export interface InactiveObjectCandidate {
  objectType: string; // adtcore:type，例如 CLAS/OC、PROG/P
  objectName: string; // adtcore:name，对象主名称
  objectUri: string;  // adtcore:uri，ADT 对象 URI（由 server 冻结，调用方不可提供）
  parentUri: string;  // adtcore:parentUri，父对象 URI（激活协议所需）
  user?: string;      // 最后修改该（未激活）对象的 SAP 用户
}

/**
 * apply 阶段实际发送给 ADT activate 的精确载荷。
 * objects 使用 ADT 原生四字段引用，只能由 preview 从 inactiveObjects 冻结产生。
 */
export interface ObjectActivationPayload {
  objects: InactiveObject[];      // 精确 ADT 对象引用集合
  preauditRequested: boolean;     // 是否请求 ADT 预审计（与 legacy activate 语义一致）
}

/** 单个执行阶段记录（时间戳由 store 写入）。 */
export interface ObjectActivationStage {
  stage: string;      // 阶段名：PREVIEW / CONFIRM / EXECUTE 等
  success: boolean;   // 该阶段是否成功
  timestamp: string;  // ISO 时间戳
  message?: string;   // 可选补充说明
}

/** 结构化错误信息（写入 plan，避免堆栈等敏感细节外泄）。 */
export interface ObjectActivationError {
  code: string;   // SafeErrorCode
  stage: string;  // 失败阶段
  message: string; // 已脱敏的错误描述
}

/**
 * 激活结果摘要（SUCCEEDED 后写入 plan 的有界结果）。
 * 只保留计数与截断后的消息列表，避免把完整 ADT 响应回显给调用方。
 */
export interface ObjectActivationResultSummary {
  kind: 'OBJECT_ACTIVATION';       // 结果类型标识
  success: boolean;                // ADT 报告的激活结果
  messageCount: number;            // ADT 返回的消息总数
  messages: Array<{                // 截断后的消息摘要（最多 20 条）
    objDescr: string;              // 对象描述
    type: string;                  // 消息类型（E/W/I 等）
    line: number;                  // 相关行号
    shortText: string;             // 消息短文本
  }>;
  remainingInactiveCount: number;  // 激活后 ADT 报告的剩余未激活条目数
  truncated: boolean;              // 消息列表是否被截断
}

/** 激活 plan（服务端内部完整形态，含执行载荷；绝不整份回显给调用方）。 */
export interface ObjectActivationPlan {
  activationPlanId: string;   // server 生成的 plan 唯一 id（apply 的唯一凭据）
  createdAt: number;          // 创建时间（epoch ms）
  expiresAt: number;          // 过期时间（epoch ms，createdAt + TTL）
  terminalAt?: number;        // 进入终态的时间
  status: ObjectActivationStatus;
  context: ObjectActivationContext;          // preview 时的 SAP 上下文快照
  objects: InactiveObjectCandidate[];        // 目标对象快照（展示/审计用）
  payloadHash: string;        // 对 payload 的 SHA-256 指纹，用于识别 plan 内容
  payload?: ObjectActivationPayload; // 执行载荷；进入终态后立即清除
  stages: ObjectActivationStage[];   // 阶段轨迹
  confirmationMode?: 'elicitation';  // 确认方式：仅支持 MCP form elicitation
  result?: ObjectActivationResultSummary; // 有界结果摘要
  primaryError?: ObjectActivationError;   // 首个错误
}

/** store.create 的输入。 */
export interface CreateObjectActivationPlanInput {
  context: ObjectActivationContext;
  objects: InactiveObjectCandidate[];
  payload: ObjectActivationPayload;
}

/** plan 的对外只读视图（时间转 ISO 字符串，不含执行载荷）。 */
export interface ObjectActivationPlanView {
  activationPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: ObjectActivationStatus;
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: ToolProfile;
  objects: InactiveObjectCandidate[];
  payloadHash: string;
  stages: ObjectActivationStage[];
  confirmationMode?: 'elicitation';
  result?: ObjectActivationResultSummary;
  primaryError?: ObjectActivationError;
}

/** preview 成功结果：plan 已冻结，等待原生确认。 */
export interface ObjectActivationPreviewResult {
  status: 'preview';
  plan: ObjectActivationPlanView;
  confirmationRequired: true;
}

/** preview 空结果：系统当前没有可激活的未激活对象，不创建 plan。 */
export interface ObjectActivationEmptyResult {
  status: 'no_inactive_objects';
  message: string;
  confirmationRequired: false;
}

/** previewObjectActivation 工具的输入（不含任何对象引用/URL，仅可选过滤条件）。 */
export interface PreviewObjectActivationInput {
  objectNames?: string[];      // 可选：限定要激活的对象名（精确匹配，自动大写）；缺省=全部未激活对象
  preauditRequested?: boolean; // 可选：是否请求 ADT 预审计；缺省 true
}

/** ADT 激活结果的受控子集，工作流 client 端口只依赖这些成员。 */
export type ObjectActivationAdtResult = ActivationResult;
