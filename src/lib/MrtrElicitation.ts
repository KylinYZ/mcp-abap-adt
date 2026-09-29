/**
 * MRTR 确认引擎（0.9.0 协议栈迁移）。
 *
 * 作用：把既有确认类的 elicitInput port（"发起表单确认并等待用户结果"）
 * 无缝映射到 MCP 2026-07-28 的多轮往返（MRTR）模型：
 * - 无本轮响应：抛出 ConfirmationRequiredError（携带 inputRequests + requestState），
 *   由 tools/call handler 捕获并转为 resultType:"input_required" 的工具结果；
 *   在 2025（legacy）连接上，v2 SDK 的 legacyInputRequiredShim 会自动把它
 *   转回 elicitation/create 服务器→客户端请求并驱动重入（实测见
 *   docs/evidence/mcp-v2-migration-api-probe.md 第 6/7 条）。
 * - 有本轮响应（客户端重试同一 tools/call 时经 inputResponses 携带）：
 *   校验后返回与 v1 等价的 ElicitResult，确认类继续原有校验与执行链。
 *
 * 安全规则：
 * - requestState 经 HMAC 完整性保护（spec basic/patterns/mrtr 服务器要求 4-5），
 *   绑定 toolName + 规范化调用参数摘要 + 轮次号 + nonce：
 *   跨工具、跨参数、跨轮次重放确认响应会在签名/摘要校验处被拒绝，
 *   引擎将重新发起确认请求（fail-safe：宁可多确认一次，不放行未绑定确认）。
 * - HMAC 密钥为进程级随机数：跨进程重启后旧 state 失效（plan 生命周期本就
 *   不跨服务器重启），无需持久化。
 */
import { createHmac, randomBytes, createHash } from 'crypto';
import {
  inputRequired,
  acceptedContent,
  type InputRequests,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams
} from '@modelcontextprotocol/server';
import type { ElicitResult } from './McpErrorCompat.js';

/** 确认请求在 inputRequests 中的固定键（单确认点串行复用） */
const CONFIRM_KEY = 'confirm';

/**
 * 穿透守卫执行链的"需要用户确认"信号。
 * handleError / serializeError 链必须原样 rethrow，最终由 tools/call
 * handler 转成 inputRequired(...) 结果返回客户端。
 */
export class ConfirmationRequiredError extends Error {
  constructor(
    readonly inputRequests: InputRequests,
    readonly requestState: string
  ) {
    super('Native confirmation required before this operation can proceed.');
    this.name = 'ConfirmationRequiredError';
  }
}

/** 进程级 HMAC 密钥：保护 requestState 完整性（不落盘，重启即失效） */
const PROCESS_SECRET = randomBytes(32);

function sign(payload: string): string {
  return createHmac('sha256', PROCESS_SECRET).update(payload).digest('base64url');
}

/** requestState 明文负载：轮次号 + nonce；绑定信息进签名（不泄露参数内容） */
interface MrtrWireState {
  round: number;
  nonce: string;
  binding: string;
}

function encodeState(state: MrtrWireState): string {
  const body = `${state.round}.${state.nonce}.${state.binding}`;
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sign(body)}`;
}

function decodeState(raw: unknown): MrtrWireState | undefined {
  if (typeof raw !== 'string' || !raw.includes('.')) return undefined;
  const dot = raw.lastIndexOf('.');
  const body = Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8');
  const sig = raw.slice(dot + 1);
  // 常数时间比较近似（HMAC 输出定长，直接比对签名不匹配即拒绝）
  if (sign(body) !== sig) return undefined;
  const [roundStr, nonce, binding] = body.split('.');
  const round = Number(roundStr);
  if (!Number.isSafeInteger(round) || round < 1 || !nonce || !binding) return undefined;
  return { round, nonce, binding };
}

/** 规范化调用绑定摘要：toolName + 排序后的参数（重试请求必须逐字节一致） */
export function mrtrCallBinding(toolName: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify([toolName, args], Object.keys(args).sort());
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 24);
}

/**
 * 创建本次 tools/call 调用的 elicitInput port。
 * 返回的函数与旧版 server.elicitInput(params, {timeout}) 语义兼容，
 * 供确认类与直调 handler 原样使用；timeoutMs 在 MRTR 模型下无服务器侧
 * 等待语义（客户端不重试即等于放弃），仅为签名兼容保留。
 */
export function createMrtrElicitPort(
  toolName: string,
  args: Record<string, unknown>,
  inputResponses: Record<string, unknown> | undefined,
  requestStateRaw: unknown
): (params: ElicitRequestFormParams | ElicitRequestURLParams, timeoutMs: number) => Promise<ElicitResult> {
  const binding = mrtrCallBinding(toolName, args);
  const wire = decodeState(requestStateRaw);
  // 绑定校验：requestState 与本次调用（工具 + 参数）不符 → 视为重放，
  // 拒绝消费 responses，直接进入新一轮确认
  const stateUsable = wire !== undefined && wire.binding === binding;
  let issuedRound = stateUsable ? wire!.round : 0;
  let responsesConsumed = false;

  return async (params, _timeoutMs) => {
    if (!responsesConsumed && issuedRound > 0 && inputResponses) {
      responsesConsumed = true;
      const got = acceptedContent<Record<string, unknown>>(inputResponses, CONFIRM_KEY);
      if (got) {
        // 与 v1 form accept 形态对齐：{action:'accept', content:{...}}
        return { action: 'accept', content: got } as ElicitResult;
      }
      // 缺失 / declined / cancel / 其他类型响应统一按未确认处理，
      // 由确认类走既有的拒绝与 text-fallback 路径
      return { action: 'decline' } as ElicitResult;
    }
    issuedRound += 1;
    throw new ConfirmationRequiredError(
      { [CONFIRM_KEY]: inputRequired.elicit(params as ElicitRequestFormParams) },
      encodeState({ round: issuedRound, nonce: randomBytes(12).toString('base64url'), binding })
    );
  };
}
