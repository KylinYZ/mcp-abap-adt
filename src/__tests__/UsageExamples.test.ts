/**
 * usage-examples API 测试（analysis.history 的 usage_examples 子操作；
 * VSP FindUsageExamples/fetchUsageCandidatesFallback 语义移植）。
 * SQL 与源码读取通道全 mock，不连接 SAP。
 */
import { getUsageExamples, extractCallSites } from '../adt/UsageExamplesApi';

describe('extractCallSites（片段提取纯函数，VSP extractCallSites 移植）', () => {
  const caller = { objectType: 'PROG', objectName: 'ZCALLER', source: [
    'REPORT zcaller.',
    '* CALL FUNCTION \'ZTARGET\'  — 注释行应跳过',
    "  CALL FUNCTION 'ZTARGET'.",
    '  WRITE / 1.'
  ].join('\n') };

  it('matches CALL_FUNCTION and skips comment lines', () => {
    const found = extractCallSites({ objectType: 'FUNC', objectName: 'ZTARGET' }, caller);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ callerObjectName: 'ZCALLER', lineNumber: 3, matchType: 'CALL_FUNCTION', confidence: 'HIGH' });
    expect(found[0].snippet).toContain('|');
  });

  it('falls back to literal GREP with MEDIUM confidence when no structural pattern hits', () => {
    const found = extractCallSites({ objectType: 'CLAS', objectName: 'ZTARGET' }, {
      objectType: 'PROG', objectName: 'ZCALLER',
      source: 'DATA lo_ref TYPE REF TO ztarget.'
    });
    expect(found).toHaveLength(1);
    expect(found[0].matchType).toBe('CLASS_REFERENCE'); // TYPE REF TO 是具体形态
  });

  it('classifies METHOD_CALL with => and ~ separators', () => {
    const src = 'zcl_target=>get_data( ).\nzcl_target->get_data( ).';
    const found = extractCallSites({ objectType: 'CLAS', objectName: 'ZCL_TARGET', method: 'GET_DATA' }, {
      objectType: 'PROG', objectName: 'ZCALLER', source: src
    });
    expect(found).toHaveLength(2);
    expect(found.every(e => e.matchType === 'METHOD_CALL')).toBe(true);
  });

  it('matches SUBMIT and PERFORM form IN PROGRAM', () => {
    const submitSrc = 'SUBMIT ztarget AND RETURN.';
    expect(extractCallSites({ objectType: 'SUBMIT', objectName: 'ZTARGET' }, { objectType: 'PROG', objectName: 'X', source: submitSrc }))
      .toMatchObject([{ matchType: 'SUBMIT' }]);
    const performSrc = 'PERFORM do_stuff IN PROGRAM ztarget.';
    expect(extractCallSites({ objectType: 'PROG', objectName: 'ZTARGET', form: 'DO_STUFF' }, { objectType: 'PROG', objectName: 'X', source: performSrc }))
      .toMatchObject([{ matchType: 'PERFORM' }]);
  });
});

describe('getUsageExamples（候选采集 + 片段组合）', () => {
  const depsWith = (cross: Record<string, unknown>[], sources: Record<string, string>) => ({
    runSql: jest.fn(async () => ({ values: cross })),
    readSource: jest.fn(async (input: { objectName: string }) => {
      const source = sources[input.objectName];
      if (source === undefined) throw new Error(`source read failed for ${input.objectName}`);
      return source;
    })
  });

  it('collects candidates from both tables, reads sources, and ranks non-test HIGH entries first', async () => {
    const deps = depsWith(
      [
        { INCLUDE: 'ZCL_TEST_RUNNER===========CP', OTYPE: 'DA', NAME: 'ZTARGET' },
        { INCLUDE: 'ZCL_PROD_CALLER===========CP', OTYPE: 'DA', NAME: 'ZTARGET' }
      ],
      {
        ZCL_TEST_RUNNER: "CALL FUNCTION 'ZTARGET'.",
        ZCL_PROD_CALLER: "CALL FUNCTION 'ZTARGET'."
      }
    );
    const result = await getUsageExamples(deps, { objectType: 'FUNC', objectName: 'ZTARGET' });

    expect(deps.runSql).toHaveBeenCalledTimes(1); // FUNC 只查 CROSS（TYPE=F）
    expect(result.totalCallers).toBe(2);
    expect(result.examples).toHaveLength(2);
    // 排序：非测试类 caller 优先（exampleRank）
    expect(result.examples[0].callerObjectName).toBe('ZCL_PROD_CALLER');
    expect(result.unsearched).toEqual([]);
  });

  it('counts source-read failures as unsearched, not as callers', async () => {
    const deps = depsWith(
      [{ INCLUDE: 'ZCL_BROKEN===========CP' }, { INCLUDE: 'ZCL_OK===========CP' }],
      { ZCL_BROKEN: '', ZCL_OK: "zcl_ok=>ztarget( )." }
    );
    const result = await getUsageExamples(deps, { objectType: 'CLAS', objectName: 'ZCL_OK' });
    expect(result.totalCallers).toBe(1);
    expect(result.unsearched).toEqual([
      { object: 'CLAS ZCL_BROKEN', reason: 'the source came back empty' }
    ]);
  });

  it('excludes FUGR callers (v1 boundary, VSP-aligned)', async () => {
    const deps = depsWith([{ INCLUDE: 'SAPLZFUGR' }], {});
    const result = await getUsageExamples(deps, { objectType: 'FUNC', objectName: 'Z_FG' });
    expect(result.totalCallers).toBe(0);
  });

  it('caps examples at maxExamples after ranking', async () => {
    const cross = Array.from({ length: 5 }, (_, i) => ({ INCLUDE: `ZPROG_C${i}` }));
    const sources: Record<string, string> = {};
    for (let i = 0; i < 5; i++) sources[`ZPROG_C${i}`] = `SUBMIT ztarget.`;
    const deps = depsWith(cross, sources);
    const result = await getUsageExamples(deps, { objectType: 'SUBMIT', objectName: 'ZTARGET', maxExamples: 3 });
    expect(result.totalCallers).toBe(5);
    expect(result.examples).toHaveLength(3);
  });

  it('reports cross-table read failures as unsearched (redacted) and survives on the other source', async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql.includes('WBCROSSGT')) throw new Error('secret-wb');
      return { values: [{ INCLUDE: 'ZPROG_READER' }] };
    });
    const deps = { runSql: run as unknown as never, readSource: jest.fn(async () => "ztarget( ).") } as never;
    const { getUsageExamples } = await import('../adt/UsageExamplesApi');
    const result = await getUsageExamples(deps as never, { objectType: 'CLAS', objectName: 'ZTARGET' });
    expect(result.unsearched).toContainEqual({ object: 'WBCROSSGT', reason: 'cross-reference read failed' });
    expect(JSON.stringify(result)).not.toContain('secret-wb');
  });

  it('rejects invalid object names and unknown types before any query', async () => {
    const deps = depsWith([], {});
    await expect(getUsageExamples(deps, { objectType: 'CLAS', objectName: 'BAD NAME!' })).rejects.toThrow(/invalid/);
    await expect(getUsageExamples(deps, { objectType: 'TABL' as never, objectName: 'ZT' })).rejects.toThrow(/objectType/);
    expect(deps.runSql).not.toHaveBeenCalled();
  });
});
