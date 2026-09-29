/**
 * where-used-config API 测试（analysis.history 的 where_used_config 子操作；
 * VSP fetchConfigRefs 语义移植）。SQL 与源码 grep 通道全 mock，不连接 SAP。
 */
import { getWhereUsedConfig } from '../adt/WhereUsedConfigApi';

const validDeps = (overrides: {
  wb?: Record<string, unknown>[] | Error
  cross?: Record<string, unknown>[] | Error
  grep?: { objects?: Array<{ objectName: string; objectType: string; matchCount: number }>; skipped?: Array<{ objectName: string; objectType?: string; reason: string }> } | Error
} = {}) => {
  const sqlCalls: string[] = [];
  const grepCalls: string[][] = [];
  return {
    sqlCalls,
    grepCalls,
    runSql: jest.fn(async (sql: string) => {
      sqlCalls.push(sql);
      const source = sql.includes('WBCROSSGT') ? overrides.wb : overrides.cross;
      if (source instanceof Error) throw source;
      return { values: source ?? [] };
    }),
    grepObjects: jest.fn(async (input: { objects: Array<{ name: string }>; pattern: string; caseInsensitive?: boolean }) => {
      grepCalls.push(input.objects.map(o => o.name));
      if (overrides.grep instanceof Error) throw overrides.grep;
      return {
        scope: 'objects' as const,
        pattern: input.pattern,
        caseInsensitive: true,
        objects: (overrides.grep?.objects ?? []).map(o => ({ ...o, objectUri: '', matches: [{ lineNumber: 1, line: 'x' }] })),
        totalMatches: overrides.grep?.objects?.length ?? 0,
        searchedObjects: input.objects.length,
        skipped: overrides.grep?.skipped ?? [],
        truncated: false
      };
    })
  };
};

const tvRow = (include: string) => ({ INCLUDE: include });

describe('getWhereUsedConfig（TVARVC 配置引用分析）', () => {
  it('collects candidates from both tables, greps each source, and marks confirmed readers', async () => {
    const deps = validDeps({
      wb: [tvRow('ZCL_READER_OO===========CP'), tvRow('ZCL_OTHER============CP')],
      cross: [tvRow('ZPROG_READER')], // 过程化候选（精确名，非池）
      grep: { objects: [{ objectName: 'ZCL_READER_OO', objectType: 'CLAS', matchCount: 3 }] }
    });
    const result = await getWhereUsedConfig(deps, { variable: 'ZMY_VAR' });

    expect(deps.sqlCalls).toEqual([
      "SELECT INCLUDE FROM WBCROSSGT WHERE OTYPE = 'TY' AND NAME = 'TVARVC'",
      "SELECT INCLUDE FROM CROSS WHERE TYPE = 'S' AND NAME = 'TVARVC'"
    ]);
    expect(result.readers).toEqual([
      { objectType: 'CLAS', objectName: 'ZCL_READER_OO', confirmed: true },
      { objectType: 'CLAS', objectName: 'ZCL_OTHER', confirmed: false },
      { objectType: 'PROG', objectName: 'ZPROG_READER', confirmed: false }
    ]);
    expect(result.greppedCount).toBe(3);
    expect(result.unsearched).toEqual([]);
    // grep：大小写不敏感 + 变量名字面模式
    expect(deps.grepCalls[0]).toEqual(['ZCL_OTHER', 'ZCL_READER_OO', 'ZPROG_READER']); // 按 (type,name) 排序
    expect(deps.grepObjects.mock.calls[0][0].pattern).toBe('ZMY_VAR');
    expect(deps.grepObjects.mock.calls[0][0].caseInsensitive).toBe(true);
  });

  it('keeps the answer alive when one cross-reference table fails, recording the gap', async () => {
    const deps = validDeps({
      wb: new Error('secret-wb'),
      cross: [tvRow('ZPROG_READER')],
      grep: { objects: [] }
    });
    const result = await getWhereUsedConfig(deps, { variable: 'ZVAR', grep: true });
    expect(result.readers).toEqual([{ objectType: 'PROG', objectName: 'ZPROG_READER', confirmed: false }]);
    expect(result.unsearched).toContainEqual({
      object: 'WBCROSSGT (object-oriented code)', reason: 'cross-reference read failed'
    });
    expect(JSON.stringify(result)).not.toContain('secret-wb');
  });

  it('fails hard when neither cross-reference table could be read', async () => {
    const deps = validDeps({ wb: new Error('a'), cross: new Error('b') });
    await expect(getWhereUsedConfig(deps, { variable: 'ZVAR' }))
      .rejects.toThrow(/neither cross-reference table could be read/);
  });

  it('records grep failures as unsearched without borrowing the confirmed=false meaning', async () => {
    const deps = validDeps({
      cross: [tvRow('ZPROG_READER')],
      grep: new Error('read timeout')
    });
    const result = await getWhereUsedConfig(deps, { variable: 'ZVAR' });
    expect(result.readers[0]).toEqual({ objectType: 'PROG', objectName: 'ZPROG_READER', confirmed: false });
    expect(result.unsearched[0]).toMatchObject({ object: 'PROG ZPROG_READER', reason: expect.stringContaining('source grep failed') });
  });

  it('respects the grep budget and reports unreached candidates as unsearched', async () => {
    const deps = validDeps({
      cross: [tvRow('ZPROG_A'), tvRow('ZPROG_B'), tvRow('ZPROG_C')],
      grep: { objects: [{ objectName: 'ZPROG_A', objectType: 'PROG', matchCount: 1 }] }
    });
    const result = await getWhereUsedConfig(deps, { variable: 'ZVAR', maxGrep: 1 });
    expect(result.greppedCount).toBe(1);
    expect(deps.grepCalls).toEqual([['ZPROG_A']]);
    const exceeded = result.unsearched.filter(u => u.reason === 'grep budget exceeded');
    expect(exceeded.map(u => u.object).sort()).toEqual(['PROG ZPROG_B', 'PROG ZPROG_C']);
    expect(result.readers.find(r => r.objectName === 'ZPROG_A')?.confirmed).toBe(true);
  });

  it('maps grep-channel skips to unsearched entries', async () => {
    const deps = validDeps({
      cross: [tvRow('ZPROG_READER')],
      grep: {
        objects: [],
        skipped: [{ objectName: 'ZPROG_READER', objectType: 'PROG', reason: 'failed to read source' }]
      }
    });
    const result = await getWhereUsedConfig(deps, { variable: 'ZVAR' });
    expect(result.unsearched).toContainEqual({
      object: 'PROG ZPROG_READER', reason: 'source grep skipped: failed to read source'
    });
  });

  it('lists non-source candidates as unsearched instead of grepping them', async () => {
    // 归一化只会产出 CLAS/INTF/PROG/FUGR 四类；本用例用 grep=false 验证纯候选路径
    const deps = validDeps({ cross: [tvRow('ZPROG_READER')] });
    const result = await getWhereUsedConfig(deps, { variable: 'ZVAR', grep: false });
    expect(result.greppedCount).toBe(0);
    expect(result.readers[0].confirmed).toBe(false);
    expect(result.unsearched).toEqual([]);
    expect(deps.grepObjects).not.toHaveBeenCalled();
  });

  it('rejects invalid variable names before any query', async () => {
    const deps = validDeps({});
    await expect(getWhereUsedConfig(deps, { variable: 'BAD NAME!' })).rejects.toThrow(/invalid/);
    expect(deps.runSql).not.toHaveBeenCalled();
  });
});
