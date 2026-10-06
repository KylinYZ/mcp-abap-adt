/**
 * 受控 ABAP 执行 API 测试（devtools.execute-abap 的执行核；VSP
 * workflows_execute.go ExecuteABAP 语义移植）。ExecuteAbapHttp 全 mock。
 *
 * mock 形态对齐 ExecuteAbapHttp 接口：分方法（create/lock/updateSource/
 * unlock/activate/runUnitTest/deleteObject），非统一 (url, init) 通道。
 * runUnitTest 返回 UnitTestClass[]（ADT 元数据字段必须齐备）。
 * 注意：清理步 cleanupOnce 会重新 LOCK 一次再 DELETE（真实 SAP 删除程序
 * 必须先持 MODIFY 锁）——调用序列断言须包含收尾的第二个 LOCK。
 */
import {
  executeAbapViaUnitTest, executeWrapperSource, execResult, payloadFailure,
  riskLevelABAP, unitTestFlagsFor, PAYLOAD_START_MARKER, EXEC_RESULT_MARKER,
  type ExecuteAbapHttp, type UnitTestClass
} from '../adt/ExecuteAbapApi';
import { UnitTestAlertKind, UnitTestSeverity } from '../adt/api/unittest';

/** 构造合规的 UnitTestMethod（ADT 元数据字段齐备）。 */
function testMethod(executionTime: number, alerts: any[]): NonNullable<UnitTestClass['testmethods']>[number] {
  return {
    'adtcore:uri': '/sap/bc/adt/oo/classes/ltc_executor/methods/execute_payload',
    'adtcore:type': 'CLAS/OM',
    'adtcore:name': 'EXECUTE_PAYLOAD',
    uriType: 'local',
    unit: 'method',
    executionTime,
    alerts: alerts as NonNullable<UnitTestClass['testmethods']>[number]['alerts']
  };
}

/** 构造合规的 UnitTestClass（ADT 元数据字段齐备；alerts 可挂类级或方法级）。 */
function testClass(alerts: any[], testmethods?: UnitTestClass['testmethods']): UnitTestClass {
  return {
    'adtcore:uri': '/sap/bc/adt/oo/classes/ltc_executor',
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'LTC_EXECUTOR',
    uriType: 'local',
    durationCategory: 'short',
    riskLevel: 'harmless',
    testmethods: testmethods ?? [],
    alerts: alerts as UnitTestClass['alerts']
  };
}

describe('execResult（EXEC_RESULT 提取）', () => {
  it('extracts the value after EXEC_RESULT marker, trimming SAP closing quote', () => {
    expect(execResult('EXEC_RESULT:42').value).toBe('42');
    // SAP 把消息包进自己的句子并加引号——按前缀匹配的原因
    expect(execResult("Critical Assertion Error: 'EXEC_RESULT:42'").value).toBe('42');
    expect(execResult('no marker here').found).toBe(false);
  });
});

describe('payloadFailure（失败 alert 挑选）', () => {
  it('skips the closing assertion and picks the payload-killing exception', () => {
    const closing = { kind: 'failedAssertion', severity: 'critical', title: 'EXEC_RESULT:42' };
    const exception = { kind: 'exception', severity: 'high', title: 'COMPUTE_INT_ZERODIVIDE' };
    expect(payloadFailure([closing, exception])?.kind).toBe('exception');
  });
});

describe('wrapper 模板与 riskLevel', () => {
  it('embeds user code between markers and places the closing assertion', () => {
    const source = executeWrapperSource('ZTEMP_EXEC_123', 'RISK LEVEL HARMLESS', 'lv_result', 'lv_result = 42.');
    expect(source).toContain('CLASS ltc_executor DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.');
    expect(source).toContain(PAYLOAD_START_MARKER);
    expect(source).toContain('lv_result = 42.');
    expect(source).toContain(`cl_abap_unit_assert=>fail( msg = |${EXEC_RESULT_MARKER}{ lv_result }| ).`);
  });

  it('maps riskLevel to the ABAP RISK LEVEL clause and unit-test flags', () => {
    expect(riskLevelABAP('harmless')).toBe('RISK LEVEL HARMLESS');
    expect(riskLevelABAP('dangerous')).toBe('RISK LEVEL DANGEROUS');
    expect(riskLevelABAP('critical')).toBe('RISK LEVEL CRITICAL');
    expect(unitTestFlagsFor('dangerous')).toMatchObject({ harmless: true, dangerous: true, critical: false });
    expect(unitTestFlagsFor('critical')).toMatchObject({ critical: true });
  });
});

describe('executeAbapViaUnitTest（单次执行核）', () => {
  /** 步进 mock：记录调用序列（kind），按注册表响应。 */
  function makeHttp(opts: {
    testClasses?: UnitTestClass[]
    failActivate?: boolean
    failRun?: boolean
    failDelete?: boolean
  } = {}) {
    const calls: string[] = [];
    const http: ExecuteAbapHttp = {
      create: async () => { calls.push('CREATE'); },
      lock: async () => { calls.push('LOCK'); return { LOCK_HANDLE: 'L1' }; },
      updateSource: async () => { calls.push('SOURCE'); },
      unlock: async () => { calls.push('UNLOCK'); },
      activate: async () => {
        calls.push('ACTIVATE');
        if (opts.failActivate) throw new Error('activation failed: syntax error');
        return { messages: [], success: true };
      },
      runUnitTest: async () => {
        calls.push('RUNUNIT');
        if (opts.failRun) throw new Error('unit-test run failed');
        return opts.testClasses ?? [];
      },
      deleteObject: async () => {
        calls.push('DELETE');
        if (opts.failDelete) throw new Error('DELETE transport error');
      }
    };
    return { http, calls };
  }

  it('happy path: create → lock → write → unlock → activate → run → lock+delete，EXEC_RESULT 提取', async () => {
    // 收尾断言放在测试方法级（ABAP Unit 真实形态：failedAssertion 挂在 method 下）
    const cls = testClass([], [testMethod(2, [{
      kind: UnitTestAlertKind.failedAssertion, severity: UnitTestSeverity.critical,
      details: [], stack: [],
      title: "Critical Assertion Error: 'EXEC_RESULT:hello by DEVUSER'"
    }])]);
    const { http, calls } = makeHttp({ testClasses: [cls] });
    const result = await executeAbapViaUnitTest(http, `lv_result = 'hello'.`);
    expect(result.success).toBe(true);
    expect(result.cleanedUp).toBe(true);
    expect(result.executionTime).toBe(2);
    expect(result.output).toEqual(['hello by DEVUSER']);
    expect(result.failure).toBeUndefined();
    // 收尾清理重新 LOCK 一次再 DELETE（SAP 删除对象必须先持锁）
    expect(calls).toEqual(['CREATE', 'LOCK', 'SOURCE', 'UNLOCK', 'ACTIVATE', 'RUNUNIT', 'LOCK', 'DELETE']);
  });

  it('reports notRun when ABAP Unit returns zero test classes (absence is not a pass)', async () => {
    const { http } = makeHttp();
    const result = await executeAbapViaUnitTest(http, `lv_result = 1.`);
    expect(result.success).toBe(false);
    expect(result.failure?.kind).toBe('notRun');
    expect(result.cleanedUp).toBe(true);
  });

  it('reports syntax errors from the activation step without running unit tests', async () => {
    const { http, calls } = makeHttp({ failActivate: true });
    const result = await executeAbapViaUnitTest(http, `lv_result = 1.`);
    expect(result.success).toBe(false);
    expect(result.failure?.kind).toBe('syntaxError');
    expect(result.cleanedUp).toBe(true);
    // 编译失败不进入运行步，但清理步照常执行
    expect(calls).toEqual(['CREATE', 'LOCK', 'SOURCE', 'UNLOCK', 'ACTIVATE', 'LOCK', 'DELETE']);
  });

  it('does not retry a failed DELETE and records the cleanup warning', async () => {
    const { http, calls } = makeHttp({ failDelete: true });
    const result = await executeAbapViaUnitTest(http, `lv_result = 1.`);
    expect(result.cleanedUp).toBe(false);
    expect(result.cleanupWarnings?.some(w => w.includes('DELETE'))).toBe(true);
    // 一次 DELETE 失败后不再重试（UNKNOWN_OUTCOME 不回放）
    expect(calls.filter(c => c === 'DELETE')).toHaveLength(1);
  });

  it('keeps the temp program when keepProgram is set', async () => {
    const { http, calls } = makeHttp();
    const result = await executeAbapViaUnitTest(http, `lv_result = 1.`, { keepProgram: true });
    expect(result.cleanedUp).toBe(false);
    expect(calls).not.toContain('DELETE');
  });

  it('rejects an invalid returnVariable before any SAP call', async () => {
    const { http, calls } = makeHttp();
    // 变量名直接拼进 wrapper 模板——非法字符必须在 create 之前被拒绝
    const result = await executeAbapViaUnitTest(http, `lv_result = 1.`, { returnVariable: '1bad name' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('return variable');
    expect(calls).toEqual([]); // 未触发任何 SAP 调用
  });
});
