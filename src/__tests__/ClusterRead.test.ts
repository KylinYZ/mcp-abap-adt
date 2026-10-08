/**
 * ClusterReadApi 测试（cluster_read 收编：任意 INDX 型集群表通用读取）。
 * SQL 通道全 mock；解码复用真实 ClusterDataDecoder（合成集群字节，与
 * FmTestData.test.ts 的构造器同思路）。
 */
import { readClusterTable, clusterTableInfo } from '../adt/ClusterReadApi';

const DD03L_ROWS = [
  { FIELDNAME: 'MANDT', KEYFLAG: 'X', DATATYPE: 'CLNT' },
  { FIELDNAME: 'RELID', KEYFLAG: 'X', DATATYPE: 'CHAR' },
  { FIELDNAME: 'NAME', KEYFLAG: 'X', DATATYPE: 'CHAR' },
  { FIELDNAME: 'SRTF2', KEYFLAG: '', DATATYPE: 'INT4' },
  { FIELDNAME: 'CLUSTR', KEYFLAG: '', DATATYPE: 'INT2' },
  { FIELDNAME: 'CLUSTD', KEYFLAG: '', DATATYPE: 'LRAW' }
];

function u32be(v: number): number[] { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) { const u = ch.codePointAt(0)!; out.push(u & 0xff, (u >> 8) & 0xff); }
  return out;
}
function v6CharObject(name: string, value: string): number[] {
  const bytes = utf16le(value);
  const head = new Array<number>(32).fill(0);
  head[0] = 1; head[1] = 0x00; head[11] = [...name].length;
  head.splice(3, 4, ...u32be(bytes.length));
  return [...head, ...utf16le(name), 0xbc, ...u32be(bytes.length), ...bytes, 0xbd];
}
function clusterHex(objects: number[][]): string {
  const head = new Array<number>(16).fill(0);
  head[0] = 0xff; head[1] = 6; head[4] = 1;
  '4103'.split('').forEach((c, i) => { head[8 + i] = c.charCodeAt(0); });
  return Buffer.from(Uint8Array.from([...head, ...objects.flat(), 0x04])).toString('hex');
}

describe('clusterTableInfo（DD03L 动态结构发现）', () => {
  it('extracts key columns (client excluded), validates the three fragment columns', async () => {
    const run = jest.fn(async () => ({ values: DD03L_ROWS }));
    const info = await clusterTableInfo(run, 'MYCLUSTER', 'readClusterTable');
    expect(info.name).toBe('MYCLUSTER');
    expect(info.client).toBe('MANDT');
    expect(info.keys).toEqual(['RELID', 'NAME']);
  });

  it('rejects a table without the cluster fragment columns', async () => {
    const run = jest.fn(async () => ({ values: [
      { FIELDNAME: 'MANDT', KEYFLAG: 'X', DATATYPE: 'CLNT' },
      { FIELDNAME: 'A', KEYFLAG: 'X', DATATYPE: 'CHAR' }
    ] }));
    await expect(clusterTableInfo(run, 'PLAIN', 'readClusterTable'))
      .rejects.toThrow(/is not a cluster table/);
  });

  it('rejects a table with no active DD03L rows', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    await expect(clusterTableInfo(run, 'NOPE', 'readClusterTable'))
      .rejects.toThrow(/no active DD03L columns/);
  });
});

describe('readClusterTable（读取 + 分组 + 解码）', () => {
  const hex1 = clusterHex([v6CharObject('%_IV', 'HELLO')]);
  const hex2 = clusterHex([v6CharObject('%_IV', 'WORLD')]);

  it('groups fragments per key and decodes each cluster', async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql.includes('dd03l')) return { values: DD03L_ROWS };
      return { values: [
        { RELID: 'FL', NAME: 'SET1', SRTF2: '0', CLUSTR: String(Buffer.from(hex1, 'hex').length), CLUSTD: hex1 },
        { RELID: 'FL', NAME: 'SET2', SRTF2: '0', CLUSTR: String(Buffer.from(hex2, 'hex').length), CLUSTD: hex2 }
      ] };
    });
    const result = await readClusterTable(run, { table: 'mycluster', where: "relid = 'FL'" });
    expect(result.table).toBe('MYCLUSTER');
    expect(result.keys).toEqual(['RELID', 'NAME']);
    expect(result.fragments).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.key).toEqual({ RELID: 'FL', NAME: 'SET1' });
    expect(result.records[0]!.objects[0]).toEqual({ name: '%_IV', kind: 'elementary', value: 'HELLO' });
    expect(result.records[1]!.objects[0]!.value).toBe('WORLD');
    // SQL：键列 + 续块列，ORDER BY 键,SRTF2
    const sql = (run.mock.calls[1] as unknown as [string, number])[0];
    expect(sql).toContain('srtf2, clustr, clustd');
    expect(sql.toLowerCase()).toContain('order by');
    expect(sql).toContain("relid = 'FL'");
  });

  it('joins SRTF2 fragments of one key into one cluster', async () => {
    const full = clusterHex([v6CharObject('%_X', 'ABCD')]);
    const bytes = Buffer.from(full, 'hex');
    const cut = 40; // 人为两片
    const run = jest.fn(async (sql: string) => {
      if (sql.includes('dd03l')) return { values: DD03L_ROWS };
      return { values: [
        { RELID: 'FL', NAME: 'K', SRTF2: '0', CLUSTR: String(cut), CLUSTD: full.slice(0, cut * 2) },
        { RELID: 'FL', NAME: 'K', SRTF2: '1', CLUSTR: String(bytes.length - cut), CLUSTD: full.slice(cut * 2) }
      ] };
    });
    const result = await readClusterTable(run, { table: 'MYCLUSTER' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.objects[0]!.value).toBe('ABCD');
    expect(result.fragments).toBe(2);
  });

  it('drops the last cluster when the row cap truncates the read', async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql.includes('dd03l')) return { values: DD03L_ROWS };
      return { values: [
        { RELID: 'FL', NAME: 'SET1', SRTF2: '0', CLUSTR: String(Buffer.from(hex1, 'hex').length), CLUSTD: hex1 },
        { RELID: 'FL', NAME: 'SET2', SRTF2: '0', CLUSTR: String(Buffer.from(hex2, 'hex').length), CLUSTD: hex2 }
      ] };
    });
    const result = await readClusterTable(run, { table: 'MYCLUSTER', maxRows: 2 });
    expect(result.truncated).toBe(true);
    expect(result.records).toHaveLength(1); // 最后一个集群被丢弃
    expect(result.records[0]!.key.NAME).toBe('SET1');
    expect(result.notes.some(n => n.includes('last cluster was dropped'))).toBe(true);
  });

  it('keeps the record list honest: undecodable cluster becomes a note, not a fake record', async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql.includes('dd03l')) return { values: DD03L_ROWS };
      return { values: [
        { RELID: 'FL', NAME: 'BAD', SRTF2: '0', CLUSTR: 4, CLUSTD: 'ZZNOTHEX' },
        { RELID: 'FL', NAME: 'GOOD', SRTF2: '0', CLUSTR: String(Buffer.from(hex2, 'hex').length), CLUSTD: hex2 }
      ] };
    });
    const result = await readClusterTable(run, { table: 'MYCLUSTER' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.key.NAME).toBe('GOOD');
    expect(result.notes.some(n => n.includes('cluster decode failed'))).toBe(true);
  });

  it('rejects control characters and semicolons in where', async () => {
    const run = jest.fn(async () => ({ values: DD03L_ROWS }));
    await expect(readClusterTable(run, { table: 'MYCLUSTER', where: "a = 'x'; DROP TABLE" }))
      .rejects.toThrow(/control characters or semicolons/);
  });

  it('rejects an invalid table name before any query', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    await expect(readClusterTable(run, { table: 'BAD NAME!' })).rejects.toThrow(/is invalid/);
    expect(run).not.toHaveBeenCalled();
  });
});
