import { TransportHistoryHandlers } from '../handlers/TransportHistoryHandlers.js';
import {
  getCrHistory,
  getCoChange,
  createTransportHistoryClient
} from '../adt/TransportHistoryApi.js';
import type { TransportHistoryQueryRunner } from '../adt/TransportHistoryApi.js';
import type { TransportHistoryClient } from '../adt/TransportHistoryApi.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * 传输历史只读契约测试（mock SQL 通道，零 SAP 往返）。
 * 锁定：E071 R3TR+LIMU 双查询与并集、E070 任务→请求层级解析、共现频次
 * 排序与目标排除、注入 token 防线、边界 notes（E070A 未配置/图引擎类不在
 * 子集）、处理器目录与分派。
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
  return Object.assign(run, { calls }) as unknown as TransportHistoryQueryRunner & { calls: string[] };
}

describe('getCrHistory (VSP handleCRHistory subset port)', () => {
  it('unions R3TR exact and LIMU prefix transports and resolves the request hierarchy', async () => {
    const runner = runnerMock([
      { match: /FROM e071 WHERE pgmid = 'R3TR'/, rows: [{ TRKORR: 'S4HK900009' }] },
      { match: /FROM e071 WHERE pgmid = 'LIMU'/, rows: [{ TRKORR: 'A4HK900001' }] },
      {
        match: /FROM e070 WHERE trkorr IN/,
        rows: [
          { TRKORR: 'S4HK900009', STRKORR: '', AS4USER: '068157', AS4DATE: '20260901' },
          { TRKORR: 'A4HK900001', STRKORR: 'S4HK900009', AS4USER: 'DEV2', AS4DATE: '20260902' }
        ]
      }
    ]);
    const result = await getCrHistory(runner, { objectType: 'clas', objectName: ' zcl_foo ' });
    expect(result.objectType).toBe('CLAS');
    expect(result.transports).toEqual(['A4HK900001', 'S4HK900009']);
    // 任务（有父请求）解析到请求，请求（无父）解析到自身
    expect(result.requests).toEqual(['S4HK900009']);
    expect(result.details).toEqual([
      { trkorr: 'S4HK900009', user: '068157', date: '20260901' },
      { trkorr: 'A4HK900001', parentRequest: 'S4HK900009', user: 'DEV2', date: '20260902' }
    ]);
    expect(result.notes[0]).toContain('E070A');
  });

  it('returns an empty history with a note when the object was never transported', async () => {
    const runner = runnerMock([
      { match: /FROM e071 WHERE pgmid = 'R3TR'/, rows: [] },
      { match: /FROM e071 WHERE pgmid = 'LIMU'/, rows: [] }
    ]);
    const result = await getCrHistory(runner, { objectType: 'PROG', objectName: 'ZNEVER' });
    expect(result.transports).toEqual([]);
    expect(result.requests).toEqual([]);
    expect(runner.calls).toHaveLength(2); // E070 不再查询
  });

  it('degrades gracefully when the LIMU lookup fails', async () => {
    const base = runnerMock([
      { match: /FROM e071 WHERE pgmid = 'R3TR'/, rows: [{ TRKORR: 'S4HK900009' }] },
      { match: /FROM e070 WHERE trkorr IN/, rows: [{ TRKORR: 'S4HK900009', STRKORR: '', AS4USER: 'U', AS4DATE: '20260901' }] }
    ]);
    const degraded: TransportHistoryQueryRunner = async (sql, limit) => {
      if (sql.includes("'LIMU'")) throw new Error('Internal server error');
      return base(sql, limit ?? 10);
    };
    const result = await getCrHistory(degraded, { objectType: 'CLAS', objectName: 'ZCL_X' });
    expect(result.transports).toEqual(['S4HK900009']);
    expect(result.notes.some(n => n.includes('LIMU'))).toBe(true);
  });

  it('rejects invalid tokens before any query', async () => {
    const runner = runnerMock([]);
    await expect(getCrHistory(runner, { objectType: "CL';--", objectName: 'X' })).rejects.toThrow(/objectType/);
    await expect(getCrHistory(runner, { objectType: 'CLAS', objectName: '' })).rejects.toThrow(/objectName/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('getCoChange (VSP handleCoChange same-request subset port)', () => {
  it('ranks co-changed objects by transport frequency and excludes the target', async () => {
    const runner = runnerMock([
      { match: /FROM e071 WHERE pgmid = 'R3TR'/, rows: [{ TRKORR: 'A4HK900001' }, { TRKORR: 'A4HK900002' }] },
      {
        match: /FROM e070 WHERE trkorr IN/,
        rows: [
          { TRKORR: 'A4HK900001', STRKORR: 'S4HK900009' },
          { TRKORR: 'A4HK900002', STRKORR: 'S4HK900009' }
        ]
      },
      { match: /FROM e070 WHERE strkorr IN/, rows: [{ TRKORR: 'A4HK900003' }] },
      {
        match: /SELECT trkorr, pgmid, object, obj_name FROM e071/,
        rows: [
          { TRKORR: 'A4HK900001', PGMID: 'R3TR', OBJECT: 'CLAS', OBJ_NAME: 'ZCL_FOO' },   // 目标自身：排除
          { TRKORR: 'A4HK900001', PGMID: 'R3TR', OBJECT: 'PROG', OBJ_NAME: 'ZPROG_A' },
          { TRKORR: 'A4HK900002', PGMID: 'R3TR', OBJECT: 'PROG', OBJ_NAME: 'ZPROG_A' },   // 两次共现
          { TRKORR: 'A4HK900003', PGMID: 'R3TR', OBJECT: 'TABL', OBJ_NAME: 'ZTAB_B' }     // 一次共现
        ]
      }
    ]);
    const result = await getCoChange(runner, { objectType: 'CLAS', objectName: 'ZCL_FOO', topN: 10 });
    expect(result.transportsScanned).toBe(2);
    expect(result.requestsCovered).toBe(1);
    expect(result.coChanges).toEqual([
      { pgmid: 'R3TR', object: 'PROG', objName: 'ZPROG_A', count: 2 },
      { pgmid: 'R3TR', object: 'TABL', objName: 'ZTAB_B', count: 1 }
    ]);
    expect(result.notes[0]).toContain('not a verdict');
  });

  it('returns empty co-changes when the target has no transports', async () => {
    const runner = runnerMock([{ match: /FROM e071 WHERE pgmid = 'R3TR'/, rows: [] }]);
    const result = await getCoChange(runner, { objectType: 'CLAS', objectName: 'ZNEVER' });
    expect(result.coChanges).toEqual([]);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('createTransportHistoryClient binding', () => {
  it('binds runQuery with decode=true', async () => {
    const runQuery = jest.fn(async () => ({ values: [] }));
    const client = createTransportHistoryClient({ runQuery });
    await client.getCrHistory({ objectType: 'PROG', objectName: 'Z1' });
    expect(runQuery).toHaveBeenCalledWith(expect.stringContaining('e071'), 500, true);
  });
});

describe('TransportHistoryHandlers catalog and dispatch', () => {
  function clientMock(): TransportHistoryClient {
    return {
      getCrHistory: jest.fn(async () => ({
        objectType: 'PROG', objectName: 'Z1', transports: [], details: [], requests: [], notes: []
      })),
      getCoChange: jest.fn(async () => ({
        objectType: 'PROG', objectName: 'Z1', transportsScanned: 0, requestsCovered: 0, coChanges: [], notes: []
      }))
    };
  }

  it('publishes two uniquely named read-only tools and dispatches normalized inputs', async () => {
    const client = clientMock();
    const handlers = new TransportHistoryHandlers(client);
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['getCrHistory', 'getCoChange']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
    await handlers.handle('getCrHistory', { objectType: ' prog ', objectName: ' z1 ' });
    expect(client.getCrHistory).toHaveBeenCalledWith({ objectType: 'PROG', objectName: 'Z1' });
    await handlers.handle('getCoChange', { objectType: 'PROG', objectName: 'Z1', topN: 999 });
    expect(client.getCoChange).toHaveBeenCalledWith({ objectType: 'PROG', objectName: 'Z1', topN: 50 });
  });

  it('rejects invalid inputs and unknown tools at the parameter layer', async () => {
    const handlers = new TransportHistoryHandlers(clientMock());
    await expect(handlers.handle('getCrHistory', { objectType: "CL';--", objectName: 'X' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('getCoChange', { objectType: 'CLAS' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('noSuchTool', {}))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
