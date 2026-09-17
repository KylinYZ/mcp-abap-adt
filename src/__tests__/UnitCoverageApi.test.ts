import {
  runUnitCoverage,
  createUnitCoverageClient,
  resolveUnitCoverageFlags,
  deriveUnitTestObjectUri
} from '../adt/UnitCoverageApi.js';
import type { AdtHTTP } from '../adt/AdtHTTP.js';

/**
 * UnitCoverageApi 执行型契约测试（mock HTTP 层，绝不连接真实 SAP）。
 * 对齐 CdsDependencyApi.test.ts 的三件套基准，断言四类内容：
 *   1. 请求契约：端点 URL、HTTP 方法、头、请求 XML 含 coverage active 标志与
 *      服务端推导的对象 URI、riskLevel/duration 档位展开；
 *   2. 解析结果：每测试类执行状态 + statement/branch/procedure 覆盖率数字
 *      （口径对齐 VSP pkg/adt/testing.go parseCoverageResult）；
 *   3. 容错语义：无 coverage 段返回零值不抛错、坏结构返回空结果；
 *   4. 参数校验：命名白名单/复合格式在发出 HTTP 前拒绝，HTTP 错误原样传播。
 */

/** 构造仅含 request mock 的 AdtHTTP 假会话（对齐 CdsDependencyApi 测试写法）。 */
function http(body: string): AdtHTTP {
  return { request: jest.fn().mockResolvedValue({ body, status: 200, headers: {} }) } as unknown as AdtHTTP;
}

// 真实感覆盖率响应：1 个测试类（2 个方法，1 个断言失败告警）+ statement 两源
// + branch 一源 + 无 procedure 段（程序未产生过程覆盖数据的常见形态）
const COVERAGE_RUN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <program adtcore:uri="/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO" adtcore:type="PROG/P" adtcore:name="ZCOVERAGE_DEMO">
    <testClasses>
      <testClass adtcore:uri="/sap/bc/adt/oo/classes/zcl_coverage_demo_test" adtcore:type="CLAS/XT" adtcore:name="ZCL_COVERAGE_DEMO_TEST" uriType="semantic" durationCategory="short" riskLevel="harmless">
        <testMethods>
          <testMethod adtcore:uri="#b=ZCL_COVERAGE_DEMO_TEST.test_pass" adtcore:name="TEST_PASS" executionTime="12" uriType="semantic"/>
          <testMethod adtcore:uri="#b=ZCL_COVERAGE_DEMO_TEST.test_fail" adtcore:name="TEST_FAIL" executionTime="5" uriType="semantic">
            <alerts>
              <alert kind="failedAssertion" severity="critical"><title>Assertion failed</title></alert>
            </alerts>
          </testMethod>
        </testMethods>
      </testClass>
    </testClasses>
  </program>
  <coverage>
    <statement>
      <node uri="/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO" type="PROG/P" name="ZCOVERAGE_DEMO" total="100" covered="75" percentage="75.0"/>
      <node uri="/sap/bc/adt/oo/classes/zcl_coverage_demo_test" type="CLAS/OC" name="ZCL_COVERAGE_DEMO_TEST" total="40" covered="10" percentage="25.0"/>
    </statement>
    <branch>
      <node uri="/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO" type="PROG/P" name="ZCOVERAGE_DEMO" total="20" covered="5" percentage="25.0"/>
    </branch>
  </coverage>
</aunit:runResult>`;

// 仅执行结果、无 coverage 段的响应（系统未启用覆盖率采集时的形态）
const RUN_WITHOUT_COVERAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <program adtcore:uri="/sap/bc/adt/oo/classes/ZCL_BARE" adtcore:type="CLAS/OC" adtcore:name="ZCL_BARE">
    <testClasses>
      <testClass adtcore:uri="/sap/bc/adt/oo/classes/zcl_bare_test" adtcore:type="CLAS/XT" adtcore:name="ZCL_BARE_TEST" uriType="semantic" durationCategory="short" riskLevel="harmless">
        <testMethods>
          <testMethod adtcore:uri="#b=ZCL_BARE_TEST.test_ok" adtcore:name="TEST_OK" executionTime="3" uriType="semantic"/>
        </testMethods>
      </testClass>
    </testClasses>
  </program>
</aunit:runResult>`;

describe('UnitCoverageApi runUnitCoverage request contract', () => {
  it('posts to the abapunit testruns endpoint with the coverage flag and a server-derived URI', async () => {
    const client = http(COVERAGE_RUN_XML);
    await runUnitCoverage(client, { objectType: 'PROGRAM', objectName: 'zcoverage_demo' });

    // 请求契约：端点/方法/头逐字对齐 VSP pkg/adt/testing.go GetCodeCoverage；
    // 小写对象名先规范化为大写再推导 URI
    expect(client.request).toHaveBeenCalledTimes(1);
    const [url, config] = (client.request as jest.Mock).mock.calls[0];
    expect(url).toBe('/sap/bc/adt/abapunit/testruns');
    expect(config.method).toBe('POST');
    expect(config.headers).toEqual({ 'Content-Type': 'application/*', Accept: 'application/*' });
    // 覆盖率采集标志：本能力与普通 unitTestRun 的唯一协议差异
    expect(config.body).toContain('<coverage active="true"/>');
    expect(config.body).toContain('aunit:runConfiguration');
    // 对象 URI 由服务端推导（不接受调用方 URL）
    expect(config.body).toContain(
      `<adtcore:objectReference adtcore:uri="${deriveUnitTestObjectUri('PROGRAM', 'ZCOVERAGE_DEMO')}"/>`
    );
  });

  it('expands default riskLevel/duration to the upstream default flag set', async () => {
    const client = http(COVERAGE_RUN_XML);
    await runUnitCoverage(client, { objectType: 'CLASS', objectName: 'ZCL_COV' });

    const body = (client.request as jest.Mock).mock.calls[0][1].body;
    // 双缺省必须逐字段对齐 VSP DefaultUnitTestFlags：harmless + short/medium
    expect(body).toContain('harmless="true" dangerous="false" critical="false"');
    expect(body).toContain('short="true" medium="true" long="false"');
    expect(body).toContain('/sap/bc/adt/oo/classes/ZCL_COV');
  });

  it('expands cumulative riskLevel/duration selections into the request XML', async () => {
    const client = http(COVERAGE_RUN_XML);
    await runUnitCoverage(client, {
      objectType: 'CLASS',
      objectName: 'ZCL_COV',
      riskLevel: 'DANGEROUS',
      duration: 'SHORT'
    });
    const body = (client.request as jest.Mock).mock.calls[0][1].body;
    // 累计语义：DANGEROUS 含 harmless+dangerous 不含 critical；SHORT 仅 short
    expect(body).toContain('harmless="true" dangerous="true" critical="false"');
    expect(body).toContain('short="true" medium="false" long="false"');

    const clientAll = http(COVERAGE_RUN_XML);
    await runUnitCoverage(clientAll, {
      objectType: 'PROGRAM',
      objectName: 'ZCOV_ALL',
      riskLevel: 'CRITICAL',
      duration: 'LONG'
    });
    const bodyAll = (clientAll.request as jest.Mock).mock.calls[0][1].body;
    // CRITICAL+LONG：全部档位打开
    expect(bodyAll).toContain('harmless="true" dangerous="true" critical="true"');
    expect(bodyAll).toContain('short="true" medium="true" long="true"');
  });

  it('derives the composite function-module URI from GROUP/FUNC', async () => {
    const client = http(COVERAGE_RUN_XML);
    const result = await runUnitCoverage(client, {
      objectType: 'FUNCTION_MODULE',
      objectName: 'zfg_cov/zfm_cov'
    });

    // 复合名规范化为大写并推导函数组/函数模块 URI
    expect(result.objectName).toBe('ZFG_COV/ZFM_COV');
    expect(result.objectUri).toBe('/sap/bc/adt/functions/groups/ZFG_COV/fmodules/ZFM_COV');
    expect((client.request as jest.Mock).mock.calls[0][1].body).toContain(result.objectUri);
  });
});

describe('UnitCoverageApi runUnitCoverage result parsing', () => {
  it('parses trimmed execution status and coverage metrics aligned with VSP fields', async () => {
    const client = http(COVERAGE_RUN_XML);
    const result = await runUnitCoverage(client, { objectType: 'PROGRAM', objectName: 'ZCOVERAGE_DEMO' });

    // 执行结果：每测试类的名字/档位/告警数/状态 + 方法级明细
    expect(result.execution.testClasses).toEqual([
      {
        name: 'ZCL_COVERAGE_DEMO_TEST',
        type: 'CLAS/XT',
        riskLevel: 'harmless',
        durationCategory: 'short',
        alertCount: 1,
        status: 'alerts',
        testMethods: [
          { name: 'TEST_PASS', executionTime: 12, alertCount: 0, status: 'passed' },
          { name: 'TEST_FAIL', executionTime: 5, alertCount: 1, status: 'alerts' }
        ]
      }
    ]);
    expect(result.execution.summary).toEqual({ testClassCount: 1, testMethodCount: 2, alertCount: 1 });

    // 覆盖率数字（对齐 VSP CoverageStats 口径）：statements 聚合两源并自行计算
    // 百分比（85/140=60.71），branches 单源，procedures 无段则全 0
    expect(result.coverage.statements).toEqual({ total: 140, covered: 85, percent: 60.71 });
    expect(result.coverage.branches).toEqual({ total: 20, covered: 5, percent: 25 });
    expect(result.coverage.procedures).toEqual({ total: 0, covered: 0, percent: 0 });
    // 按源 URI 索引的语句级覆盖（对齐 VSP SourceCoverage map[uri] 结构）
    expect(result.coverage.sourceCoverage).toEqual({
      '/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO': {
        uri: '/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO',
        type: 'PROG/P',
        name: 'ZCOVERAGE_DEMO',
        statements: { total: 100, covered: 75, percent: 75 }
      },
      '/sap/bc/adt/oo/classes/zcl_coverage_demo_test': {
        uri: '/sap/bc/adt/oo/classes/zcl_coverage_demo_test',
        type: 'CLAS/OC',
        name: 'ZCL_COVERAGE_DEMO_TEST',
        statements: { total: 40, covered: 10, percent: 25 }
      }
    });

    // 回显信息：规范化对象名/类型/URI/生效标志，便于调用方核对测试范围
    expect(result.objectName).toBe('ZCOVERAGE_DEMO');
    expect(result.objectType).toBe('PROGRAM');
    expect(result.objectUri).toBe('/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO');
    expect(result.flags).toEqual({
      harmless: true, dangerous: false, critical: false, short: true, medium: true, long: false
    });
  });

  it('returns zeroed coverage and parsed execution when the response has no coverage section', async () => {
    const client = http(RUN_WITHOUT_COVERAGE_XML);
    const result = await runUnitCoverage(client, { objectType: 'CLASS', objectName: 'ZCL_BARE' });

    // 无 coverage 段（系统未启用覆盖率采集）不抛错：执行结果照常，覆盖率全 0
    expect(result.execution.summary).toEqual({ testClassCount: 1, testMethodCount: 1, alertCount: 0 });
    expect(result.execution.testClasses[0]).toMatchObject({ name: 'ZCL_BARE_TEST', status: 'passed' });
    expect(result.coverage.statements).toEqual({ total: 0, covered: 0, percent: 0 });
    expect(result.coverage.branches).toEqual({ total: 0, covered: 0, percent: 0 });
    expect(result.coverage.procedures).toEqual({ total: 0, covered: 0, percent: 0 });
    expect(result.coverage.sourceCoverage).toEqual({});
  });

  it('returns an empty result instead of failing on unexpected payload structures', async () => {
    // 对齐 VSP parseCoverageResult：结构不在预期格式时返回空而非抛错
    for (const body of ['', 'this is not xml', '<unexpected/>']) {
      const client = http(body);
      const result = await runUnitCoverage(client, { objectType: 'PROGRAM', objectName: 'Z_ODD' });
      expect(result.execution.testClasses).toEqual([]);
      expect(result.execution.summary).toEqual({ testClassCount: 0, testMethodCount: 0, alertCount: 0 });
      expect(result.coverage.statements.total).toBe(0);
      expect(result.coverage.sourceCoverage).toEqual({});
    }
  });

  it('propagates upstream HTTP errors unchanged', async () => {
    const failure = new Error('HTTP 500 SECRET_REMOTE_BODY');
    const client = { request: jest.fn().mockRejectedValue(failure) } as unknown as AdtHTTP;
    await expect(runUnitCoverage(client, { objectType: 'CLASS', objectName: 'ZCL_X' })).rejects.toBe(failure);
  });
});

describe('UnitCoverageApi input validation', () => {
  it.each([
    ['unknown objectType', { objectType: 'TABLE', objectName: 'ZFOO' }],
    ['missing objectName', { objectType: 'CLASS', objectName: '' }],
    ['blank objectName', { objectType: 'CLASS', objectName: '   ' }],
    ['objectName with illegal characters', { objectType: 'PROGRAM', objectName: 'Z(A)' }],
    ['objectName over 30 characters', { objectType: 'CLASS', objectName: 'Z'.repeat(31) }],
    ['PROGRAM name containing a slash', { objectType: 'PROGRAM', objectName: 'NSG/ZPROG' }],
    ['FUNCTION_MODULE without the composite form', { objectType: 'FUNCTION_MODULE', objectName: 'ZFM_ONLY' }],
    ['FUNCTION_MODULE with two separators', { objectType: 'FUNCTION_MODULE', objectName: 'A/B/C' }],
    ['FUNCTION_MODULE group segment too long', { objectType: 'FUNCTION_MODULE', objectName: `${'G'.repeat(27)}/ZFM` }]
  ])('rejects invalid input (%s) before any HTTP call', async (_label, input) => {
    const client = http(COVERAGE_RUN_XML);
    await expect(runUnitCoverage(client, input as never)).rejects.toThrow(/objectName|objectType/);
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('UnitCoverageApi flags and URI helpers', () => {
  it('resolves the default flag set identical to VSP DefaultUnitTestFlags', () => {
    // VSP devtools.go DefaultUnitTestFlags：harmless+short+medium，其余关闭
    expect(resolveUnitCoverageFlags()).toEqual({
      harmless: true, dangerous: false, critical: false, short: true, medium: true, long: false
    });
    expect(resolveUnitCoverageFlags('HARMLESS', 'MEDIUM')).toEqual(resolveUnitCoverageFlags());
  });

  it('derives object URIs per type from normalized names only', () => {
    expect(deriveUnitTestObjectUri('PROGRAM', 'ZPROG')).toBe('/sap/bc/adt/programs/programs/ZPROG');
    expect(deriveUnitTestObjectUri('CLASS', 'ZCL_COV')).toBe('/sap/bc/adt/oo/classes/ZCL_COV');
    expect(deriveUnitTestObjectUri('FUNCTION_MODULE', 'ZFG/ZFM')).toBe(
      '/sap/bc/adt/functions/groups/ZFG/fmodules/ZFM'
    );
  });
});

describe('UnitCoverageClient binding', () => {
  it('binds the executing capability to one AdtHTTP session', async () => {
    const client = http(COVERAGE_RUN_XML);
    const bound = createUnitCoverageClient(client);

    const result = await bound.runUnitCoverage({ objectType: 'PROGRAM', objectName: 'ZCOVERAGE_DEMO' });

    // 绑定必须落在同一注入会话上，并透传解析结果
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(result.objectName).toBe('ZCOVERAGE_DEMO');
  });
});
