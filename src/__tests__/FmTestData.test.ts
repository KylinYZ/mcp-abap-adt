/**
 * 函数模块测试数据目录 API 测试（diagnostics.knowledge-queries 的
 * fm_test_data 目录层子集）。SQL 通道全 mock，不连接 SAP。
 * 行形态对齐真机取证（2026-09-25，sap-demo EUFUNC 实查）。
 */
import { getFmTestDataSets, createFmTestDataClient } from '../adt/FmTestDataApi';

const row = (overrides: Record<string, unknown>) => ({
  NAME: 'Z_MCP_SM21_READ', GRUPPE: 'ZMCP_TOOLS', NUMMER: '', AUTOR: '', DATUM: '', ZEIT: '',
  ...overrides
});

describe('getFmTestDataSets（EUFUNC 目录层）', () => {
  it('lists saved sets with metadata, separates the 999 directory row, and reports the group', async () => {
    const run = jest.fn(async () => ({ values: [
      row({ NUMMER: '001', AUTOR: 'DEVUSER', DATUM: '20260925', ZEIT: '101500' }),
      row({ NUMMER: '001', AUTOR: 'DEVUSER', DATUM: '20260925', ZEIT: '101500' }), // SRTF2 续块 → 去重
      row({ NUMMER: '999', AUTOR: 'SAP', DATUM: '20260901', ZEIT: '090000' })
    ] }));
    const result = await getFmTestDataSets(run, { function: 'z_mcp_sm21_read' });

    expect(result.function).toBe('Z_MCP_SM21_READ');
    expect(result.group).toBe('ZMCP_TOOLS');
    expect(result.directory).toMatchObject({ number: '999', author: 'SAP', date: '20260901' });
    expect(result.sets).toEqual([
      { number: '001', author: 'DEVUSER', date: '20260925', time: '101500' }
    ]);
    expect(result.notes[0]).toContain('Directory view only');
    // SQL：relid='FL' + name 精确匹配，引号包裹
    const sql = (run.mock.calls[0] as unknown as [string, number])[0];
    expect(sql).toContain("relid = 'FL'");
    expect(sql).toContain("name = 'Z_MCP_SM21_READ'");
  });

  it('reports sets without a 999 directory row via notes', async () => {
    const run = jest.fn(async () => ({ values: [row({ NUMMER: '002', AUTOR: 'DEVUSER' })] }));
    const result = await getFmTestDataSets(run, { function: 'Z_MCP_SM21_READ' });
    expect(result.sets).toEqual([{ number: '002', author: 'DEVUSER' }]);
    expect(result.directory).toBeUndefined();
    expect(result.notes.some(n => n.includes('No directory row'))).toBe(true);
  });

  it('reports an empty directory for a function module without saved test data', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    const result = await getFmTestDataSets(run, { function: 'Z_MCP_SM21_READ' });
    expect(result.sets).toEqual([]); expect(result.directory).toBeUndefined();
    expect(result.notes).toHaveLength(2); // 声明 + 无 999 目录行提示
  });

  it('degrades to an empty directory with a note when the datapreview channel fails', async () => {
    const run = jest.fn(async () => { throw new Error('Internal server error'); });
    const result = await getFmTestDataSets(run, { function: 'Z_MCP_SM21_READ' });
    expect(result.sets).toEqual([]);
    expect(result.notes.some(n => n.includes('EUFUNC lookup failed'))).toBe(true);
  });

  it('rejects invalid function names before any query', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    await expect(getFmTestDataSets(run, { function: 'BAD NAME!' })).rejects.toThrow(/invalid/);
    await expect(getFmTestDataSets(run, { function: '' })).rejects.toThrow(/invalid/);
    expect(run).not.toHaveBeenCalled();
  });

  it('wires the client channel with decode=false (真机取证：DATS 列 decode=true 会转 Date 损坏 date 元数据)', async () => {
    // 2026-09-28 真机实证（fm-test-data-clustd-real-dev-verified）：EUFUNC.DATUM
    // 在 datapreview 元数据中报 type='D'，decode=true 把它转成 JS Date，
    // date 字段退化成英文日期串。接线必须固定 decode=false 保持原样字符串。
    const runQuery = jest.fn(async (_sqlQuery: string, _rowNumber?: number, _decode?: boolean) => ({ values: [row({ NUMMER: '001', DATUM: '20260925' })] }));
    const client = createFmTestDataClient({ runQuery });
    const result = await client.getFmTestDataSets({ function: 'C162_SPEC_GET_BY_ID' });
    expect(result.sets[0].date).toBe('20260925');
    expect(runQuery.mock.calls[0][2]).toBe(false); // 第三参 decode 固定 false
  });
});

/* ==========================================================================
 * 内容层（includePayload=true，2026-10-07 集群解码器工程轮）
 * 合成 V6 集群（UTF-16 码页 4103）作为 EUFUNC 行的 CLUSTD hex；字节构造与
 * ClusterDataDecoder.test.ts 的向量同思路，全部自造、零 fixture 复制。
 * ========================================================================== */
import { parseCluster } from '../adt/ClusterDataDecoder';

function u32be(v: number): number[] { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) { const u = ch.codePointAt(0)!; out.push(u & 0xff, (u >> 8) & 0xff); }
  return out;
}
/** V6 elementary CHAR 对象（kind 1，行长按 UTF-16 字节算）。 */
function v6CharObject(name: string, value: string): number[] {
  const bytes = utf16le(value);
  const head = new Array<number>(32).fill(0);
  head[0] = 1; head[1] = 0x00; head[11] = [...name].length;
  head.splice(3, 4, ...u32be(bytes.length));
  return [...head, ...utf16le(name), 0xbc, ...u32be(bytes.length), ...bytes, 0xbd];
}
/** V6 顶层 TABLE 对象（kind 6），行类型为多列 CHAR（每列 UTF-16、按列宽逐列
 *  定长补空格），行按列给值。 */
function v6CharTable(name: string, colWidths: number[], rows: string[][]): number[] {
  const rowBytes = colWidths.reduce((a, w) => a + w * 2, 0);
  const head = new Array<number>(32).fill(0);
  head[0] = 6; head[1] = 0x0e; head[11] = [...name].length;
  head.splice(3, 4, ...u32be(rowBytes));
  const body: number[] = [
    ...head, ...utf16le(name),
    0xad, 0x0e, 0x00, ...u32be(rowBytes),
    ...colWidths.flatMap(w => [0xaa, 0x00, 0x00, ...u32be(w * 2)]),
    0xae, 0x0e, 0x00, ...u32be(rowBytes),
    0xbe, ...u32be(rowBytes), ...u32be(rows.length),
    ...rows.flatMap(r => {
      const bytes = r.flatMap((cell, i) => utf16le(cell.padEnd(colWidths[i]!).slice(0, colWidths[i]!)));
      return [0xbc, ...u32be(bytes.length), ...bytes, 0xbd];
    }),
    0xbf
  ];
  return body;
}
/** 拼 V6 明文集群并 hex 化（EU FUNC.CLUSTD 形态）。 */
function clusterHex(objects: number[][]): string {
  const head = new Array<number>(16).fill(0);
  head[0] = 0xff; head[1] = 6; head[4] = 1;
  '4103'.split('').forEach((c, i) => { head[8 + i] = c.charCodeAt(0); });
  const bytes = Uint8Array.from([...head, ...objects.flat(), 0x04]);
  parseCluster(bytes); // 自证向量合法（构造器与解码器互为回归）
  return Buffer.from(bytes).toString('hex');
}

describe('getFmTestDataSets（includePayload=true 内容层）', () => {
  const payloadRow = (overrides: Record<string, unknown>) => row({
    SRTF2: '0', CLUSTR: 0, CLUSTD: '', ...overrides
  });

  it('decodes set payloads into inputs/outputs/runtime/rc and the saved interface snapshot', async () => {
    // 目录集群（999）：TE_DATADIR 一行 = [编号,?,?,日期,时间,标题]；FDESC_COPY 一行 = [名,DDIC,类型,长,,,类别]
    const directoryCluster = clusterHex([
      v6CharTable('TE_DATADIR', [3, 1, 1, 8, 6, 20], [['001', '', '', '20261007', '101500', 'SMOKE SET']]),
      v6CharTable('FDESC_COPY', [10, 10, 4, 6, 1, 1, 1], [['IV_INPUT', 'IV_INPUT', 'CHAR', '10', '', '', 'I']])
    ]);
    // 测试集集群（001）：导入参数 + 运行时 + 返回码
    const setCluster = clusterHex([
      v6CharObject('%_IIV_INPUT', 'HELLO'),
      v6CharObject('TIME1', '42'),
      v6CharObject('V_RC', '0')
    ]);
    const run = jest.fn(async () => ({ values: [
      payloadRow({ NUMMER: '001', AUTOR: 'DEVUSER', SRTF2: '0', CLUSTR: Buffer.from(setCluster, 'hex').length, CLUSTD: setCluster }),
      payloadRow({ NUMMER: '999', AUTOR: 'SAP', SRTF2: '0', CLUSTR: Buffer.from(directoryCluster, 'hex').length, CLUSTD: directoryCluster })
    ] }));
    const result = await getFmTestDataSets(run, { function: 'Z_MCP_SM21_READ', includePayload: true });

    // SQL 带 payload 列
    const sql = (run.mock.calls[0] as unknown as [string, number])[0];
    expect(sql).toContain('srtf2, clustr, clustd');
    // 测试集内容
    const set = result.sets[0]!;
    expect(set.inputs).toEqual({ IV_INPUT: 'HELLO' });
    expect(set.runtime).toBe('42 µs');
    expect(set.rc).toBe('0');
    expect(set.title).toBe('SMOKE SET');
    // 接口快照
    expect(result.interface).toEqual([{ name: 'IV_INPUT', ddic: 'IV_INPUT', type: 'CHAR', length: '10', kind: 'I' }]);
    // notes 不再出现"未实现"声明
    expect(result.notes.join(' ')).not.toContain('not implemented');
  });

  it('keeps the directory entry and records a note when one set fails to decode', async () => {
    const run = jest.fn(async () => ({ values: [
      payloadRow({ NUMMER: '001', AUTOR: 'DEVUSER', SRTF2: '0', CLUSTR: 4, CLUSTD: 'ZZNOTHEX' }),
      payloadRow({ NUMMER: '002', AUTOR: 'DEVUSER', SRTF2: '0', CLUSTR: Buffer.from(clusterHex([v6CharObject('%_IX', 'V')]), 'hex').length, CLUSTD: clusterHex([v6CharObject('%_IX', 'V')]) })
    ] }));
    const result = await getFmTestDataSets(run, { function: 'Z_MCP_SM21_READ', includePayload: true });
    expect(result.sets).toHaveLength(2); // 坏集条目保留
    expect(result.sets[0]!.inputs).toBeUndefined();
    expect(result.notes.some(n => n.startsWith('set 001: cluster decode failed'))).toBe(true);
    expect(result.sets[1]!.inputs).toEqual({ X: 'V' });
  });

  it('does not query payload columns when includePayload is not set', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    await getFmTestDataSets(run, { function: 'Z_MCP_SM21_READ' });
    const sql = (run.mock.calls[0] as unknown as [string, number])[0];
    expect(sql).not.toContain('clustd');
  });
});
