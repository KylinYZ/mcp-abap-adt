/**
 * 受控程序文本池写入工作流（TextPoolWorkflow）——F1 完整方案：关闭矩阵行
 * report.text-elements 的"程序文本池受控写路径缺失"（文本池原子写最小方案
 * 已入 focused 面并真机验证，见 docs/evidence/f1-textpool-focused-real-dev-verified.md）。
 *
 * 任务语义：指定程序的文本池类别（symbols/selections/headings）整池替换
 * （PUT /source/{category}，text/plain 源形态——真机 415 取证：该端点只认
 * text/plain；@MaxLength 协议见 formatTextElements，D1 真机固化）。
 *
 * 安全模型（与消息类文本受控链同面）：
 * 1. preview：只读读当前类别文本池 → 校验入参（按 category 的 id/长度规则）→
 *    冻结 immutable plan（旧清单/新清单/payloadHash/TTL/上下文）。
 * 2. applyConfirmed：仅接受 server 生成的 planId；对象锁（server 会话持有）→
 *    单次 PUT → 解锁 → readback（按 id 比对文本）→ SUCCEEDED；PUT 发出后异常
 *    按 UNKNOWN_OUTCOME 终结（可能已写，不自动重试）。
 * 3. 同值短路：新清单与现值完全一致时不锁不写（sameValue=true，仍记审计）。
 *
 * 整池替换语义：写入即该类别的完整集合——不在新清单中的既有元素会被删除
 * （与 SE32 保存行为一致）；preview 的 oldTexts/newTexts 使差异对调用方可见。
 */
import { SafeAbapError } from './errors.js';
import type { SafetyPolicy } from './SafetyPolicy.js';
import type { AuditEvent } from './AuditLogger.js';

export type TextPoolCategory = 'symbols' | 'selections' | 'headings'

export interface TextPoolElement {
  /** symbols：3 位字符编号；selections：选择屏参数名（≤8 大写）；headings：LISTHEADER/COLUMNHEADER_1-4。 */
  id: string
  text: string
  /** 仅 symbols 生效：@MaxLength 指令（缺省 132，SE32 新建符号默认上限）。 */
  maxLength?: number
}

export interface TextPoolChangeInput {
  /** 目标程序名（REPORT/FUGR 均可——URL 由类别与程序名推导）。 */
  program: string
  category: TextPoolCategory
  /** 目标文本池清单（整池替换语义）。 */
  elements: TextPoolElement[]
  transport?: string
}

export interface TextPoolPlanView {
  textPoolPlanId: string
  createdAt: string
  expiresAt: string
  status: 'PREVIEWED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED'
  systemHost: string
  client: string
  systemRole: string
  toolProfile: string
  program: string
  category: TextPoolCategory
  oldElements: TextPoolElement[]
  newElements: TextPoolElement[]
  payloadHash: string
}

interface TextPoolPlan extends TextPoolPlanView {
  transport?: string
  context: { systemHost: string; client: string; sapUser: string; systemRole: string; toolProfile: string }
  inputElements: TextPoolElement[]
}

export interface TextPoolAuditSink {
  append(event: AuditEvent): Promise<void>
}

const VALID_HEADINGS = new Set([
  'LISTHEADER', 'COLUMNHEADER_1', 'COLUMNHEADER_2', 'COLUMNHEADER_3', 'COLUMNHEADER_4'
])
const DEFAULT_SYMBOL_MAX_LENGTH = 132
const DEFAULT_TTL_MS = 15 * 60 * 1000

const SAFE_PROGRAM = /^[A-Z][A-Z0-9_]{0,29}$/

/** 规范化并按类别校验文本池清单（对齐 SE32/validateTextElements 规则）。 */
export function normalizeTextPoolElements(raw: unknown, category: TextPoolCategory): TextPoolElement[] {
  if (!Array.isArray(raw) || raw.length > 999) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'elements must be an array of at most 999 entries.')
  }
  const seen = new Set<string>()
  return (raw as unknown[]).map(entry => {
    const record = (entry ?? {}) as Record<string, unknown>
    const id = String(record.id ?? '').trim().toUpperCase()
    const text = typeof record.text === 'string' ? record.text : ''
    const maxLength = record.maxLength === undefined ? undefined : Number(record.maxLength)
    if (category === 'symbols') {
      if (!/^[A-Z0-9]{3}$/.test(id)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `symbol id "${String(record.id ?? '')}" must be exactly 3 characters (A-Z 0-9).`)
      }
      if (!text || text.length > (maxLength && maxLength > 0 ? maxLength : DEFAULT_SYMBOL_MAX_LENGTH)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `symbol ${id} text must be 1-${maxLength && maxLength > 0 ? maxLength : DEFAULT_SYMBOL_MAX_LENGTH} characters.`)
      }
    } else if (category === 'selections') {
      if (!/^[A-Z_][A-Z0-9_]{0,7}$/.test(id)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `selection id "${String(record.id ?? '')}" must be 1-8 characters (letter first).`)
      }
      if (!text || text.length > 30) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `selection ${id} text must be 1-30 characters.`)
      }
    } else {
      if (!VALID_HEADINGS.has(id)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `heading id "${String(record.id ?? '')}" must be one of ${[...VALID_HEADINGS].join('/')}.`)
      }
      const limit = id === 'LISTHEADER' ? 71 : 255
      if (!text || text.length > limit) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `heading ${id} text must be 1-${limit} characters.`)
      }
    }
    if (seen.has(id)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `duplicate element id ${id}.`)
    }
    seen.add(id)
    return { id, text, ...(category === 'symbols' && maxLength && maxLength > 0 ? { maxLength } : {}) }
  })
}

/** 稳定 hash（plan payloadHash）。 */
export async function textPoolHash(payload: unknown): Promise<string> {
  const { createHash } = await import('crypto')
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** 上下文形态。 */
export interface TextPoolContext {
  systemHost: string
  client: string
  sapUser: string
  systemRole: string
  toolProfile: string
}

/** 受控程序文本池工作流。 */
export class TextPoolWorkflow {
  private readonly plans = new Map<string, TextPoolPlan & { expiresAtMs: number }>()

  private getForContext(planId: string, context: TextPoolContext): TextPoolPlan {
    const plan = this.plans.get(planId)
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'text-pool-plan', 'Text pool plan does not exist.')
    if (plan.context.systemHost !== context.systemHost || plan.context.client !== context.client
      || plan.context.sapUser !== context.sapUser || plan.context.systemRole !== context.systemRole
      || plan.context.toolProfile !== context.toolProfile) {
      throw new SafeAbapError('POLICY_DENIED', 'text-pool-plan', 'Plan belongs to a different SAP context.')
    }
    if (plan.expiresAtMs <= (this.deps.now?.() ?? Date.now())) {
      plan.status = 'EXPIRED'
    }
    return plan
  }

  private setStatus(planId: string, status: TextPoolPlan['status']): void {
    const plan = this.plans.get(planId)
    if (plan) plan.status = status
  }

  constructor(
    private readonly deps: {
      /** 读当前文本池（GET /source/{category}，text/plain——真机 415 取证）。 */
      read: (program: string, category: TextPoolCategory) => Promise<TextPoolElement[]>
      /** 写文本池（PUT /source/{category}，text/plain，服务端锁句柄）。 */
      write: (program: string, category: TextPoolCategory, elements: TextPoolElement[], lockHandle: string, transport?: string) => Promise<void>
      /** 程序对象锁（server 会话持有；句柄与写调用同会话）。 */
      locks: {
        lock: (programUrl: string, mode: string) => Promise<{ lockHandle?: string; LOCK_HANDLE?: string }>
        unLock: (programUrl: string, lockHandle: string) => Promise<unknown>
      }
      policy: SafetyPolicy
      audit: TextPoolAuditSink
      now?: () => number
    },
    private readonly ttlMs: number = DEFAULT_TTL_MS
  ) {}

  private context(): TextPoolContext {
    return {
      systemHost: this.deps.policy.systemHost,
      client: this.deps.policy.client,
      sapUser: this.deps.policy.sapUser,
      systemRole: this.deps.policy.systemRole,
      toolProfile: this.deps.policy.toolProfile
    };
  }

  private programUrl(program: string): string {
    return `/sap/bc/adt/programs/programs/${program.toLowerCase()}`;
  }

  private auditEvent(plan: TextPoolPlan, eventType: string, success: boolean, extra?: Partial<AuditEvent>): AuditEvent {
    return {
      correlationId: plan.textPoolPlanId,
      eventType,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      resultSummary: `program ${plan.program} (${plan.category}): ${plan.newElements.length} elements`,
      success,
      ...extra
    } as AuditEvent;
  }

  /** preview：只读读当前文本池并冻结 immutable plan。 */
  async preview(input: TextPoolChangeInput): Promise<Record<string, unknown>> {
    const program = String(input?.program ?? '').trim().toUpperCase();
    const category = String(input?.category ?? '').trim().toLowerCase() as TextPoolCategory;
    if (!SAFE_PROGRAM.test(program)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'program must be 1-30 characters (letter first).');
    }
    if (!['symbols', 'selections', 'headings'].includes(category)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'category must be symbols, selections, or headings.');
    }
    const elements = normalizeTextPoolElements(input?.elements, category);

    // 只读预检：读当前类别文本池（可空——新程序可能尚无该类别文本池）
    const oldElements = await this.deps.read(program, category);

    const now = this.deps.now?.() ?? Date.now();
    const payloadHash = await textPoolHash({ program, category, elements });
    const plan: TextPoolPlan = {
      textPoolPlanId: globalThis.crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: 'PREVIEWED',
      ...this.context(),
      program,
      category,
      oldElements,
      newElements: elements,
      payloadHash,
      ...(input.transport ? { transport: String(input.transport).toUpperCase() } : {}),
      context: this.context(),
      inputElements: elements
    };
    this.plans.set(plan.textPoolPlanId, { ...plan, expiresAtMs: now + this.ttlMs });
    await this.deps.audit.append(this.auditEvent(plan, 'TEXT_POOL_PREVIEW_CREATED', true));
    return { status: 'preview', plan: this.publicView(plan), confirmationRequired: true };
  }

  /** apply：按已确认的 plan 单次执行（锁 → PUT → 解锁 → readback）。 */
  async applyConfirmed(textPoolPlanId: string): Promise<Record<string, unknown>> {
    const context = this.context();
    const plan = this.getForContext(textPoolPlanId, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'text-pool-plan', 'Text pool plan has expired.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'text-pool-plan', `Text pool plan is already ${plan.status.toLowerCase()}.`);
    }

    // 同值短路：新清单与现值完全一致（按 id+text 集合）→ 不锁不写
    const keyOf = (e: TextPoolElement) => `${e.id}=${e.text}`;
    const oldKeys = new Set(plan.oldElements.map(keyOf));
    const newKeys = new Set(plan.newElements.map(keyOf));
    const sameValue = oldKeys.size === newKeys.size && [...newKeys].every(k => oldKeys.has(k));
    if (sameValue) {
      this.setStatus(plan.textPoolPlanId, 'SUCCEEDED');
      await this.deps.audit.append(this.auditEvent(plan, 'TEXT_POOL_SAME_VALUE', true));
      return { status: 'success', plan: this.publicView(plan), sameValue: true };
    }

    let outcome: 'SUCCEEDED' | 'UNKNOWN_OUTCOME' | 'FAILED';
    let lockHandle = '';
    const programUrl = this.programUrl(plan.program);
    try {
      // 程序对象锁（server 会话持有；句柄与写调用同会话——真机实证跨会话句柄被拒）
      const lock = await this.deps.locks.lock(programUrl, 'MODIFY');
      const raw = (lock ?? {}) as Record<string, unknown>;
      lockHandle = String(raw.lockHandle ?? raw.LOCK_HANDLE ?? '');
      if (!lockHandle) {
        throw new Error('lock did not yield a handle');
      }
      await this.deps.write(plan.program, plan.category, plan.newElements, lockHandle, plan.transport);
      // readback：重读核验（按 id 集合比对文本——服务端可能按 id 重排）
      const after = await this.deps.read(plan.program, plan.category);
      const afterById = new Map(after.map((e: TextPoolElement) => [e.id, e.text]));
      const mismatch = plan.newElements.find((e: TextPoolElement) => afterById.get(e.id) !== e.text);
      if (mismatch) {
        throw new SafeAbapError('VERIFICATION_FAILED', 'readback', `element ${mismatch.id} readback does not match.`);
      }
      outcome = 'SUCCEEDED';
    } catch (error) {
      if (error instanceof SafeAbapError && error.code === 'VERIFICATION_FAILED') {
        this.setStatus(plan.textPoolPlanId, 'FAILED');
        await this.deps.audit.append(this.auditEvent(plan, 'TEXT_POOL_FAILED', false));
        throw error;
      }
      if (error instanceof SafeAbapError && error.code === 'PLAN_EXPIRED') throw error;
      // PUT 发出后的失败：结果未知——终止不重试。底层错误透传进 message
      const underlying = error instanceof Error ? error.message : String(error);
      this.setStatus(plan.textPoolPlanId, 'UNKNOWN_OUTCOME');
      try {
        await this.deps.audit.append(this.auditEvent(plan, 'TEXT_POOL_UNKNOWN', false, { unknownOutcome: true, errorSummary: underlying }));
      } catch { /* 审计失败不掩盖主错误 */ }
      throw new SafeAbapError('UNKNOWN_OUTCOME', 'EXECUTE', `The text pool write outcome is unknown (${underlying.slice(0, 200)}). Review the program text pool before retrying.`);
    } finally {
      // 对象锁必须显式释放（标准 UNLOCK 带句柄——真机实证可靠）。尽力而为。
      if (lockHandle) {
        try { await this.deps.locks.unLock(programUrl, lockHandle); }
        catch { /* 解锁失败不掩盖主结果 */ }
      }
    }

    this.setStatus(plan.textPoolPlanId, outcome);
    await this.deps.audit.append(this.auditEvent(plan, 'TEXT_POOL_COMPLETED', true));
    return { status: 'success', plan: this.publicView(plan), sameValue: false };
  }

  /** 本地状态查询。 */
  status(planId: string): TextPoolPlanView {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'text-pool-plan', 'Text pool plan does not exist.');
    return this.publicView(plan);
  }

  private publicView(plan: TextPoolPlan): TextPoolPlanView {
    const { textPoolPlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      program, category, oldElements, newElements, payloadHash } = plan;
    return {
      textPoolPlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      program, category, oldElements, newElements, payloadHash
    };
  }
}
