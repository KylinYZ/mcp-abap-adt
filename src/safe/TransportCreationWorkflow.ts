/**
 * 受控传输请求创建工作流（TransportCreationWorkflow）。
 *
 * 任务背景：放开"由 AI 创建传输请求"这一个动作——用户明确要求建请求时，
 * 提供与受控激活/质检一致的 preview → 原生确认 → apply 受控链，锚定到一个
 * 既有开发包创建新的工作台请求（workbench request）。
 *
 * 安全模型（与 ObjectActivationWorkflow 一致）：
 * 1. preview：先做只读 CTS 预检（transportInfo，仅校验包与传输设置，
 *    绝不选择/复用既有请求），通过后由 server 冻结 immutable plan
 *    （包名、请求描述、锚点 URI、payloadHash、TTL）。不接受调用方提供的
 *    任何 ADT URL / XML / JSON 引用——锚点 URI 一律由 server 从包名推导。
 * 2. apply：仅接受 server 生成的 planId；单次执行创建；拒绝重复 apply、
 *    未知 plan、过期 plan 与跨上下文 plan。
 * 3. 读回验证：创建返回请求号后，用 transportDetails 只读读回该请求，
 *    请求号一致才算 SUCCEEDED——对应证据基线的 create/readback 双步。
 * 4. 结果未知即停止：创建调用抛异常（可能超时中断，请求是否创建未知）、
 *    返回号为空、或读回失败/请求号不一致时，plan 置 UNKNOWN_OUTCOME 并
 *    终结——绝不自动重试、绝不自动删除（删除请求只能人工在 SAP 中完成）。
 *
 * 有意不做的事：
 * - 不实现释放/删除/改属主/加用户等任何其他传输动作；
 * - 不向新请求添加对象（对象登记由受控对象创建链的 transportRequest 维度完成）；
 * - 不直接触碰 E071/E071K 等传输表（表条目由 SAP CTS 框架在创建时自行维护）。
 */
import type { TransportRequest } from '../adt/index.js';
import type { AuditEvent } from './AuditLogger.js';
import { SafeAbapError } from './errors.js';
import { TransportCreationPlanStore } from './TransportCreationPlanStore.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import type {
  PreviewTransportCreationInput,
  TransportCreationPayload,
  TransportCreationPlan,
  TransportCreationPlanView,
  TransportCreationPreviewResult,
  TransportCreationResultSummary,
  TransportCreationTarget
} from './transportCreationTypes.js';

/** 工作流依赖的 ADT 客户端端口（结构子集，便于测试 mock）。 */
interface TransportCreationClient {
  /**
   * 只读 CTS 预检：校验包存在性与传输设置；对错误级 CTS 消息会抛异常。
   * 注意：其返回中的 TRANSPORTS/LOCKS 仅是检查回显，本工作流从不据此
   * 复用既有请求。
   */
  transportInfo(objSourceUrl: string, devClass?: string, operation?: string): Promise<unknown>;
  /** 写入：创建新的工作台请求（CreateCorrectionRequest），返回新请求号 */
  createTransport(
    objSourceUrl: string,
    REQUEST_TEXT: string,
    DEVCLASS: string,
    transportLayer?: string
  ): Promise<string>;
  /** 只读：按请求号读回请求详情（属主/描述/状态/子任务），用于读回验证 */
  transportDetails(transportNumber: string): Promise<TransportRequest>;
}

/** 审计日志端口（与既有 workflow 的 auditLogger.append 用法一致）。 */
interface TransportCreationAuditSink {
  append(event: AuditEvent): Promise<void>;
}

/** 请求描述长度上限：SAP AS4TEXT 字段为 60 字符。 */
const MAX_REQUEST_TEXT_LENGTH = 60;
/** 传输层名长度上限：DEVLAYER 为 20 字符。 */
const MAX_TRANSPORT_LAYER_LENGTH = 20;

export class TransportCreationWorkflow {
  constructor(
    private readonly client: TransportCreationClient,
    private readonly policy: SafetyPolicy,
    private readonly plans: TransportCreationPlanStore,
    private readonly audit: TransportCreationAuditSink
  ) {}

  /**
   * preview：只读预检并生成创建 plan。
   * - input 仅允许 requestText / devClass / transportLayer 三个字段；
   * - 预检失败（包不存在、无传输配置等）时不创建任何 plan；
   * - 预检绝不选择既有请求，也不产生任何 SAP 写副作用。
   */
  async preview(
    input: PreviewTransportCreationInput
  ): Promise<TransportCreationPreviewResult> {
    assertAllowedKeys(input, ['requestText', 'devClass', 'transportLayer'], 'transport creation preview');
    const target = parseTarget(input);

    // 只读 CTS 预检：transportInfo 对包/传输设置错误会抛带 CTS 消息的异常，
    // 该异常直接让 preview 失败；成功返回值只用于确认设置有效，不作他用。
    try {
      await this.client.transportInfo(target.anchorUri, target.devClass, 'I');
    } catch (error) {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `CTS preflight for package ${target.devClass} failed: ${sanitizeMessage(error)}`
      );
    }

    const plan = this.plans.create({
      context: creationContext(this.policy),
      target,
      payload: frozenPayload(target)
    });
    try {
      this.plans.recordStage(plan.transportCreationPlanId, { stage: 'PREVIEW', success: true });
      await this.audit.append(creationAuditEvent(plan, this.policy, 'TRANSPORT_CREATION_PREVIEW_CREATED', true));
    } catch (error) {
      // 审计失败视为 preview 失败：plan 置 FAILED，绝不让无审计的创建意图存活
      this.plans.recordResult(plan.transportCreationPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'PREVIEW', message: 'Transport creation preview audit failed.'
      });
      this.plans.setStatus(plan.transportCreationPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.status(plan.transportCreationPlanId), confirmationRequired: true };
  }

  /** 本地查询 plan 状态（带上下文校验，跨上下文访问报 POLICY_DENIED）。 */
  status(transportCreationPlanId: string): TransportCreationPlanView {
    return this.plans.view(transportCreationPlanId, creationContext(this.policy));
  }

  /**
   * apply：按已确认的 plan 执行一次创建。
   * 只接受 server 生成 plan 的 id；重复 apply、未知 plan、过期 plan、
   * 跨上下文 plan 一律拒绝。创建/读回任何一步结果未知时置 UNKNOWN_OUTCOME 停止。
   */
  async apply(
    transportCreationPlanId: string,
    /** 确认层如实传入的确认方式：native elicitation / 部署级 auto-config；缺省 elicitation 保持旧行为 */
    confirmationMode: 'elicitation' | 'auto-config' = 'elicitation'
  ): Promise<Record<string, unknown>> {
    const context = creationContext(this.policy);
    const previewed = this.plans.getForContext(transportCreationPlanId, context);
    // 过期 plan 单独报 PLAN_EXPIRED：与"已被消费"区分，提示调用方必须重新 preview
    if (previewed.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'transport-creation-plan', 'Transport creation plan has expired.');
    }
    if (previewed.status !== 'PREVIEWED') {
      throw new SafeAbapError(
        'PLAN_ALREADY_CONSUMED',
        'transport-creation-plan',
        `Transport creation plan is already ${previewed.status.toLowerCase()}.`
      );
    }
    const payload = previewed.payload;
    if (!payload) {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'transport-creation-plan', 'Transport creation plan payload is unavailable.');
    }

    // 进入 RUNNING：同一 plan 从此不可再次 apply；确认方式由确认层如实传入
    const plan = this.plans.beginRun(transportCreationPlanId, context, confirmationMode);
    try {
      await this.audit.append(creationAuditEvent(plan, this.policy, 'TRANSPORT_CREATION_CONFIRMED', true));
    } catch (error) {
      // 远端尚未被调用，本地审计失败可以安全地置 FAILED
      this.plans.recordResult(transportCreationPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'CONFIRM', message: 'Transport creation confirmation audit failed.'
      });
      this.plans.setStatus(transportCreationPlanId, 'FAILED');
      throw error;
    }

    // 单次创建调用：载荷与 plan 冻结值一致；锚点 URI 由 plan 提供，不接受外部输入
    let createdNumber = '';
    try {
      createdNumber = String(await this.client.createTransport(
        payload.anchorUri,
        payload.requestText,
        payload.devClass,
        payload.transportLayer
      ) || '').trim();
    } catch (error) {
      // 请求异常：远端结果未知（超时/中断都可能导致请求已创建），
      // 按 UNKNOWN_OUTCOME 保守处理并停止，绝不自动重试或自动删除。
      return this.failWithUnknownOutcome(transportCreationPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'EXECUTE',
        `The transport creation request outcome is unknown (${sanitizeMessage(error)}). `
        + 'Verify existing requests read-only before any further action.'
      ));
    }
    if (!createdNumber) {
      // ADT 未返回可解析的请求号：无法确认是否创建成功，同样按未知处理
      return this.failWithUnknownOutcome(transportCreationPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'EXECUTE',
        'ADT did not return a transport number; the creation outcome is unknown. '
        + 'Verify existing requests read-only before any further action.'
      ));
    }
    this.plans.recordStage(transportCreationPlanId, { stage: 'EXECUTE', success: true });

    // 读回验证（create/readback 双步证据）：读回失败或请求号不一致都视为未知
    let readback: TransportRequest;
    try {
      readback = await this.client.transportDetails(createdNumber);
    } catch (error) {
      return this.failWithUnknownOutcome(transportCreationPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'READBACK',
        `Transport ${createdNumber} could not be read back (${sanitizeMessage(error)}). `
        + 'The request may exist; verify read-only before any further action.'
      ));
    }
    const readbackNumber = String(readback?.['tm:number'] || '').trim();
    if (readbackNumber !== createdNumber) {
      return this.failWithUnknownOutcome(transportCreationPlanId, plan, new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'READBACK',
        `Read-back transport number '${readbackNumber}' does not match the created number '${createdNumber}'. `
        + 'The creation outcome is unknown; verify read-only before any further action.'
      ));
    }

    const summary: TransportCreationResultSummary = {
      kind: 'TRANSPORT_CREATION',
      transportNumber: readbackNumber,
      owner: String(readback?.['tm:owner'] || '').trim(),
      description: String(readback?.['tm:desc'] || '').trim(),
      status: String(readback?.['tm:status'] || '').trim(),
      taskCount: Array.isArray(readback?.tasks) ? readback.tasks.length : 0
    };
    this.plans.recordStage(transportCreationPlanId, { stage: 'READBACK', success: true });
    this.plans.recordResult(transportCreationPlanId, summary);
    this.plans.setStatus(transportCreationPlanId, 'SUCCEEDED');
    await this.audit.append(creationAuditEvent(
      plan, this.policy, 'TRANSPORT_CREATION_COMPLETED', true, summary
    ));
    return { status: 'success', plan: this.status(transportCreationPlanId) };
  }

  /**
   * UNKNOWN_OUTCOME 终止路径：记录阶段失败、写错误、置 UNKNOWN_OUTCOME、
   * 尽力补一条审计（审计失败不掩盖主错误），最后抛出带 plan 视图的错误。
   */
  private async failWithUnknownOutcome(
    transportCreationPlanId: string,
    plan: TransportCreationPlan,
    error: SafeAbapError
  ): Promise<never> {
    this.plans.recordStage(transportCreationPlanId, {
      stage: error.stage, success: false, message: 'Remote outcome unknown.'
    });
    this.plans.recordResult(transportCreationPlanId, undefined, {
      code: error.code, stage: error.stage, message: error.message
    });
    this.plans.setStatus(transportCreationPlanId, 'UNKNOWN_OUTCOME');
    try {
      await this.audit.append(creationAuditEvent(
        plan, this.policy, 'TRANSPORT_CREATION_UNKNOWN', false, undefined, true
      ));
    } catch {
      // 审计失败不掩盖主错误；plan 上保留的 UNKNOWN_OUTCOME 状态是首要重放安全信号。
    }
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.status(transportCreationPlanId) });
  }
}

/**
 * 解析并校验 preview 输入，产出目标快照（含 server 推导的锚点 URI）。
 * - requestText：1..60 字符（SAP AS4TEXT 上限），首尾空白剔除；
 * - devClass：1..30 字符的包名，允许 /NS/NAME 命名空间形式；拒绝 $ 开头的
 *   本地包（本地包不能锚定可传输请求）；
 * - transportLayer：可选，1..20 字符。
 */
function parseTarget(input: PreviewTransportCreationInput): TransportCreationTarget {
  const requestText = String(input?.requestText ?? '').trim();
  if (!requestText || requestText.length > MAX_REQUEST_TEXT_LENGTH) {
    throw new SafeAbapError(
      'VALIDATION_FAILED',
      'PREVIEW',
      `requestText must contain 1 to ${MAX_REQUEST_TEXT_LENGTH} characters.`
    );
  }
  const devClass = String(input?.devClass ?? '').trim().toUpperCase();
  if (!isValidDevClass(devClass)) {
    throw new SafeAbapError(
      'VALIDATION_FAILED',
      'PREVIEW',
      'devClass must be a non-local package name (1-30 characters, optional /NS/ namespace form).'
    );
  }
  const rawLayer = String(input?.transportLayer ?? '').trim().toUpperCase();
  if (rawLayer) {
    if (rawLayer.length > MAX_TRANSPORT_LAYER_LENGTH || !/^[A-Z][A-Z0-9_]*$/.test(rawLayer)) {
      throw new SafeAbapError(
        'VALIDATION_FAILED',
        'PREVIEW',
        `transportLayer must contain 1 to ${MAX_TRANSPORT_LAYER_LENGTH} transport layer characters.`
      );
    }
  }
  return {
    devClass,
    requestText,
    ...(rawLayer ? { transportLayer: rawLayer } : {}),
    // 锚点 URI 一律由 server 推导，调用方无法注入任意 URL
    anchorUri: `/sap/bc/adt/packages/${devClass.toLowerCase()}`
  };
}

/**
 * 包名合法性：普通形式为字母开头的 1..30 位 [A-Z0-9_]；命名空间形式为
 * /NS/NAME（NS 1..10 位、NAME 1..24 位）。$ 开头的本地包一律拒绝。
 */
function isValidDevClass(devClass: string): boolean {
  if (!devClass || devClass.includes('$')) return false;
  if (/^[A-Z][A-Z0-9_]{0,29}$/.test(devClass)) return true;
  const namespace = /^\/([A-Z0-9_]{1,10})\/([A-Z0-9_]{1,24})$/.exec(devClass);
  return Boolean(namespace);
}

/** 由冻结目标生成执行载荷（字段一一对应 ADT createTransport 参数）。 */
function frozenPayload(target: TransportCreationTarget): TransportCreationPayload {
  return {
    anchorUri: target.anchorUri,
    requestText: target.requestText,
    devClass: target.devClass,
    ...(target.transportLayer ? { transportLayer: target.transportLayer } : {})
  };
}

/** 从 SafetyPolicy 提取当前 SAP 上下文（与激活链相同的字段集合）。 */
function creationContext(policy: SafetyPolicy) {
  return {
    systemHost: policy.systemHost,
    client: policy.client,
    sapUser: policy.sapUser,
    systemRole: policy.systemRole,
    toolProfile: policy.toolProfile
  };
}

/** 构造创建专用审计事件；载荷只出现 hash，不出现锚点 URI 或描述明文以外的内容。 */
function creationAuditEvent(
  plan: TransportCreationPlan,
  policy: SafetyPolicy,
  eventType: string,
  success: boolean,
  result?: TransportCreationResultSummary,
  unknownOutcome = false
): AuditEvent {
  return {
    correlationId: plan.transportCreationPlanId,
    transportCreationPlanId: plan.transportCreationPlanId,
    eventType,
    systemHost: policy.systemHost,
    client: policy.client,
    systemRole: policy.systemRole,
    packageName: plan.target.devClass,
    ...(result ? { transportRequest: result.transportNumber } : {}),
    resultSummary: result
      ? `created transport ${result.transportNumber} (owner ${result.owner}, status ${result.status})`
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
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Transport creation input must be an object.');
  }
  return value as Record<string, any>;
}

/** 错误消息脱敏：截断到 500 字符，避免把完整 ADT 响应外泄到错误通道。 */
function sanitizeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}
