import {
  ui5ListApps,
  ui5GetApp,
  ui5GetFileContent,
  normalizeUi5AppName,
  normalizeUi5FilePath,
  createUi5FilestoreClient
} from '../adt/Ui5FilestoreApi.js';
import type { AdtHTTP } from '../adt/AdtHTTP.js';

/**
 * Ui5FilestoreApi 只读契约测试（mock AdtHTTP 请求通道，绝不连接真实 SAP）。
 * 断言五类内容（各段标注对齐的 VSP 来源）：
 *   1. 请求拼装契约：三个 filestore GET 端点路径、qs、Accept 头逐字对齐
 *      VSP pkg/adt/ui5.go（L98-108 列表 / L140-148 文件树 / L267-270 文件内容，
 *      应用+路径合并后整体转义，斜杠编码为 %2f）；
 *   2. 注入与穿越防线：应用名白名单、'..' 段 / 查询串 / 反斜杠拒绝，全部在
 *      请求发出之前；
 *   3. Atom 解析：条目标题/摘要/category term 提取、带属性文本容错；
 *   4. 客户端通配符过滤与 maxResults 截断（系统忽略 name 参数的行为增强）；
 *   5. 文件树路径推导（剥 <APP>/ 前缀、补 leading /）与排序。
 */

/** 构造记录型 AdtHTTP mock：按注册的路由返回响应体。 */
function httpMock(routes: Array<{ match: (url: string, opts: any) => boolean; body: string }>) {
  const calls: Array<{ url: string; opts: any }> = [];
  const request = jest.fn(async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    const route = routes.find(r => r.match(url, opts));
    if (!route) throw new Error(`unexpected request: ${url}`);
    return { body: route.body };
  });
  return { request, calls } as unknown as AdtHTTP & { calls: Array<{ url: string; opts: any }> };
}

// Atom feed 样例（结构与 2026-09-17 专用 DEV 实测一致：atom: 前缀 + 带属性 summary）
const LIST_FEED = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xml:base="/sap/bc/adt/filestore/ui5-bsp/objects/" xmlns:atom="http://www.w3.org/2005/Atom">
<atom:entry><atom:category term="folder"/><atom:id>%2fSAM4U%2fDASHBRD</atom:id><atom:summary type="text">Software Asset Management</atom:summary><atom:title>/SAM4U/DASHBRD</atom:title></atom:entry>
<atom:entry><atom:category term="folder"/><atom:id>ZAPP_SIMPLE</atom:id><atom:summary type="text">Own test app</atom:summary><atom:title>ZAPP_SIMPLE</atom:title></atom:entry>
</atom:feed>`;

const APP_CONTENT_FEED = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
<atom:entry><atom:category term="file"/><atom:title>ZAPP_SIMPLE/.project</atom:title></atom:entry>
<atom:entry><atom:category term="folder"/><atom:title>ZAPP_SIMPLE/WebContent</atom:title></atom:entry>
<atom:entry><atom:category term="file"/><atom:title>ZAPP_SIMPLE/WebContent/index.html</atom:title></atom:entry>
</atom:feed>`;

describe('ui5ListApps (VSP ui5.go L90-131 port)', () => {
  it('requests the filestore base with maxResults and atom accept, parses entries', async () => {
    const http = httpMock([{ match: url => url.startsWith('/sap/bc/adt/filestore/ui5-bsp/objects'), body: LIST_FEED }]);
    const result = await ui5ListApps(http, {});
    expect(http.calls[0].url).toBe('/sap/bc/adt/filestore/ui5-bsp/objects');
    expect(http.calls[0].opts.qs).toEqual({ maxResults: 100 });
    expect(http.calls[0].opts.headers.Accept).toBe('application/atom+xml');
    expect(result.feedEntries).toBe(2);
    expect(result.apps).toEqual([
      { name: '/SAM4U/DASHBRD', description: 'Software Asset Management', uri: '%2fSAM4U%2fDASHBRD', type: 'folder' },
      { name: 'ZAPP_SIMPLE', description: 'Own test app', uri: 'ZAPP_SIMPLE', type: 'folder' }
    ]);
    expect(result.truncated).toBe(false);
  });

  it('sends the name parameter and applies client-side wildcard filtering', async () => {
    const http = httpMock([{ match: () => true, body: LIST_FEED }]);
    const result = await ui5ListApps(http, { query: 'ZAPP*', maxResults: 10 });
    // name 参数照传（对齐 VSP）；系统忽略时客户端过滤兜底
    expect(http.calls[0].opts.qs).toEqual({ maxResults: 10, name: 'ZAPP*' });
    expect(result.apps.map(a => a.name)).toEqual(['ZAPP_SIMPLE']);
    expect(result.query).toBe('ZAPP*');
  });

  it('truncates to maxResults and flags it', async () => {
    const http = httpMock([{ match: () => true, body: LIST_FEED }]);
    const result = await ui5ListApps(http, { maxResults: 1 });
    expect(result.apps).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe('ui5GetApp (VSP ui5.go L134-197 port)', () => {
  it('requests <APP>/content and derives file paths from entry titles', async () => {
    const http = httpMock([{ match: url => url.includes('/ZAPP_SIMPLE/content'), body: APP_CONTENT_FEED }]);
    const result = await ui5GetApp(http, { appName: ' zapp_simple ' });
    expect(http.calls[0].url).toBe('/sap/bc/adt/filestore/ui5-bsp/objects/ZAPP_SIMPLE/content');
    expect(http.calls[0].opts.headers.Accept).toBe('application/atom+xml');
    expect(result.appName).toBe('ZAPP_SIMPLE');
    expect(result.files.map(f => `${f.type}:${f.path}`)).toEqual([
      'file:/.project',
      'folder:/WebContent',
      'file:/WebContent/index.html'
    ]);
  });

  it('rejects traversal and malformed app names before any request', async () => {
    const http = httpMock([]);
    await expect(ui5GetApp(http, { appName: "ZAPP';--" })).rejects.toThrow(/not a UI5 BSP application name/);
    await expect(ui5GetApp(http, { appName: 'A/B/C' })).rejects.toThrow(/not a UI5 BSP application name/);
    expect(http.calls).toHaveLength(0);
  });
});

describe('ui5GetFileContent (VSP ui5.go L246-273 port)', () => {
  it('combines app + path, escapes slashes, and returns raw content', async () => {
    const http = httpMock([{ match: url => url.includes('%2F'), body: '<project/> contents' }]);
    const result = await ui5GetFileContent(http, { appName: 'ZAPP_SIMPLE', filePath: '/WebContent/index.html' });
    // 整体路径转义：斜杠编码为 %2F（对齐 Go url.PathEscape 语义）
    expect(http.calls[0].url).toBe('/sap/bc/adt/filestore/ui5-bsp/objects/ZAPP_SIMPLE%2FWebContent%2Findex.html/content');
    expect(result.content).toBe('<project/> contents');
    expect(result.size).toBeGreaterThan(0);
    expect(result.filePath).toBe('WebContent/index.html');
  });

  it('rejects path traversal segments before any request', async () => {
    const http = httpMock([]);
    await expect(ui5GetFileContent(http, { appName: 'ZAPP', filePath: '../../etc/passwd' }))
      .rejects.toThrow(/path traversal/);
    await expect(ui5GetFileContent(http, { appName: 'ZAPP', filePath: 'a?b=c' }))
      .rejects.toThrow(/outside/);
    expect(http.calls).toHaveLength(0);
  });
});

describe('input normalization guards', () => {
  it('normalizeUi5AppName upper-cases and whitelists', () => {
    expect(normalizeUi5AppName(' zapp_01 ', 'x')).toBe('ZAPP_01');
    expect(normalizeUi5AppName('/ns/app', 'x')).toBe('/NS/APP');
    expect(() => normalizeUi5AppName('', 'x')).toThrow();
    expect(() => normalizeUi5AppName('A B', 'x')).toThrow();
    expect(() => normalizeUi5AppName('A%2FB', 'x')).toThrow();
  });

  it('normalizeUi5FilePath strips leading slashes and rejects traversal', () => {
    expect(normalizeUi5FilePath('/WebContent/i.html', 'x')).toBe('WebContent/i.html');
    expect(normalizeUi5FilePath('.project', 'x')).toBe('.project');
    expect(() => normalizeUi5FilePath('a/../b', 'x')).toThrow(/traversal/);
    expect(() => normalizeUi5FilePath('..', 'x')).toThrow(/traversal/);
    expect(() => normalizeUi5FilePath('a\\b', 'x')).toThrow(/outside/);
  });
});

describe('createUi5FilestoreClient binding', () => {
  it('binds the three capabilities onto one client', async () => {
    const http = httpMock([
      { match: url => url.includes('/content'), body: APP_CONTENT_FEED },
      { match: () => true, body: LIST_FEED }
    ]);
    const client = createUi5FilestoreClient(http);
    const list = await client.ui5ListApps({});
    const app = await client.ui5GetApp({ appName: 'ZAPP_SIMPLE' });
    expect(list.apps).toHaveLength(2);
    expect(app.files).toHaveLength(3);
  });
});
