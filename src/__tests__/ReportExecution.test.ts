/**
 * report 三件套测试（report.run / report.async / report.variants 收编）。
 * SQL 通道与受控执行核全 mock；解码复用真实逻辑路径。
 */
import { getReportVariants, validateReportName } from '../adt/ReportVariantsApi';
import { submitReportJob, runReport } from '../adt/ReportJobApi';

/* ==========================================================================
 * getReportVariants（VARID/VARIT 只读 SQL）
 * ========================================================================== */

describe('getReportVariants', () => {
  const makeRunner = (dirRows: Record<string, unknown>[], textRows: Record<string, unknown>[] = []) =>
    jest.fn(async (sql: string) => {
      if (sql.includes('varit')) return { values: textRows };
      if (sql.includes('varid')) return { values: dirRows };
      return { values: [] };
    });

  it('lists variants with protected flag and merged English text', async () => {
    const run = makeRunner(
      [
        { REPORT: 'RSUSR002', VARIANT: 'SAP_ALL', PROTECTED: 'X' },
        { REPORT: 'RSUSR002', VARIANT: 'MY_VAR', PROTECTED: '' }
      ],
      [
        { LANGU: 'D', VARIANT: 'MY_VAR', VTEXT: 'Meine Variante' },
        { LANGU: 'E', VARIANT: 'MY_VAR', VTEXT: 'My variant' }
      ]
    );
    const result = await getReportVariants(run, { report: 'rsusr002' });
    expect(result.report).toBe('RSUSR002');
    expect(result.variants).toEqual([
      { name: 'SAP_ALL', protected: true },
      { name: 'MY_VAR', protected: false, text: 'My variant' }
    ]);
  });

  it('returns an empty list as a valid answer for a report without variants', async () => {
    const run = makeRunner([]);
    const result = await getReportVariants(run, { report: 'ZNOVARIANTS' });
    expect(result.variants).toEqual([]);
  });

  it('degrades VARIT failure to a note (directory stays intact)', async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql.includes('varit')) throw new Error('Internal server error');
      return { values: [{ REPORT: 'R', VARIANT: 'V1', PROTECTED: '' }] };
    });
    const result = await getReportVariants(run, { report: 'R' });
    expect(result.variants).toEqual([{ name: 'V1', protected: false }]);
    expect(result.notes.some(n => n.includes('VARIT text lookup failed'))).toBe(true);
  });

  it('wraps VARID failures with the table name', async () => {
    const run = jest.fn(async () => { throw new Error('Internal server error'); });
    await expect(getReportVariants(run, { report: 'R' })).rejects.toThrow(/reading VARID for R/);
  });

  it('rejects invalid report names before any query', async () => {
    const run = jest.fn(async () => ({ values: [] }));
    await expect(getReportVariants(run, { report: 'BAD NAME!' })).rejects.toThrow(/is invalid/);
    expect(run).not.toHaveBeenCalled();
    expect(validateReportName('X/=$Y', 'cap')).toBe('X/=$Y');
  });
});

/* ==========================================================================
 * submitReportJob（受控执行核包装 JOB_OPEN/SUBMIT/JOB_CLOSE）
 * ========================================================================== */

describe('submitReportJob', () => {
  const makeExecutor = (output: string[], success = true) => ({
    executeAbap: jest.fn(async () => ({ success, output, message: 'ok', failure: success ? undefined : { kind: 'exception', title: 'boom' } }))
  });
  const makeRunner = (rows: Record<string, unknown>[] = [{ OBJ_NAME: 'ZOK' }]) =>
    jest.fn(async () => ({ values: rows }));

  it('generates a wrapper with JOB_OPEN/SUBMIT(VIA JOB)/JOB_CLOSE and parses JOB=name/count', async () => {
    const executor = makeExecutor(['JOB=ZRPT_26100710111200/12345678']);
    const run = makeRunner();
    const result = await submitReportJob(executor, { runQuery: run }, { report: 'zwrite_test' });
    expect(result).toMatchObject({ report: 'ZWRITE_TEST', jobName: 'ZRPT_26100710111200', jobCount: '12345678' });
    // 系统风险上限=HARMLESS（头注释）：包装器只调度，报表执行在后台进程
    expect(executor.executeAbap).toHaveBeenCalledWith(expect.any(String), { riskLevel: 'harmless' });
    const code = (executor.executeAbap as jest.Mock).mock.calls[0]![0] as string;
    expect(code).toContain("lv_report = 'ZWRITE_TEST'.");
    expect(code).toContain("CALL FUNCTION 'JOB_OPEN'");
    expect(code).toContain('SUBMIT (lv_report) VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN.');
    expect(code).toContain("CALL FUNCTION 'JOB_CLOSE'");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("name = 'ZWRITE_TEST'"), 5);
  });

  it('uses USING SELECTION-SET for variant (precedence over params)', async () => {
    const executor = makeExecutor(['JOB=J/1']);
    await submitReportJob(executor, { runQuery: makeRunner() }, {
      report: 'Z', variant: 'MYVAR', params: { PA_X: 'x' }
    });
    const code = (executor.executeAbap as jest.Mock).mock.calls[0]![0] as string;
    expect(code).toContain("USING SELECTION-SET 'MYVAR'");
    expect(code).not.toContain('WITH SELECTION-TABLE');
  });

  it('emits escaped RSPARAMS rows when no variant is given', async () => {
    const executor = makeExecutor(['JOB=J/1']);
    await submitReportJob(executor, { runQuery: makeRunner() }, {
      report: 'Z', params: { PA_X: "it's", PA_Y: 'plain' }
    });
    const code = (executor.executeAbap as jest.Mock).mock.calls[0]![0] as string;
    expect(code).toContain('WITH SELECTION-TABLE lt_rsparams');
    expect(code).toContain("low = 'it''s'");
    expect(code).toContain("low = 'plain'");
  });

  it('fails fast when the report has no active PROG version', async () => {
    const executor = makeExecutor(['JOB=J/1']);
    await expect(submitReportJob(executor, { runQuery: makeRunner([]) }, { report: 'ZNOPROG' }))
      .rejects.toThrow(/does not exist \(TRDIR\)/);
    expect(executor.executeAbap).not.toHaveBeenCalled();
  });

  it('surfaces JOB_OPEN/JOB_CLOSE failures from the wrapper output', async () => {
    const executor = makeExecutor(['JOB_OPEN_FAILED=1']);
    await expect(submitReportJob(executor, { runQuery: makeRunner() }, { report: 'Z' }))
      .rejects.toThrow(/job API failed: JOB_OPEN_FAILED=1/);
  });

  it('rejects invalid param names and overlong values', async () => {
    const executor = makeExecutor(['JOB=J/1']);
    await expect(submitReportJob(executor, { runQuery: makeRunner() }, {
      report: 'Z', params: { WAY_TOO_LONG_NAME: 'x' }
    })).rejects.toThrow(/parameter name .* is invalid/);
    await expect(submitReportJob(executor, { runQuery: makeRunner() }, {
      report: 'Z', params: { OK: 'x'.repeat(133) }
    })).rejects.toThrow(/exceeds 132 characters/);
    expect(executor.executeAbap).not.toHaveBeenCalled();
  });
});

/* ==========================================================================
 * runReport（提交 + 轮询 TBTCO + spool 解码）
 * ========================================================================== */

describe('runReport（等待链）', () => {
  const makeExecutor = (output: string[]) => ({
    executeAbap: jest.fn(async () => ({ success: true, output, message: 'ok' }))
  });
  /** SQL mock：REPOSRC 预检 → TBTCO 状态序列 → TBTCP listident。 */
  const makeRunner = (statuses: string[], spoolRows: Record<string, unknown>[] = [{ LISTIDENT: '4242' }]) => {
    let statusIdx = 0;
    return jest.fn(async (sql: string) => {
      if (sql.includes('trdir')) return { values: [{ OBJ_NAME: 'ZOK' }] };
      if (sql.includes('tbtco')) {
        const status = statuses[Math.min(statusIdx, statuses.length - 1)]!;
        statusIdx += 1;
        return { values: [{ STATUS: status }] };
      }
      if (sql.includes('tbtcp')) return { values: spoolRows };
      return { values: [] };
    });
  };
  const makeSpool = (text?: string, rawNote?: string) => ({
    readSpoolContent: jest.fn(async () => ({ contentType: 'LIST', ...(text !== undefined ? { text } : { rawNote }) }))
  });

  it('submits, polls until finished, locates the spool and returns decoded text', async () => {
    const executor = makeExecutor(['JOB=ZRPT_A/7']);
    const run = makeRunner(['R', 'F']);
    const spool = makeSpool('SMOKE-MARKER-START\nSY-INDEX=1');
    const result = await runReport(executor, { runQuery: run, spool }, { report: 'Z', waitSeconds: 30 });
    expect(result.jobStatus).toBe('F');
    expect(result.jobStatusText).toBe('finished');
    expect(result.spoolId).toBe(4242);
    expect(result.output).toContain('SMOKE-MARKER-START');
    expect(result.pollTimeout).toBeUndefined();
  });

  it('marks pollTimeout and skips the spool when the budget expires', async () => {  // jest timeout extended below
    const executor = makeExecutor(['JOB=ZRPT_A/7']);
    const run = makeRunner(['R']);
    const spool = makeSpool('x');
    const result = await runReport(executor, { runQuery: run, spool, pollIntervalMs: 1 }, { report: 'Z', waitSeconds: 5 });
    expect(result.pollTimeout).toBe(true);
    expect(result.spoolId).toBeUndefined();
    expect(spool.readSpoolContent).not.toHaveBeenCalled();
    expect(result.notes.some(n => n.includes('Poll budget'))).toBe(true);
  }, 20_000);

  it('returns the spool honestly for aborted jobs (jobStatus=A)', async () => {
    const executor = makeExecutor(['JOB=ZRPT_A/7']);
    const run = makeRunner(['A']);
    const spool = makeSpool('Dump text in the list');
    const result = await runReport(executor, { runQuery: run, spool }, { report: 'Z' });
    expect(result.jobStatus).toBe('A');
    expect(result.output).toContain('Dump text');
  });

  it('falls back to rawNote for non-text spool documents', async () => {
    const executor = makeExecutor(['JOB=ZRPT_A/7']);
    const run = makeRunner(['F']);
    const spool = makeSpool(undefined, 'OTF document; text decoding not applicable');
    const result = await runReport(executor, { runQuery: run, spool }, { report: 'Z' });
    expect(result.output).toContain('OTF document');
    expect(result.notes.some(n => n.includes('not a text document'))).toBe(true);
  });
});
