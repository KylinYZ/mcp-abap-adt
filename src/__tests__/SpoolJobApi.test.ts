import {
  listSpoolRequests,
  listJobs,
  bindSpoolJobQueryRunner,
  createSpoolJobClient
} from '../adt/SpoolJobApi.js';
import { normalizeRepositoryName } from '../adt/CrossReferenceApi.js';
import type { SpoolJobRow, SpoolJobQueryRunner } from '../adt/SpoolJobApi.js';

/**
 * SpoolJobApi 只读契约测试（mock 自由 SQL 通道，绝不连接真实 SAP）。
 * 断言五类内容（各段标注对齐的 VSP 来源）：
 *   1. SQL 拼装契约：TSP01/TST01/TBTCP/TBTCO 查询逐字对齐 VSP spool.go L115-119/
 *      L171-190/L192-216 与 jobs.go L100-124/L154-157；
 *   2. 注入防线：控制字符/引号在查询生成前拒绝；状态码白名单；LIKE 通配转换；
 *   3. 行解析：TSP01 行 → SpoolRequest、TST01 头增补、TBTCP 步骤引用（含
 *      listident 补零到 10 位）；
 *   4. 作业清单：TBTCO 行解析（状态释义、起止时间、时长）、步骤增补、程序反查；
 *   5. 边界说明：notes 随结果返回（job log / spool content 不在子集内）。
 */

/** 构造按表路由的查询通道 mock（记录每次 SQL 与限额）。 */
function runnerRouter(routes: {
  tsp01?: SpoolJobRow[];
  tst01?: SpoolJobRow[];
  tbtcp?: SpoolJobRow[];
  tbtco?: SpoolJobRow[];
}): SpoolJobQueryRunner & { calls: Array<{ sql: string; limit: number }> } {
  const calls: Array<{ sql: string; limit: number }> = [];
  const run = jest.fn(async (sql: string, limit: number) => {
    calls.push({ sql, limit });
    const lower = sql.toLowerCase();
    let rows: SpoolJobRow[] | undefined;
    if (lower.includes('from tsp01')) rows = routes.tsp01;
    else if (lower.includes('from tst01')) rows = routes.tst01;
    else if (lower.includes('from tbtcp')) rows = routes.tbtcp;
    else if (lower.includes('from tbtco')) rows = routes.tbtco;
    if (!rows) throw new Error(`unexpected sql in test: ${sql}`);
    return rows;
  });
  return Object.assign(run, { calls }) as unknown as SpoolJobQueryRunner & { calls: Array<{ sql: string; limit: number }> };
}

function sqlAt(runner: SpoolJobQueryRunner & { calls: Array<{ sql: string; limit: number }> }, index: number): string {
  return runner.calls[index].sql;
}

/* ==========================================================================
 * 1) spool 清单（listSpoolRequests）
 * ========================================================================== */

describe('listSpoolRequests (VSP spool.go SpoolRequests port)', () => {
  it('queries TSP01 ordered by creation and enriches from TST01 + TBTCP', async () => {
    const runner = runnerRouter({
      tsp01: [{
        RQIDENT: '42', RQCLIENT: '300', RQOWNER: 'DEVUSER',
        RQCRETIME: '20260917080000' + '00', RQTITLE: 'night run',
        RQ0NAME: 'LIST', RQ1NAME: 'LOCL', RQ2NAME: 'ZPROG',
        RQDOCTYPE: 'LIST', RQDEST: 'LOCL', RQCOPIES: '1', RQPJREQ: '3',
        RQO1NAME: 'TEMSE01'
      }],
      tst01: [{ DNAME: 'TEMSE01', DSTOTYP: 'D', DCHARCOD: '4103', DROWS: '120', DSIZE: '5400' }],
      tbtcp: [{
        JOBNAME: 'NIGHTJOB', JOBCOUNT: '20260917', STEPCOUNT: '1',
        PROGNAME: 'ZPROG', VARIANT: 'VAR1', AUTHCKNAM: 'DEVUSER', LISTIDENT: '0000000042'
      }]
    });
    const result = await listSpoolRequests(runner, {});
    // 主查询逐字对齐 VSP spool.go L115-119
    expect(sqlAt(runner, 0)).toBe('SELECT rqident, rqclient, rqowner, rqcretime, rqtitle, rq0name, rq1name, rq2name, rqdoctype, rqdest, rqcopies, rqpjreq, rqo1name FROM tsp01 ORDER BY rqcretime DESCENDING');
    expect(result.count).toBe(1);
    const request = result.requests[0];
    expect(request.number).toBe(42);
    expect(request.owner).toBe('DEVUSER');
    expect(request.created).toBe('2026-09-17T08:00:00');
    expect(request.suffixes).toEqual(['LIST', 'LOCL', 'ZPROG']);
    // TST01 头增补
    expect(request.storage).toBe('D');
    expect(request.codepage).toBe('4103');
    expect(request.lines).toBe(120);
    expect(request.bytes).toBe(5400);
    // TBTCP 作业引用增补
    expect(request.job).toEqual({
      name: 'NIGHTJOB', count: '20260917', step: 1,
      program: 'ZPROG', variant: 'VAR1', user: 'DEVUSER'
    });
    // 边界说明随结果返回
    expect(result.notes[0]).toContain('spool content');
  });

  it('pads listident to ten digits for the TBTCP enrichment predicate', async () => {
    const runner = runnerRouter({
      tsp01: [{ RQIDENT: '42', RQO1NAME: '' }],
      tbtcp: [],
      tst01: []
    });
    await listSpoolRequests(runner, {});
    // VSP padSpoolIDs L151-157：10 位补零
    expect(sqlAt(runner, 1)).toContain("listident IN (\n'0000000042' )");
  });

  it('resolves the job filter via TBTCP and skips TSP01 when nothing matches', async () => {
    const runner = runnerRouter({
      tbtcp: []
    });
    const result = await listSpoolRequests(runner, { job: 'NIGHTJOB' });
    expect(sqlAt(runner, 0)).toContain("FROM tbtcp WHERE jobname = 'NIGHTJOB' AND listident <> '0000000000'");
    expect(result.requests).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('builds WHERE terms for owner/title/program/date bounds', async () => {
    const runner = runnerRouter({ tsp01: [], tst01: [], tbtcp: [] });
    await listSpoolRequests(runner, {
      owner: 'devuser', title: 'night*', program: 'zprog_long_name', from: '2026-09-01', to: '2026-09-17'
    });
    const sql = sqlAt(runner, runner.calls.length - 1);
    expect(sql).toContain("rqowner = 'DEVUSER'");
    expect(sql).toContain("rqtitle LIKE 'night%'");
    // RQ2NAME 截断到 12 位（VSP spool.go L86-88）
    expect(sql).toContain("rq2name = 'ZPROG_LONG_N'");
    expect(sql).toContain("rqcretime >= '20260901000000'");
    // to 边界补齐到 23595999（亚秒段，VSP spool.go L95）
    expect(sql).toContain("rqcretime <= '2026091723595999'");
  });

  it('rejects control characters before any query', async () => {
    const runner = runnerRouter({});
    await expect(listSpoolRequests(runner, { title: 'a\nDROP TABLE' })).rejects.toThrow(/control characters/);
    expect(runner.calls).toHaveLength(0);
  });
});

/* ==========================================================================
 * 2) 作业清单（listJobs）
 * ========================================================================== */

// TBTCO 行样例：07:00:05 启动、07:01:00 结束（时长 55 秒）
const TBCO_ROW = {
  JOBNAME: 'NIGHTJOB', JOBCOUNT: '20260917', STATUS: 'F',
  SDLDATE: '20260917', SDLTIME: '070000', RELDATE: '20260917', RELTIME: '070001',
  STRTDATE: '20260917', STRTTIME: '070005', ENDDATE: '20260917', ENDTIME: '070100',
  SDLUNAME: 'DEVUSER', REAXSERVER: '', EXECSERVER: 'server01',
  PERIODIC: 'X', JOBCLASS: 'C', JOBLOG: 'LOGTMP'
};

describe('listJobs (VSP jobs.go Jobs port)', () => {
  it('queries TBTCO with status text, timestamps, duration, and step enrichment', async () => {
    const runner = runnerRouter({
      tbtco: [TBCO_ROW],
      tbtcp: [{
        JOBNAME: 'NIGHTJOB', JOBCOUNT: '20260917', STEPCOUNT: '1',
        PROGNAME: 'ZPROG', VARIANT: 'V1', AUTHCKNAM: 'DEVUSER',
        LANGUAGE: 'E', STATUS: 'F', LISTIDENT: '42', XPGPROG: '', EXTCMD: ''
      }]
    });
    const result = await listJobs(runner, { name: 'NIGHT*' });
    // LIKE 通配转换（VSP jobs.go L76-78）
    expect(sqlAt(runner, 0)).toContain("jobname LIKE 'NIGHT%'");
    // 主查询逐字对齐 VSP jobs.go L114-118
    expect(sqlAt(runner, 0)).toContain('SELECT jobname, jobcount, status, sdldate, sdltime, reldate, reltime, strtdate, strttime, enddate, endtime, sdluname, reaxserver, execserver, periodic, jobclass, joblog FROM tbtco');
    expect(sqlAt(runner, 0)).toContain('ORDER BY strtdate DESCENDING, strttime DESCENDING, sdldate DESCENDING, sdltime DESCENDING');
    expect(result.count).toBe(1);
    const job = result.jobs[0];
    expect(job.name).toBe('NIGHTJOB');
    expect(job.status).toBe('F');
    expect(job.statusText).toBe('finished');
    expect(job.server).toBe('server01');
    expect(job.periodic).toBe(true);
    expect(job.started).toBe('2026-09-17T07:00:05');
    expect(job.ended).toBe('2026-09-17T07:01:00');
    expect(job.durationSeconds).toBe(55);
    // 步骤增补
    expect(job.steps).toEqual([{
      step: 1, program: 'ZPROG', variant: 'V1', user: 'DEVUSER',
      lang: 'E', status: 'F', spool: 42
    }]);
    expect(result.notes[0]).toContain('RFC/XBP');
  });

  it('resolves the program filter via a TBTCP pre-query', async () => {
    const runner = runnerRouter({
      tbtcp: [{ JOBNAME: 'NIGHTJOB', JOBCOUNT: '20260917' }],
      tbtco: []
    });
    const result = await listJobs(runner, { program: 'zprog' });
    expect(sqlAt(runner, 0)).toContain("SELECT jobname, jobcount FROM tbtcp WHERE progname = 'ZPROG' ORDER BY sdldate DESCENDING, sdltime DESCENDING");
    expect(sqlAt(runner, 1)).toContain("( jobname = 'NIGHTJOB' AND jobcount = '20260917' )");
    expect(result.jobs).toEqual([]);
  });

  it('falls back to WHERE-only with client-side sort when the endpoint rejects ORDER BY', async () => {
    // 专用 DEV 实测：tbtco 的 WHERE + ORDER BY 组合被 datapreview 拒绝
    const calls: string[] = [];
    const runner: SpoolJobQueryRunner = Object.assign(jest.fn(async (sql: string, limit: number) => {
      calls.push(sql);
      if (sql.includes('ORDER BY')) throw new Error('"DES" is not allowed here. "." is expected.');
      if (!sql.toLowerCase().includes('from tbt')) throw new Error(`unexpected: ${sql}`);
      // 乱序返回两行，验证客户端排序
      return [
        { JOBNAME: 'JOB_B', JOBCOUNT: '2', STATUS: 'F', SDLDATE: '20260917', SDLTIME: '080000', STRTDATE: '20260917', STRTTIME: '080005', ENDDATE: '20260917', ENDTIME: '080100', SDLUNAME: 'U', PERIODIC: '', EXECSERVER: 's1' },
        { JOBNAME: 'JOB_A', JOBCOUNT: '1', STATUS: 'F', SDLDATE: '20260917', SDLTIME: '090000', STRTDATE: '20260917', STRTTIME: '090005', ENDDATE: '20260917', ENDTIME: '090100', SDLUNAME: 'U', PERIODIC: '', EXECSERVER: 's1' }
      ];
    }), { calls });
    const result = await listJobs(runner, { from: '2026-09-10', to: '2026-09-17', limit: 50 });
    // 第一次尝试带 ORDER BY，回退查询只含 WHERE
    expect(calls[0]).toContain('ORDER BY strtdate DESCENDING');
    expect(calls[1]).not.toContain('ORDER BY');
    expect(result.notes.some(n => n.includes('sorted client-side'))).toBe(true);
    // 客户端按实际开始时间倒序
    expect(result.jobs.map(j => j.name)).toEqual(['JOB_A', 'JOB_B']);
  });

  it('whitelists status codes and normalizes exact job names', async () => {
    const runner = runnerRouter({ tbtco: [] });
    await listJobs(runner, { name: 'NIGHTJOB', status: 'f, r, X, Z' });
    const sql = sqlAt(runner, 0);
    expect(sql).toContain("jobname = 'NIGHTJOB'");
    // X 不在状态映射里，被剔除；F/Z 保留
    expect(sql).toContain("status IN ( 'F', 'R', 'Z' )");
  });

  it('rejects control characters and malformed dates before any query', async () => {
    const runner = runnerRouter({});
    // 名字类输入先过仓库名白名单（换行不在白名单内）
    await expect(listJobs(runner, { name: 'A\nB' })).rejects.toThrow(/not a repository name/);
    await expect(listJobs(runner, { from: 'not-a-date' })).rejects.toThrow(/must be a date/);
    expect(runner.calls).toHaveLength(0);
  });
});

/* ==========================================================================
 * 3) 绑定与防线
 * ========================================================================== */

describe('binding and guards', () => {
  it('binds runQuery with decode=true and per-call limits', async () => {
    const runQuery = jest.fn(async () => ({ values: [] }));
    const runner = bindSpoolJobQueryRunner({ runQuery });
    await runner('SELECT 1 FROM tbtco', 7);
    expect(runQuery).toHaveBeenCalledWith('SELECT 1 FROM tbtco', 7, true);
  });

  it('createSpoolJobClient exposes both capabilities', async () => {
    const runner = runnerRouter({ tsp01: [], tst01: [], tbtcp: [], tbtco: [TBCO_ROW] });
    const client = createSpoolJobClient(runner);
    const jobs = await client.listJobs({ user: 'DEVUSER' });
    expect(jobs.count).toBe(1);
    const spools = await client.listSpoolRequests({ limit: 5 });
    expect(spools.requests).toEqual([]);
  });

  it('keeps the repository-name guard in place for name inputs', () => {
    expect(() => normalizeRepositoryName("A';--", 'x')).toThrow();
    expect(normalizeRepositoryName('NIGHTJOB', 'x')).toBe('NIGHTJOB');
  });
});
