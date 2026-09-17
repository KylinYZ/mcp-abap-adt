/**
 * RFC 连接参数模型与解析（rfc-transport-spike 阶段 0）。
 *
 * 用途：把调用方提供的「裸」连接参数（unknown）严格校验、归一化为
 * `RfcConnectionParams`，并生成连接池复用所需的确定性 key。
 *
 * 寻址业务规则：
 * - 两种寻址方式二选一：ashost + sysnr（实例号，'00'-'99'，网关端口
 *   约定为 3300+sysnr）或 ashost + port（显式服务端口）。
 * - 两者同时给出时必须一致（port === 3300+sysnr），否则视为配置错误。
 * - client 必须是 3 位十进制（'000'-'999'），这是 SAP 登录的硬性约定。
 * - route 为 SAP Router 路由串（如 '/H/router/S/3299'）的解析模型，
 *   阶段 0 仅做语法建模占位，不做真实路由行为。
 * - 本模块只建模与校验，绝不发起连接（无任何网络 IO）。
 */

import { RfcError } from './errors';

/** SAP Router 路由段类型：H = 主机跳，S = 端口/服务跳，P = 路由口令。 */
export type RfcRouteHopKind = 'H' | 'S' | 'P';

/** 路由串解析出的单个跳点；P 型 value 是敏感口令，展示时必须打码。 */
export interface RfcRouteHop {
  readonly kind: RfcRouteHopKind;
  readonly value: string;
}

/**
 * 归一化后的 RFC 连接参数。
 *
 * 关键变量：
 * - `ashost`：应用服务器主机名/IP；`client`：3 位登录 client。
 * - `sysnr`：2 位实例号；`port`：显式服务端口；二者恰好存在一个
 *   （另一者可由 gatewayPort() 推导，但存储上只保留用户提供的一个）。
 * - `password`：阶段 0 仅建模占位，任何日志/输出路径都必须打码。
 * - `language`：1 位 SAP 语言键或 2 位 ISO 语言码，默认 'EN'。
 * - `route`：可选路由跳点序列（已解析）。
 */
export interface RfcConnectionParams {
  readonly ashost: string;
  readonly client: string;
  readonly user: string;
  readonly password?: string;
  readonly language: string;
  readonly sysnr?: string;
  readonly port?: number;
  readonly route?: readonly RfcRouteHop[];
}

/** 网关端口 = 3300 + 实例号，这是 SAP dispatcher 的固定约定。 */
const GATEWAY_PORT_BASE = 3300;

/* ---------------------------------------------------------------------------
 * 路由串解析（模型占位）
 * ------------------------------------------------------------------------- */

/**
 * 解析 SAP Router 路由串，如 '/H/router1/S/3299/H/innerhost'。
 *
 * 语法规则：以 '/' 开头，按「段类型 + 值」成对出现；支持 H/S/P 三种段；
 * 允许一个结尾 '/'；其余任何形态（空串、缺值、未知段类型、连续 '/'、
 * S 段端口越界）都抛 `RFC_INVALID_CONNECTION_PARAMS`。
 */
export function parseRfcRouteString(route: string): RfcRouteHop[] {
  if (typeof route !== 'string' || route.length === 0 || !route.startsWith('/')) {
    throw invalidConnectionParam('route', 'Route string must start with "/" and be non-empty.');
  }
  if (route.length > 512 || /[\u0000-\u001f\u007f]/.test(route)) {
    throw invalidConnectionParam('route', 'Route string must be at most 512 characters without control characters.');
  }
  // 去掉至多一个结尾 '/' 后按 '/' 切分；空串开头由 startsWith 保证剥离。
  const trimmed = route.endsWith('/') && route.length > 1 ? route.slice(0, -1) : route;
  const segments = trimmed.split('/').slice(1); // 第一段是 startsWith('/') 产生的空串
  if (segments.length === 0 || segments.length % 2 !== 0) {
    throw invalidConnectionParam('route', 'Route string must consist of kind/value pairs, e.g. "/H/host/S/3200".');
  }
  const hops: RfcRouteHop[] = [];
  for (let i = 0; i < segments.length; i += 2) {
    const kind = segments[i];
    const value = segments[i + 1];
    if (kind !== 'H' && kind !== 'S' && kind !== 'P') {
      throw invalidConnectionParam('route', `Unknown route segment kind: "/${kind}".`);
    }
    if (value.length === 0 || value.length > 255) {
      throw invalidConnectionParam('route', `Route segment "/${kind}" needs a value of 1-255 characters.`);
    }
    if (kind === 'S' && !/^[0-9]+$/.test(value)) {
      throw invalidConnectionParam('route', `Route service segment must be numeric: "/S/${value}".`);
    }
    hops.push({ kind, value });
  }
  return hops;
}

/**
 * 把路由跳点序列还原为路由串；P（口令）段统一打码为 '/P/***'，
 * 防止日志与错误信息泄漏口令。
 */
export function formatRfcRouteHops(hops: readonly RfcRouteHop[]): string {
  return hops.map(hop => `/${hop.kind}/${hop.kind === 'P' ? '***' : hop.value}`).join('');
}

/* ---------------------------------------------------------------------------
 * 连接参数校验与归一化
 * ------------------------------------------------------------------------- */

/**
 * 校验并归一化裸连接参数（接受 unknown，适合直连 MCP 入参）。
 *
 * 归一化行为：
 * - client：数字 0-999 或 3 位字符串 → 统一为 3 位字符串（如 12 → '012'）。
 * - sysnr：数字 0-99 或 2 位字符串 → 统一为 2 位字符串（如 0 → '00'）。
 * - language：缺省补 'EN'，统一小写。
 * - route：接受路由串（string）或已解析跳点数组，统一为跳点数组副本。
 * 函数幂等：对已归一化的参数再次调用结果不变。
 */
export function normalizeRfcConnectionParams(raw: unknown): RfcConnectionParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidConnectionParam('params', 'Connection params must be a plain object.');
  }
  const input = raw as Record<string, unknown>;

  const ashost = requireBoundedText(input.ashost, 'ashost', 255);
  const client = normalizeClient(input.client);
  const user = requireBoundedText(input.user, 'user', 128);
  const password = input.password === undefined ? undefined : requireBoundedText(input.password, 'password', 128);
  const language = normalizeLanguage(input.language);

  // sysnr / port 互斥；同时给出时必须语义一致（port === 3300 + sysnr）。
  const sysnr = normalizeSysnr(input.sysnr);
  const port = normalizePort(input.port);
  if (sysnr !== undefined && port !== undefined && port !== GATEWAY_PORT_BASE + Number(sysnr)) {
    throw invalidConnectionParam(
      'port',
      `port (${port}) contradicts sysnr (${sysnr}); the gateway port for sysnr is ${GATEWAY_PORT_BASE + Number(sysnr)}.`
    );
  }
  if (sysnr === undefined && port === undefined) {
    throw invalidConnectionParam('sysnr', 'Either sysnr or port is required for RFC addressing.');
  }

  const route = normalizeRoute(input.route);
  return {
    ashost,
    client,
    user,
    ...(password === undefined ? {} : { password }),
    language,
    ...(sysnr !== undefined ? { sysnr } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(route !== undefined ? { route } : {})
  };
}

/** 返回该连接实际使用的服务端口：显式 port 优先，否则 3300+sysnr。 */
export function gatewayPort(params: RfcConnectionParams): number {
  if (params.port !== undefined) return params.port;
  if (params.sysnr !== undefined) return GATEWAY_PORT_BASE + Number(params.sysnr);
  throw invalidConnectionParam('sysnr', 'Either sysnr or port is required for RFC addressing.');
}

/**
 * 连接池复用 key：由主机、端口、client、用户、语言组成。
 *
 * 业务规则：password 绝不参与 key（凭据不进入日志/内存 key 空间）；
 * 主机名统一小写（DNS 大小写不敏感），其余保持原样。
 */
export function connectionPoolKey(params: RfcConnectionParams): string {
  return [
    params.ashost.toLowerCase(),
    String(gatewayPort(params)),
    params.client,
    params.user,
    params.language
  ].join('|');
}

/**
 * 面向日志的安全摘要：password 一律打码，route 中的 P 段打码。
 * 示例：'vhost:3300/client/100/user/DEVELOP(route=/H/r/S/3299)'
 */
export function formatConnectionTarget(params: RfcConnectionParams): string {
  const routeText = params.route ? `(route=${formatRfcRouteHops(params.route)})` : '';
  return `${params.ashost}:${gatewayPort(params)}/client/${params.client}/user/${params.user}${routeText}`;
}

/* ---------------------------------------------------------------------------
 * 内部校验工具
 * ------------------------------------------------------------------------- */

/**
 * 要求非空、无控制字符且长度受限的文本字段；失败抛 RFC_INVALID_CONNECTION_PARAMS。
 * 业务规则：同时禁止空白字符（\S 取反校验）——主机名/用户名/凭据在 SAP
 * 寻址语义中都不应包含空格，提前拒绝可避免下游拼接连接串时产生歧义。
 */
function requireBoundedText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /\s/.test(value)
  ) {
    throw invalidConnectionParam(field, `${field} must be a non-empty string of at most ${maxLength} characters without whitespace or control characters.`);
  }
  return value;
}

/** client 归一化：接受数字 0-999 或 3 位数字字符串，统一为 3 位字符串。 */
function normalizeClient(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999) {
    return String(value).padStart(3, '0');
  }
  if (typeof value === 'string' && /^[0-9]{3}$/.test(value)) {
    return value;
  }
  throw invalidConnectionParam('client', 'client must be a 3-digit string or an integer 0-999.');
}

/** sysnr 归一化：接受数字 0-99 或 2 位数字字符串，统一为 2 位字符串。 */
function normalizeSysnr(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99) {
    return String(value).padStart(2, '0');
  }
  if (typeof value === 'string' && /^[0-9]{2}$/.test(value)) {
    return value;
  }
  throw invalidConnectionParam('sysnr', 'sysnr must be a 2-digit string or an integer 0-99.');
}

/** port 校验：1-65535 的整数（显式端口允许任意合法端口，如经 SAP Router 映射）。 */
function normalizePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  throw invalidConnectionParam('port', 'port must be an integer between 1 and 65535.');
}

/** language 归一化：1 位 SAP 语言键或 2 位 ISO 码，缺省 'EN'，统一小写。 */
function normalizeLanguage(value: unknown): string {
  if (value === undefined) return 'en';
  if (typeof value === 'string' && /^[A-Za-z]{1,2}$/.test(value)) {
    return value.toLowerCase();
  }
  throw invalidConnectionParam('language', 'language must be a 1-2 letter SAP/ISO language key.');
}

/** route 归一化：接受路由串（现场直传最常见）或已解析的跳点数组。 */
function normalizeRoute(value: unknown): RfcRouteHop[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return parseRfcRouteString(value);
  if (Array.isArray(value)) {
    // 已解析数组：逐项校验形状后复制，避免外部后续篡改影响归一化结果。
    return value.map(hop => {
      if (
        typeof hop !== 'object' ||
        hop === null ||
        !('kind' in hop) ||
        !('value' in hop) ||
        !(['H', 'S', 'P'] as const).includes((hop as { kind: unknown }).kind as 'H' | 'S' | 'P')
      ) {
        throw invalidConnectionParam('route', 'Route hop must be an object with kind (H/S/P) and value.');
      }
      const typed = hop as { kind: RfcRouteHopKind; value: unknown };
      if (typeof typed.value !== 'string' || typed.value.length === 0 || typed.value.length > 255) {
        throw invalidConnectionParam('route', 'Route hop value must be a string of 1-255 characters.');
      }
      return { kind: typed.kind, value: typed.value };
    });
  }
  throw invalidConnectionParam('route', 'route must be a SAP router string or an array of parsed hops.');
}

/** 构造统一的连接参数错误（携带出错字段名，便于上层定位）。 */
function invalidConnectionParam(field: string, message: string): RfcError {
  return new RfcError('RFC_INVALID_CONNECTION_PARAMS', message, { field });
}
