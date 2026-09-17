import {
  getCallees,
  bindRunSqlToAdtQuery,
  createCrossReferenceClient,
  normalizeRepositoryName,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_CAP,
  CALLEE_ROW_LIMIT
} from '../adt/CrossReferenceApi.js';
import type {
  CrossReferenceRow,
  GetCalleesInput,
  RunSql
} from '../adt/CrossReferenceApi.js';

/**
 * CrossReferenceApi 只读契约测试（mock runSql 查询通道，绝不连接真实 SAP）。
 * 断言四类内容：
 *   1. SQL 拼装契约：WBCROSSGT/CROSS/TFDIR 模板逐字对齐 VSP callees.go，
 *      对象名进入 WHERE 的模式（LIKE/等值）正确且已大写规范化；
 *   2. 注入防线：一切含引号/分号/注释符/空格的名字在 SQL 生成前被白名单拒绝；
 *   3. 行解析与聚合：DIRECT 过滤、OTYPE/CROSS TYPE→kind 映射、自引用剔除、
 *      合并去重（调用优先）与排序；
 *   4. 容错语义：单表失败聚合 failedSources 不整体失败，两表全失败才抛错；
 *      maxResults 默认/上限/截断标注。
 */

/**
 * 构造按表名路由的 runSql mock：
 * - WBCROSSGT 查询 → wbRows；FROM CROSS 查询 → crossRows；
 * - TFDIR 查询 → tfdirRows（函数模块谓词构造的往返）。
 */
function runSqlRouter(routes: {
  wbRows?: CrossReferenceRow[] | Error;
  crossRows?: CrossReferenceRow[] | Error;
  tfdirRows?: CrossReferenceRow[] | Error;
}): RunSql {
  const resolve = (route: CrossReferenceRow[] | Error | undefined) => {
    if (route instanceof Error) return Promise.reject(route);
    return Promise.resolve(route ?? []);
  };
  return jest.fn((sql: string) => {
    if (sql.includes('FROM WBCROSSGT')) return resolve(routes.wbRows);
    if (sql.includes('FROM CROSS')) return resolve(routes.crossRows);
    if (sql.includes('FROM TFDIR')) return resolve(routes.tfdirRows);
    return Promise.reject(new Error(`unexpected sql in test: ${sql}`));
  }) as unknown as RunSql;
}

/** 取第 N 次 SQL 调用文本（断言拼装契约用）。 */
function sqlAt(runSql: RunSql, index: number): string {
  return (runSql as unknown as jest.Mock).mock.calls[index][0] as string;
}

// ---------- CLAS 场景的 WBCROSSGT 行：覆盖 DIRECT 过滤/自引用/兄弟对象剔除 ----------
const WB_ROWS_FOR_CLAS: CrossReferenceRow[] = [
  // 方法引用：NAME 带 \ME: 组件段 → kind=method、calls=true、component=DO_STUFF
  { INCLUDE: 'ZCL_FOO=====================CM001', OTYPE: 'ME', NAME: 'ZCL_UTILS\\ME:DO_STUFF', DIRECT: 'X' },
  // 类型引用：kind=type、calls=false
  { INCLUDE: 'ZCL_FOO=====CI', OTYPE: 'TY', NAME: 'IF_FOO_BAR', DIRECT: 'X' },
  // INDIRECT 行（DIRECT 非 'X'）：类型引用噪声，必须丢弃
  { INCLUDE: 'ZCL_FOO=====CU', OTYPE: 'TY', NAME: 'SYST_DATUM', DIRECT: '' },
  // 自引用：类引用自己的方法不算 callee
  { INCLUDE: 'ZCL_FOO=====CM001', OTYPE: 'ME', NAME: 'ZCL_FOO\\ME:INIT', DIRECT: 'X' },
  // 兄弟对象：ZCL_FOO_HELPER 与 ZCL_FOO 共享 LIKE 前缀，但 include 归属不属于目标
  { INCLUDE: 'ZCL_FOO_HELPER=====CP', OTYPE: 'TY', NAME: 'OTHER_CLASS', DIRECT: 'X' },
  // 数据引用：kind=data
  { INCLUDE: 'ZCL_FOO=====CU', OTYPE: 'DA', NAME: 'GV_COUNT', DIRECT: 'X' },
  // 未知 OTYPE：原样大写透传，不瞎猜
  { INCLUDE: 'ZCL_FOO=====CI', OTYPE: 'ZZ', NAME: 'ZZ_THING', DIRECT: 'X' }
];

// ---------- CLAS 场景的 CROSS 行：函数模块 + PERFORM 交换 + 空名剔除 ----------
const CROSS_ROWS_FOR_CLAS: CrossReferenceRow[] = [
  // 类对 FM 的调用只出现在 CROSS（VSP callees.go 第 133-136 行实测语义）
  { INCLUDE: 'ZCL_FOO=====CM001', TYPE: 'F', NAME: 'SSFC_BASE64_DECODE', PROG: '' },
  // PERFORM 行：NAME=子例程、PROG=所属程序 → 交换后 name=ZPERFORM_PROG、component=DO_FORM
  { INCLUDE: 'ZCL_FOO=====CM001', TYPE: 'U', NAME: 'DO_FORM', PROG: 'ZPERFORM_PROG' },
  // 空名行：无被引用对象可报告，丢弃
  { INCLUDE: 'ZCL_FOO=====CM001', TYPE: 'R', NAME: '', PROG: '' }
];

describe('CrossReferenceApi getCallees SQL assembly (VSP callees.go contract)', () => {
  it('queries WBCROSSGT and CROSS with the VSP include predicate for a class and aggregates both halves', async () => {
    const runSql = runSqlRouter({ wbRows: WB_ROWS_FOR_CLAS, crossRows: CROSS_ROWS_FOR_CLAS });

    const result = await getCallees(runSql, { objectType: 'CLAS', objectName: 'zcl_foo' });

    // 小写输入规范化为大写后拼入 WHERE（对齐 VSP includePredicate 第 314-322 行）
    expect(sqlAt(runSql, 0)).toBe("SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE INCLUDE LIKE 'ZCL_FOO%'");
    expect(sqlAt(runSql, 1)).toBe("SELECT INCLUDE, TYPE, NAME, PROG FROM CROSS WHERE INCLUDE LIKE 'ZCL_FOO%'");

    // 聚合结果：调用优先（名称升序），其后类型/数据提及（名称升序）
    expect(result).toEqual({
      objectName: 'ZCL_FOO',
      objectType: 'CLAS',
      includePredicate: "INCLUDE LIKE 'ZCL_FOO%'",
      truncated: false,
      sourcesSearched: ['WBCROSSGT', 'CROSS'],
      failedSources: [],
      callees: [
        { name: 'SSFC_BASE64_DECODE', kind: 'function module', direct: true, calls: true, source: 'CROSS' },
        { name: 'ZCL_UTILS', kind: 'method', direct: true, calls: true, source: 'WBCROSSGT', component: 'DO_STUFF' },
        { name: 'ZPERFORM_PROG', kind: 'subroutine', direct: true, calls: true, source: 'CROSS', component: 'DO_FORM' },
        { name: 'GV_COUNT', kind: 'data', direct: true, calls: false, source: 'WBCROSSGT' },
        { name: 'IF_FOO_BAR', kind: 'type', direct: true, calls: false, source: 'WBCROSSGT' },
        { name: 'ZZ_THING', kind: 'ZZ', direct: true, calls: false, source: 'WBCROSSGT' }
      ]
    });
  });

  it('uses an exact include for PROG and an L-prefixed LIKE for FUGR (VSP includePredicate)', async () => {
    const progRun = runSqlRouter({});
    await getCallees(progRun, { objectType: 'PROG', objectName: 'ZREPORT01' });
    expect(sqlAt(progRun, 0)).toBe("SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE INCLUDE = 'ZREPORT01'");
    expect(sqlAt(progRun, 1)).toBe("SELECT INCLUDE, TYPE, NAME, PROG FROM CROSS WHERE INCLUDE = 'ZREPORT01'");

    const fugrRun = runSqlRouter({});
    await getCallees(fugrRun, { objectType: 'FUGR', objectName: 'ZGRP' });
    expect(sqlAt(fugrRun, 0)).toBe("SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE INCLUDE LIKE 'LZGRP%'");
  });

  it('filters FUGR include rows back to the target group (LIKE prefix catches siblings)', async () => {
    const runSql = runSqlRouter({
      wbRows: [
        { INCLUDE: 'LZGRPTOP', OTYPE: 'DA', NAME: 'GV_OK_TOP', DIRECT: 'X' },
        { INCLUDE: 'LZGRPU01', OTYPE: 'DA', NAME: 'GV_OK_U01', DIRECT: 'X' },
        { INCLUDE: 'LZGRPF01', OTYPE: 'DA', NAME: 'GV_OK_F01', DIRECT: 'X' },
        // 前缀碰撞兄弟组 LZGRP2 / SAPLZGRP 主程序 / 非法后缀行都必须剔除
        { INCLUDE: 'LZGRP2TOP', OTYPE: 'DA', NAME: 'GV_SIBLING', DIRECT: 'X' },
        { INCLUDE: 'SAPLZGRP', OTYPE: 'DA', NAME: 'GV_MAINPROG', DIRECT: 'X' },
        { INCLUDE: 'LZGRPXY', OTYPE: 'DA', NAME: 'GV_ODD', DIRECT: 'X' }
      ]
    });

    const result = await getCallees(runSql, { objectType: 'FUGR', objectName: 'ZGRP' });

    // VSP 用 unitForFrame 精确归属；本实现按 include 命名规则（TOP/字母+两位数字）近似
    expect(result.callees.map(c => c.name)).toEqual(['GV_OK_F01', 'GV_OK_TOP', 'GV_OK_U01']);
  });

  it('resolves a function module through TFDIR to its L<group>U<nn> include (VSP functionModuleInclude)', async () => {
    const runSql = runSqlRouter({
      wbRows: [{ INCLUDE: 'LZGRPU05', OTYPE: 'ME', NAME: 'ZCL_CALLED\\ME:RUN', DIRECT: 'X' }],
      // TFDIR：PNAME=主程序 SAPL<组名>，INCLUDE=节号（VSP 实测 BAL_LOG_CREATE→LSBALU15 语义）
      tfdirRows: [{ PNAME: 'SAPLZGRP', INCLUDE: '5' }]
    });

    const result = await getCallees(runSql, { objectType: 'FUNC', objectName: 'Z_FM_X' });

    // 第一次查询是 TFDIR 往返；两表查询用补齐两位节号的精确 include
    expect(sqlAt(runSql, 0)).toBe("SELECT PNAME, INCLUDE FROM TFDIR WHERE FUNCNAME = 'Z_FM_X'");
    expect(sqlAt(runSql, 1)).toBe("SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE INCLUDE = 'LZGRPU05'");
    expect(result.includePredicate).toBe("INCLUDE = 'LZGRPU05'");
    expect(result.callees).toEqual([
      { name: 'ZCL_CALLED', kind: 'method', direct: true, calls: true, source: 'WBCROSSGT', component: 'RUN' }
    ]);
  });

  it('rejects a function module that TFDIR does not know before querying the cross tables', async () => {
    const runSql = runSqlRouter({ tfdirRows: [] });

    await expect(getCallees(runSql, { objectType: 'FUNC', objectName: 'Z_GHOST_FM' }))
      .rejects.toThrow(/Z_GHOST_FM.*TFDIR/);
    // 谓词构造失败是硬错误：只有 TFDIR 一次查询，绝不发出两表查询
    expect((runSql as unknown as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe('CrossReferenceApi getCallees SQL injection defense (repository-name whitelist)', () => {
  it.each([
    ["quote and comment marker", "Z X'--"],
    ['statement separator', 'Z;DROP'],
    ['double quote', 'Z"OR'],
    ['dash comment', 'Z--X'],
    ['block comment opener', 'Z/*X'],
    ['space', 'Z X'],
    ['tab', 'Z\tX'],
    ['backslash', 'Z\\ME']
  ])('rejects %s before any SQL is generated', async (_label, badName) => {
    const runSql = runSqlRouter({ wbRows: [], crossRows: [] });

    // 注入样本必须在白名单闸门被拦：错误里不回显 SQL，也绝不发出任何查询
    await expect(getCallees(runSql, { objectType: 'CLAS', objectName: badName }))
      .rejects.toThrow(/not a repository name/);
    expect((runSql as unknown as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('still accepts namespace slashes and dollar signs that cannot form SQL metacharacters', async () => {
    const runSql = runSqlRouter({});

    await getCallees(runSql, { objectType: 'PROG', objectName: '/sdf/get_app_log' });
    expect(sqlAt(runSql, 0)).toBe("SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE INCLUDE = '/SDF/GET_APP_LOG'");

    await getCallees(runSql, { objectType: 'PROG', objectName: '$GENERATED_1' });
    expect(sqlAt(runSql, 2)).toBe("SELECT INCLUDE, OTYPE, NAME, DIRECT FROM WBCROSSGT WHERE INCLUDE = '$GENERATED_1'");
  });

  it('exposes the same whitelist on normalizeRepositoryName for defense in depth', () => {
    expect(normalizeRepositoryName(' zcl_foo ', 't')).toBe('ZCL_FOO');
    expect(() => normalizeRepositoryName("A'B", 't')).toThrow(/not a repository name/);
    expect(() => normalizeRepositoryName('A;B', 't')).toThrow(/not a repository name/);
    expect(() => normalizeRepositoryName('', 't')).toThrow(/not a repository name/);
    expect(() => normalizeRepositoryName('Z'.repeat(41), 't')).toThrow(/not a repository name/);
  });
});

describe('CrossReferenceApi getCallees type-code mapping (VSP wbCrossKind / crossKind)', () => {
  it.each([
    ['ME', 'method', true],
    ['TY', 'type', false],
    ['DA', 'data', false],
    ['', 'reference', false],
    ['ZZ', 'ZZ', false]
  ])('maps WBCROSSGT OTYPE %s to kind %s (calls=%s)', async (otype, kind, calls) => {
    const runSql = runSqlRouter({
      wbRows: [{ INCLUDE: 'ZPROG', OTYPE: otype, NAME: 'ZTARGET_OBJ', DIRECT: 'X' }]
    });
    const result = await getCallees(runSql, { objectType: 'PROG', objectName: 'ZPROG' });
    expect(result.callees).toEqual([
      { name: 'ZTARGET_OBJ', kind, direct: true, calls, source: 'WBCROSSGT' }
    ]);
  });

  it.each([
    ['F', 'function module', true],
    ['R', 'report', true],
    ['T', 'transaction', true],
    ['U', 'subroutine', true],
    ['P', 'program', true],
    ['D', 'dialog module', true],
    ['', 'reference', false],
    ['Q', 'Q', false]
  ])('maps CROSS TYPE %s to kind %s (calls=%s)', async (type, kind, calls) => {
    const runSql = runSqlRouter({
      crossRows: [{ INCLUDE: 'ZPROG', TYPE: type, NAME: 'ZCROSS_OBJ', PROG: '' }]
    });
    const result = await getCallees(runSql, { objectType: 'PROG', objectName: 'ZPROG' });
    expect(result.callees).toEqual([
      { name: 'ZCROSS_OBJ', kind, direct: true, calls, source: 'CROSS' }
    ]);
  });
});

describe('CrossReferenceApi getCallees merge, self-reference and truncation', () => {
  it('merges duplicate objects and upgrades a type mention to a call', async () => {
    const runSql = runSqlRouter({
      wbRows: [
        // 同一对象两行：类型提及行 + 调用行 → 合并为一条，调用侧的 kind/calls 胜出
        { INCLUDE: 'ZPROG', OTYPE: 'TY', NAME: 'ZCL_UTILS', DIRECT: 'X' },
        { INCLUDE: 'ZPROG', OTYPE: 'ME', NAME: 'ZCL_UTILS\\ME:RUN', DIRECT: 'X' }
      ]
    });
    const result = await getCallees(runSql, { objectType: 'PROG', objectName: 'ZPROG' });

    expect(result.callees).toEqual([
      { name: 'ZCL_UTILS', kind: 'method', direct: true, calls: true, source: 'WBCROSSGT', component: 'RUN' }
    ]);
  });

  it('returns an empty list without error when both tables are readable but carry no rows', async () => {
    const runSql = runSqlRouter({});
    const result = await getCallees(runSql, { objectType: 'PROG', objectName: 'ZLEAF' });

    expect(result.callees).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.sourcesSearched).toEqual(['WBCROSSGT', 'CROSS']);
    expect(result.failedSources).toEqual([]);
  });

  it(`defaults maxResults to ${DEFAULT_MAX_RESULTS} and marks the truncation`, async () => {
    // 构造 250 个不同对象（全部 data 提及），默认上限 200 → 截断并标注
    const rows = Array.from({ length: 250 }, (_, i) => ({
      INCLUDE: 'ZPROG', OTYPE: 'DA', NAME: `ZT${String(i).padStart(3, '0')}`, DIRECT: 'X'
    }));
    const result = await getCallees(runSqlRouter({ wbRows: rows }), { objectType: 'PROG', objectName: 'ZPROG' });

    expect(result.callees).toHaveLength(DEFAULT_MAX_RESULTS);
    expect(result.truncated).toBe(true);
    expect(result.callees[0].name).toBe('ZT000'); // 截断发生在排序之后，保留调用优先+名称序
  });

  it(`clamps maxResults to the hard cap of ${MAX_RESULTS_CAP} instead of failing`, async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      INCLUDE: 'ZPROG', OTYPE: 'DA', NAME: `ZT${String(i).padStart(4, '0')}`, DIRECT: 'X'
    }));
    const result = await getCallees(runSqlRouter({ wbRows: rows }), {
      objectType: 'PROG',
      objectName: 'ZPROG',
      maxResults: 5000
    });

    expect(result.callees).toHaveLength(MAX_RESULTS_CAP);
    expect(result.truncated).toBe(true);
  });

  it('honors an explicit smaller maxResults', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      INCLUDE: 'ZPROG', OTYPE: 'DA', NAME: `ZT${String(i).padStart(3, '0')}`, DIRECT: 'X'
    }));
    const result = await getCallees(runSqlRouter({ wbRows: rows }), {
      objectType: 'PROG',
      objectName: 'ZPROG',
      maxResults: 10
    });

    expect(result.callees).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});

describe('CrossReferenceApi getCallees fault tolerance (VSP failures/gaps semantics)', () => {
  it('keeps the CROSS half and reports the failed source when WBCROSSGT fails', async () => {
    const runSql = runSqlRouter({
      wbRows: new Error('HTTP 403 table read blocked'),
      crossRows: CROSS_ROWS_FOR_CLAS
    });

    const result = await getCallees(runSql, { objectType: 'CLAS', objectName: 'ZCL_FOO' });

    // 单表失败不整体失败：返回已得结果 + failedSources（缺口必须随行返回，
    // 否则"读不到 CROSS"会被误读成"没有 FM 调用"）
    expect(result.sourcesSearched).toEqual(['CROSS']);
    expect(result.failedSources).toEqual([
      { source: 'WBCROSSGT', reason: 'HTTP 403 table read blocked' }
    ]);
    expect(result.callees.map(c => c.name)).toEqual(['SSFC_BASE64_DECODE', 'ZPERFORM_PROG']);
  });

  it('fails the call only when both tables are unreadable and nothing was learned', async () => {
    const runSql = runSqlRouter({
      wbRows: new Error('WBCROSSGT down'),
      crossRows: new Error('CROSS down')
    });

    // 两表全败且无结果：查询失败与查到空合并后不可区分但含义相反，必须抛错
    await expect(getCallees(runSql, { objectType: 'PROG', objectName: 'ZPROG' }))
      .rejects.toThrow(/cross-reference tables could not be read/);
  });

  it('keeps the error reason single-line and bounded in failedSources', async () => {
    const runSql = runSqlRouter({
      wbRows: new Error(`multi\nline\terror ${'x'.repeat(300)}`),
      crossRows: []
    });
    const result = await getCallees(runSql, { objectType: 'PROG', objectName: 'ZPROG' });

    expect(result.failedSources).toHaveLength(1);
    expect(result.failedSources[0].reason).not.toMatch(/\n/);
    expect(result.failedSources[0].reason.length).toBeLessThanOrEqual(203); // 200 + 省略号
  });

  it('rejects invalid objectType and malformed input before any query', async () => {
    const runSql = runSqlRouter({});
    await expect(getCallees(runSql, { objectType: 'TABL' } as unknown as GetCalleesInput))
      .rejects.toThrow(/objectType/);
    await expect(getCallees(runSql, null as unknown as GetCalleesInput))
      .rejects.toThrow(/input object is required/);
    expect((runSql as unknown as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe('CrossReferenceApi client binding', () => {
  it('binds runQuery-backed channels with decode=true and the VSP row limit by default', async () => {
    const client = { runQuery: jest.fn().mockResolvedValue({ columns: [], values: [{ NAME: 'X' }] }) };
    const runSql = bindRunSqlToAdtQuery(client);

    expect(await runSql('SELECT 1')).toEqual([{ NAME: 'X' }]);
    // 默认行数上限对齐 VSP calleeRowLimit=500；decode=true 保证 DIRECT='X' 等值可判
    expect(client.runQuery).toHaveBeenCalledWith('SELECT 1', CALLEE_ROW_LIMIT, true);
  });

  it('maps a missing values payload to an empty row list and honors a custom row limit', async () => {
    const client = { runQuery: jest.fn().mockResolvedValue({}) };
    const runSql = bindRunSqlToAdtQuery(client, 42);

    expect(await runSql('SELECT 1')).toEqual([]);
    expect(client.runQuery).toHaveBeenCalledWith('SELECT 1', 42, true);
  });

  it('exposes getCallees through the narrow CrossReferenceClient', async () => {
    const runSql = runSqlRouter({ wbRows: [], crossRows: [] });
    const client = createCrossReferenceClient(runSql);

    const result = await client.getCallees({ objectType: 'PROG', objectName: 'ZLEAF' });
    expect(result.objectName).toBe('ZLEAF');
  });
});
