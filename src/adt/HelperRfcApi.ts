import { ApcWebSocketConnection } from './ApcWebSocketBridge.js'
import { FmAllowlist, createDefaultFmAllowlist } from '../rfc/allowlist.js'

/**
 * ZADT_VSP helper 桥 rfc 域受控客户端（矩阵行 rfc.helper-bridge 收编，
 * 2026-10-10 所有者明确授权后实施）。
 *
 * 与 open-rfc 直链（callRfm）的分工：
 *   - callRfm：remote-enabled FM，走 SAP 网关（open-rfc 基座）；
 *   - helperCallRfm：**非 remote-enabled FM 也可调**——桥的 rfc 服务在 SAP
 *     应用服务进程内直接 CALL FUNCTION，不受网关 remote 标志限制。这正是
 *     rfc.helper-bridge 行的独特价值，也是它需要独立风险评审的原因：
 *     执行面绕过 ADT 审计与网关限制。
 *
 * 受控设计（fail-closed）：
 *   - allowlist 硬门：默认复用 callRfm 的只读白名单（RFC_PING 等 7 FM，
 *     标准交付/无副作用/名称稳定）；经构造注入扩展（部署者显式追加）。
 *     白名单外拒绝在任何网络往返之前发生。
 *   - DEV-only：helper 只部署在 DEV，policy 门控已保证。
 *   - 审计：每次调用的 FM 名与参数键随结果透出。
 *
 * 桥契约（ZCL_VSP_RFC_SERVICE handle_call，sap-dev 部署版实测）：
 *   params = { function, <IMPORT 参数名>: <字符串值>, ... }
 *   → data = { subrc, exports: {...}, tables: {...} }
 */

/** 桥接目标（与 git/report 桥共用 APC 服务节点）。 */
export interface HelperRfcBridgeTarget {
  host: string
  port: number
  path: string
  authorization: string
  timeoutMs?: number
}

export interface HelperCallInput {
  /** FM 名（白名单硬门；allowlist 外零往返拒绝）。 */
  function: string
  /** IMPORT 参数（键=参数名，值=字符串；值非字符串转字符串）。 */
  importing?: Record<string, string>
}

export interface HelperCallResult {
  function: string
  /** SAP sy-subrc。 */
  subrc: number
  /** EXPORT/CHANGING 返回值（参数名 → JSON 值）。 */
  exports: Record<string, unknown>
  /** TABLES 参数（参数名 → 行数组）。 */
  tables: Record<string, unknown[]>
  /** allowlist 命中来源（default-readonly / extended），供审计。 */
  allowlistSource: 'default-readonly' | 'extended'
}

export class HelperRfcBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HelperRfcBridgeError';
  }
}

/** 应答 data 提取（JSON 字符串/对象双形态兼容——GitBridgeApi 同款契约）。 */
function requireHelperSuccess(response: Record<string, unknown>): Record<string, unknown> {
  const err = response.error as { code?: string; message?: string } | undefined;
  if (response.success !== true) {
    throw new HelperRfcBridgeError(
      err?.code ?? 'HELPER_BRIDGE_FAILED',
      err?.message ?? 'rfc helper domain returned no data'
    );
  }
  const raw = response.data;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new HelperRfcBridgeError('HELPER_DATA_MALFORMED', 'rfc helper domain data is not valid JSON');
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  throw new HelperRfcBridgeError('HELPER_BRIDGE_FAILED', 'rfc helper domain returned no data');
}

export class HelperRfcBridge {
  private readonly allowlist: FmAllowlist
  private readonly allowlistSource: 'default-readonly' | 'extended'

  constructor(
    private readonly target: HelperRfcBridgeTarget,
    extraAllowlist: readonly string[] = []
  ) {
    if (extraAllowlist.length > 0) {
      this.allowlist = new FmAllowlist(extraAllowlist);
      this.allowlistSource = 'extended';
    } else {
      this.allowlist = createDefaultFmAllowlist();
      this.allowlistSource = 'default-readonly';
    }
  }

  /** FM 名是否在白名单（供审计/诊断）。 */
  isAllowed(functionName: string): boolean {
    return this.allowlist.isAllowed(functionName.trim().toUpperCase());
  }

  /** 经桥 rfc 域调用 FM（白名单硬门在先，零往返拒绝）。 */
  async callFunction(functionName: string, importing?: Record<string, string>): Promise<Omit<HelperCallResult, 'allowlistSource'>> {
    const fm = String(functionName ?? '').trim().toUpperCase();
    if (!this.allowlist.isAllowed(fm)) {
      throw new HelperRfcBridgeError(
        'FM_NOT_ALLOWED',
        `FM ${fm} is not on the helper-bridge allowlist (default: read-only standard FMs; extend via constructor injection).`
      );
    }
    const conn = await ApcWebSocketConnection.connect(this.target);
    try {
      const params: Record<string, unknown> = { function: fm };
      if (importing !== undefined) {
        for (const [k, v] of Object.entries(importing)) params[k] = String(v);
      }
      const response = await conn.request(
        { id: 'helper-rfc-call', domain: 'rfc', action: 'call', params },
        this.target.timeoutMs
      );
      const data = requireHelperSuccess(response);
      const exportsRaw = data.exports as Record<string, unknown> | undefined;
      const tablesRaw = data.tables as Record<string, unknown[]> | undefined;
      return {
        function: fm,
        subrc: Number(data.subrc ?? 0),
        exports: exportsRaw && typeof exportsRaw === 'object' ? exportsRaw : {},
        tables: tablesRaw && typeof tablesRaw === 'object' ? tablesRaw : {}
      };
    } finally {
      conn.close();
    }
  }
}
