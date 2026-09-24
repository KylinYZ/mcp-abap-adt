/**
 * D010INC 加载图 API 测试（矩阵行 analysis.history 的 loads 子操作）：
 * 全套语义对照 VSP pkg/adt/loads.go + pkg/graph/builder_loads.go。SQL 通道
 * 全 mock，不连接 SAP。
 */
import { getLoadGraph, normalizeLoadName } from '../adt/LoadGraphApi';

/** 行工厂：模拟 datapreview 返回的 D010INC 行（列名混合大小写形态）。 */
function row(master: string, include: string, obsolete = '0') {
  return { Master: master, INCLUDE: include, obsolete_in_version: obsolete };
}

function runner(rows: Record<string, unknown>[]) {
  const queries: string[] = [];
  return {
    queries,
    run: jest.fn(async (sql: string) => { queries.push(sql); return { values: rows }; })
  };
}

describe('normalizeLoadName（填充名归一化，VSP NormalizeInclude 移植）', () => {
  it('normalizes padded class/interface pools by suffix', () => {
    expect(normalizeLoadName('ZCL_ORDER===========CP')).toEqual({ objectType: 'CLAS', objectName: 'ZCL_ORDER' });
    expect(normalizeLoadName('ZCL_ORDER===========CT')).toEqual({ objectType: 'CLAS', objectName: 'ZCL_ORDER' });
    expect(normalizeLoadName('ZIF_ORDER==========IU')).toEqual({ objectType: 'INTF', objectName: 'ZIF_ORDER' });
    expect(normalizeLoadName('ZIF_ORDER==========IP')).toEqual({ objectType: 'INTF', objectName: 'ZIF_ORDER' });
  });

  it('normalizes function-group pools and includes', () => {
    expect(normalizeLoadName('SAPLZDEMO_GROUP')).toEqual({ objectType: 'FUGR', objectName: 'ZDEMO_GROUP' });
    expect(normalizeLoadName('LZDEMO_GROUPTOP')).toEqual({ objectType: 'FUGR', objectName: 'ZDEMO_GROUP' });
    expect(normalizeLoadName('LZDEMO_GROUPU01')).toEqual({ objectType: 'FUGR', objectName: 'ZDEMO_GROUP' });
    expect(normalizeLoadName('LZDEMO_GROUPF15')).toEqual({ objectType: 'FUGR', objectName: 'ZDEMO_GROUP' });
    // U27（两位数段）也必须是函数组——VSP 曾因宽松匹配把 LEGACY_REPORT 误判为函数组
    expect(normalizeLoadName('LZDEMO_GROUPU27')).toEqual({ objectType: 'FUGR', objectName: 'ZDEMO_GROUP' });
  });

  it('does not mistake programs ending in a letter-pair for function pools', () => {
    expect(normalizeLoadName('LEGACY_REPORT')).toEqual({ objectType: 'PROG', objectName: 'LEGACY_REPORT' });
  });

  it('treats bare names as programs', () => {
    expect(normalizeLoadName('ZREPORT01')).toEqual({ objectType: 'PROG', objectName: 'ZREPORT01' });
  });
});

describe('getLoadGraph（D010INC 加载图）', () => {
  it('collects object-to-object loads with normalization and drops containment and machinery rows', async () => {
    const db = runner([
      row('ZREPORT01', 'ZREPORT01'),                                   // 自包含：丢弃
      row('ZCL_ORDER===========CP', 'ZCL_ORDER===========CM001'),      // 类池加载自身方法：丢弃
      row('ZCL_ORDER===========CP', 'ZIF_ORDER==========IU'),          // 类加载接口：保留
      row('SAPLZDEMO_GROUP', 'CL_ABAP_TYPEDESCR=============CT'),      // 函数组加载标准类：保留
      row('SAPLZDEMO_GROUP', '<SYSINI>'),                              // 内核机器行：丢弃
      row('SAPLZDEMO_GROUP', '%_CABAP'),                               // 内核机器行：丢弃
      row('~CL_SOME_SERVICE===========HCZ', 'ZIF_ORDER==========IU'),  // 生成伴随池 master：丢弃
      row('ZREPORT01', 'ZREPORT02'),                                   // 程序加载程序：保留
      row('ZREPORT01', 'ZREPORT01OLD', '1')                            // obsolete：丢弃
    ]);
    const result = await getLoadGraph(db.run, { objectName: 'ZREPORT01', direction: 'loads' });

    expect(result.loads).toEqual([
      { from: { objectType: 'PROG', objectName: 'ZREPORT01' }, to: { objectType: 'PROG', objectName: 'ZREPORT02' }, detail: 'LOADS:ZREPORT02' }
    ]);
    expect(result.loadsTotal).toBe(1);
    expect(result.loadedBy).toEqual([]);
    expect(result.notes).toEqual([]);
    // down 方向查询：本名前缀 + SAPL 两种形态一次覆盖
    expect(db.queries[0]).toContain("MASTER LIKE 'ZREPORT01%'");
    expect(db.queries[0]).toContain("MASTER = 'SAPLZREPORT01'");
  });

  it('prefix-safety: does not claim ZCL_ORDER_ITEM loads for ZCL_ORDER (up direction)', async () => {
    const db = runner([
      row('ZCL_ORDER===========CP', 'ZIF_ORDER==========IU'),
      row('ZCL_ORDER_ITEM=========CP', 'ZIF_ORDER==========IU'),  // 兄弟对象：不属于 ZCL_ORDER
      row('ZREPORT_USES_ORDER', 'ZCL_ORDER===========CP')          // up 方向的正主
    ]);
    const result = await getLoadGraph(db.run, { objectName: 'ZCL_ORDER', direction: 'loaded_by' });

    expect(result.loadedBy).toEqual([
      { from: { objectType: 'PROG', objectName: 'ZREPORT_USES_ORDER' }, to: { objectType: 'CLAS', objectName: 'ZCL_ORDER' }, detail: 'LOADS:ZCL_ORDER===========CP' }
    ]);
    expect(db.queries[0]).toContain("INCLUDE LIKE 'ZCL_ORDER%'");
  });

  it('reports a real "no dependencies" note when every row is containment or machinery', async () => {
    const db = runner([
      row('ZREPORT01', 'ZREPORT01'),
      row('ZREPORT01', '<SYSINI>')
    ]);
    const result = await getLoadGraph(db.run, { objectName: 'ZREPORT01', direction: 'loads' });
    expect(result.loadsTotal).toBe(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('containment or kernel machinery');
  });

  it('caps oversized results with a note', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => row('ZREPORT01', `ZTARGET${String(i).padStart(4, '0')}`));
    const db = runner(rows);
    const result = await getLoadGraph(db.run, { objectName: 'ZREPORT01', direction: 'loads' });
    expect(result.loadsTotal).toBe(2000);
    expect(result.notes.some(note => note.includes('2000-row cap'))).toBe(true);
  });

  it('supports both directions and returns the source semantics line', async () => {
    const db = runner([
      row('ZREPORT01', 'ZREPORT02'),
      row('ZREPORT03', 'ZREPORT01')
    ]);
    const result = await getLoadGraph(db.run, { objectName: 'ZREPORT01', direction: 'both' });
    expect(result.loadsTotal).toBe(1);
    expect(result.loadedByTotal).toBe(1);
    expect(result.loads[0].to.objectName).toBe('ZREPORT02');
    expect(result.loadedBy[0].from.objectName).toBe('ZREPORT03');
    expect(result.loadedBy[0].to.objectName).toBe('ZREPORT01');
    expect(result.source).toContain('loads, not calls');
  });

  it('degrades to an empty answer with a note when the datapreview channel fails', async () => {
    const db = { run: jest.fn(async () => { throw new Error('Internal server error'); }) };
    const result = await getLoadGraph(db.run, { objectName: 'ZREPORT01', direction: 'loads' });
    expect(result.loads).toEqual([]);
    expect(result.loadsTotal).toBe(0);
    expect(result.notes[0]).toContain('D010INC lookup failed');
  });

  it('rejects invalid tokens and directions before any query', async () => {
    const db = runner([]);
    await expect(getLoadGraph(db.run, { objectName: 'BAD NAME!' })).rejects.toThrow(/invalid/);
    await expect(getLoadGraph(db.run, { objectName: 'ZREPORT01', direction: 'sideways' })).rejects.toThrow(/direction/);
    expect(db.run).not.toHaveBeenCalled();
  });
});
