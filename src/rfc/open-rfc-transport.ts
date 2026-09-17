import { Client, languageIsoToSap, type RfcClientOptions } from 'open-rfc';

import { FmCallResult } from './call';
import { RfcError, RfcTransportError } from './errors';
import { normalizeRfcConnectionParams, RfcConnectionParams } from './connection';
import { TransportAdapter, RfcTransportInvokeRequest } from './transport';

/**
 * open-rfc 真实传输适配器（rfc-transport-spike 阶段 1）。
 *
 * 用途：把 npm `open-rfc`（SDK-free TypeScript classic RFC 客户端，与 VSP 的
 * open-rfc-go 同源同协议）适配为 `TransportAdapter`，替换阶段 0 的
 * LoopbackTransport，使 `src/rfc` 的接口校验/白名单/连接池上层全部生效于
 * 真实网络。
 *
 * 连接参数来源：由既有 ADT 系统配置推导（SAP_URL 主机 + SAP_CLIENT +
 * SAP_USER/SAP_PASSWORD + RFC_SYSNR 实例号，缺省 '01'——与专用 DEV 的
 * .vsp.json rfc_sysnr 一致；经典 RFC 网关端口 = 3300+sysnr）。
 *
 * 错误映射规则：
 * - open-rfc 的网络/登录/系统故障 → `RFC_TRANSPORT_FAILURE`（连接池据此剔除）；
 * - FM 侧 RAISE 的 ABAP 异常（ABAPError）→ `RFC_ABAP_EXCEPTION`（非传输故障，
 *   连接不剔除——FM 报错不代表连接坏了）。
 */

/** 错误码扩展：ABAP 异常与传输故障分离（连接池剔除只认传输故障）。 */
type OpenRfcTransportErrorCode = 'RFC_TRANSPORT_FAILURE' | 'RFC_TRANSPORT_CLOSED' | 'RFC_ABAP_EXCEPTION';

/** 判定 open-rfc 抛出的错误是否为其 ABAP 异常形态（FM 侧 RAISE）。 */
function isAbapFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'abapMsgClass' in (error as Record<string, unknown>)
  );
}

/** 从 open-rfc 错误中摘取可展示消息（不携带凭据）。 */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
}

export class OpenRfcTransport implements TransportAdapter {
  private readonly client: Client;
  private readonly timeoutSeconds: number;
  private lastActivityAt: number | null = null;
  private opened = false;

  constructor(
    params: RfcConnectionParams,
    options: { readonly timeoutSeconds?: number } = {}
  ) {
    // 连接参数由 normalizeRfcConnectionParams 严格校验/归一化后再喂给 open-rfc
    const normalized = normalizeRfcConnectionParams(params);
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    const clientOptions: RfcClientOptions =
      options.timeoutSeconds !== undefined
        ? ({ timeout: options.timeoutSeconds } as RfcClientOptions)
        : {};
    this.client = new Client(
      {
        ashost: normalized.ashost,
        sysnr: normalized.sysnr,
        client: normalized.client,
        user: normalized.user,
        passwd: normalized.password,
        // RFC 会话语言固定 E：仅影响 RFM 返回的消息文本语言。中文简体内部码
        // 为数字 1，会被 open-rfc 的单字母校验拒绝（库限制），且语言会话与
        // 工作语言解耦是 RFC 生态通用做法
        lang: 'E'
      },
      clientOptions
    );
  }

  /** 建立经典 RFC 连接（open-rfc Client.open）。 */
  async connect(): Promise<void> {
    if (this.opened) return;
    await this.client.open();
    this.opened = true;
    this.lastActivityAt = Date.now();
  }

  /**
   * 执行一次 FM 调用。
   * 输出归类：open-rfc 返回对象中数组值归入 tables，其余归入 values
   * （与 FmCallResult 的 values/tables 语义一致）。
   */
  async invoke(request: RfcTransportInvokeRequest): Promise<FmCallResult> {
    if (!this.opened) {
      throw new RfcTransportError('invoke before connect (open-rfc transport)', undefined, 'RFC_TRANSPORT_CLOSED');
    }
    const started = Date.now();
    let result: Record<string, unknown>;
    try {
      result = (await this.client.call(
        request.functionName,
        (request.payload ?? {}) as Record<string, unknown>,
        { timeout: this.timeoutSeconds }
      )) as Record<string, unknown>;
      this.lastActivityAt = Date.now();
    } catch (error) {
      this.lastActivityAt = Date.now();
      if (isAbapFailure(error)) {
        // FM 侧 RAISE：不是传输故障——连接保留，异常名进 exceptions 通道
        const abap = error as { abapMsgClass?: unknown };
        throw new RfcError(
          'RFC_ABAP_EXCEPTION',
          `FM ${request.functionName} raised an ABAP exception: ${errorMessage(error)}`,
          { abapMsgClass: String(abap.abapMsgClass ?? '') }
        );
      }
      throw new RfcTransportError(
        `FM ${request.functionName} transport failure: ${errorMessage(error)}`
      );
    }

    const values: Record<string, unknown> = {};
    const tables: Record<string, readonly unknown[]> = {};
    for (const [key, value] of Object.entries(result ?? {})) {
      if (Array.isArray(value)) {
        tables[key] = value as readonly unknown[];
      } else {
        values[key] = value;
      }
    }
    return {
      functionName: request.functionName,
      values,
      tables,
      exceptions: [],
      durationMs: Date.now() - started
    };
  }

  /** 关闭经典 RFC 连接。 */
  async close(): Promise<void> {
    if (!this.opened) return;
    await this.client.close();
    this.opened = false;
  }

  /** 最近一次成功活动（open 或 call）的 epoch 毫秒。 */
  lastActivity(): number | null {
    return this.lastActivityAt;
  }
}

/** 连接参数推导：由既有 ADT 环境变量组装 RFC 目标（不引入第二套凭据）。 */
export interface AdtDerivedRfcConfig {
  readonly host: string
  readonly client: string
  readonly user: string
  readonly password?: string
  readonly language?: string
  /** RFC 实例号；缺省 '01'（专用 DEV .vsp.json rfc_sysnr 实测值）。 */
  readonly sysnr?: string
}

/** 从 ADT 环境推导 RFC 连接参数（SAP_URL 主机 + 既有凭据 + RFC_SYSNR 覆盖）。 */
export function rfcParamsFromEnvironment(config: AdtDerivedRfcConfig): RfcConnectionParams {
  return normalizeRfcConnectionParams({
    ashost: config.host,
    client: config.client,
    user: config.user,
    password: config.password,
    language: config.language ?? 'EN',
    sysnr: config.sysnr ?? '01'
  });
}
