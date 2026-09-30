/**
 * 受控传输请求清理工作流（TransportCleanupWorkflow）。
 *
 * 任务背景（所有者 2026-09-29 边界调整）：空请求允许删除——传输创建链
 * 创建的请求不应在系统里堆积，AI 可在三条红线同时满足时经受控链删除：
 *   1. 未释放：请求状态必须为 D（可修改）；
 *   2. 零对象：请求本体 + 全部子任务的 E071 对象总数必须为 0；
 *   3. 本人属主：请求属主必须等于当前 SAP 用户（数字型用户名剥前导零比较）。
 * 任何一条不满足，preview 直接拒绝且不建 plan——删除非空/已释放/他人请求
 * 仍然一律禁止。
 *
 * 安全模型（与受控创建链一致）：
 * 1. preview：只读 transportDetails 核验红线 → server 冻结 immutable plan
 *    （请求号、属主、状态、对象数、payloadHash、TTL）。不接受除请求号外的
 *    任何输入。
 * 2. apply：仅接受 server 生成的 planId；form elicitation 原生确认后单次
 *    执行 transportDelete（ADT DELETE /cts/transportrequests/<number>）。
 * 3. 缺席验证：删除后再次只读 transportDetails——仍能读到即视为未达成
 *    （UNKNOWN_OUTCOME 终结），读不到（抛异常/404）才算 SUCCEEDED。
 * 4. 结果未知即停止：删除调用异常（超时/中断，请求是否已删未知）置
 *    UNKNOWN_OUTCOME——绝不自动重试，人工只读复核后再决定。
 */
import type { TransportRequest } from '../adt/index.js';
import type { AuditEvent } from './AuditLogger.js';
import { SafeAbapError } from './errors.js';
import { TransportCleanupPlanStore } from './TransportCleanupPlanStore.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import type {
  PreviewTransportCleanupInput,
  TransportCleanupPayload,
  TransportCleanupPlan,
  TransportCleanupPlanView,
  TransportCleanupPreviewResult,
  TransportCleanupResultSummary,
  TransportCleanupTarget
} from './transportCleanupTypes.js';

/** 工作流依赖的 ADT 客户端端口（结构子集，便于测试 mock）。 */
interface TransportCleanupClient {
  /** 只读：按请求号读回请求详情（属主/状态/子任务/对象） */
  transportDetails(transportNumber: string): Promise<TransportRequest>;
  /** 写入：删除传输请求（ADT DELETE /cts/transportrequests/<number>） */
  transportDelete(transportNumber: string): Promise<void>;
}

/** 审计日志端口（与既有 workflow 的 auditLogger.append 用法一致）。 */
interface TransportCleanupAuditSink {
  append(event: AuditEvent): Promise<void>;
}

export class TransportCleanupWorkflow {
  constructor(
    private readonly client: TransportCleanupClient,
    private readonly policy: SafetyPolicy,
    private readonly plans: TransportCleanupPlanStore,
    private readonly audit: TransportCleanupAuditSink
  ) {}

  /**
   * preview：只读核验三条红线并生成清理 plan。
   * - input 仅允许 transportNumber 一个字段；
   * - 请求不存在/非本人属主/已释放/非空：分别给出确定性拒绝，不建 plan；
   * - 全程零写副作用。
   */
  async preview(
    input: PreviewTransportCleanupInput
  ): Promise<TransportCleanupPreviewResult> {
    assertAllowedKeys(input, ['transportNumber'], 'transport cleanup preview');
    const transportNumber = parseTransportNumber(input?.transportNumber);

    // 红线核验：全部依据只读 transportDetails 读回值，不接受调用方断言
    let details: TransportRequest;
    try {
      details = await this.client.transportDetails(transportNumber);
    } catch {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `Transport ${transportNumber} was not found (read-back failed); nothing to clean up.`
      );
    }
    const owner = String(details?.['tm:owner'] || '').trim();
    const requestStatus = String(details?.['tm:status'] || '').trim().toUpperCase();
    const tasks = Array.isArray(details?.tasks) ? details.tasks : [];
    // 对象总数 = 请求本体 tm:abap_object + 各子任务的对象；非空即拒
    const objectCount
      = (Array.isArray(details?.objects) ? details.objects.length : 0)
      + tasks.reduce((sum, task) => sum + (Array.isArray(task?.objects) ? task.objects.length : 0), 0);
    if (stripZeros(owner) !== stripZeros(this.policy.sapUser)) {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `Transport ${transportNumber} is owned by '${owner}', not the current user; deleting other users' requests is not permitted.`
      );
    }
    if (requestStatus !== 'D') {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `Transport ${transportNumber} has status '${requestStatus}' (only modifiable 'D' requests can be cleaned up); released or locked requests are out of scope.`
      );
    }
    if (objectCount > 0) {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `Transport ${transportNumber} still contains ${objectCount} object(s); only empty requests can be cleaned up.`
      );
    }

    const target: TransportCleanupTarget = {
      transportNumber,
      owner,
      requestStatus,
      taskCount: tasks.length,
      objectCount
    };
    const plan = this.plans.create({
      context: cleanupContext(this.policy),
      target,
      payload: frozenPayload(target)
    });
    try {
      this.plans.recordStage(plan.transportCleanupPlanId, { stage: 'PREVIEW', success: true });
      await this.audit.append(cleanupAuditEvent(plan, this.policy, 'TRANSPORT_CLEANUP_PREVIEW_CREATED', true));
    } catch (error) {
      // 审计失败视为 preview 失败：plan 置 FAILED，绝不让无审计的删除意图存活
      this.plans.recordResult(plan.transportCleanupPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'PREVIEW', message: 'Transport cleanup preview audit failed.'
      });
      this.plans.setStatus(plan.transportCleanupPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.status(plan.transportCleanupPlanId), confirmationRequired: true };
  }

  /** 本地查询 plan 状态（带上下文校验，跨上下文访问报 POLICY_DENIED）。 */
  status(transportCleanupPlanId: string): TransportCleanupPlanView {
    return this.plans.view(transportCleanupPlanId, cleanupContext(this.policy));
  }

  /**
   * apply：按已确认的 plan 执行一次删除。
   * 只接受 server 生成 plan 的 id；重复 apply、未知 plan、过期 plan、
   * 跨上下文 plan 一律拒绝。删除异常或请求仍可读时置 UNKNOWN_OUTCOME 停止。
   */
  async apply(transportCleanupPlanId: string): Promise<Record<string, unknown>> {
    const context = cleanupContext(this.policy);
    const previewed = this.plans.getForContext(transportCleanupPlanId, context);
    // 过期 plan 单独报 PLAN_EXPIRED：与"已被消费"区分，提示调用方必须重新 preview
    if (previewed.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'transport-cleanup-plan', 'Transport cleanup plan has expired.');
    }
    if (previewed.status !== 'PREVIEWED') {
      throw new SafeAbapError(
        'PLAN_ALREADY_CONSUMED',
        'transport-cleanup-plan',
        `Transport cleanup plan is already ${previewed.status.toLowerCase()}.`
      );
    }
    const payload = previewed.payload;
    if (!payload) {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'transport-cleanup-plan', 'Transport cleanup plan payload is unavailable.');
    }

    // 进入 RUNNING：同一 plan 从此不可再次 apply
    const plan = this.plans.beginRun(transportCleanupPlanId, context);
    try {
      await this.audit.append(cleanupAuditEvent(plan, this.policy, 'TRANSPORT_CLEANUP_CONFIRMED', true));
    } catch (error) {
      // 远端尚未被调用，本地审计失败可以安全地置 FAILED
      this.plans.recordResult(transportCleanupPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'CONFIRM', message: 'Transport cleanup confirmation audit failed.'
      });
      this.plans.setStatus(transportCleanupPlanId, 'FAILED');
      throw error;
    }

    // 单次删除调用：目标请求号由 plan 冻结
    try {
      await this.client.transportDelete(payload.transportNumber);
    } catch (error) {
      // 删除异常：远端结果未知（超时/中断都可能导致删除已生效），
      // 按 UNKNOWN_OUTCOME 保守处理并停止，绝不自动重试。
      return this.failWithUnknownOutcome(transportCleanupPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'EXECUTE',
        `The transport deletion outcome is unknown (${sanitizeMessage(error)}). `
        + 'Verify the request read-only before any further action.'
      ));
    }
    this.plans.recordStage(transportCleanupPlanId, { stage: 'EXECUTE', success: true });

    // 缺席验证（create/readback 双步的删除侧对应）：仍能读到即未达成
    let stillReadable = false;
    try {
      await this.client.transportDetails(payload.transportNumber);
      stillReadable = true;
    } catch {
      // 读不到（404/报错）= 缺席成立
    }
    if (stillReadable) {
      return this.failWithUnknownOutcome(transportCleanupPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'READBACK',
        `Transport ${payload.transportNumber} is still readable after the delete call; the cleanup did not take effect. `
        + 'Verify read-only before any further action.'
      ));
    }

    const summary: TransportCleanupResultSummary = {
      kind: 'TRANSPORT_CLEANUP',
      transportNumber: payload.transportNumber,
      absenceVerified: true
    };
    this.plans.recordStage(transportCleanupPlanId, { stage: 'READBACK', success: true, message: 'absence verified' });
    this.plans.recordResult(transportCleanupPlanId, summary);
    this.plans.setStatus(transportCleanupPlanId, 'SUCCEEDED');
    await this.audit.append(cleanupAuditEvent(plan, this.policy, 'TRANSPORT_CLEANUP_COMPLETED', true, summary));
    return { status: 'success', plan: this.status(transportCleanupPlanId) };
  }

  /**
   * UNKNOWN_OUTCOME 终止路径：记录阶段失败、写错误、置 UNKNOWN_OUTCOME、
   * 尽力补一条审计（审计失败不掩盖主错误），最后抛出带 plan 视图的错误。
   */
  private async failWithUnknownOutcome(
    transportCleanupPlanId: string,
    plan: TransportCleanupPlan,
    error: SafeAbapError
  ): Promise<never> {
    this.plans.recordStage(transportCleanupPlanId, {
      stage: error.stage, success: false, message: 'Remote outcome unknown.'
    });
    this.plans.recordResult(transportCleanupPlanId, undefined, {
      code: error.code, stage: error.stage, message: error.message
    });
    this.plans.setStatus(transportCleanupPlanId, 'UNKNOWN_OUTCOME');
    try {
      await this.audit.append(cleanupAuditEvent(
        plan, this.policy, 'TRANSPORT_CLEANUP_UNKNOWN', false, undefined, true
      ));
    } catch {
      // 审计失败不掩盖主错误；plan 上保留的 UNKNOWN_OUTCOME 状态是首要重放安全信号。
    }
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.status(transportCleanupPlanId) });
  }
}

/**
 * 解析并校验目标请求号：10 位、SAP TRKORR 工作台/定制请求形态
 * （第 4 位为 K，与 legacy transportDelete 的 validateTransport 语义一致）。
 */
function parseTransportNumber(value: unknown): string {
  const transportNumber = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{2}K[0-9]{6}$/.test(transportNumber)) {
    throw new SafeAbapError(
      'VALIDATION_FAILED',
      'PREVIEW',
      'transportNumber must be a 10-character SAP transport request number (e.g. S4HK900123).'
    );
  }
  return transportNumber;
}

/** 由冻结目标生成执行载荷。 */
function frozenPayload(target: TransportCleanupTarget): TransportCleanupPayload {
  return { transportNumber: target.transportNumber };
}

/** 从 SafetyPolicy 提取当前 SAP 上下文（与创建链相同的字段集合）。 */
function cleanupContext(policy: SafetyPolicy) {
  return {
    systemHost: policy.systemHost,
    client: policy.client,
    sapUser: policy.sapUser,
    systemRole: policy.systemRole,
    toolProfile: policy.toolProfile
  };
}

/** 属主比较辅助：数字型用户名剥前导零（068157 → 68157，真机实锤形态差异）。 */
function stripZeros(value: string): string {
  return value.replace(/^0+/, '');
}

/** 构造清理专用审计事件；载荷只出现 hash，不出现请求内容。 */
function cleanupAuditEvent(
  plan: TransportCleanupPlan,
  policy: SafetyPolicy,
  eventType: string,
  success: boolean,
  result?: TransportCleanupResultSummary,
  unknownOutcome = false
): AuditEvent {
  return {
    correlationId: plan.transportCleanupPlanId,
    transportCleanupPlanId: plan.transportCleanupPlanId,
    eventType,
    systemHost: policy.systemHost,
    client: policy.client,
    systemRole: policy.systemRole,
    transportRequest: plan.target.transportNumber,
    resultSummary: result
      ? `deleted empty transport ${result.transportNumber} (absence verified)`
      : undefined,
    unknownOutcome,
    success
  };
}

/** 拒绝输入对象上的未知字段，防止调用方夹带任意引用。 */
function assertAllowedKeys(value: unknown, keys: string[], label: string): void {
  const record = asRecord(value);
  const unexpected = Object.keys(record).filter(key => !keys.includes(key));
  if (unexpected.length > 0) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `${label} does not accept fields: ${unexpected.join(', ')}.`);
  }
}

function asRecord(value: unknown): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Transport cleanup input must be an object.');
  }
  return value as Record<string, any>;
}

/** 错误消息脱敏：截断到 500 字符，避免把完整 ADT 响应外泄到错误通道。 */
function sanitizeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}
