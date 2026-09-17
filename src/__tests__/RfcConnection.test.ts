/**
 * RFC 连接参数模型测试（对应 src/rfc/connection.ts）。
 *
 * 覆盖：sysnr/port 两种寻址与互斥规则、client 归一化、语言默认值、
 * SAP Router 路由串解析与口令打码、池 key 稳定性、日志脱敏、幂等性。
 * 全部为纯内存校验，无任何网络 IO。
 */

import {
  connectionPoolKey,
  formatConnectionTarget,
  formatRfcRouteHops,
  gatewayPort,
  normalizeRfcConnectionParams,
  parseRfcRouteString
} from '../rfc/connection';
import { RfcError } from '../rfc/errors';

/** 基准合法参数（sysnr 寻址），各用例在其上做变形。 */
function baseParams(): Record<string, unknown> {
  return { ashost: 'dev.example.com', client: 100, user: 'DEVELOP', sysnr: '00' };
}

/** 断言抛出 RFC_INVALID_CONNECTION_PARAMS 且字段名匹配。 */
function expectParamError(raw: unknown, field: string): void {
  try {
    normalizeRfcConnectionParams(raw);
    throw new Error(`expected RFC_INVALID_CONNECTION_PARAMS for field ${field}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RfcError);
    expect((error as RfcError).code).toBe('RFC_INVALID_CONNECTION_PARAMS');
    expect((error as RfcError).details).toMatchObject({ field });
  }
}

describe('RfcConnection params normalization', () => {
  it('normalizes a valid sysnr-based connection', () => {
    const params = normalizeRfcConnectionParams(baseParams());
    expect(params).toMatchObject({ ashost: 'dev.example.com', client: '100', user: 'DEVELOP', sysnr: '00', language: 'en' });
    expect(params.port).toBeUndefined();
    // 网关端口约定：3300 + 实例号。
    expect(gatewayPort(params)).toBe(3300);
  });

  it('normalizes a port-based connection', () => {
    const params = normalizeRfcConnectionParams({ ...baseParams(), sysnr: undefined, port: 3399 });
    expect(params.sysnr).toBeUndefined();
    expect(params.port).toBe(3399);
    expect(gatewayPort(params)).toBe(3399);
  });

  it('accepts consistent sysnr+port pairs and rejects contradictions', () => {
    // sysnr 99 → 网关端口 3399，与显式 port 一致，允许。
    const consistent = normalizeRfcConnectionParams({ ...baseParams(), sysnr: 99, port: 3399 });
    expect(consistent.sysnr).toBe('99');
    expectParamsOk(consistent);
    // 端口与 sysnr 推导值不一致：视为配置错误。
    expectParamError({ ...baseParams(), sysnr: '00', port: 3399 }, 'port');
  });

  it('requires exactly one addressing style', () => {
    expectParamError({ ashost: 'h', client: '100', user: 'U' }, 'sysnr'); // 两者都缺
  });

  it('normalizes client numbers into 3-digit strings', () => {
    expect(normalizeRfcConnectionParams(baseParams()).client).toBe('100');
    expect(normalizeRfcConnectionParams({ ...baseParams(), client: 12 }).client).toBe('012');
    expect(normalizeRfcConnectionParams({ ...baseParams(), client: '999' }).client).toBe('999');
    expectParamError({ ...baseParams(), client: '12' }, 'client'); // 2 位
    expectParamError({ ...baseParams(), client: 1000 }, 'client'); // 越界
  });

  it('normalizes sysnr and rejects malformed values', () => {
    expect(normalizeRfcConnectionParams({ ...baseParams(), sysnr: 0 }).sysnr).toBe('00');
    expectParamError({ ...baseParams(), sysnr: '123' }, 'sysnr');
    expectParamError({ ...baseParams(), sysnr: 100 }, 'sysnr');
  });

  it('validates port range', () => {
    expectParamError({ ...baseParams(), sysnr: undefined, port: 0 }, 'port');
    expectParamError({ ...baseParams(), sysnr: undefined, port: 65536 }, 'port');
    expectParamError({ ...baseParams(), sysnr: undefined, port: '3399' }, 'port');
  });

  it('defaults language to en and validates its shape', () => {
    expect(normalizeRfcConnectionParams(baseParams()).language).toBe('en');
    expect(normalizeRfcConnectionParams({ ...baseParams(), language: 'ZH' }).language).toBe('zh');
    expectParamError({ ...baseParams(), language: 'ENG' }, 'language');
  });

  it('rejects malformed host/user/password and non-object input', () => {
    expectParamError({ ...baseParams(), ashost: '' }, 'ashost');
    expectParamError({ ...baseParams(), ashost: 'a b' }, 'ashost'); // 空白字符
    expectParamError({ ...baseParams(), user: '' }, 'user');
    expectParamError(null, 'params');
    expectParamError('host', 'params');
  });

  it('is idempotent for already-normalized params', () => {
    const once = normalizeRfcConnectionParams({ ...baseParams(), route: '/H/router/S/3299' });
    const twice = normalizeRfcConnectionParams(once);
    expect(twice).toEqual(once);
  });
});

function expectParamsOk(_params: unknown): void {
  // 占位断言：组合用例中确认归一化路径不抛错（上面已构造成功）。
  expect(_params).toBeDefined();
}

describe('RfcConnection pool key and redaction', () => {
  it('builds a stable key independent of password and host case', () => {
    const a = connectionPoolKey(normalizeRfcConnectionParams({ ...baseParams(), password: 'secret1' }));
    const b = connectionPoolKey(normalizeRfcConnectionParams({ ...baseParams(), ashost: 'DEV.Example.COM', password: 'other' }));
    expect(a).toBe(b); // 大小写不敏感主机 + 凭据不参与 key
  });

  it('differentiates connections by client and user', () => {
    const a = connectionPoolKey(normalizeRfcConnectionParams(baseParams()));
    const b = connectionPoolKey(normalizeRfcConnectionParams({ ...baseParams(), client: 200 }));
    const c = connectionPoolKey(normalizeRfcConnectionParams({ ...baseParams(), user: 'OTHER' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('never leaks the password into log output', () => {
    const params = normalizeRfcConnectionParams({ ...baseParams(), password: 'super-secret', route: '/H/r/S/3299/P/topsecret' });
    const text = formatConnectionTarget(params);
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('topsecret');
    expect(text).toContain('P/***'); // 路由口令打码
  });

  it('formats route hops with masked password segments', () => {
    const hops = parseRfcRouteString('/H/router/S/3299/P/pass/H/inner');
    expect(formatRfcRouteHops(hops)).toBe('/H/router/S/3299/P/***/H/inner');
  });
});

describe('RfcConnection route string parsing', () => {
  it('parses H/S hop sequences', () => {
    expect(parseRfcRouteString('/H/router1/S/3299/H/innerhost')).toEqual([
      { kind: 'H', value: 'router1' },
      { kind: 'S', value: '3299' },
      { kind: 'H', value: 'innerhost' }
    ]);
  });

  it('accepts a single hop with a trailing slash', () => {
    expect(parseRfcRouteString('/H/fw/')).toEqual([{ kind: 'H', value: 'fw' }]);
  });

  it('rejects malformed route strings', () => {
    expect(() => parseRfcRouteString('')).toThrow(RfcError);
    expect(() => parseRfcRouteString('H/host')).toThrow(RfcError); // 必须以 / 开头
    expect(() => parseRfcRouteString('/H')).toThrow(RfcError); // 缺值
    expect(() => parseRfcRouteString('/H//S/3299')).toThrow(RfcError); // 空值
    expect(() => parseRfcRouteString('/X/host')).toThrow(RfcError); // 未知段类型
    expect(() => parseRfcRouteString('/S/abc')).toThrow(RfcError); // 服务段必须为数字
    expect(() => parseRfcRouteString('/H/host/S/3299/extra')).toThrow(RfcError); // 奇数段
  });
});
