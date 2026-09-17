/**
 * 受控对象激活 plan 存储（ObjectActivationPlanStore）。
 *
 * 设计完全对齐 QualityCheckPlanStore：
 * - plan 是 server 生成并冻结的不可变意图记录：preview 时一次性写入目标对象与
 *   执行载荷，apply 只能按 planId 消费一次。
 * - TTL：PREVIEWED 状态的 plan 超时后自动置 EXPIRED；终态 plan 在容量压力下
 *   按时间先后驱逐。
 * - 上下文绑定：apply/status 必须携带与 preview 一致的 SAP 上下文
 *   （host/client/user/role/profile），跨上下文重放 plan 直接 POLICY_DENIED。
 * - 终态（含 UNKNOWN_OUTCOME）立即清除执行载荷，只保留有界摘要与错误。
 */
import { createHash, randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type {
  CreateObjectActivationPlanInput,
  ObjectActivationContext,
  ObjectActivationError,
  ObjectActivationPlan,
  ObjectActivationPlanView,
  ObjectActivationResultSummary,
  ObjectActivationStage,
  ObjectActivationStatus
} from './objectActivationTypes.js';

export class ObjectActivationPlanStore {
  /** 全部激活 plan，按 planId 索引。 */
  private readonly plans = new Map<string, ObjectActivationPlan>();

  constructor(
    /** plan 存活时长（毫秒），由 SafetyPolicy.planTtlMs 统一配置 */
    private readonly ttlMs: number,
    /** 可注入时钟，测试用固定时间获得确定性 */
    private readonly now: () => number = () => Date.now(),
    /** 可注入 planId 生成器，测试用固定 id 获得确定性 */
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    /** plan 容量上限，超出时优先驱逐终态 plan，仍满则拒绝创建 */
    private readonly maxEntries: number = 100
  ) {}

  /**
   * 创建新的激活 plan（PREVIEWED 状态）。
   * payload 会被深拷贝冻结；payloadHash 是对载荷的 SHA-256 指纹，
   * 用于审计比对 plan 内容，不泄露载荷本身。
   */
  create(input: CreateObjectActivationPlanInput): ObjectActivationPlan {
    this.cleanupExpired();
    this.evictTerminalPlans();
    if (this.plans.size >= this.maxEntries) {
      throw new SafeAbapError('PLAN_CAPACITY_FULL', 'activation-plan', 'Object activation plan capacity is full.');
    }
    const createdAt = this.now();
    // 冻结执行载荷：objects 与 preaudit 一经写入不可变更
    const payload = {
      objects: structuredClone(input.payload.objects),
      preauditRequested: input.payload.preauditRequested
    };
    const plan: ObjectActivationPlan = {
      activationPlanId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'PREVIEWED',
      context: normalizeContext(input.context),
      objects: input.objects.map(candidate => ({ ...candidate })),
      payloadHash: fingerprint(payload),
      payload,
      stages: []
    };
    this.plans.set(plan.activationPlanId, plan);
    return plan;
  }

  /** 按 id 取 plan；不存在则 PLAN_NOT_FOUND。查询前先做过期清理。 */
  get(activationPlanId: string): ObjectActivationPlan {
    this.cleanupExpired();
    const plan = this.plans.get(activationPlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'activation-plan', 'Object activation plan was not found.');
    return plan;
  }

  /** 取 plan 并校验当前 SAP 上下文与 preview 一致，防止跨系统/跨客户端重放。 */
  getForContext(activationPlanId: string, context: ObjectActivationContext): ObjectActivationPlan {
    const plan = this.get(activationPlanId);
    if (!sameContext(plan.context, normalizeContext(context))) {
      throw new SafeAbapError('POLICY_DENIED', 'activation-plan', 'Object activation plan does not match the current SAP context.');
    }
    return plan;
  }

  /**
   * 进入执行态（RUNNING）。仅 PREVIEWED 状态可进入：
   * - EXPIRED 明确报 PLAN_EXPIRED；
   * - 其他非 PREVIEWED 状态报 PLAN_ALREADY_CONSUMED（含重复 apply）。
   */
  beginRun(activationPlanId: string, context: ObjectActivationContext): ObjectActivationPlan {
    const plan = this.getForContext(activationPlanId, context);
    if (plan.status === 'EXPIRED') throw new SafeAbapError('PLAN_EXPIRED', 'activation-plan', 'Object activation plan has expired.');
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'activation-plan', `Object activation plan is already ${plan.status.toLowerCase()}.`);
    }
    plan.status = 'RUNNING';
    plan.confirmationMode = 'elicitation';
    return plan;
  }

  /** 更新 plan 状态；进入终态时记录 terminalAt 并立即清除执行载荷。 */
  setStatus(activationPlanId: string, status: ObjectActivationStatus): ObjectActivationPlan {
    const plan = this.get(activationPlanId);
    plan.status = status;
    if (isTerminal(status)) {
      plan.terminalAt = this.now();
      plan.payload = undefined;
    }
    return plan;
  }

  /** 追加阶段轨迹（时间戳由 store 统一生成）。 */
  recordStage(activationPlanId: string, stage: Omit<ObjectActivationStage, 'timestamp'>): void {
    const plan = this.get(activationPlanId);
    plan.stages.push({ ...stage, timestamp: new Date(this.now()).toISOString() });
  }

  /** 写入结果摘要或错误（互相排斥；深拷贝避免外部引用篡改）。 */
  recordResult(activationPlanId: string, result?: ObjectActivationResultSummary, error?: ObjectActivationError): void {
    const plan = this.get(activationPlanId);
    plan.result = result ? structuredClone(result) : undefined;
    plan.primaryError = error ? { ...error } : undefined;
  }

  /** 对外只读视图：时间转 ISO 字符串；绝不包含执行载荷。 */
  view(activationPlanId: string, context?: ObjectActivationContext): ObjectActivationPlanView {
    const plan = context ? this.getForContext(activationPlanId, context) : this.get(activationPlanId);
    return {
      activationPlanId: plan.activationPlanId,
      createdAt: new Date(plan.createdAt).toISOString(),
      expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      sapUser: plan.context.sapUser,
      systemRole: plan.context.systemRole,
      toolProfile: plan.context.toolProfile,
      objects: plan.objects.map(object => ({ ...object })),
      payloadHash: plan.payloadHash,
      stages: plan.stages.map(stage => ({ ...stage })),
      confirmationMode: plan.confirmationMode,
      result: plan.result ? structuredClone(plan.result) : undefined,
      primaryError: plan.primaryError ? { ...plan.primaryError } : undefined
    };
  }

  /** 把已到 TTL 的 PREVIEWED plan 置为 EXPIRED（惰性清理，查询时触发）。 */
  private cleanupExpired(): void {
    const timestamp = this.now();
    for (const plan of this.plans.values()) {
      if (plan.status === 'PREVIEWED' && timestamp >= plan.expiresAt) {
        plan.status = 'EXPIRED';
        plan.terminalAt = timestamp;
        plan.payload = undefined;
      }
    }
  }

  /** 容量压力下按终态时间从早到晚驱逐终态 plan；无终态 plan 可驱逐时保留现状。 */
  private evictTerminalPlans(): void {
    while (this.plans.size >= this.maxEntries) {
      const removable = [...this.plans.values()]
        .filter(plan => isTerminal(plan.status))
        .sort((left, right) => (left.terminalAt || left.createdAt) - (right.terminalAt || right.createdAt))[0];
      if (!removable) return;
      this.plans.delete(removable.activationPlanId);
    }
  }
}

/** 上下文规范化：host 小写、user/role 大写，保证比对的一致性。 */
function normalizeContext(context: ObjectActivationContext): ObjectActivationContext {
  return {
    systemHost: String(context.systemHost || '').trim().toLowerCase(),
    client: String(context.client || '').trim(),
    sapUser: String(context.sapUser || '').trim().toUpperCase(),
    systemRole: String(context.systemRole || '').trim().toUpperCase(),
    toolProfile: context.toolProfile
  };
}

/** 逐字段比较两个上下文是否完全一致。 */
function sameContext(left: ObjectActivationContext, right: ObjectActivationContext): boolean {
  return left.systemHost === right.systemHost
    && left.client === right.client
    && left.sapUser === right.sapUser
    && left.systemRole === right.systemRole
    && left.toolProfile === right.toolProfile;
}

/** 对执行载荷计算 SHA-256 指纹。 */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** 终态判定：只有 PREVIEWED 与 RUNNING 是非终态。 */
function isTerminal(status: ObjectActivationStatus): boolean {
  return status !== 'PREVIEWED' && status !== 'RUNNING';
}
