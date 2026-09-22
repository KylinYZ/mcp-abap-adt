/**
 * 受控对象克隆工作流（CloneObjectWorkflow）——矩阵行 crud.clone-object
 * 的一站式受控克隆（clone-controlled-workflow）。
 *
 * 任务语义（VSP 来源）：pkg/adt/workflows_source.go CloneObject——读源 →
 * 声明行改名 → 以新名创建。VSP 一站式直写没有确认与身份证明；本工作流
 * 把"确认/创建/激活/readback/补偿"整体委托既有受控创建链
 * （RepositoryObjectCreationWorkflow：immutable plan + 原生确认 + 受控执行），
 * 自身只负责克隆特有三步：
 *   1. preview：服务端解析源 URL 读源（快照冻结进 plan）→ 声明行改名 →
 *      把改名后的源码与创建参数冻结为克隆 plan；
 *   2. applyConfirmed：按克隆 plan 委托受控创建链完成目标创建（单确认）；
 *   3. readback：创建链自身已含源码 hash 比对（VERIFY_SOURCE 阶段），
 *      本工作流复用其结果，不再重复直读。
 *
 * 安全模型（与描述修改/受控创建一致）：
 * - 不接受调用方提供的任何 ADT URL（源 URL 由 objectType+sourceName 解析）；
 * - plan 上下文绑定（跨 host/client/user/role/profile 重放拒绝）；
 * - 单 plan 单确认单执行；UNKNOWN_OUTCOME 终止（受控创建链内部已把
 *   写路径异常归为 RepositoryCreationOutcomeUnknownError）。
 *
 * 范围：PROGRAM/ABAP_CLASS/ABAP_INTERFACE 三类（受控创建链已覆盖的
 * 可克隆源对象类型）。
 */
import { SafeAbapError } from './errors.js';
import type { SafetyPolicy } from './SafetyPolicy.js';
import type { AuditEvent } from './AuditLogger.js';
import {
  readCloneSource,
  renameCloneDeclarations,
  cloneSourceUrl,
  type CloneableObjectType,
  type CloneHttp
} from '../adt/CloneObjectApi.js';
import { sourceHash } from './sourceTools.js';

const SAFE_OBJECT_NAME = /^[A-Z][A-Z0-9_]{2,39}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type CloneObjectType = CloneableObjectType;

export interface CloneObjectPreviewInput {
  objectType: CloneObjectType;
  sourceName: string;
  targetName: string;
  packageName: string;
  transport: string;
  /** 目标描述；缺省对齐 VSP 语义取 `Copy of <sourceName>`。 */
  description?: string;
}

export interface CloneObjectPlanView {
  clonePlanId: string;
  createdAt: string;
  expiresAt: string;
  status: 'PREVIEWED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED';
  systemHost: string;
  client: string;
  systemRole: string;
  toolProfile: string;
  objectType: CloneObjectType;
  sourceName: string;
  targetName: string;
  packageName: string;
  description: string;
  sourceUrl: string;
  sourceHash: string;
  /** 改名后源码的行数（预览可见，全文不回显——以 plan 冻结为准）。 */
  targetSourceLines: number;
  declarationChanges: number;
  payloadHash: string;
}

interface CloneObjectPlan extends CloneObjectPlanView {
  transport: string;
  context: { systemHost: string; client: string; sapUser: string; systemRole: string; toolProfile: string };
  /** 改名后的完整源码（冻结进 plan，apply 时原样提交受控创建链）。 */
  targetSource: string;
}

/** 受控创建链的窄接口（避免全量依赖，便于 mock）。 */
export interface CloneCreationDelegate {
  preview(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  apply(creationPlanId: string): Promise<Record<string, unknown>>;
  status(creationPlanId: string): { status: string; target?: { objectName?: string }; stages?: Array<{ stage: string; success: boolean; message?: string }> };
}

export class CloneObjectPlanStore {
  private readonly plans = new Map<string, CloneObjectPlan & { expiresAtMs: number }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  create(plan: CloneObjectPlan): CloneObjectPlan {
    this.plans.set(plan.clonePlanId, { ...plan, expiresAtMs: this.now() + this.ttlMs });
    return plan;
  }

  /** 取 plan 并校验上下文绑定（跨 host/client/user/role/profile 重放拒绝）。 */
  getForContext(planId: string, context: CloneObjectPlan['context']): CloneObjectPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'clone-plan', 'Clone plan does not exist.');
    if (plan.context.systemHost !== context.systemHost || plan.context.client !== context.client
      || plan.context.sapUser !== context.sapUser || plan.context.systemRole !== context.systemRole
      || plan.context.toolProfile !== context.toolProfile) {
      throw new SafeAbapError('POLICY_DENIED', 'clone-plan', 'Plan belongs to a different SAP context.');
    }
    if (plan.expiresAtMs <= this.now()) {
      plan.status = 'EXPIRED';
    }
    return plan;
  }

  setStatus(planId: string, status: CloneObjectPlan['status']): void {
    const plan = this.plans.get(planId);
    if (plan) plan.status = status;
  }
}

/** 工作流依赖端口。 */
export interface CloneObjectDeps {
  http: CloneHttp;
  /** 既有受控创建工作流（PROGRAAM 用 ABAP_SOURCE 适配器，类/接口用受控源对象适配器）。 */
  creation: CloneCreationDelegate;
  policy: SafetyPolicy;
  audit: { append(event: AuditEvent): Promise<void> };
  now?: () => number;
}

/** 克隆类型 → 受控创建 objectKind 的映射（创建链按 objectKind 分派适配器）。 */
const CREATION_OBJECT_KIND_BY_TYPE: Record<CloneObjectType, 'PROGRAM' | 'ABAP_CLASS' | 'ABAP_INTERFACE'> = {
  PROGRAM: 'PROGRAM',
  ABAP_CLASS: 'ABAP_CLASS',
  ABAP_INTERFACE: 'ABAP_INTERFACE'
};

export class CloneObjectWorkflow {
  private readonly plans: CloneObjectPlanStore;

  constructor(private readonly deps: CloneObjectDeps, ttlMs?: number) {
    this.plans = new CloneObjectPlanStore(ttlMs ?? deps.policy.planTtlMs, deps.now ?? (() => Date.now()));
  }

  private context() {
    return {
      systemHost: this.deps.policy.systemHost,
      client: this.deps.policy.client,
      sapUser: this.deps.policy.sapUser,
      systemRole: this.deps.policy.systemRole,
      toolProfile: this.deps.policy.toolProfile
    };
  }

  private auditEvent(plan: CloneObjectPlan, eventType: string, success: boolean, extra?: Partial<AuditEvent>): AuditEvent {
    return {
      correlationId: plan.clonePlanId,
      eventType,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      clonePlanId: plan.clonePlanId,
      resultSummary: `${plan.objectType} ${plan.sourceName} -> ${plan.targetName}`,
      success,
      ...extra
    } as AuditEvent;
  }

  /** preview：只读（源码 GET + 本地改名）并冻结 immutable plan（不触碰 SAP 写路径）。 */
  async preview(input: CloneObjectPreviewInput): Promise<Record<string, unknown>> {
    const objectType = String(input?.objectType ?? '').toUpperCase() as CloneObjectType;
    if (!(['PROGRAM', 'ABAP_CLASS', 'ABAP_INTERFACE'] as string[]).includes(objectType)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'objectType must be one of PROGRAM, ABAP_CLASS, ABAP_INTERFACE.');
    }
    const sourceName = String(input?.sourceName ?? '').trim().toUpperCase();
    const targetName = String(input?.targetName ?? '').trim().toUpperCase();
    const packageName = String(input?.packageName ?? '').trim().toUpperCase();
    const transport = String(input?.transport ?? '').trim().toUpperCase();
    for (const [label, value] of [['sourceName', sourceName], ['targetName', targetName], ['packageName', packageName]] as const) {
      if (!SAFE_OBJECT_NAME.test(value)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `${label} must be a bounded SAP object name (3-40 chars, starting with a letter).`);
      }
    }
    if (sourceName === targetName) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'targetName must differ from sourceName.');
    }
    if (!/^[A-Z0-9]{10}$/.test(transport)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'transport must be a 10-character request id.');
    }
    const description = (typeof input?.description === 'string' && input.description.trim())
      ? input.description.trim()
      : `Copy of ${sourceName}`;
    if (description.length > 120) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'description must be at most 120 characters.');
    }

    // 快照：读当前源码并完成声明行改名（纯本地字符串操作）
    let sourceText: string;
    try {
      sourceText = await readCloneSource(this.deps.http, objectType, sourceName);
    } catch (error) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `Clone source ${sourceName} could not be read: ${errorMessage(error)}`);
    }
    let targetSource: string;
    try {
      targetSource = renameCloneDeclarations(sourceText, objectType, sourceName, targetName);
    } catch (error) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', errorMessage(error));
    }
    if (!targetSource.trim()) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Clone source is empty.');
    }

    const now = this.deps.now?.() ?? Date.now();
    const plan: CloneObjectPlan = {
      clonePlanId: globalThis.crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.deps.policy.planTtlMs ?? DEFAULT_TTL_MS)).toISOString(),
      status: 'PREVIEWED',
      ...this.context(),
      objectType,
      sourceName,
      targetName,
      packageName,
      description,
      sourceUrl: cloneSourceUrl(objectType, sourceName),
      sourceHash: sourceHash(sourceText),
      targetSourceLines: targetSource.split('\n').length,
      declarationChanges: objectType === 'ABAP_CLASS' ? 2 : 1,
      payloadHash: await hashPayload({ objectType, sourceName, targetName, packageName, transport, targetSource }),
      transport,
      context: this.context(),
      targetSource
    };
    this.plans.create(plan);
    await this.deps.audit.append(this.auditEvent(plan, 'CLONE_PREVIEW_CREATED', true));
    return { status: 'preview', plan: this.publicView(plan), confirmationRequired: true };
  }

  /**
   * apply：按已确认的克隆 plan 单次执行——把改名源码提交给既有受控创建链
   * （创建链内部完成壳创建/锁/写/语法检查/激活/源码 hash 比对/失败补偿，
   * 并在确认层内自持执行门控，本层不重复 gate）。
   */
  async applyConfirmed(clonePlanId: string): Promise<Record<string, unknown>> {
    const context = this.context();
    const plan = this.plans.getForContext(clonePlanId, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'clone-plan', 'Clone plan has expired.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'clone-plan', `Clone plan is already ${plan.status.toLowerCase()}.`);
    }

    // 委托受控创建链：同一 plan 上下文、同一 transport、改名后的冻结源码
    let creationResult: Record<string, unknown>;
    try {
      const preview = await this.deps.creation.preview({
        objectKind: CREATION_OBJECT_KIND_BY_TYPE[plan.objectType],
        name: plan.targetName,
        description: plan.description,
        packageName: plan.packageName,
        transportRequest: plan.transport,
        source: plan.targetSource
      });
      const creationPlanId = String((preview as { plan?: { creationPlanId?: string } }).plan?.creationPlanId || '');
      if (!creationPlanId) {
        throw new Error('Controlled creation preview did not return a plan id.');
      }
      creationResult = await this.deps.creation.apply(creationPlanId);
    } catch (error) {
      // 受控创建链的 UNKNOWN_OUTCOME（写路径异常）按未知终结：不重试不删除
      if (error instanceof SafeAbapError && error.code === 'UNKNOWN_OUTCOME') {
        this.plans.setStatus(plan.clonePlanId, 'UNKNOWN_OUTCOME');
        try {
          await this.deps.audit.append(this.auditEvent(plan, 'CLONE_UNKNOWN', false, { unknownOutcome: true }));
        } catch { /* 审计失败不掩盖主错误 */ }
        throw new SafeAbapError('UNKNOWN_OUTCOME', 'EXECUTE', 'The clone outcome is unknown. Review the target object before retrying.');
      }
      this.plans.setStatus(plan.clonePlanId, 'FAILED');
      try {
        await this.deps.audit.append(this.auditEvent(plan, 'CLONE_FAILED', false));
      } catch { /* 审计失败不掩盖主错误 */ }
      throw error;
    }

    this.plans.setStatus(plan.clonePlanId, 'SUCCEEDED');
    await this.deps.audit.append(this.auditEvent(plan, 'CLONE_COMPLETED', true));
    return { status: 'success', plan: this.publicView(this.plans.getForContext(plan.clonePlanId, context)), creation: creationResult };
  }

  /** 本地状态查询（带上下文校验）。 */
  status(planId: string): CloneObjectPlanView {
    return this.publicView(this.plans.getForContext(planId, this.context()));
  }

  private publicView(plan: CloneObjectPlan): CloneObjectPlanView {
    const { clonePlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      objectType, sourceName, targetName, packageName, description, sourceUrl, sourceHash,
      targetSourceLines, declarationChanges, payloadHash } = plan;
    return {
      clonePlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      objectType, sourceName, targetName, packageName, description, sourceUrl, sourceHash,
      targetSourceLines, declarationChanges, payloadHash
    };
  }
}

async function hashPayload(payload: unknown): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
