import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../types/tools.js';
import { FmAllowlist, createDefaultFmAllowlist } from '../rfc/allowlist.js';
import { invokeFmCall } from '../rfc/call.js';
import { normalizeRfcConnectionParams, type RfcConnectionParams } from '../rfc/connection.js';
import { RfcError } from '../rfc/errors.js';
import { RfcConnectionPool } from '../rfc/pool.js';
import type { TransportAdapter } from '../rfc/transport.js';
import { readRfcTable } from '../rfc/read-table-adapter.js';
import { OpenRfcTransport, rfcParamsFromEnvironment } from '../rfc/open-rfc-transport.js';

/**
 * ============================================================================
 * RFC 探测只读 MCP 工具处理器（rfc.remote-enabled.discovery 的直链路线）
 * ============================================================================
 *
 * 暴露一个只读工具 probeRfcSystem：经 open-rfc（纯 TS classic RFC 客户端，
 * 与 VSP 的 open-rfc-go 同源同协议）直连 SAP 网关，调用白名单内的
 * RFC_PING + RFC_SYSTEM_INFO，输出连通状态与系统指纹。
 *
 * 通道说明（真机实测 2026-09-18）：该 DEV 的 RFC 直链为 host 10.30.254.48 +
 * sysnr 01（网关 3301，.vsp.json rfc_sysnr 实测值）；HTTP 8001 端口的
 * SOAP-RFC 路线与直连无关。RFC_SIMULATE_AUTH_CHECK 授权模拟探测尚未纳入
 * （notes 标注）。
 *
 * 安全链路（阶段 0 协议层全量生效）：
 *   allowlist 门控（白名单外 RF_CALL_NOT_ALLOWED）→ invokeFmCall 超时/取消
 *   → OpenRfcTransport（连接池复用，传输故障剔除，ABAP 异常不剔除）。
 *
 * 业务规则：
 *   - 只读工具（RFC_PING/RFC_SYSTEM_INFO 均为白名单内无副作用系统 RFM；
 *     _meta.operationClass='read-only tenant'）。
 *   - 探测失败不抛错：pong=false / status=error 分类报告（discovery 语义）。
 *   - QAS/PRD 角色门控由既有策略层负责（read-only 类对三角色可见，但真实
 *     RFC 仅专用 DEV 授权 smoke）。
 */

/** 本处理器认领的工具名。 */
const RFC_PROBE_TOOL_NAMES = new Set(['probeRfcSystem', 'readRfcTable']);

type RfcProbeToolDefinition = ToolDefinition & {
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: true;
  };
  _meta: {
    operationClass: 'read-only tenant';
    approvalRequired: false;
  };
};

/** 只读白名单门控（RFC_PING/RFC_SYSTEM_INFO/RFC_READ_TABLE，协议层硬门）。 */
const allowlist = createDefaultFmAllowlist();

/** RFC 调用超时毫秒，30 秒与 VSP keep-alive 一致。 */
const RFC_CALL_TIMEOUT_MS = 30_000;

export class RfcProbeHandlers {
  /** 单连接退化适配器（未注入连接池时使用，懒建复用）。 */
  private standaloneAdapter?: TransportAdapter;

  /**
   * @param rfcConfig ADT 环境推导的 RFC 连接参数（host/client/user/password/
   *   language + 可选 sysnr 覆盖，缺省 '01'）
   * @param pool 可选的连接池（复用与 keep-alive）；未提供时退化为单连接适配器
   */
  constructor(
    private readonly rfcConfig: {
      readonly host: string
      readonly client: string
      readonly user: string
      readonly password?: string
      readonly language?: string
      readonly sysnr?: string
    },
    private readonly pool?: RfcConnectionPool
  ) {}

  /** 该工具名是否由本处理器负责。 */
  supports(toolName: string): boolean {
    return RFC_PROBE_TOOL_NAMES.has(toolName);
  }

  /** 取传输适配器：优先走连接池（acquire 按参数 key 复用），退化用单连接。 */
  private async adapter(): Promise<TransportAdapter> {
    if (this.standaloneAdapter) return this.standaloneAdapter;
    const params: RfcConnectionParams = normalizeRfcConnectionParams(
      rfcParamsFromEnvironment(this.rfcConfig)
    );
    if (this.pool) {
      const entry = await this.pool.acquire(params);
      return entry as unknown as TransportAdapter;
    }
    this.standaloneAdapter = new OpenRfcTransport(params);
    await this.standaloneAdapter.connect();
    return this.standaloneAdapter;
  }

  /** 单 FM 调用（allowlist 门控 + 超时取消，经白名单校验后才进传输层）。 */
  private async invokeWhitelisted(functionName: string): Promise<Record<string, unknown>> {
    if (!allowlist.isAllowed(functionName)) {
      throw new RfcError('RF_CALL_NOT_ALLOWED', `FM ${functionName} is not on the read-only allowlist.`);
    }
    const adapter = await this.adapter();
    const result = await invokeFmCall(adapter, { functionName, timeoutMs: RFC_CALL_TIMEOUT_MS });
    return {
      ...result.values,
      ...(Object.keys(result.tables).length > 0 ? { tables: result.tables } : {})
    } as Record<string, unknown>;
  }

  /** 只读工具定义（probeRfcSystem 无入参 + readRfcTable 带表/列过滤）。 */
  getTools(): RfcProbeToolDefinition[] {
    const readOnly: Pick<RfcProbeToolDefinition, 'annotations' | '_meta'> = {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      _meta: { operationClass: 'read-only tenant', approvalRequired: false }
    };
    return [
      {
        name: 'probeRfcSystem',
        description:
          'Probe the classic-RFC face of the system over a direct RFC link (node:net to the gateway, no SDK): RFC_PING for reachability and RFC_SYSTEM_INFO for the system fingerprint (sysid/release/kernel/host/codepage). Gated to the read-only FM allowlist. Note: RFC_SIMULATE_AUTH_CHECK authorization probing is not included. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {}
        },
        ...readOnly
      },
      {
        name: 'readRfcTable',
        description:
          'Read rows from a DDIC table or view over the direct RFC link (RFC_READ_TABLE): WHERE clause with single-quote escaping, column projection, row-count limit. Gated to the read-only FM allowlist. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            table: {
              type: 'string',
              description: 'Target DDIC table or view name, e.g. T001.',
              minLength: 1,
              maxLength: 30
            },
            whereClause: {
              type: 'string',
              description: "WHERE clause (e.g. \"BUKRS = '1000'\"); single quotes are escaped automatically.",
              optional: true
            },
            fields: {
              type: 'array',
              description: 'Column names to read; empty reads all columns.',
              items: { type: 'string' },
              optional: true
            },
            maxRows: {
              type: 'number',
              description: 'Maximum rows to return; default 100, cap 1000.',
              minimum: 1,
              maximum: 1000,
              optional: true
            }
          },
          required: ['table']
        },
        ...readOnly
      }
    ];
  }

  /**
   * 分派到注入的 RFC 客户端。探测失败不抛错（discovery 语义）；
   * 其余底层异常脱敏为 InternalError。
   */
  async handle(toolName: string, argumentsValue: Record<string, unknown> = {}): Promise<Record<string, any>> {
    try {
      if (toolName === 'probeRfcSystem') {
        let ping: Record<string, unknown>;
        try {
          await this.invokeWhitelisted('RFC_PING');
          // RFC_PING 无输出参数：调用成功本身即连通证明
          ping = { pong: true, detail: 'RFC_PING succeeded over the direct RFC link' };
        } catch (error) {
          ping = { pong: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) };
        }
        let systemInfo: Record<string, unknown>;
        try {
          systemInfo = await this.invokeWhitelisted('RFC_SYSTEM_INFO');
        } catch (error) {
          systemInfo = { status: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) };
        }
        return success({ ping, systemInfo });
      }
      if (toolName === 'readRfcTable') {
        const table = typeof argumentsValue?.table === 'string' ? argumentsValue.table.trim().toUpperCase() : '';
        if (!table || table.length > 30 || !/^[A-Z0-9_/]+$/.test(table)) {
          throw invalid(
            `${toolName} requires table: a non-empty DDIC table name of at most 30 characters matching [A-Z0-9_/].`
          );
        }
        const whereClause = typeof argumentsValue?.whereClause === 'string' ? argumentsValue.whereClause.trim() : undefined;
        const fieldsRaw = Array.isArray(argumentsValue?.fields) ? argumentsValue.fields : undefined;
        const fields = fieldsRaw?.map(f => String(f ?? '').trim().toUpperCase()).filter(f => f !== '');
        const maxRows = typeof argumentsValue?.maxRows === 'number' && Number.isFinite(argumentsValue.maxRows)
          ? Math.min(Math.max(Math.floor(argumentsValue.maxRows), 1), 1000)
          : undefined;
        return success(await readRfcTable(
          await this.adapter(),
          {
            table,
            ...(whereClause ? { whereClause } : {}),
            ...(fields && fields.length > 0 ? { fields } : {}),
            ...(maxRows !== undefined ? { maxRows } : {})
          }
        ));
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown RFC probe tool: ${toolName}`);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, `${toolName} failed.`);
    }
  }
}

/** 成功响应包装：content 文本与 structuredContent 同构。 */
function success(result: unknown): Record<string, any> {
  const structuredContent = { status: 'success', result };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

/** 参数校验失败的 MCP 语义错误。 */
function invalid(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}
