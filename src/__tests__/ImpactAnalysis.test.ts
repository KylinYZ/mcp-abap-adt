/**
 * ImpactAnalysisApi 测试（analysis.history 的 impact 子操作收编）。
 * WBCROSSGT 查询全 mock（行形态对齐真机取证：INCLUDE 30 位填充池 + OTYPE + NAME）。
 */
import { getImpactAnalysis } from '../adt/ImpactAnalysisApi';

/** 构造 WBCROSSGT 行。 */
const wbRow = (include: string) => ({ INCLUDE: include, OTYPE: 'TY', NAME: 'ZCL_TARGET' });

/** 类池名：30 位填充（ZCL_X===================CM001 形态）。 */
function classPool(name: string, suffix = 'CM001'): string {
  const base = name.toLowerCase();
  return base + '='.repeat(Math.max(0, 30 - base.length - suffix.length)) + suffix;
}

describe('getImpactAnalysis（反向影响面 BFS）', () => {
  it('collects direct callers at depth 1 and expands deeper levels via BFS', async () => {
    const callerA = classPool('zcl_caller_a');
    const callerB = classPool('zcl_caller_b');
    const queries: string[] = [];
    const run = jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("LIKE 'ZCL_TARGET%'")) {
        return { values: [wbRow(callerA), wbRow(callerB)] };
      }
      if (sql.includes("LIKE 'ZCL_CALLER_A%'")) {
        // A 被更深层的 B 引用（反向：B→A）
        return { values: [wbRow(classPool('zcl_caller_b'))] };
      }
      return { values: [] };
    });
    const result = await getImpactAnalysis(run, { objectType: 'CLAS', objectName: 'zcl_target' });
    expect(result.target).toEqual({ type: 'CLAS', name: 'ZCL_TARGET' });
    expect(result.directCallers).toEqual([
      { type: 'CLAS', name: 'ZCL_CALLER_A' },
      { type: 'CLAS', name: 'ZCL_CALLER_B' }
    ]);
    expect(result.levels[0]!.nodes).toHaveLength(2);
    // 深度 2：B→A 的边让 A 出现在 level 2？不——A 已在 depth 1 visited，无重复
    expect(result.totalAffected).toBe(2);
    expect(result.edges.every(e => e.rawInclude.length > 0)).toBe(true);
    expect(result.notes[0]).toContain('WBCROSSGT');
  });

  it('skips self references and sibling-name false hits via ownership filtering', async () => {
    const sibling = classPool('zcl_target_item'); // 前缀拖进——归属过滤应排除对目标的误判
    const run = jest.fn(async (sql: string) => {
      if (sql.includes("LIKE 'ZCL_TARGET%'")) {
        return { values: [
          wbRow(classPool('zcl_target')), // 自引用
          wbRow(sibling), // ZCL_TARGET_ITEM：normalizeLoadName → ZCL_TARGET_ITEM（非目标本体）
          wbRow(classPool('zcl_real_caller'))
        ] };
      }
      return { values: [] };
    });
    const result = await getImpactAnalysis(run, { objectType: 'CLAS', objectName: 'ZCL_TARGET' });
    const names = result.directCallers.map(n => n.name);
    expect(names).toContain('ZCL_REAL_CALLER');
    // 自引用不出现
    expect(result.edges.every(e => e.from.name !== 'ZCL_TARGET')).toBe(true);
  });

  it('respects maxDepth=1 (direct callers only, one query round)', async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql.includes("LIKE 'ZCL_TARGET%'")) return { values: [wbRow(classPool('zcl_caller_a'))] };
      return { values: [] };
    });
    const result = await getImpactAnalysis(run, { objectType: 'CLAS', objectName: 'ZCL_TARGET', maxDepth: 1 });
    expect(result.levels).toHaveLength(1);
    expect(result.rounds).toBe(1);
  });

  it('records query failures as notes and keeps going', async () => {
    let first = true;
    const run = jest.fn(async (sql: string) => {
      if (sql.includes("LIKE 'ZCL_TARGET%'")) {
        if (first) { first = false; throw new Error('Internal server error'); }
        return { values: [] };
      }
      return { values: [] };
    });
    const result = await getImpactAnalysis(run, { objectType: 'CLAS', objectName: 'ZCL_TARGET' });
    expect(result.notes.some(n => n.includes('failed and was skipped'))).toBe(true);
    expect(result.levels).toHaveLength(0);
  });

  it('enforces the query budget (datapreview session budget guard)', async () => {
    // 广扇出目标：每层 5 个新调用方，深度 5 → 查询数超预算被截断
    let seq = 0;
    const run = jest.fn(async (sql: string) => {
      const m = sql.match(/LIKE '(Z[^%]+)%'/);
      const base = m ? m[1] : 'Z';
      seq += 1;
      return { values: Array.from({ length: 5 }, (_, i) => wbRow(classPool(`${base}_C${i}_${seq}`))) };
    });
    const result = await getImpactAnalysis(run, { objectType: 'CLAS', objectName: 'ZCL_ROOT', maxDepth: 5 });
    expect(result.rounds).toBeLessThanOrEqual(12); // MAX_QUERIES_PER_RUN
    expect(result.notes.some(n => n.includes('Query budget'))).toBe(true);
  });

  it('rejects invalid object names and unknown object types before any query', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    await expect(getImpactAnalysis(run, { objectType: 'CLAS', objectName: 'BAD NAME!' })).rejects.toThrow(/is invalid/);
    await expect(getImpactAnalysis(run, { objectType: 'XYZ', objectName: 'ZCL_X' })).rejects.toThrow(/object_type/);
    expect(run).not.toHaveBeenCalled();
  });
});
