/**
 * 受控对象激活工作流（ObjectActivationWorkflow）。
 *
 * 任务背景：关闭能力矩阵缺口 `devtools.activate` —— 为受控 profiles
 * （development / development-workbench）提供“不动源码的重新激活”任务链，
 * 替代专家 legacy-full 的原子 activateObjects/activateByName。
 *
 * 安全模型（与 QualityCheckWorkflow 一致）：
 * 1. preview：只读调用 inactiveObjects 收集候选 → server 冻结 immutable plan
 *    （目标对象、SAP 上下文、payloadHash、TTL）。不接受调用方提供的任何
 *    ADT URI / XML / JSON 对象引用。
 * 2. apply：仅接受 server 生成的 planId；单次执行 activate；
 *    拒绝重复 apply、未知 plan、过期 plan 与跨上下文 plan。
 * 3. 结果未知即停止：activate 抛异常或返回 success=false 时，plan 置
 *    UNKNOWN_OUTCOME 并终结——部分对象可能已激活，本地无法判定真实状态，
 *    因此绝不自动重试、绝不自动删除；必须先人工只读复查再决定下一步。
 *
 * 设计取舍（有意不做的事）：
 * - 不做 apply 前 drift 复查（对比 preview 时的未激活集合）：TTL 已限制窗口，
 *   且其他用户可能并行激活对象导致集合天然变化；ADT activate 对已激活对象
 *   是无害的幂等操作，重复整包激活不会产生副作用。
 */
import type { ActivationResult, InactiveObject, InactiveObjectRecord } from '../adt/index.js';
import type { AuditEvent } from './AuditLogger.js';
import { SafeAbapError } from './errors.js';
import { ObjectActivationPlanStore } from './ObjectActivationPlanStore.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import type {
  InactiveObjectCandidate,
  ObjectActivationPlan,
  ObjectActivationPlanView,
  ObjectActivationPreviewResult,
  ObjectActivationEmptyResult,
  ObjectActivationResultSummary,
  PreviewObjectActivationInput
} from './objectActivationTypes.js';

/** 工作流依赖的 ADT 客户端端口（结构子集，便于测试 mock）。 */
interface ObjectActivationClient {
  /** 只读：列出当前系统全部未激活对象条目 */
  inactiveObjects(): Promise<InactiveObjectRecord[]>;
  /** 写入：批量激活 ADT 对象（preaudit 语义与 legacy activate 一致） */
  activate(object: InactiveObject | InactiveObject[], preauditRequested?: boolean): Promise<ActivationResult>;
}

/** 审计日志端口（与既有 workflow 的 auditLogger.append 用法一致）。 */
interface ActivationAuditSink {
  append(event: AuditEvent): Promise<void>;
}

/** 单个 plan 允许的最大目标对象数：保证激活批量有界，超过必须显式过滤。 */
const MAX_ACTIVATION_OBJECTS = 50;
/** 结果摘要中保留的最大 ADT 消息条数，超出截断。 */
const MAX_RESULT_MESSAGES = 20;

export class ObjectActivationWorkflow {
  constructor(
    private readonly client: ObjectActivationClient,
    private readonly policy: SafetyPolicy,
    private readonly plans: ObjectActivationPlanStore,
    private readonly audit: ActivationAuditSink
  ) {}

  /**
   * preview：只读收集未激活对象并生成激活 plan。
   * - input 仅允许 objectNames（可选过滤）与 preauditRequested（可选开关）；
   * - 不调用 activate，绝不产生任何 SAP 副作用；
   * - 无候选时返回 no_inactive_objects 且不创建 plan；
   * - 候选超过上限时要求调用方用 objectNames 显式缩小范围。
   */
  async preview(
    input: PreviewObjectActivationInput
  ): Promise<ObjectActivationPreviewResult | ObjectActivationEmptyResult> {
    assertAllowedKeys(input, ['objectNames', 'preauditRequested'], 'activation preview');
    const objectNames = parseObjectNames(input?.objectNames);
    // preauditRequested 缺省为 true：与 legacy activate 的默认安全行为保持一致
    const preauditRequested = input?.preauditRequested === undefined ? true : Boolean(input.preauditRequested);

    // 只读收集：inactiveObjects 是纯读 ADT 报表
    const records = await this.collectInactiveRecords();
    const candidates = selectCandidates(records, objectNames);
    if (candidates.length === 0) {
      return {
        status: 'no_inactive_objects',
        message: objectNames.length > 0
          ? 'None of the requested objects is currently inactive; no activation plan was created.'
          : 'The system reports no inactive objects; no activation plan was created.',
        confirmationRequired: false
      };
    }
    if (candidates.length > MAX_ACTIVATION_OBJECTS) {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `${candidates.length} inactive objects exceed the bounded plan limit of ${MAX_ACTIVATION_OBJECTS}; provide an explicit objectNames filter.`
      );
    }

    // 冻结执行载荷：精确 ADT 引用只能来自本次只读收集
    const payload = {
      objects: candidates.map(candidate => ({
        'adtcore:uri': candidate.objectUri,
        'adtcore:type': candidate.objectType,
        'adtcore:name': candidate.objectName,
        'adtcore:parentUri': candidate.parentUri
      })),
      preauditRequested
    };
    const plan = this.plans.create({
      context: activationContext(this.policy),
      objects: candidates,
      payload
    });
    try {
      this.plans.recordStage(plan.activationPlanId, { stage: 'PREVIEW', success: true });
      await this.audit.append(activationAuditEvent(plan, this.policy, 'OBJECT_ACTIVATION_PREVIEW_CREATED', true));
    } catch (error) {
      // 审计失败视为 preview 失败：plan 置 FAILED，绝不让无审计的激活意图存活
      this.plans.recordResult(plan.activationPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'PREVIEW', message: 'Object activation preview audit failed.'
      });
      this.plans.setStatus(plan.activationPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.status(plan.activationPlanId), confirmationRequired: true };
  }

  /** 本地查询 plan 状态（带上下文校验，跨上下文访问报 POLICY_DENIED）。 */
  status(activationPlanId: string): ObjectActivationPlanView {
    return this.plans.view(activationPlanId, activationContext(this.policy));
  }

  /**
   * apply：按已确认的 plan 执行一次激活。
   * 只接受 server 生成 plan 的 id；重复 apply、未知 plan、过期 plan、
   * 跨上下文 plan 一律拒绝。激活异常或 success=false 时置 UNKNOWN_OUTCOME 停止。
   */
  async apply(activationPlanId: string): Promise<Record<string, unknown>> {
    const context = activationContext(this.policy);
    const previewed = this.plans.getForContext(activationPlanId, context);
    // 过期 plan 单独报 PLAN_EXPIRED：与“已被消费”区分，提示调用方必须重新 preview
    if (previewed.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'activation-plan', 'Object activation plan has expired.');
    }
    if (previewed.status !== 'PREVIEWED') {
      throw new SafeAbapError(
        'PLAN_ALREADY_CONSUMED',
        'activation-plan',
        `Object activation plan is already ${previewed.status.toLowerCase()}.`
      );
    }
    const payload = previewed.payload;
    if (!payload) {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'activation-plan', 'Object activation plan payload is unavailable.');
    }

    // 进入 RUNNING：同一 plan 从此不可再次 apply
    const plan = this.plans.beginRun(activationPlanId, context);
    try {
      await this.audit.append(activationAuditEvent(plan, this.policy, 'OBJECT_ACTIVATION_CONFIRMED', true));
    } catch (error) {
      this.plans.recordResult(activationPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'CONFIRM', message: 'Object activation confirmation audit failed.'
      });
      this.plans.setStatus(activationPlanId, 'FAILED');
      throw error;
    }

    let result: ActivationResult;
    try {
      // 单次激活调用：preaudit 语义与 plan 冻结值一致
      result = await this.client.activate(payload.objects, payload.preauditRequested);
    } catch {
      // 请求异常：远端结果未知（连接中断/超时都可能导致部分激活已生效）
      return this.failWithUnknownOutcome(activationPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'EXECUTE',
        'The activation request outcome is unknown. Do not create or run a replacement plan until read-only evidence is reviewed.'
      ));
    }
    if (!result?.success) {
      // ADT 明确返回失败：批量激活可能部分生效（部分对象已激活、部分仍失败），
      // 本地无法判定真实系统状态，因此同样按 RESULT_UNKNOWN 保守处理并停止。
      return this.failWithUnknownOutcome(activationPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'EXECUTE',
        'ADT reported activation failure; individual objects may or may not have been activated. Review the inactive list before any further activation.'
      ));
    }

    const summary = summarizeActivation(result);
    this.plans.recordStage(activationPlanId, { stage: 'EXECUTE', success: true });
    this.plans.recordResult(activationPlanId, summary);
    this.plans.setStatus(activationPlanId, 'SUCCEEDED');
    await this.audit.append(activationAuditEvent(plan, this.policy, 'OBJECT_ACTIVATION_COMPLETED', true, summary));
    return { status: 'success', plan: this.status(activationPlanId) };
  }

  /**
   * RESULT_UNKNOWN 终止路径：记录阶段失败、写错误、置 UNKNOWN_OUTCOME、
   * 尽力补一条审计（审计失败不掩盖主错误），最后抛出带 plan 视图的错误。
   */
  private async failWithUnknownOutcome(
    activationPlanId: string,
    plan: ObjectActivationPlan,
    error: SafeAbapError
  ): Promise<never> {
    this.plans.recordStage(activationPlanId, { stage: error.stage, success: false, message: 'Remote outcome unknown.' });
    this.plans.recordResult(activationPlanId, undefined, { code: error.code, stage: error.stage, message: error.message });
    this.plans.setStatus(activationPlanId, 'UNKNOWN_OUTCOME');
    try {
      await this.audit.append(activationAuditEvent(plan, this.policy, 'OBJECT_ACTIVATION_UNKNOWN', false, undefined, true));
    } catch {
      // 审计失败不掩盖主错误；plan 上保留的 UNKNOWN_OUTCOME 状态是首要重放安全信号。
    }
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.status(activationPlanId) });
  }

  /**
   * 只读收集并规范化 inactiveObjects 记录：
   * - 只保留 record.object 存在的条目（纯 transport 条目无法独立激活）；
   * - 跳过 deleted 标记条目：激活“已删除”对象不是本工具的任务，
   *   删除走独立的受控清理工作流。
   */
  private async collectInactiveRecords(): Promise<InactiveObjectCandidate[]> {
    const records: InactiveObjectRecord[] = await this.client.inactiveObjects();
    if (!Array.isArray(records)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Inactive object response has an unexpected shape.');
    }
    const candidates: InactiveObjectCandidate[] = [];
    for (const record of records) {
      const element = record?.object;
      if (!element || element.deleted) continue;
      const objectType = String(element['adtcore:type'] || '').trim().toUpperCase();
      const objectName = String(element['adtcore:name'] || '').trim().toUpperCase();
      const objectUri = String(element['adtcore:uri'] || '').trim();
      const parentUri = String(element['adtcore:parentUri'] || '').trim();
      if (!objectType || !objectName || !objectUri || !parentUri) continue;
      candidates.push({
        objectType,
        objectName,
        objectUri,
        parentUri,
        ...(element.user ? { user: String(element.user).trim() } : {})
      });
    }
    return candidates;
  }
}

/**
 * 按 objectNames 精确过滤候选；objectNames 为空表示接受全部候选。
 * 名称比较统一大写，与候选规范化一致。
 */
function selectCandidates(
  candidates: InactiveObjectCandidate[],
  objectNames: string[]
): InactiveObjectCandidate[] {
  if (objectNames.length === 0) return candidates;
  const wanted = new Set(objectNames);
  return candidates.filter(candidate => wanted.has(candidate.objectName));
}

/** 解析并校验可选的 objectNames 过滤器：1..50 个、有界长度、合法字符。 */
function parseObjectNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTIVATION_OBJECTS) {
    throw new SafeAbapError(
      'VALIDATION_FAILED',
      'PREVIEW',
      `objectNames must contain between one and ${MAX_ACTIVATION_OBJECTS} exact object names.`
    );
  }
  const result = value.map(item => {
    const name = String(item || '').trim().toUpperCase();
    if (!name || name.length > 128 || !/^[A-Z0-9_/$.-]+$/.test(name)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'objectNames entries must be bounded SAP object names.');
    }
    return name;
  });
  // 重复名称没有意义，直接拒绝以保持输入整洁
  if (new Set(result).size !== result.length) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'objectNames entries must be unique.');
  }
  return result;
}

/** 把 ADT ActivationResult 压缩为有界摘要（计数 + 截断消息）。 */
function summarizeActivation(result: ActivationResult): ObjectActivationResultSummary {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const inactive = Array.isArray(result?.inactive) ? result.inactive : [];
  return {
    kind: 'OBJECT_ACTIVATION',
    success: Boolean(result?.success),
    messageCount: messages.length,
    messages: messages.slice(0, MAX_RESULT_MESSAGES).map(message => ({
      objDescr: String(message?.objDescr || '').slice(0, 128),
      type: String(message?.type || '').slice(0, 16),
      line: Number(message?.line) || 0,
      shortText: String(message?.shortText || '').slice(0, 500)
    })),
    remainingInactiveCount: inactive.length,
    truncated: messages.length > MAX_RESULT_MESSAGES
  };
}

/** 从 SafetyPolicy 提取当前 SAP 上下文（与 QualityCheck 相同的字段集合）。 */
function activationContext(policy: SafetyPolicy) {
  return {
    systemHost: policy.systemHost,
    client: policy.client,
    sapUser: policy.sapUser,
    systemRole: policy.systemRole,
    toolProfile: policy.toolProfile
  };
}

/** 构造激活专用审计事件；敏感载荷只出现 hash，不出现 URI 或对象内容。 */
function activationAuditEvent(
  plan: ObjectActivationPlan,
  policy: SafetyPolicy,
  eventType: string,
  success: boolean,
  result?: ObjectActivationResultSummary,
  unknownOutcome = false
): AuditEvent {
  return {
    correlationId: plan.activationPlanId,
    activationPlanId: plan.activationPlanId,
    eventType,
    systemHost: policy.systemHost,
    client: policy.client,
    systemRole: policy.systemRole,
    activationObjectCount: plan.objects.length,
    activationPayloadHash: plan.payloadHash,
    resultSummary: result
      ? `activated ${plan.objects.length} object(s), ${result.messageCount} message(s), ${result.remainingInactiveCount} still inactive`
      : undefined,
    unknownOutcome,
    success
  };
}

/** 拒绝输入对象上的未知字段，防止调用方夹带任意 ADT 引用。 */
function assertAllowedKeys(value: unknown, keys: string[], label: string): void {
  const record = asRecord(value);
  const unexpected = Object.keys(record).filter(key => !keys.includes(key));
  if (unexpected.length > 0) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `${label} does not accept fields: ${unexpected.join(', ')}.`);
  }
}

function asRecord(value: unknown): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Object activation input must be an object.');
  }
  return value as Record<string, any>;
}
