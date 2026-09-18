import {
  getAbapDocumentation,
  searchImgActivities,
  getImgActivity,
  createKnowledgeQueriesClient
} from '../adt/KnowledgeQueriesApi.js';
import type { KnowledgeQueryRunner } from '../adt/KnowledgeQueriesApi.js';

/**
 * KnowledgeQueriesApi 只读契约测试（mock SQL 通道，绝不连接真实 SAP）。
 * 断言四类内容（标注对齐的 VSP 来源）：
 *   1. SQL 拼装契约：DOKIL 索引、DOKTL 最新版本两段查询、CUS_IMGACT/
 *      TNODEIMGT 检索、TNODEIMGR 引用 + TNODEIMG/TNODEIMGT 递归；
 *   2. 注入防线：控制字符/引号进入查询前拒绝；
 *   3. 解析：正文行、截断、索引条目、活动 tcode、IMG 活动详情与路径串；
 *   4. 边界 notes（fm_test_data/cluster_read 不在子集）与降级容错。
 */

function runnerMock(routes: Array<{ match: RegExp; rows: Record<string, unknown>[] }>) {
  const calls: string[] = [];
  const run = jest.fn(async (sql: string, limit?: number) => {
    calls.push(sql);
    void limit;
    const route = routes.find(r => r.match.test(sql));
    if (!route) throw new Error(`unexpected sql: ${sql}`);
    return { values: route.rows };
  });
  return Object.assign(run, { calls }) as unknown as KnowledgeQueryRunner & { calls: string[] };
}

describe('getAbapDocumentation (VSP docLines/DocumentationIndex port)', () => {
  it('reads the latest version lines with truncation support', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      LINE: i + 1,
      DOKFORMAT: i === 0 ? 'U1' : '',
      DOKTEXT: `line ${i + 1}`
    }));
    const runner = runnerMock([
      { match: /FROM doktl WHERE id = 'DE' AND object = 'ZDE_TEST'.*dokversion DESCENDING/, rows: [{ DOKVERSION: 2 }] },
      { match: /FROM doktl WHERE id = 'DE' AND object = 'ZDE_TEST'.*dokversion = '0002'/, rows }
    ]);
    const result = await getAbapDocumentation(runner, {
      docClass: 'DE', docObject: 'ZDE_TEST', language: 'DE'
    });
    // 最新版本两段查询：先取 max 版本再读该版本行
    expect(runner.calls[0]).toContain("SELECT dokversion FROM doktl WHERE id = 'DE' AND object = 'ZDE_TEST' AND langu = 'D' ORDER BY dokversion DESCENDING");
    expect(runner.calls[1]).toContain("dokversion = '0002' ORDER BY line");
    expect(result.version).toBe(2);
    expect(result.lines).toEqual([
      { line: 1, format: 'U1', text: 'line 1' },
      { line: 2, format: '', text: 'line 2' },
      { line: 3, format: '', text: 'line 3' }
    ]);
    expect(result.mode).toBe('content');
  });

  it('returns the documentation index across classes and languages', async () => {
    const runner = runnerMock([
      {
        match: /FROM dokil/,
        rows: [
          { ID: 'DE', OBJECT: 'ZDE_TEST', LANGU: 'D', VERSION: 2, TXTLINES: 3 },
          { ID: 'DE', OBJECT: 'ZDE_TEST', LANGU: 'E', VERSION: 1, TXTLINES: 2 }
        ]
      }
    ]);
    const result = await getAbapDocumentation(runner, {
      docClass: 'DE', docObject: 'ZDE_TEST', language: 'EN', mode: 'index'
    });
    expect(runner.calls[0]).toContain('SELECT id, object, langu, version, txtlines FROM dokil WHERE object = \'ZDE_TEST\' ORDER BY id, langu');
    expect(result.mode).toBe('index');
    expect(result.index).toEqual([
      { docClass: 'DE', language: 'D', version: 2, lines: 3 },
      { docClass: 'DE', language: 'E', version: 1, lines: 2 }
    ]);
  });

  it('rejects a missing document with a clear error', async () => {
    const runner = runnerMock([{ match: /FROM doktl/, rows: [] }]);
    await expect(
      getAbapDocumentation(runner, { docClass: 'DE', docObject: 'ZDE_NONE', language: 'EN' })
    ).rejects.toThrow(/no DE documentation for ZDE_NONE in language EN/);
  });

  it('rejects control characters and oversized tokens before any query', async () => {
    const runner = runnerMock([]);
    await expect(getAbapDocumentation(runner, { docObject: "Z';--", docClass: 'DE' }))
      .rejects.toThrow(/docObject ".*" is invalid/);
    await expect(getAbapDocumentation(runner, { docObject: 'ZDE', docClass: 'TOOLONGCLASS' }))
      .rejects.toThrow(/docClass .* is invalid/);
    await expect(getAbapDocumentation(runner, { docObject: 'ZDE', docClass: 'DE', language: 'CHN' }))
      .rejects.toThrow(/language key/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('searchImgActivities (VSP IMGSearch simplified port)', () => {
  it('searches activities then fills tcodes, then folders', async () => {
    const runner = runnerMock([
      { match: /FROM cus_imgact/, rows: [{ ACTIVITY: 'FCML_FIAACO', TEXT: 'Depreciation posting' }] },
      { match: /FROM cus_imgach/, rows: [{ ACTIVITY: 'FCML_FIAACO', TCODE: 'FCMLSTART' }] },
      { match: /FROM tnodeimgt/, rows: [{ NODE_ID: 'NODE1', TEXT: 'Depreciation folder' }] }
    ]);
    const result = await searchImgActivities(runner, { text: 'Depreciation', language: 'EN' });
    // LIKE 通配自动包 %
    expect(runner.calls[0]).toContain("text LIKE '%Depreciation%'");
    expect(runner.calls[1]).toContain("activity IN ('FCML_FIAACO')");
    expect(result.count).toBe(2);
    expect(result.nodes[0]).toEqual({
      type: 'activity', text: 'Depreciation posting', activity: 'FCML_FIAACO', tcode: 'FCMLSTART'
    });
    expect(result.nodes[1]).toEqual({ type: 'folder', text: 'Depreciation folder', nodeId: 'NODE1' });
    expect(result.notes[0]).toContain('getImgActivity');
  });

  it('wraps a plain word with % wildcards when no wildcard is given', async () => {
    const runner = runnerMock([
      { match: /FROM cus_imgact/, rows: [] },
      { match: /FROM tnodeimgt/, rows: [] }
    ]);
    await searchImgActivities(runner, { text: 'anlage', language: 'DE', limit: 10 });
    expect(runner.calls[0]).toContain("spras = 'D'");
    expect(runner.calls[0]).toContain("text LIKE '%anlage%'");
  });

  it('degrades without tcodes when CUS_IMGACH is restricted (dedicated-DEV observation)', async () => {
    // 专用 DEV 实测：CUS_IMGACH 数据读取 Internal server error（datapreview 限制）
    const base = runnerMock([
      { match: /FROM cus_imgact/, rows: [{ ACTIVITY: 'BW_DOCUMENT_RFC', TEXT: 'Anlage einer RFC-Destination' }] },
      { match: /FROM tnodeimgt/, rows: [] }
    ]);
    const restricted: KnowledgeQueryRunner = async (sql: string, rowLimit?: number) => {
      if (sql.toLowerCase().includes('from cus_imgach')) throw new Error('Internal server error');
      return base(sql, rowLimit ?? 10);
    };
    const result = await searchImgActivities(restricted, { text: 'Anlage*', language: 'DE' });
    // 活动检索主语义不受影响，tcode 缺省 + notes 标注
    expect(result.nodes).toEqual([{
      type: 'activity', text: 'Anlage einer RFC-Destination', activity: 'BW_DOCUMENT_RFC'
    }]);
    expect(result.notes.some(n => n.includes('CUS_IMGACH'))).toBe(true);
  });

  it('rejects control characters and empty text', async () => {
    const runner = runnerMock([]);
    await expect(searchImgActivities(runner, { text: 'a\nb' })).rejects.toThrow(/control characters/);
    await expect(searchImgActivities(runner, { text: '' })).rejects.toThrow(/text is required/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('getImgActivity (VSP IMGActivity/imgPaths port)', () => {
  /** 引用节点 → 父链的走查桩：nodeId → (parent, text)。 */
  function treeMock(leaves: {
    base: Record<string, unknown>
    text?: Record<string, unknown>
    refs: string[]
    nodes: Record<string, { parent: string; texts?: Record<string, unknown>[] }>
    doc?: { version: Record<string, unknown>[]; lines: Record<string, unknown>[] }
  }) {
    return runnerMock([
      { match: /FROM cus_imgach WHERE activity = /, rows: [leaves.base] },
      { match: /FROM cus_imgact/, rows: leaves.text ? [leaves.text] : [] },
      { match: /FROM tnodeimgr/, rows: leaves.refs.map(nodeId => ({ NODE_ID: nodeId })) },
      ...Object.entries(leaves.nodes).flatMap(([nodeId, node]) => [
        { match: new RegExp(`FROM tnodeimg WHERE node_id = '${nodeId}'`), rows: [{ PARENT_ID: node.parent }] },
        { match: new RegExp(`FROM tnodeimgt WHERE node_id = '${nodeId}'`), rows: node.texts ?? [] }
      ]),
      ...(leaves.doc ? [
        { match: /FROM doktl WHERE id = 'HY'.*dokversion DESCENDING/, rows: leaves.doc.version },
        { match: /FROM doktl WHERE id = 'HY'.*ORDER BY line/, rows: leaves.doc.lines }
      ] : [])
    ]);
  }

  it('assembles base, text, sorted menu paths and HY documentation', async () => {
    const runner = treeMock({
      base: { ACTIVITY: 'APOC_C_FORMV', TCODE: 'APOC_FORMV', DOCU_ID: 'SIMGAPOC_FORMV' },
      text: { TEXT: 'Manage Forms for Payment Runs' },
      refs: ['CHILD1', 'CHILD2'],
      nodes: {
        CHILD1: { parent: 'ROOT1', texts: [{ TEXT: 'Form Templates' }] },
        ROOT1: { parent: '', texts: [{ TEXT: 'Customizing Roots' }] },
        CHILD2: { parent: '', texts: [{ TEXT: 'Application Forms' }] }
      },
      doc: {
        version: [{ DOKVERSION: 3 }],
        lines: [{ LINE: 1, DOKFORMAT: 'U1', DOKTEXT: 'Form overview' }]
      }
    });
    const result = await getImgActivity(runner, { activity: 'apoc_c_formv', language: 'EN' });
    expect(result.activity).toBe('APOC_C_FORMV');
    expect(result.transaction).toBe('APOC_FORMV');
    expect(result.text).toBe('Manage Forms for Payment Runs');
    expect(result.docObject).toBe('SIMGAPOC_FORMV');
    // 路径根在前、按字典序排序；无文本的链被跳过
    expect(result.paths).toEqual(['Application Forms', 'Customizing Roots > Form Templates']);
    expect(result.documentation).toEqual({
      version: 3, lines: [{ line: 1, format: 'U1', text: 'Form overview' }]
    });
  });

  it('tolerates missing text, restricted TNODEIMGR and absent documentation via notes', async () => {
    const base = runnerMock([
      { match: /FROM cus_imgach WHERE activity = /, rows: [{ ACTIVITY: 'X1', TCODE: '', DOCU_ID: '' }] },
      { match: /FROM tnodeimgr/, rows: [] }
    ]);
    const degraded: KnowledgeQueryRunner = async (sql, limit) => {
      if (sql.includes('from cus_imgact')) throw new Error('Internal server error');
      return base(sql, limit ?? 10);
    };
    const result = await getImgActivity(degraded, { activity: 'X1' });
    expect(result.text).toBeUndefined();
    expect(result.transaction).toBeUndefined();
    expect(result.docObject).toBeUndefined();
    expect(result.documentation).toBeUndefined();
    expect(result.paths).toEqual([]);
    expect(result.notes.some(n => n.includes('CUS_IMGACT'))).toBe(true);
  });

  it('stops the parent walk on cycles and depth limits', async () => {
    const runner = treeMock({
      base: { ACTIVITY: 'CYC1', TCODE: '', DOCU_ID: '' },
      refs: ['A'],
      nodes: {
        // A → B → A 的环：seen 集合必须终止走查
        A: { parent: 'B', texts: [{ TEXT: 'A text' }] },
        B: { parent: 'A', texts: [{ TEXT: 'B text' }] }
      }
    });
    const result = await getImgActivity(runner, { activity: 'CYC1' });
    expect(result.paths).toEqual(['B text > A text']);
  });

  it('caps expanded references at maxRefs (session query budget control)', async () => {
    const runner = treeMock({
      base: { ACTIVITY: 'X2', TCODE: '', DOCU_ID: '' },
      refs: ['A', 'B'],
      nodes: {
        A: { parent: '', texts: [{ TEXT: 'Path A' }] },
        B: { parent: '', texts: [{ TEXT: 'Path B' }] }
      }
    });
    const result = await getImgActivity(runner, { activity: 'X2', maxRefs: 1 });
    expect(result.paths).toEqual(['Path A']);
  });

  it('rejects unknown activities and invalid names before/at the first query', async () => {
    const runner = runnerMock([{ match: /FROM cus_imgach WHERE activity = /, rows: [] }]);
    await expect(getImgActivity(runner, { activity: 'NOPE' })).rejects.toThrow(/does not exist/);
    const clean = runnerMock([]);
    await expect(getImgActivity(clean, { activity: "Z';--" })).rejects.toThrow(/activity ".*" is invalid/);
    expect(clean.calls).toHaveLength(0);
  });
});

describe('createKnowledgeQueriesClient binding', () => {
  it('binds runQuery with decode=true', async () => {
    const runQuery = jest.fn(async () => ({ values: [] }));
    const client = createKnowledgeQueriesClient({ runQuery });
    await client.searchImgActivities({ text: 'x' });
    expect(runQuery).toHaveBeenCalledWith(expect.stringContaining('cus_imgact'), 40, true);
  });

  it('does not retry a failed query (datapreview per-session query budget)', async () => {
    const runQuery = jest.fn(async () => { throw new Error('Request failed with status code 400'); });
    const client = createKnowledgeQueriesClient({ runQuery });
    await expect(client.searchImgActivities({ text: 'x' })).rejects.toThrow('Request failed with status code 400');
    // 预算耗尽型失败重试只会进一步消耗预算：同一查询失败后不重发
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});
