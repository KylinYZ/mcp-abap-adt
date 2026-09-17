import { createI18nReadClient, getTextPoolInLanguage } from '../adt/I18nReadApi.js';
import type { I18nAdtCapability } from '../adt/I18nReadApi.js';

/**
 * I18nReadApi 只读契约测试（mock 请求通道，绝不连接真实 SAP）。
 * 断言三类内容（标注对齐的 VSP 来源）：
 *   1. 请求拼装契约：sap-language 覆盖、数据元素 v2 词汇 Accept（406 教训，
 *      VSP i18n.go L92-99）、文本池三个子资源与各自的 v1 Accept；
 *   2. 文本池解析：key=value 行、@ 指令跳过、空文本保留、子资源 404 容错
 *      记入 missing（VSP L303-312）；
 *   3. 语言对比：按行键对齐、只返回差异/缺失条目；源 URL 服务端解析。
 */

// 文本池子资源响应（key=value + @MaxLength 指令 + 空值保留）
const SYMBOLS = '@MaxLength:8\nTXT_HELLO=Hello world\nTXT_EMPTY=';
const SELECTIONS = 'P_CARRID=Carrier';

type RecordedCall = { url: string; opts: Record<string, any> };

function httpMock(options: { notFoundSubs?: string[] } = {}): { calls: RecordedCall[]; request: any } {
  const calls: RecordedCall[] = [];
  const request = async (url: string, opts: Record<string, any> = {}) => {
    calls.push({ url, opts });
    if (url.includes('/dataelements/')) {
      return {
        body: '<wbobj name="ZDE_TEST" type="DTEL/DE"><dataElement><shortFieldLabel>Short lbl</shortFieldLabel><mediumFieldLabel>Medium lbl</mediumFieldLabel><longFieldLabel>Long lbl</longFieldLabel><headingFieldLabel>Heading lbl</headingFieldLabel></dataElement></wbobj>'
      };
    }
    for (const sub of ['symbols', 'selections', 'headings']) {
      if (url.includes(`/source/${sub}`)) {
        if (options.notFoundSubs?.includes(sub)) {
          throw Object.assign(new Error('Not found'), { status: 404 });
        }
        const bodies: Record<string, string> = { symbols: SYMBOLS, selections: SELECTIONS, headings: '' };
        return { body: bodies[sub] };
      }
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, request };
}

/** 构造带对象解析链的 i18n 能力 mock（sourceBodies 按 sap-language 差异化）。 */
function capabilityMock(sourceBodies: Record<string, string>): I18nAdtCapability {
  return {
    searchObject: jest.fn(async () => [
      { 'adtcore:name': 'ZPROG', 'adtcore:type': 'PROG/P', 'adtcore:uri': '/sap/bc/adt/programs/programs/zprog' }
    ]),
    objectStructure: jest.fn(async () => ({
      metaData: {},
      includes: [{ 'class:includeType': 'main', 'abapsource:sourceUri': 'source/main' }]
    })),
    httpClient: {
      request: jest.fn(async (url: string, opts: Record<string, any> = {}) => {
        const lang = opts.qs?.['sap-language'] ?? '';
        if (url === '/sap/bc/adt/programs/programs/zprog/source/main') {
          return { body: sourceBodies[lang] ?? 'MISSING' };
        }
        if (url.startsWith('/sap/bc/adt/ddic/dataelements/')) {
          return {
            body: '<wbobj name="ZDE_TEST" type="DTEL/DE"><dataElement><shortFieldLabel>Short lbl</shortFieldLabel><mediumFieldLabel>Medium lbl</mediumFieldLabel><longFieldLabel>Long lbl</longFieldLabel><headingFieldLabel>Heading lbl</headingFieldLabel></dataElement></wbobj>'
          };
        }
        throw new Error(`unexpected request: ${url}`);
      })
    }
  };
}

describe('getTextPoolInLanguage (VSP GetTextPoolInLanguage port)', () => {
  it('reads three sub-resources with per-kind Accept and parses key=value entries', async () => {
    const http = httpMock();
    const result = await getTextPoolInLanguage(http as any, { program: ' zprog ', language: 'en' });
    // 三个子资源各自携带自己的 v1 Accept 与 sap-language 覆盖
    for (const sub of ['symbols', 'selections', 'headings']) {
      const call = http.calls.find(c => c.url.includes(`/source/${sub}`));
      expect(call).toBeDefined();
      expect(call!.opts.headers.Accept).toBe(`application/vnd.sap.adt.textelements.${sub}.v1`);
      expect(call!.opts.qs['sap-language']).toBe('EN');
    }
    expect(result.missing).toEqual([]);
    // @MaxLength 指令跳过；空值保留；按 I/S/H 分类
    expect(result.entries).toEqual([
      { id: 'I', key: 'TXT_HELLO', text: 'Hello world' },
      { id: 'I', key: 'TXT_EMPTY', text: '' },
      { id: 'S', key: 'P_CARRID', text: 'Carrier' }
    ]);
    expect(result.program).toBe('ZPROG');
    expect(result.language).toBe('EN');
  });

  it('treats per-sub-resource 404 as missing instead of failing (VSP L303-312)', async () => {
    const http = httpMock({ notFoundSubs: ['selections', 'headings'] });
    const result = await getTextPoolInLanguage(http as any, { program: 'ZPROG', language: 'EN' });
    expect(result.missing).toEqual(['selections', 'headings']);
    // symbols 仍正常解析（TXT_HELLO/TXT_EMPTY 两条 I 类条目）
    expect(result.entries.map(e => e.id)).toEqual(['I', 'I']);
  });

  it('rejects malformed program names and language keys', async () => {
    const http = httpMock();
    await expect(getTextPoolInLanguage(http as any, { program: "Z';--", language: 'EN' })).rejects.toThrow(/not a valid repository name/);
    await expect(getTextPoolInLanguage(http as any, { program: 'ZPROG', language: 'CHN' })).rejects.toThrow(/language key/);
  });
});

describe('createI18nReadClient (four read-only capabilities)', () => {
  it('resolves the source URL server-side for language reads', async () => {
    const cap = capabilityMock({ DE: 'REPORT zprog.\nWRITE 1.' });
    const client = createI18nReadClient(cap);
    const result = await client.getObjectContentInLanguage({ objectType: 'PROG', objectName: 'zprog', language: 'DE' });
    expect(result.language).toBe('DE');
    expect(result.content).toContain('REPORT zprog.');
    // 解析链：源 GET 的 URL 由 searchObject+objectStructure 推导
    const sourceCall = (cap.httpClient.request as jest.Mock).mock.calls.find(c => c[0] === '/sap/bc/adt/programs/programs/zprog/source/main');
    expect(sourceCall).toBeDefined();
    expect(sourceCall[1].qs['sap-language']).toBe('DE');
  });

  it('compares two languages and returns only differing or missing lines', async () => {
    const cap = capabilityMock({
      EN: 'REPORT zprog.\nWRITE 1.\nWRITE 2.',
      DE: 'REPORT zprog.\nWRITE 1.\nWRITE 3.'
    });
    const client = createI18nReadClient(cap);
    const result = await client.compareObjectLanguages({
      objectType: 'PROG', objectName: 'ZPROG', sourceLanguage: 'EN', targetLanguage: 'DE'
    });
    expect(result.differing).toBe(1);
    expect(result.totalLines).toBe(3);
    expect(result.entries).toEqual([{ key: 'line-3', sourceText: 'WRITE 2.', targetText: 'WRITE 3.' }]);
  });

  it('reads data element labels with the versioned vocabulary type', async () => {
    const cap = capabilityMock({});
    const client = createI18nReadClient(cap);
    const result = await client.getDataElementLabels({ dataElement: 'zde_test', language: 'DE' });
    const requestMock = cap.httpClient.request as jest.Mock;
    expect(requestMock.mock.calls[0][0]).toBe('/sap/bc/adt/ddic/dataelements/ZDE_TEST');
    expect(requestMock.mock.calls[0][1].headers.Accept).toBe('application/vnd.sap.adt.dataelements.v2+xml');
    expect(requestMock.mock.calls[0][1].qs['sap-language']).toBe('DE');
    expect(result.labels).toEqual({ short: 'Short lbl', medium: 'Medium lbl', long: 'Long lbl', heading: 'Heading lbl' });
  });
});
