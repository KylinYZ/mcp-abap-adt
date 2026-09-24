/**
 * 受控消息类文本写入工作流（MessageTextWorkflow）——关闭矩阵行 i18n.write 的
 * write_message_texts 半边（write_labels 已由 DDIC 受控链覆盖）。
 *
 * 任务语义（VSP 来源）：pkg/adt/i18n.go WriteMessageClassTexts——指定语言下
 * 更新消息类的消息文本（锁 → PUT namespaced XML → 解锁；Stateful 会话绑定，
 * VSP 注释 issue #91）。
 *
 * 安全模型（与描述/克隆受控链一致）：
 * 1. preview：只读读当前语言文本 → 校验入参（编号三位数字、文本有界）→
 *    冻结 immutable plan（旧清单/新清单/payloadHash/TTL/上下文）。
 * 2. applyConfirmed：仅接受 server 生成的 planId；锁 → 单次 PUT → 解锁 →
 *    readback（重读文本清单比对）→ SUCCEEDED；PUT 发出后异常按
 *    UNKNOWN_OUTCOME 终结（可能已写，不自动重试）。
 * 3. 同值短路：新清单与现值完全一致时不锁不写（sameValue=true，仍记审计）。
 *
 * 范围：PROG 类消息编号 001-999；语言为 2 位 ISO 码（ Accept-Language）。
 */
import { SafeAbapError } from './errors.js';
import type { SafetyPolicy } from './SafetyPolicy.js';
import type { AuditEvent } from './AuditLogger.js';
import {
  readMessageClassTexts,
  writeMessageClassTexts,
  type MessageClassEntry,
  type MessageClassHttp,
  type MessageClassLockPort,
  messageClassURL
} from '../adt/MessageClassApi.js';

const SAFE_MESSAGE_CLASS = /^[A-Z][A-Z0-9_]{1,19}$/;
const SAFE_MESSAGE_NUMBER = /^\d{3}$/;
const MESSAGE_TEXT_MAX = 200;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface MessageTextChangeInput {
  messageClass: string;
  /** 2 位 ISO 语言码（如 EN/DE/ZH——转换为 Accept-Language 大写）。 */
  language: string;
  /** 目标文本清单（整清单替换语义：写入即该语言的完整集合）。 */
  texts: MessageClassEntry[];
  transport?: string;
}

export interface MessageTextPlanView {
  messageTextPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: 'PREVIEWED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED';
  systemHost: string;
  client: string;
  systemRole: string;
  toolProfile: string;
  messageClass: string;
  language: string;
  oldTexts: MessageClassEntry[];
  newTexts: MessageClassEntry[];
  payloadHash: string;
}

interface MessageTextPlan extends MessageTextPlanView {
  transport?: string;
  context: { systemHost: string; client: string; sapUser: string; systemRole: string; toolProfile: string };
  inputTexts: MessageClassEntry[];
}

export interface MessageTextAuditSink {
  append(event: AuditEvent): Promise<void>;
}

/** 规范化并校验文本清单。 */
export function normalizeMessageTexts(raw: unknown): MessageClassEntry[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 999) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'texts must be a non-empty array of at most 999 entries.');
  }
  return raw.map(entry => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const number = String(record.number ?? '').trim();
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!SAFE_MESSAGE_NUMBER.test(number)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'every message number must be a 3-digit string (001-999).');
    }
    if (!text || text.length > MESSAGE_TEXT_MAX) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `message ${number} text must be 1-${MESSAGE_TEXT_MAX} characters.`);
    }
    return { number, text };
  });
}

/** 稳定 hash（plan payloadHash）。 */
export async function messageTextHash(payload: unknown): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** 上下文形态。 */
export interface MessageTextContext {
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: string;
}

/** 受控消息文本工作流。 */
export class MessageTextWorkflow {
  private readonly plans = new Map<string, MessageTextPlan & { expiresAtMs: number }>();

  /** 取 plan 并校验上下文绑定（跨 host/client/user/role/profile 重放拒绝）。 */
  private getForContext(planId: string, context: MessageTextContext): MessageTextPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'message-text-plan', 'Message text plan does not exist.');
    if (plan.context.systemHost !== context.systemHost || plan.context.client !== context.client
      || plan.context.sapUser !== context.sapUser || plan.context.systemRole !== context.systemRole
      || plan.context.toolProfile !== context.toolProfile) {
      throw new SafeAbapError('POLICY_DENIED', 'message-text-plan', 'Plan belongs to a different SAP context.');
    }
    if (plan.expiresAtMs <= (this.deps.now?.() ?? Date.now())) {
      plan.status = 'EXPIRED';
    }
    return plan;
  }

  private setStatus(planId: string, status: MessageTextPlan['status']): void {
    const plan = this.plans.get(planId);
    if (plan) plan.status = status;
  }

  constructor(
    private readonly deps: {
      http: MessageClassHttp;
      locks: MessageClassLockPort;
      policy: SafetyPolicy;
      audit: MessageTextAuditSink;
      now?: () => number;
    },
    private readonly ttlMs: number = DEFAULT_TTL_MS
  ) {}

  private context(): MessageTextContext {
    return {
      systemHost: this.deps.policy.systemHost,
      client: this.deps.policy.client,
      sapUser: this.deps.policy.sapUser,
      systemRole: this.deps.policy.systemRole,
      toolProfile: this.deps.policy.toolProfile
    };
  }

  private auditEvent(plan: MessageTextPlan, eventType: string, success: boolean, extra?: Partial<AuditEvent>): AuditEvent {
    return {
      correlationId: plan.messageTextPlanId,
      eventType,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      resultSummary: `message class ${plan.messageClass} (${plan.language}): ${plan.newTexts.length} texts`,
      success,
      ...extra
    } as AuditEvent;
  }

  /** preview：只读读现文本并冻结 immutable plan。 */
  async preview(input: MessageTextChangeInput): Promise<Record<string, unknown>> {
    const messageClass = String(input?.messageClass ?? '').trim().toUpperCase();
    const language = String(input?.language ?? '').trim().toUpperCase();
    const texts = normalizeMessageTexts(input?.texts);
    if (!SAFE_MESSAGE_CLASS.test(messageClass)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'messageClass must be 2-20 characters (letter first).');
    }
    if (!/^[A-Z]{2}$/.test(language)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'language must be a 2-letter ISO code.');
    }

    // 只读预检：读当前语言的现文本（可空——新消息类可能尚无该语言文本）
    const oldTexts = await readMessageClassTexts(this.deps.http, messageClass, language);

    const now = this.deps.now?.() ?? Date.now();
    const payloadHash = await messageTextHash({ messageClass, language, texts });
    const plan: MessageTextPlan = {
      messageTextPlanId: globalThis.crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: 'PREVIEWED',
      ...this.context(),
      messageClass,
      language,
      oldTexts,
      newTexts: texts,
      payloadHash,
      ...(input.transport ? { transport: String(input.transport).toUpperCase() } : {}),
      context: this.context(),
      inputTexts: texts
    };
    this.plans.set(plan.messageTextPlanId, { ...plan, expiresAtMs: now + this.ttlMs });
    await this.deps.audit.append(this.auditEvent(plan, 'MESSAGE_TEXT_PREVIEW_CREATED', true));
    return { status: 'preview', plan: this.publicView(plan), confirmationRequired: true };
  }

  /** apply：按已确认的 plan 单次执行（锁 → PUT → 解锁 → readback）。 */
  async applyConfirmed(messageTextPlanId: string): Promise<Record<string, unknown>> {
    const context = this.context();
    const plan = this.getForContext(messageTextPlanId, context);
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'message-text-plan', 'Message text plan has expired.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'message-text-plan', `Message text plan is already ${plan.status.toLowerCase()}.`);
    }

    // 同值短路：新清单与现值完全一致 → 不锁不写
    const sameValue =
      plan.oldTexts.length === plan.newTexts.length &&
      plan.newTexts.every((entry: MessageClassEntry, index: number) =>
        plan.oldTexts[index]?.number === entry.number && plan.oldTexts[index]?.text === entry.text
      );
    if (sameValue) {
      this.setStatus(plan.messageTextPlanId, 'SUCCEEDED');
      await this.deps.audit.append(this.auditEvent(plan, 'MESSAGE_TEXT_SAME_VALUE', true));
      return { status: 'success', plan: this.publicView(plan), sameValue: true };
    }

    let outcome: 'SUCCEEDED' | 'UNKNOWN_OUTCOME' | 'FAILED';
    let lockHandle = '';
    try {
      // 锁协议（真机实证 2026-09-24）：只用对象级 LOCK（query 级句柄）。消息级
      // LOCK_MSG 与对象锁双向 EU510 互斥（msgno 初值=泛型锁）；PUT 只认对象锁句柄
      // （消息句柄报"invalid lock handle"）。PUT 走 application/* + 富属性行形态
      // （本仓库受控创建链已真机验证；mc 专用媒体类型会被服务端静默忽略）。
      const lock = await this.deps.locks.lock(`/sap/bc/adt/messageclass/${plan.messageClass.toLowerCase()}`, 'MODIFY');
      const raw = (lock ?? {}) as Record<string, unknown>;
      lockHandle = String(raw.lockHandle ?? raw.LOCK_HANDLE ?? '');
      if (!lockHandle) {
        throw new Error('lock did not yield a handle');
      }
      await writeMessageClassTexts(this.deps.http, {
        name: plan.messageClass,
        language: plan.language,
        texts: plan.inputTexts,
        lockHandle,
        ...(plan.transport ? { transport: plan.transport } : {})
      });
      // readback：重读核验
      const after = await readMessageClassTexts(this.deps.http, plan.messageClass, plan.language);
      const readbackMap = new Map(after.map((entry: MessageClassEntry) => [entry.number, entry.text]));
      const mismatch = plan.newTexts.find((entry: MessageClassEntry) => readbackMap.get(entry.number) !== entry.text);
      if (mismatch) {
        throw new SafeAbapError('VERIFICATION_FAILED', 'readback', `message ${mismatch.number} readback does not match.`);
      }
      outcome = 'SUCCEEDED';
    } catch (error) {
      if (error instanceof SafeAbapError && error.code === 'VERIFICATION_FAILED') {
        this.setStatus(plan.messageTextPlanId, 'FAILED');
        await this.deps.audit.append(this.auditEvent(plan, 'MESSAGE_TEXT_FAILED', false));
        throw error;
      }
      if (error instanceof SafeAbapError && error.code === 'PLAN_EXPIRED') throw error;
      // PUT 发出后的失败：结果未知——终止不重试。底层错误透传进 message
      // （语义仍是 UNKNOWN_OUTCOME，但调用方能看到卡在哪一步，真机排障必需）
      const underlying = error instanceof Error ? error.message : String(error);
      this.setStatus(plan.messageTextPlanId, 'UNKNOWN_OUTCOME');
      try {
        // 底层错误记入 errorSummary（诊断可见；语义仍是 UNKNOWN_OUTCOME）
        await this.deps.audit.append(this.auditEvent(plan, 'MESSAGE_TEXT_UNKNOWN', false, { unknownOutcome: true, errorSummary: underlying }));
      } catch { /* 审计失败不掩盖主错误 */ }
      throw new SafeAbapError('UNKNOWN_OUTCOME', 'EXECUTE', `The message text write outcome is unknown (${underlying.slice(0, 200)}). Review the message class before retrying.`);
    } finally {
      // 对象锁必须显式释放（标准 UNLOCK 带句柄——真机实证可靠）。尽力而为，
      // 释放失败不掩盖主结果。
      if (lockHandle) {
        try { await this.deps.locks.unLock(`/sap/bc/adt/messageclass/${plan.messageClass.toLowerCase()}`, lockHandle); }
        catch { /* 解锁失败不掩盖主结果 */ }
      }
    }

    this.setStatus(plan.messageTextPlanId, outcome);
    await this.deps.audit.append(this.auditEvent(plan, 'MESSAGE_TEXT_COMPLETED', true));
    return { status: 'success', plan: this.publicView(plan), sameValue: false };
  }

  /** 本地状态查询。 */
  status(planId: string): MessageTextPlanView {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'message-text-plan', 'Message text plan does not exist.');
    return this.publicView(plan);
  }

  private publicView(plan: MessageTextPlan): MessageTextPlanView {
    const { messageTextPlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      messageClass, language, oldTexts, newTexts, payloadHash } = plan;
    return {
      messageTextPlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      messageClass, language, oldTexts, newTexts, payloadHash
    };
  }
}
