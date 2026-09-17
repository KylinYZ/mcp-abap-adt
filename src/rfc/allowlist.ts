/**
 * 只读 FM allowlist 门控（rfc-transport-spike 阶段 0）。
 *
 * 用途：在协议层强制「只允许白名单内的只读 FM 被调用」。白名单之外
 * 一律拒绝，并返回结构化拒绝（错误码 `RF_CALL_NOT_ALLOWED` + 原因），
 * 这是禁止「调用任意 FM 通用入口」的第一道硬门。
 *
 * 业务规则：
 * - 默认白名单保持最小集合：RFC_SYSTEM_INFO / RFC_PING / RFC_READ_TABLE，
 *   均为 SAP 标准只读 FM（系统信息、连通性探测、表读取）。
 * - 允许注入扩展条目（未来按 profile 分层放开），但默认不开放；
 *   扩展条目同样必须通过 FM 命名校验。
 * - FM 名统一大写比较（SAP 对象名大小写不敏感的约定）。
 */

import { RfcError } from './errors';
import { isValidFmName } from './interface';

/** 默认只读白名单（最小集合，故意不随需求随意扩张）。 */
export const DEFAULT_READONLY_FM_ALLOWLIST: readonly string[] = ['RFC_SYSTEM_INFO', 'RFC_PING', 'RFC_READ_TABLE'];

/**
 * 只读 FM 白名单。
 *
 * 关键变量：
 * - `allowed`：内部大写集合，判定 O(1)；构造后不再暴露可变引用。
 */
export class FmAllowlist {
  private readonly allowed: ReadonlySet<string>;

  /**
   * @param extra 额外注入的白名单条目（默认为空）。条目必须符合 FM 命名，
   *              非法条目直接抛错，避免带病扩展。
   */
  constructor(extra: readonly string[] = []) {
    const names = new Set<string>();
    for (const name of [...DEFAULT_READONLY_FM_ALLOWLIST, ...extra]) {
      const upper = String(name).toUpperCase();
      if (!isValidFmName(upper)) {
        throw new RfcError('RFC_INVALID_INTERFACE', `Allowlist entry is not a valid FM name: ${JSON.stringify(name)}.`);
      }
      names.add(upper);
    }
    this.allowed = names;
  }

  /** 判断 FM 是否在白名单内（大小写不敏感；非字符串一律 false）。 */
  isAllowed(functionName: unknown): boolean {
    return typeof functionName === 'string' && this.allowed.has(functionName.toUpperCase());
  }

  /**
   * 强制门控：白名单外抛 `RF_CALL_NOT_ALLOWED`。
   *
   * 错误信息中显式包含错误码文本与目标 FM 名，保证调用方（MCP 客户端
   * 与审计日志）可以直接从 message 读出拒绝原因；details 携带结构化字段。
   */
  assertAllowed(functionName: unknown): void {
    if (this.isAllowed(functionName)) return;
    const shown = typeof functionName === 'string' ? functionName : JSON.stringify(functionName);
    throw new RfcError(
      'RF_CALL_NOT_ALLOWED',
      `RF_CALL_NOT_ALLOWED: FM ${shown} is not in the read-only allowlist (${this.entries().join(', ')}).`,
      {
        functionName: typeof functionName === 'string' ? functionName.toUpperCase() : undefined,
        allowed: this.entries(),
        reason: 'not-in-readonly-allowlist'
      }
    );
  }

  /** 当前白名单（排序后的副本），用于 describe/诊断输出。 */
  entries(): readonly string[] {
    return [...this.allowed].sort();
  }

  /** 白名单条目数量。 */
  get size(): number {
    return this.allowed.size;
  }
}

/** 构造默认只读白名单；extra 为可选的受控扩展。 */
export function createDefaultFmAllowlist(extra: readonly string[] = []): FmAllowlist {
  return new FmAllowlist(extra);
}
