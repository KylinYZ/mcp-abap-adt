import {
  grepPackage,
  grepObjects,
  createSourceGrepClient,
  isSourceObjectType,
  matchesTypeFilter,
  sourceReadUrl
} from '../adt/SourceGrepApi.js';
import type { AdtHTTP } from '../adt/AdtHTTP.js';

/**
 * SourceGrepApi 只读契约测试（mock HTTP 层，绝不连接真实 SAP）。
 * 覆盖对齐 VSP workflows_grep.go（GrepPackage/GrepObjects/GrepObject）的语义：
 *   1. 请求契约：包枚举 nodestructure 端点、逐对象源码 GET（text/plain、
 *      /source/main 规则、DDLS 直接读对象 URI）；
 *   2. 匹配语义：逐行正则、大小写开关、上下文行、行截断、单对象命中上限；
 *   3. 有界与容错：非源码对象/子包过滤、objectTypes 过滤、枚举 200 上限、
 *      maxResults 截断、单对象读取失败聚合进 skipped、正则非法友好失败。
 */

/** 包内容枚举（nodestructure）的真实感响应：2 个源码命中对象 + 表 + 子包 + CDS 源 */
const PACKAGE_TREE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <TREE_CONTENT>
        <SEU_ADT_REPOSITORY_OBJ_NODE>
          <OBJECT_TYPE>PROG/P</OBJECT_TYPE>
          <OBJECT_NAME>ZREP_HIT</OBJECT_NAME>
          <OBJECT_URI>/sap/bc/adt/programs/programs/zrep_hit</OBJECT_URI>
          <DESCRIPTION>hit report</DESCRIPTION>
        </SEU_ADT_REPOSITORY_OBJ_NODE>
        <SEU_ADT_REPOSITORY_OBJ_NODE>
          <OBJECT_TYPE>CLAS/OC</OBJECT_TYPE>
          <OBJECT_NAME>ZCL_HIT</OBJECT_NAME>
          <OBJECT_URI>/sap/bc/adt/oo/classes/zcl_hit</OBJECT_URI>
        </SEU_ADT_REPOSITORY_OBJ_NODE>
        <SEU_ADT_REPOSITORY_OBJ_NODE>
          <OBJECT_TYPE>TABL/DT</OBJECT_TYPE>
          <OBJECT_NAME>ZTAB</OBJECT_NAME>
          <OBJECT_URI>/sap/bc/adt/ddic/tables/ztab</OBJECT_URI>
        </SEU_ADT_REPOSITORY_OBJ_NODE>
        <SEU_ADT_REPOSITORY_OBJ_NODE>
          <OBJECT_TYPE>DEVC/K</OBJECT_TYPE>
          <OBJECT_NAME>ZSUB</OBJECT_NAME>
          <OBJECT_URI>/sap/bc/adt/packages/zsub</OBJECT_URI>
        </SEU_ADT_REPOSITORY_OBJ_NODE>
        <SEU_ADT_REPOSITORY_OBJ_NODE>
          <OBJECT_TYPE>DDLS/DDLS</OBJECT_TYPE>
          <OBJECT_NAME>ZDDL_HIT</OBJECT_NAME>
          <OBJECT_URI>/sap/bc/adt/ddic/ddl/sources/zddl_hit</OBJECT_URI>
        </SEU_ADT_REPOSITORY_OBJ_NODE>
      </TREE_CONTENT>
    </DATA>
  </asx:values>
</asx:abap>`;

// 各对象的模拟源码（\n 分行；ZREP_HIT 第 2/3 行、ZCL_HIT 第 2 行含 counter）
const SOURCE_ZREP = 'REPORT zrep_hit.\nDATA lv_counter TYPE i.\nWRITE lv_counter.\n';
const SOURCE_ZCL = 'CLASS zcl_hit DEFINITION.\n  DATA mv_counter TYPE i.\nENDCLASS.\n';
const SOURCE_ZDDL = `@EndUserText.label: 'Hit'\ndefine view ZDDL_HIT as select from ztab { key a }\n`;

/**
 * 构造按 URL 前缀分发的 AdtHTTP 假会话：
 * - key 为 URL 前缀（源码请求会带 /source/main 后缀，前缀匹配即可命中）；
 * - value 为响应文本，或 Error（模拟该对象源码读取失败）；
 * - 未命中任何前缀时抛 unexpected request，防止测试遗漏契约。
 */
function http(routes: Record<string, string | Error>): AdtHTTP {
  const sortedEntries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return {
    request: jest.fn(async (url: string) => {
      for (const [prefix, value] of sortedEntries) {
        if (url === prefix || url.startsWith(prefix)) {
          if (value instanceof Error) throw value;
          return { body: value, status: 200, headers: {} };
        }
      }
      throw new Error(`unexpected request: ${url}`);
    })
  } as unknown as AdtHTTP;
}

/** 默认包路由：nodestructure + 三个源码对象的源码。 */
function packageHttp(): AdtHTTP {
  return http({
    '/sap/bc/adt/repository/nodestructure': PACKAGE_TREE_XML,
    '/sap/bc/adt/programs/programs/zrep_hit': SOURCE_ZREP,
    '/sap/bc/adt/oo/classes/zcl_hit': SOURCE_ZCL,
    '/sap/bc/adt/ddic/ddl/sources/zddl_hit': SOURCE_ZDDL
  });
}

describe('SourceGrepApi grepPackage (read-only package content grep)', () => {
  it('enumerates the package, reads only source objects and returns trimmed hits', async () => {
    const client = packageHttp();
    const result = await grepPackage(client, { packageName: ' zpkg ', pattern: 'counter' });

    // 请求契约 1：包枚举对齐 VSP GetPackage（POST nodestructure + DEVC/K 查询参数）
    const calls = (client.request as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe('/sap/bc/adt/repository/nodestructure');
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].qs).toEqual({ parent_type: 'DEVC/K', parent_name: 'ZPKG', withShortDescriptions: true });

    // 请求契约 2：源码读取为 GET + Accept text/plain；ABAP 对象追加 /source/main
    const sourceCalls = calls.slice(1);
    expect(sourceCalls).toHaveLength(3); // 表与子包被过滤，不发起请求
    expect(sourceCalls.map(call => call[0])).toEqual([
      '/sap/bc/adt/programs/programs/zrep_hit/source/main',
      '/sap/bc/adt/oo/classes/zcl_hit/source/main',
      '/sap/bc/adt/ddic/ddl/sources/zddl_hit' // DDLS 源码挂在对象 URI 本身
    ]);
    expect(sourceCalls[0][1]).toEqual({ method: 'GET', headers: { Accept: 'text/plain' } });

    // 精简结果：只含有匹配的对象；行号 1 起始；聚合口径对齐 VSP
    expect(result.scope).toBe('package');
    expect(result.packageName).toBe('ZPKG'); // 输入含空白仍被规范化为大写
    expect(result.objects).toEqual([
      {
        objectName: 'ZREP_HIT',
        objectType: 'PROG/P',
        objectUri: '/sap/bc/adt/programs/programs/zrep_hit',
        matchCount: 2,
        matches: [
          { lineNumber: 2, matchedLine: 'DATA lv_counter TYPE i.' },
          { lineNumber: 3, matchedLine: 'WRITE lv_counter.' }
        ]
      },
      {
        objectName: 'ZCL_HIT',
        objectType: 'CLAS/OC',
        objectUri: '/sap/bc/adt/oo/classes/zcl_hit',
        matchCount: 1,
        matches: [{ lineNumber: 2, matchedLine: '  DATA mv_counter TYPE i.' }]
      }
    ]);
    expect(result.totalMatches).toBe(3);
    expect(result.searchedObjects).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.message).toBe('Found 3 match(es) across 2 object(s) in package ZPKG');
  });

  it('honors caseInsensitive for the pattern compilation', async () => {
    const client = packageHttp();

    // 大写 pattern 默认区分大小写：源码里全是小写，应零命中
    const sensitive = await grepPackage(client, { packageName: 'ZPKG', pattern: 'COUNTER' });
    expect(sensitive.totalMatches).toBe(0);
    expect(sensitive.message).toBe('No matches found in package ZPKG');

    // caseInsensitive=true 等价 VSP 的 "(?i)" 前缀：命中全部 3 行 counter
    //（ZREP_HIT 两行 + ZCL_HIT 一行；mv_counter 同样以 counter 子串命中）
    const insensitive = await grepPackage(client, {
      packageName: 'ZPKG',
      pattern: 'COUNTER',
      caseInsensitive: true
    });
    expect(insensitive.caseInsensitive).toBe(true);
    expect(insensitive.totalMatches).toBe(3);
    expect(insensitive.objects).toHaveLength(2);
  });

  it('attaches bounded context lines around each match', async () => {
    const client = http({
      '/sap/bc/adt/repository/nodestructure': PACKAGE_TREE_XML,
      '/sap/bc/adt/programs/programs/zrep_hit': 'a\nb\nc\nd\ne\n',
      '/sap/bc/adt/oo/classes/zcl_hit': '',
      '/sap/bc/adt/ddic/ddl/sources/zddl_hit': ''
    });
    const result = await grepPackage(client, { packageName: 'ZPKG', pattern: '^c$', contextLines: 1 });

    expect(result.objects[0].matches).toEqual([
      { lineNumber: 3, matchedLine: 'c', contextBefore: ['b'], contextAfter: ['d'] }
    ]);

    // 越界上下文被夹取到上限 5：与显式传 5 的结果完全一致
    const clamped = await grepPackage(client, { packageName: 'ZPKG', pattern: '^c$', contextLines: 99 });
    const explicitMax = await grepPackage(client, { packageName: 'ZPKG', pattern: '^c$', contextLines: 5 });
    expect(clamped.objects[0].matches).toEqual(explicitMax.objects[0].matches);
  });

  it('aggregates unreadable objects into skipped without breaking the sweep', async () => {
    const client = http({
      '/sap/bc/adt/repository/nodestructure': PACKAGE_TREE_XML,
      '/sap/bc/adt/programs/programs/zrep_hit': SOURCE_ZREP,
      // 模拟类源码读取失败（如 403/404/网络错误）
      '/sap/bc/adt/oo/classes/zcl_hit': new Error('HTTP 500'),
      '/sap/bc/adt/ddic/ddl/sources/zddl_hit': SOURCE_ZDDL
    });
    const result = await grepPackage(client, { packageName: 'ZPKG', pattern: 'view|lv_counter' });

    // 单对象失败不中断：其余对象仍被搜索；原因只写固定文案，不泄漏远端细节
    expect(result.searchedObjects).toBe(2);
    expect(result.skipped).toEqual([
      { objectName: 'ZCL_HIT', objectType: 'CLAS/OC', reason: 'failed to read source' }
    ]);
    expect(result.message).toContain('skipped 1 object(s)');
    expect(JSON.stringify(result)).not.toContain('HTTP 500');
  });

  it('stops at maxResults matching objects and reports truncation', async () => {
    const client = packageHttp();
    const result = await grepPackage(client, {
      packageName: 'ZPKG',
      pattern: 'counter|define view',
      maxResults: 1
    });

    // 第 1 个命中对象达到 maxResults=1 且仍有未检查候选：立即停止并如实告知截断
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].objectName).toBe('ZREP_HIT');
    expect(result.searchedObjects).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.message).toContain('results truncated');
  });

  it('applies the objectTypes filter before any source read', async () => {
    const client = packageHttp();
    const result = await grepPackage(client, { packageName: 'ZPKG', pattern: 'counter', objectTypes: ['PROG'] });

    // 前缀语义：PROG 命中 PROG/P；类与 CDS 根本不会被请求
    const urls = (client.request as jest.Mock).mock.calls.map((call: any[]) => call[0] as string);
    expect(urls.some(url => String(url).includes('/oo/classes/'))).toBe(false);
    expect(urls.some(url => String(url).includes('/ddic/ddl/sources/'))).toBe(false);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].objectType).toBe('PROG/P');

    // 精确语义：完整类型串只命中自身
    const exact = await grepPackage(packageHttp(), {
      packageName: 'ZPKG',
      pattern: 'counter',
      objectTypes: ['CLAS/OC']
    });
    expect(exact.objects.map(object => object.objectName)).toEqual(['ZCL_HIT']);
  });

  it('caps the per-package enumeration at 200 source objects with truncated=true', async () => {
    // 生成 205 个 PROG 源码对象（每个源码都命中），枚举应在 200 个处截断
    const nodes = Array.from({ length: 205 }, (_unused, index) => {
      const name = `ZGEN_${String(index).padStart(3, '0')}`;
      return `<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>PROG/P</OBJECT_TYPE><OBJECT_NAME>${name}</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/programs/programs/${name.toLowerCase()}</OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>`;
    }).join('');
    const bigTree = `<?xml version="1.0"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><TREE_CONTENT>${nodes}</TREE_CONTENT></DATA></asx:values></asx:abap>`;
    const client = http({
      '/sap/bc/adt/repository/nodestructure': bigTree,
      '/sap/bc/adt/programs/programs/zgen_': 'hit\n'
    });

    // 枚举截断：只读取前 200 个源码对象；maxResults=500 不再叠加截断
    const result = await grepPackage(client, { packageName: 'ZPKG', pattern: 'hit', maxResults: 500 });

    expect(result.searchedObjects).toBe(200);
    expect(result.objects).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.message).toContain('results truncated');
  });

  it('truncates displayed matched lines but matches against the full line', async () => {
    // 命中文本位于行内第 280 字符：完整行匹配必须命中，回显截断到 200 字符
    const longLine = `${'x'.repeat(280)}NEEDLE${'y'.repeat(10)}`;
    const client = http({
      '/sap/bc/adt/repository/nodestructure': PACKAGE_TREE_XML,
      '/sap/bc/adt/programs/programs/zrep_hit': `${longLine}\r\n`, // 行尾 CR 应被剥离
      '/sap/bc/adt/oo/classes/zcl_hit': '',
      '/sap/bc/adt/ddic/ddl/sources/zddl_hit': ''
    });
    const result = await grepPackage(client, { packageName: 'ZPKG', pattern: 'NEEDLE' });

    expect(result.totalMatches).toBe(1);
    const match = result.objects[0].matches[0];
    expect(match.matchedLine).toHaveLength(200);
    expect(match.matchedLine.endsWith('NEEDLE')).toBe(false);
  });

  it('caps matches per object at 200 while counting every hit', async () => {
    const client = http({
      '/sap/bc/adt/repository/nodestructure': PACKAGE_TREE_XML,
      '/sap/bc/adt/programs/programs/zrep_hit': Array.from({ length: 250 }, () => 'hit').join('\n'),
      '/sap/bc/adt/oo/classes/zcl_hit': '',
      '/sap/bc/adt/ddic/ddl/sources/zddl_hit': ''
    });
    const result = await grepPackage(client, { packageName: 'ZPKG', pattern: 'hit' });

    const object = result.objects[0];
    expect(object.matchCount).toBe(250); // 计数如实
    expect(object.matches).toHaveLength(200); // 明细封顶
    expect(object.matchesTruncated).toBe(true);
  });

  it('rejects an invalid regex before any HTTP call', async () => {
    const client = packageHttp();
    await expect(grepPackage(client, { packageName: 'ZPKG', pattern: '[unclosed' }))
      .rejects.toThrow(/invalid regex pattern/i);
    expect(client.request).not.toHaveBeenCalled();

    await expect(grepPackage(client, { packageName: 'ZPKG', pattern: 'x'.repeat(257) }))
      .rejects.toThrow(/at most 256/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects invalid package names before any HTTP call', async () => {
    const client = packageHttp();
    await expect(grepPackage(client, { packageName: '', pattern: 'x' })).rejects.toThrow(/packageName/);
    await expect(grepPackage(client, { packageName: 'Z PKG', pattern: 'x' })).rejects.toThrow(/packageName/);
    await expect(grepPackage(client, { packageName: 'Z-PKG', pattern: 'x' })).rejects.toThrow(/packageName/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('propagates package enumeration failures unchanged', async () => {
    const failure = new Error('HTTP 404');
    const client = { request: jest.fn().mockRejectedValue(failure) } as unknown as AdtHTTP;
    await expect(grepPackage(client, { packageName: 'ZMISSING', pattern: 'x' })).rejects.toBe(failure);
  });

  it('returns an empty result for a package without source objects', async () => {
    const client = http({
      '/sap/bc/adt/repository/nodestructure':
        '<?xml version="1.0"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA/></asx:values></asx:abap>'
    });
    const result = await grepPackage(client, { packageName: 'ZEMPTY', pattern: 'x' });
    expect(result.objects).toEqual([]);
    expect(result.searchedObjects).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe('SourceGrepApi grepObjects (read-only explicit object list grep)', () => {
  it('derives URIs server-side from name+type and aggregates hits', async () => {
    const client = http({
      '/sap/bc/adt/oo/classes/zcl_a': 'METHODS read.\ntodo: implement.\n',
      '/sap/bc/adt/programs/programs/zprog_a': 'todo in report.\n',
      '/sap/bc/adt/ddic/ddl/sources/zc_view': 'define view ZC_VIEW\n'
    });
    const result = await grepObjects(client, {
      objects: [
        { name: ' zcl_a ', objectType: 'CLAS' },
        { name: 'ZPROG_A', objectType: 'PROG' },
        { name: 'zc_view', objectType: 'DDLS' }
      ],
      pattern: 'todo|define'
    });

    // 请求契约：URI 由服务端从对象名+类型推导（小写惯例），ABAP 追加 /source/main
    const calls = (client.request as jest.Mock).mock.calls;
    expect(calls.map(call => [call[0], call[1].method])).toEqual([
      ['/sap/bc/adt/oo/classes/zcl_a/source/main', 'GET'],
      ['/sap/bc/adt/programs/programs/zprog_a/source/main', 'GET'],
      ['/sap/bc/adt/ddic/ddl/sources/zc_view', 'GET']
    ]);

    expect(result.scope).toBe('objects');
    // 三个对象各命中一次（todo/todo/define），DDLS 的 define 行同样计入
    expect(result.totalMatches).toBe(3);
    expect(result.objects.map(object => object.objectName)).toEqual(['ZCL_A', 'ZPROG_A', 'ZC_VIEW']);
    expect(result.searchedObjects).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.message).toBe('Found 3 match(es) across 3 object(s)');
  });

  it('aggregates unreadable objects into skipped and keeps searching the rest', async () => {
    const client = http({
      '/sap/bc/adt/oo/classes/zcl_a': new Error('HTTP 403'),
      '/sap/bc/adt/programs/programs/zprog_a': 'todo\n'
    });
    const result = await grepObjects(client, {
      objects: [
        { name: 'ZCL_A', objectType: 'CLAS' },
        { name: 'ZPROG_A', objectType: 'PROG' }
      ],
      pattern: 'todo'
    });

    expect(result.objects).toHaveLength(1);
    expect(result.searchedObjects).toBe(1);
    expect(result.skipped).toEqual([
      { objectName: 'ZCL_A', objectType: 'CLAS', reason: 'failed to read source' }
    ]);
    expect(result.message).toBe('Found 1 match(es) across 1 object(s); skipped 1 object(s) that could not be searched');
  });

  it('validates list size, names and types before any HTTP call', async () => {
    const client = http({});
    const ref = { name: 'ZA', objectType: 'PROG' as const };

    await expect(grepObjects(client, { objects: [], pattern: 'x' })).rejects.toThrow(/between 1 and 20/);
    await expect(
      grepObjects(client, { objects: Array.from({ length: 21 }, () => ref), pattern: 'x' })
    ).rejects.toThrow(/between 1 and 20/);
    await expect(
      grepObjects(client, { objects: [{ name: 'Z-A', objectType: 'PROG' }], pattern: 'x' })
    ).rejects.toThrow(/objectName/);
    await expect(
      grepObjects(client, { objects: [{ name: 'ZA', objectType: 'TABL' as never }], pattern: 'x' })
    ).rejects.toThrow(/objectType/);
    await expect(grepObjects(client, { objects: [ref], pattern: '[bad' })).rejects.toThrow(/invalid regex pattern/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('SourceGrepApi helpers (VSP isSourceObject parity)', () => {
  it('keeps the VSP source-type whitelist plus the DDLS extension', () => {
    // VSP workflows_grep.go isSourceObject 白名单逐项对齐
    expect(isSourceObjectType('PROG/P')).toBe(true);
    expect(isSourceObjectType('CLAS/OC')).toBe(true);
    expect(isSourceObjectType('INTF/OI')).toBe(true);
    expect(isSourceObjectType('FUGR/F')).toBe(true);
    expect(isSourceObjectType('FUGR/FF')).toBe(true);
    expect(isSourceObjectType('PROG/I')).toBe(true);
    // 本项目扩展：CDS DDL 源
    expect(isSourceObjectType('DDLS')).toBe(true);
    expect(isSourceObjectType('DDLS/DDLS')).toBe(true);
    // 非源码对象一律排除
    expect(isSourceObjectType('TABL/DT')).toBe(false);
    expect(isSourceObjectType('DEVC/K')).toBe(false);
    expect(isSourceObjectType('')).toBe(false);
  });

  it('matches type filters exactly or as prefix', () => {
    expect(matchesTypeFilter('PROG/P', ['PROG'])).toBe(true);
    expect(matchesTypeFilter('PROG/I', ['PROG'])).toBe(true);
    expect(matchesTypeFilter('CLAS/OC', ['CLAS/OC'])).toBe(true);
    expect(matchesTypeFilter('CLAS/OC', ['PROG'])).toBe(false);
    expect(matchesTypeFilter('FUGR/F', ['FUGR/FF'])).toBe(false); // 精确条目不扩散
  });

  it('derives source read URLs per object kind', () => {
    expect(sourceReadUrl('/sap/bc/adt/programs/programs/zrep', 'PROG/P')).toBe(
      '/sap/bc/adt/programs/programs/zrep/source/main'
    );
    expect(sourceReadUrl('/sap/bc/adt/oo/classes/zcl/source/main', 'CLAS/OC')).toBe(
      '/sap/bc/adt/oo/classes/zcl/source/main'
    );
    expect(sourceReadUrl('/sap/bc/adt/ddic/ddl/sources/zview', 'DDLS/DDLS')).toBe(
      '/sap/bc/adt/ddic/ddl/sources/zview'
    );
  });
});

describe('SourceGrepClient binding', () => {
  it('binds both read-only capabilities to one AdtHTTP session', async () => {
    const client = http({
      '/sap/bc/adt/repository/nodestructure': PACKAGE_TREE_XML,
      '/sap/bc/adt/programs/programs/zrep_hit': SOURCE_ZREP,
      '/sap/bc/adt/oo/classes/zcl_hit': SOURCE_ZCL,
      '/sap/bc/adt/ddic/ddl/sources/zddl_hit': SOURCE_ZDDL
    });
    const bound = createSourceGrepClient(client);

    const packageResult = await bound.grepPackage({ packageName: 'ZPKG', pattern: 'counter' });
    const objectsResult = await bound.grepObjects({
      objects: [{ name: 'ZREP_HIT', objectType: 'PROG' }],
      pattern: 'counter'
    });

    expect(packageResult.scope).toBe('package');
    expect(objectsResult.scope).toBe('objects');
    // 全部调用都是只读（POST 仅为 nodestructure 查询，源码读取为 GET）
    const methods = (client.request as jest.Mock).mock.calls.map((call: any[]) => call[1].method);
    expect(methods).toEqual(['POST', 'GET', 'GET', 'GET', 'GET']);
  });
});
