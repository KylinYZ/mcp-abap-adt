/**
 * 受控描述修改工作流（DescriptionChangeWorkflow）——关闭矩阵缺口
 * crud.set-description 的受控写链（description-controlled-write）。
 *
 * 任务语义（VSP 来源）：修改对象的短文本（如 SE38 标题/TRDIRT 描述）而不触碰
 * 源码——pkg/adt/description.go SetDescription（锁 → 锁下重读 → description
 * 属性替换 → PUT(corrNr) → 解锁，同值短路、长度超限拒绝）。
 *
 * 安全模型（与激活/克隆工作流一致）：
 * 1. preview：只读预检（读元数据取旧描述与长度上限）→ 冻结 immutable plan
 *    （对象 URL、旧/新描述、payloadHash、TTL、上下文）。不接受调用方提供的
 *    任何 ADT URL。
 * 2. applyConfirmed：仅接受 server 生成的 planId；单次执行
 *    setDescription（锁链内建）；PUT 发出后的异常按 UNKNOWN_OUTCOME 终结
 *    （描述可能已写，不自动重试）→ readback 重读元数据核验。
 * 3. 审计：preview/apply/readback 全链审计，敏感载荷只入 payloadHash。
 *
 * 范围：PROG/CLAS/INTF/INCL 四类（对齐 VSP DescriptionObjectURL 常用子集）。
 */
import { SafeAbapError } from './errors.js';
import type { SafetyPolicy } from './SafetyPolicy.js';
import type { AuditEvent } from './AuditLogger.js';
import {
  descriptionObjectURL,
  readObjectMetadata,
  descriptionOf,
  setDescription,
  type DescriptionObjectType,
  type DescriptionHttp,
  type DescriptionLockPort
} from '../adt/DescriptionApi.js';

const SAFE_OBJECT_NAME = /^[A-Z0-9_/$]+$/;
const DESCRIPTION_MAX = 120;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type DescriptionChangeableType = DescriptionObjectType;

export interface DescriptionChangePreviewInput {
  objectType: DescriptionChangeableType;
  name: string;
  description: string;
  transport?: string;
}

export interface DescriptionChangePlanView {
  descriptionPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: 'PREVIEWED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED';
  systemHost: string;
  client: string;
  systemRole: string;
  toolProfile: string;
  objectType: DescriptionChangeableType;
  name: string;
  objectURL: string;
  oldDescription: string;
  newDescription: string;
  payloadHash: string;
}

interface DescriptionChangePlan extends DescriptionChangePlanView {
  transport?: string;
  context: { systemHost: string; client: string; sapUser: string; systemRole: string; toolProfile: string };
  newDescriptionValue: string;
}

export class DescriptionChangePlanStore {
  private readonly plans = new Map<string, DescriptionChangePlan & { expiresAtMs: number }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly idFactory: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  create(plan: DescriptionChangePlan): DescriptionChangePlan {
    const stored: DescriptionChangePlan & { expiresAtMs: number } = {
      ...plan,
      expiresAtMs: this.now() + this.ttlMs
    };
    this.plans.set(plan.descriptionPlanId, stored);
    return plan;
  }

  /** 取 plan 并校验上下文绑定（跨 host/client/user/role/profile 重放拒绝）。 */
  getForContext(planId: string, context: DescriptionChangePlan['context']): DescriptionChangePlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'description-plan', 'Description change plan does not exist.');
    if (plan.context.systemHost !== context.systemHost || plan.context.client !== context.client
      || plan.context.sapUser !== context.sapUser || plan.context.systemRole !== context.systemRole
      || plan.context.toolProfile !== context.toolProfile) {
      throw new SafeAbapError('POLICY_DENIED', 'description-plan', 'Plan belongs to a different SAP context.');
    }
    if (plan.expiresAtMs <= this.now()) {
      plan.status = 'EXPIRED';
    }
    return plan;
  }

  setStatus(planId: string, status: DescriptionChangePlan['status']): void {
    const plan = this.plans.get(planId);
    if (plan) plan.status = status;
  }
}

/** 工作流依赖端口。 */
export interface DescriptionChangeDeps {
  http: DescriptionHttp;
  locks: DescriptionLockPort;
  policy: SafetyPolicy;
  audit: { append(event: AuditEvent): Promise<void> };
  now?: () => number;
}

export class DescriptionChangeWorkflow {
  private readonly plans: DescriptionChangePlanStore;

  constructor(private readonly deps: DescriptionChangeDeps, ttlMs?: number) {
    this.plans = new DescriptionChangePlanStore(ttlMs ?? deps.policy.planTtlMs, deps.now ?? (() => Date.now()));
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

  private auditEvent(plan: DescriptionChangePlan, eventType: string, success: boolean, extra?: Partial<AuditEvent>): AuditEvent {
    return {
      correlationId: plan.descriptionPlanId,
      eventType,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      descriptionPlanId: plan.descriptionPlanId,
      resultSummary: `${plan.objectType} ${plan.name}: "${plan.oldDescription}" -> "${plan.newDescription}"`,
      success,
      ...extra
    } as AuditEvent;
  }

  /** preview：只读预检并冻结 immutable plan（不触碰 SAP 写路径）。 */
  async preview(input: DescriptionChangePreviewInput): Promise<Record<string, unknown>> {
    const objectType = String(input?.objectType ?? '').toUpperCase() as DescriptionChangeableType;
    const name = String(input?.name ?? '').trim().toUpperCase();
    const description = typeof input?.description === 'string' ? input.description.trim() : '';
    if (!(['PROG', 'CLAS', 'INTF', 'INCL'] as string[]).includes(objectType)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'objectType must be one of PROG, CLAS, INTF, INCL.');
    }
    if (!name || name.length > 40 || !SAFE_OBJECT_NAME.test(name)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'name must be a bounded SAP object name.');
    }
    if (!description || description.length > DESCRIPTION_MAX) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `description must be 1-${DESCRIPTION_MAX} characters.`);
    }
    if (input.transport !== undefined && input.transport !== null && !/^[A-Z0-9]{10}$/.test(String(input.transport).toUpperCase())) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'transport must be a 10-character request id.');
    }

    const objectURL = descriptionObjectURL(objectType, name);
    // 只读预检：取旧描述与长度限制（长度超限在此提前失败，不进写路径）
    const metadata = await readObjectMetadata(this.deps.http, objectURL);
    const info = descriptionOf(metadata.body);

    const now = this.deps.now?.() ?? Date.now();
    const plan: DescriptionChangePlan = {
      descriptionPlanId: globalThis.crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.deps.policy.planTtlMs ?? DEFAULT_TTL_MS)).toISOString(),
      status: 'PREVIEWED',
      ...this.context(),
      objectType,
      name,
      objectURL,
      oldDescription: info.description,
      newDescription: description,
      payloadHash: await hashPayload({ objectURL, description, transport: input.transport ?? '' }),
      ...(input.transport ? { transport: String(input.transport).toUpperCase() } : {}),
      context: this.context(),
      newDescriptionValue: description
    };
    this.plans.create(plan);
    await this.deps.audit.append(this.auditEvent(plan, 'DESCRIPTION_CHANGE_PREVIEW_CREATED', true));
    return { status: 'preview', plan: this.publicView(plan), confirmationRequired: true };
  }

  /** apply：按已确认的 plan 单次执行（锁链内建），readback 核验。 */
  async applyConfirmed(descriptionPlanId: string): Promise<Record<string, unknown>> {
    const context = this.context();
    const plan = this.plans.getForContext(descriptionPlanId, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'description-plan', 'Description change plan has expired.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'description-plan', `Description change plan is already ${plan.status.toLowerCase()}.`);
    }
    this.plans.setStatus(plan.descriptionPlanId, plan.status); // 保持（status 在 plan 上原地推进）

    let outcome: 'SUCCEEDED' | 'UNKNOWN_OUTCOME' | 'FAILED';
    let readback: string | undefined;
    try {
      const result = await setDescription(this.deps.http, this.deps.locks, {
        objectType: plan.objectType,
        name: plan.name,
        description: plan.newDescriptionValue,
        ...(plan.transport ? { transport: plan.transport } : {})
      });
      // readback：重读元数据核验描述已生效
      const after = await readObjectMetadata(this.deps.http, plan.objectURL);
      readback = descriptionOf(after.body).description;
      if (readback !== plan.newDescriptionValue) {
        throw new SafeAbapError('VERIFICATION_FAILED', 'readback', 'Description readback does not match the confirmed value.');
      }
      outcome = 'SUCCEEDED';
    } catch (error) {
      if (error instanceof SafeAbapError && error.code === 'VERIFICATION_FAILED') {
        this.plans.setStatus(plan.descriptionPlanId, 'FAILED');
        await this.deps.audit.append(this.auditEvent(plan, 'DESCRIPTION_CHANGE_FAILED', false));
        throw error;
      }
      if (error instanceof SafeAbapError && error.code === 'PLAN_EXPIRED') throw error;
      // PUT 已发出后的失败：结果未知——终止，不自动重试
      const wasWrite = /PUT/i.test(String((error as any)?.stack ?? '')) || true; // 描述修改只有一次写调用，异常按未知保守处理
      void wasWrite;
      this.plans.setStatus(plan.descriptionPlanId, 'UNKNOWN_OUTCOME');
      try {
        await this.deps.audit.append(this.auditEvent(plan, 'DESCRIPTION_CHANGE_UNKNOWN', false, { unknownOutcome: true }));
      } catch { /* 审计失败不掩盖主错误 */ }
      throw new SafeAbapError('UNKNOWN_OUTCOME', 'EXECUTE', 'The description change outcome is unknown. Review the object metadata before retrying.');
    }

    this.plans.setStatus(plan.descriptionPlanId, outcome);
    await this.deps.audit.append(this.auditEvent(plan, 'DESCRIPTION_CHANGE_COMPLETED', true));
    return { status: 'success', plan: this.publicView(this.plans.getForContext(plan.descriptionPlanId, context)), readback };
  }

  /** 本地状态查询（带上下文校验）。 */
  status(planId: string): DescriptionChangePlanView {
    return this.publicView(this.plans.getForContext(planId, this.context()));
  }

  private publicView(plan: DescriptionChangePlan): DescriptionChangePlanView {
    const { descriptionPlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      objectType, name, objectURL, oldDescription, newDescription, payloadHash } = plan;
    return {
      descriptionPlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      objectType, name, objectURL, oldDescription, newDescription, payloadHash
    };
  }
}

async function hashPayload(payload: unknown): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** ADT HTTP/锁端口的装配绑定（index.ts 用 AdtClient.h 与 lock/unLock 构造）。 */
export function bindDescriptionPorts(client: {
  h: DescriptionHttp;
  lock(objectURL: string, accessMode: string): Promise<Record<string, unknown>>;
  unLock(objectURL: string, lockHandle: string): Promise<unknown>;
}): { http: DescriptionHttp; locks: DescriptionLockPort } {
  return {
    http: client.h,
    locks: {
      lock: async (objectURL, accessMode) => client.lock(objectURL, accessMode),
      unLock: async (objectURL, lockHandle) => client.unLock(objectURL, lockHandle)
    }
  };
}
