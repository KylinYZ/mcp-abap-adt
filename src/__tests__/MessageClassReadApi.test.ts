import {
  getMessages,
  normalizeMessageClassName,
  normalizeLanguageKey,
  createMessageClassReadClient
} from '../adt/MessageClassReadApi.js';
import type { AdtHTTP } from '../adt/AdtHTTP.js';

/**
 * MessageClassReadApi 只读契约测试（mock AdtHTTP，绝不连接真实 SAP）。
 * 断言四类内容（标注对齐的 VSP 来源）：
 *   1. 请求拼装契约：/sap/bc/adt/messageclass/<小写名>、Accept
 *      vnd.sap.adt.mc.messageclass+xml、可选 sap-language 覆盖（VSP
 *      client.go L1002-1007 / i18n.go L130-135）；
 *   2. 名字与语言键白名单：多级斜杠/超长/空值拒绝，1-2 位语言键放行；
 *   3. XML 解析：mc: 前缀属性按后缀容错匹配、消息号升序、空条目过滤；
 *   4. 客户端绑定。
 */

const MC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core"
  mc:name="ZMC_TEST" mc:description="Test messages" adtcore:type="MSAG/N">
  <mc:messages mc:msgno="002" mc:msgtext="Second message" mc:selfexplainatory="false"/>
  <mc:messages mc:msgno="001" mc:msgtext="First message"/>
  <mc:messages mc:msgno="003" mc:msgtext=""/>
</mc:messageClass>`;

/** 构造记录型 AdtHTTP mock：按路由返回响应体。 */
function httpMock(body: string) {
  const calls: Array<{ url: string; opts: any }> = [];
  const request = jest.fn(async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    return { body };
  });
  return { request, calls } as unknown as AdtHTTP & { calls: Array<{ url: string; opts: any }> };
}

describe('getMessages (VSP GetMessageClass port)', () => {
  it('requests the messageclass resource with the ADT accept type and parses entries', async () => {
    const http = httpMock(MC_XML);
    const result = await getMessages(http, { messageClass: ' zmc_test ' });
    expect(http.calls[0].url).toBe('/sap/bc/adt/messageclass/zmc_test');
    expect(http.calls[0].opts.headers.Accept).toBe('application/vnd.sap.adt.mc.messageclass+xml');
    expect(http.calls[0].opts.qs).toEqual({});
    expect(result.messageClass).toBe('ZMC_TEST');
    expect(result.description).toBe('Test messages');
    // 消息号升序；空文本条目（003 无文本且被过滤规则保留 number）计入
    expect(result.messages.map(m => m.number)).toEqual(['001', '002', '003']);
    expect(result.messages[0].text).toBe('First message');
    expect(result.count).toBe(3);
    expect(result.language).toBeUndefined();
  });

  it('passes the sap-language override when a language key is given', async () => {
    const http = httpMock(MC_XML);
    const result = await getMessages(http, { messageClass: 'ZMC_TEST', language: 'de' });
    expect(http.calls[0].opts.qs).toEqual({ 'sap-language': 'DE' });
    expect(result.language).toBe('DE');
  });

  it('rejects malformed names and language keys before any request', async () => {
    const http = httpMock(MC_XML);
    await expect(getMessages(http, { messageClass: 'A/B/C' })).rejects.toThrow(/not a message class name/);
    await expect(getMessages(http, { messageClass: "Z';--" })).rejects.toThrow(/not a message class name/);
    await expect(getMessages(http, { messageClass: 'ZMC', language: 'GER' })).rejects.toThrow(/language key/);
    expect(http.calls).toHaveLength(0);
  });

  it('returns an empty message list for a class without entries', async () => {
    const http = httpMock('<mc:messageClass mc:name="ZEMPTY" mc:description=""/>');
    const result = await getMessages(http, { messageClass: 'ZEMPTY' });
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });
});

describe('input normalization guards', () => {
  it('normalizeMessageClassName upper-cases, allows one-level namespaces', () => {
    expect(normalizeMessageClassName(' zmc_01 ', 'x')).toBe('ZMC_01');
    expect(normalizeMessageClassName('/ns/name', 'x')).toBe('/NS/NAME');
    expect(() => normalizeMessageClassName('', 'x')).toThrow();
    expect(() => normalizeMessageClassName('NAME/EXTRA/PLUS', 'x')).toThrow();
    expect(() => normalizeMessageClassName('x'.repeat(21), 'x')).toThrow();
  });

  it('normalizeLanguageKey accepts 1-2 letters only', () => {
    expect(normalizeLanguageKey('en', 'x')).toBe('EN');
    expect(normalizeLanguageKey('D', 'x')).toBe('D');
    expect(() => normalizeLanguageKey('CHN', 'x')).toThrow();
    expect(() => normalizeLanguageKey('1', 'x')).toThrow();
  });
});

describe('createMessageClassReadClient binding', () => {
  it('exposes getMessages over the injected session', async () => {
    const http = httpMock(MC_XML);
    const client = createMessageClassReadClient(http);
    const result = await client.getMessages({ messageClass: 'ZMC_TEST' });
    expect(result.count).toBe(3);
  });
});
