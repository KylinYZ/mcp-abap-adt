/**
 * 受控对象重命名工作流（RenameControlledWorkflow）——矩阵行
 * refactor.rename 的一站式受控重命名（rename-controlled-write）。
 *
 * 任务语义（VSP 来源）：pkg/adt/workflows_fileio.go RenameObject（第 28-210 行）
 * ——读旧源 → 改名 → 创建新对象 → 写源 → 激活 → 删除旧对象。VSP 直写无确认；
 * 本工作流复用受控克隆工作流（CloneObjectWorkflow，含受控创建链的全部保证）
 * 落地新对象，再经受控清理链（RepositoryObjectCleanupWorkflow）删除旧对象。
 *
 * 安全模型（比克隆多一个删除面的风险控制）：
 * 1. preview：读源快照 + 声明改名 → 冻结 immutable rename plan（克隆参数 +
 *    旧对象身份 + 源 hash）。此阶段零写路径。
 * 2. apply：单确认后顺序执行两步——
 *    步骤 1（创建侧）：委托受控创建链创建新对象（APPLIED = 已激活且源码
 *    hash 比对通过；UNKNOWN_OUTCOME 终结）；
 *    步骤 2（删除侧）：冻结旧对象清理 plan 并执行受控删除（删除链自身含
 *    身份/依赖/传输校验与独立确认语义）。
 * 3. 防御语义（对齐 VSP 第 176-210 行的教训）：删除失败或结果未知时，
 *    绝不删除新对象（新对象已激活可用，旧对象保持原样），把两对象同时
 *    保留并如实报告 PARTIAL_RENAME——由人决定手工清理，不自动重试。
 *
 * 范围：PROGRAM/ABAP_CLASS/ABAP_INTERFACE 三类（与克隆工作流一致，
 * 受控创建链与受控清理链共同覆盖的源对象类型）。
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

export type RenameObjectType = CloneableObjectType;

export interface RenameObjectPreviewInput {
  objectType: RenameObjectType;
  oldName: string;
  newName: string;
  packageName: string;
  transport: string;
  /** 新对象描述；缺省对齐 VSP 语义取 `Renamed from <oldName>`。 */
  description?: string;
}

export interface RenameObjectPlanView {
  renamePlanId: string;
  createdAt: string;
  expiresAt: string;
  status: 'PREVIEWED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED' | 'PARTIAL_RENAME';
  systemHost: string;
  client: string;
  systemRole: string;
  toolProfile: string;
  objectType: RenameObjectType;
  oldName: string;
  newName: string;
  packageName: string;
  description: string;
  oldObjectUrl: string;
  sourceHash: string;
  declarationChanges: number;
  payloadHash: string;
}

interface RenameObjectPlan extends RenameObjectPlanView {
  transport: string;
  context: { systemHost: string; client: string; sapUser: string; systemRole: string; toolProfile: string };
  /** 改名后的新对象源码（冻结进 plan，apply 时原样提交克隆工作流）。 */
  newSource: string;
}

/** 克隆工作流窄接口（复用受控克隆的 plan/执行/补偿保证）。 */
export interface RenameCloneDelegate {
  preview(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  applyConfirmed(clonePlanId: string): Promise<Record<string, unknown>>;
}

/** 受控清理工作流窄接口（旧对象删除走既有受控清理链）。 */
export interface RenameCleanupDelegate {
  preview(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  apply(cleanupPlanId: string): Promise<Record<string, unknown>>;
  status(cleanupPlanId: string): { status: string };
}

export class RenameObjectPlanStore {
  private readonly plans = new Map<string, RenameObjectPlan & { expiresAtMs: number }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  create(plan: RenameObjectPlan): RenameObjectPlan {
    this.plans.set(plan.renamePlanId, { ...plan, expiresAtMs: this.now() + this.ttlMs });
    return plan;
  }

  /** 取 plan 并校验上下文绑定（跨 host/client/user/role/profile 重放拒绝）。 */
  getForContext(planId: string, context: RenameObjectPlan['context']): RenameObjectPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'rename-plan', 'Rename plan does not exist.');
    if (plan.context.systemHost !== context.systemHost || plan.context.client !== context.client
      || plan.context.sapUser !== context.sapUser || plan.context.systemRole !== context.systemRole
      || plan.context.toolProfile !== context.toolProfile) {
      throw new SafeAbapError('POLICY_DENIED', 'rename-plan', 'Plan belongs to a different SAP context.');
    }
    if (plan.expiresAtMs <= this.now()) {
      plan.status = 'EXPIRED';
    }
    return plan;
  }

  setStatus(planId: string, status: RenameObjectPlan['status']): void {
    const plan = this.plans.get(planId);
    if (plan) plan.status = status;
  }
}

/** 工作流依赖端口。 */
export interface RenameObjectDeps {
  http: CloneHttp;
  clone: RenameCloneDelegate;
  cleanup: RenameCleanupDelegate;
  policy: SafetyPolicy;
  audit: { append(event: AuditEvent): Promise<void> };
  now?: () => number;
}

/** 重命名类型 → 克隆/清理两侧的 objectKind（两链共用同一受控对象类型）。 */
const OBJECT_KIND_BY_TYPE: Record<RenameObjectType, 'PROGRAM' | 'ABAP_CLASS' | 'ABAP_INTERFACE'> = {
  PROGRAM: 'PROGRAM',
  ABAP_CLASS: 'ABAP_CLASS',
  ABAP_INTERFACE: 'ABAP_INTERFACE'
};

export class RenameControlledWorkflow {
  private readonly plans: RenameObjectPlanStore;

  constructor(private readonly deps: RenameObjectDeps, ttlMs?: number) {
    this.plans = new RenameObjectPlanStore(ttlMs ?? deps.policy.planTtlMs, deps.now ?? (() => Date.now()));
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

  private auditEvent(plan: RenameObjectPlan, eventType: string, success: boolean, extra?: Partial<AuditEvent>): AuditEvent {
    return {
      correlationId: plan.renamePlanId,
      eventType,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      renamePlanId: plan.renamePlanId,
      resultSummary: `${plan.objectType} ${plan.oldName} -> ${plan.newName}`,
      success,
      ...extra
    } as AuditEvent;
  }

  /** preview：只读（源码 GET + 本地改名）并冻结 immutable rename plan。 */
  async preview(input: RenameObjectPreviewInput): Promise<Record<string, unknown>> {
    const objectType = String(input?.objectType ?? '').toUpperCase() as RenameObjectType;
    if (!(['PROGRAM', 'ABAP_CLASS', 'ABAP_INTERFACE'] as string[]).includes(objectType)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'objectType must be one of PROGRAM, ABAP_CLASS, ABAP_INTERFACE.');
    }
    const oldName = String(input?.oldName ?? '').trim().toUpperCase();
    const newName = String(input?.newName ?? '').trim().toUpperCase();
    const packageName = String(input?.packageName ?? '').trim().toUpperCase();
    const transport = String(input?.transport ?? '').trim().toUpperCase();
    for (const [label, value] of [['oldName', oldName], ['newName', newName], ['packageName', packageName]] as const) {
      if (!SAFE_OBJECT_NAME.test(value)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `${label} must be a bounded SAP object name (3-40 chars, starting with a letter).`);
      }
    }
    if (oldName === newName) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'newName must differ from oldName.');
    }
    if (!/^[A-Z0-9]{10}$/.test(transport)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'transport must be a 10-character request id.');
    }
    const description = (typeof input?.description === 'string' && input.description.trim())
      ? input.description.trim()
      : `Renamed from ${oldName}`;
    if (description.length > 120) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'description must be at most 120 characters.');
    }

    // 快照：读当前源码并完成声明行改名（纯本地字符串操作）
    let sourceText: string;
    try {
      sourceText = await readCloneSource(this.deps.http, objectType, oldName);
    } catch (error) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `Rename source ${oldName} could not be read: ${errorMessage(error)}`);
    }
    let newSource: string;
    try {
      newSource = renameCloneDeclarations(sourceText, objectType, oldName, newName);
    } catch (error) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', errorMessage(error));
    }
    if (!newSource.trim()) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Rename source is empty.');
    }

    const now = this.deps.now?.() ?? Date.now();
    const plan: RenameObjectPlan = {
      renamePlanId: globalThis.crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.deps.policy.planTtlMs ?? DEFAULT_TTL_MS)).toISOString(),
      status: 'PREVIEWED',
      ...this.context(),
      objectType,
      oldName,
      newName,
      packageName,
      description,
      oldObjectUrl: cloneSourceUrl(objectType, oldName).replace(/\/source\/main$/, ''),
      sourceHash: sourceHash(sourceText),
      declarationChanges: objectType === 'ABAP_CLASS' ? 2 : 1,
      payloadHash: await hashPayload({ objectType, oldName, newName, packageName, transport, newSource }),
      transport,
      context: this.context(),
      newSource
    };
    this.plans.create(plan);
    await this.deps.audit.append(this.auditEvent(plan, 'RENAME_PREVIEW_CREATED', true));
    return { status: 'preview', plan: this.publicView(plan), confirmationRequired: true };
  }

  /**
   * apply：单确认后两步——①克隆工作流落地新对象（受控创建链保证）；
   * ②受控清理链删除旧对象。删除失败/未知按 PARTIAL_RENAME 终结：
   * 新对象已激活可用，旧对象保持原样，两对象保留待人工处置，不自动重试、
   * 不回滚删除新对象（对齐 VSP 激活未证实不删除旧对象的防御语义）。
   */
  async applyConfirmed(renamePlanId: string): Promise<Record<string, unknown>> {
    const context = this.context();
    const plan = this.plans.getForContext(renamePlanId, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'rename-plan', 'Rename plan has expired.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'rename-plan', `Rename plan is already ${plan.status.toLowerCase()}.`);
    }

    // 步骤 1：克隆落地新对象（复用受控克隆工作流，其内部含受控创建链与确认语义）
    let cloneResult: Record<string, unknown>;
    try {
      const clonePreview = await this.deps.clone.preview({
        objectType: plan.objectType,
        sourceName: plan.oldName,
        targetName: plan.newName,
        packageName: plan.packageName,
        transport: plan.transport,
        description: plan.description
      });
      const clonePlanId = String((clonePreview as { plan?: { clonePlanId?: string } }).plan?.clonePlanId || '');
      if (!clonePlanId) {
        throw new Error('Controlled clone preview did not return a plan id.');
      }
      cloneResult = await this.deps.clone.applyConfirmed(clonePlanId);
    } catch (error) {
      if (error instanceof SafeAbapError && error.code === 'UNKNOWN_OUTCOME') {
        this.plans.setStatus(plan.renamePlanId, 'UNKNOWN_OUTCOME');
        try {
          await this.deps.audit.append(this.auditEvent(plan, 'RENAME_UNKNOWN', false, { unknownOutcome: true }));
        } catch { /* 审计失败不掩盖主错误 */ }
        throw new SafeAbapError('UNKNOWN_OUTCOME', 'EXECUTE', 'The rename outcome is unknown (creation side). Review the target object before retrying.');
      }
      this.plans.setStatus(plan.renamePlanId, 'FAILED');
      try {
        await this.deps.audit.append(this.auditEvent(plan, 'RENAME_FAILED', false));
      } catch { /* 审计失败不掩盖主错误 */ }
      throw error;
    }

    // 步骤 2：受控删除旧对象（清理链冻结 plan → apply；失败/未知走 PARTIAL_RENAME）
    let cleanupPlanId = '';
    let cleanupError: string | undefined;
    try {
      const cleanupPreview = await this.deps.cleanup.preview({
        objectKind: OBJECT_KIND_BY_TYPE[plan.objectType],
        name: plan.oldName
      });
      cleanupPlanId = String((cleanupPreview as { plan?: { cleanupPlanId?: string } }).plan?.cleanupPlanId || '');
      if (!cleanupPlanId) {
        throw new Error('Controlled cleanup preview did not return a plan id.');
      }
      await this.deps.cleanup.apply(cleanupPlanId);
    } catch (error) {
      cleanupError = errorMessage(error);
    }

    if (cleanupError) {
      // 缺席复核（只读独立证据）：清理链的删除动作可能已生效而其后置的传输
      // 证据校验失败（实测形态：删除登记挂在请求的子任务下，请求级对象清单
      // 聚合不完整导致 key 组零匹配）。此时旧对象缺席是比传输清单更直接的事
      // 实证据——缺席成立则按 SUCCEEDED 收敛并注明替代证据，避免误报 PARTIAL。
      const oldAbsent = await this.verifyOldObjectAbsent(plan.objectType, plan.oldName);
      if (oldAbsent) {
        this.plans.setStatus(plan.renamePlanId, 'SUCCEEDED');
        await this.deps.audit.append(this.auditEvent(plan, 'RENAME_COMPLETED', true, {
          resultSummary: `${plan.objectType} ${plan.oldName} -> ${plan.newName} (delete verified by absence recheck; transport evidence unavailable: ${cleanupError.slice(0, 120)})`
        }));
        return {
          status: 'success',
          plan: this.publicView(this.plans.getForContext(plan.renamePlanId, context)),
          creation: cloneResult,
          deleteVerifiedBy: 'absence-recheck',
          cleanupNote: `Old object ${plan.oldName} is confirmed absent from SAP. The cleanup chain's transport-evidence step failed on this system's task-level entry aggregation; absence recheck was used as the independent deletion evidence. TADIR residue, if any, is reclaimed by SAP background jobs.`
        };
      }
      // 防御语义：新对象保留（已激活可用），旧对象保留原样，如实报告部分完成
      this.plans.setStatus(plan.renamePlanId, 'PARTIAL_RENAME');
      try {
        await this.deps.audit.append(this.auditEvent(plan, 'RENAME_PARTIAL', false, {
          errorSummary: cleanupError.slice(0, 300)
        }));
      } catch { /* 审计失败不掩盖主错误 */ }
      return {
        status: 'partial',
        plan: this.publicView(this.plans.getForContext(plan.renamePlanId, context)),
        creation: cloneResult,
        cleanupError,
        guidance: `New object ${plan.newName} is active and kept. Old object ${plan.oldName} could not be deleted automatically and is left untouched. Review and clean up manually.`
      };
    }

    this.plans.setStatus(plan.renamePlanId, 'SUCCEEDED');
    await this.deps.audit.append(this.auditEvent(plan, 'RENAME_COMPLETED', true));
    return { status: 'success', plan: this.publicView(this.plans.getForContext(plan.renamePlanId, context)), creation: cloneResult };
  }

  /** 本地状态查询（带上下文校验）。 */
  status(planId: string): RenameObjectPlanView {
    return this.publicView(this.plans.getForContext(planId, this.context()));
  }

  /**
   * 缺席复核：只读 GET 旧对象源码（与 preview 读源同一只读通道）。
   * 对象存在时源码读取恒为 2xx；HTTP 错误响应（404/500 等）即旧对象无法
   * 再寻址——删除后复核上下文中这就是缺席证据。两点环境适配：
   * ① 错误消息可能本地化（真机实测中文"没有找到角色"），按状态码判定；
   * ② 本项目 ADT 客户端把非 2xx 转成 AdtErrorException（状态码在 err 字段，
   * AMDP 轮已发现此形态），需同时兼容 err/status 两种携带方式。
   * 网络层异常（两者皆无）与 409/403（锁冲突/权限，对象可能仍在）按未能
   * 证实缺席处理，保守走 PARTIAL。
   */
  private async verifyOldObjectAbsent(objectType: RenameObjectType, oldName: string): Promise<boolean> {
    try {
      await readCloneSource(this.deps.http, objectType, oldName);
      return false; // 仍可读到 → 旧对象还在
    } catch (error) {
      const candidate = error as Error & { status?: number; err?: number };
      const status = typeof candidate.status === 'number' ? candidate.status : candidate.err;
      if (typeof status !== 'number') return false; // 网络层异常 → 缺席未知
      // 409 冲突（锁占用）/403 权限拒绝时对象可能仍在，不判缺席
      return status !== 409 && status !== 403;
    }
  }

  private publicView(plan: RenameObjectPlan): RenameObjectPlanView {
    const { renamePlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      objectType, oldName, newName, packageName, description, oldObjectUrl, sourceHash,
      declarationChanges, payloadHash } = plan;
    return {
      renamePlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      objectType, oldName, newName, packageName, description, oldObjectUrl, sourceHash,
      declarationChanges, payloadHash
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
