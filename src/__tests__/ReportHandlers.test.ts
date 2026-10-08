/**
 * ReportHandlers 测试（report.run / report.async / report.variants 的 MCP 面）。
 * 注入客户端全 mock——只验证 schema 契约、参数校验与错误分层。
 */
import { ReportHandlers } from '../handlers/ReportHandlers';
import { ErrorCode } from '../lib/McpErrorCompat';
import type { ReportVariantsClient } from '../adt/ReportVariantsApi';
import type { ReportJobClient, RunReportInput } from '../adt/ReportJobApi';

function makeDeps(overrides: {
  variants?: Partial<ReportVariantsClient>;
  job?: Partial<ReportJobClient>;
} = {}): { variants: ReportVariantsClient; job: ReportJobClient } {
  return {
    variants: {
      getReportVariants: jest.fn(async () => ({ report: 'R', variants: [], notes: [] })),
      ...overrides.variants
    },
    job: {
      submitReportJob: jest.fn(async () => ({
        report: 'R', jobName: 'ZRPT_X', jobCount: '1', notes: []
      })),
      runReport: jest.fn(async (input: RunReportInput) => ({
        report: input.report, jobName: 'ZRPT_X', jobCount: '1', jobStatus: 'F', output: 'out', notes: []
      })),
      ...overrides.job
    }
  };
}

describe('ReportHandlers', () => {
  it('splits the read-only variants tool from the two execution tools', () => {
    const deps = makeDeps();
    const handlers = new ReportHandlers(deps.variants, deps.job);
    const all = handlers.getTools().map(t => t.name);
    expect(all).toEqual(['getReportVariants', 'runReport', 'submitReportJob']);
    expect(handlers.getVariantsTool().name).toBe('getReportVariants');
    expect(handlers.getVariantsTool().annotations?.readOnlyHint).toBe(true);
    const exec = handlers.getExecutionTools().map(t => t.name);
    expect(exec).toEqual(['runReport', 'submitReportJob']);
    for (const tool of handlers.getExecutionTools()) {
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool._meta?.operationClass).toBe('mutating tenant');
    }
  });

  it('dispatches variants and normalizes the report name', async () => {
    const deps = makeDeps();
    await new ReportHandlers(deps.variants, deps.job)
      .handle('getReportVariants', { report: ' rsusr002 ' });
    expect(deps.variants.getReportVariants).toHaveBeenCalledWith({ report: 'RSUSR002' });
  });

  it('dispatches runReport through the job client with waitSeconds bounds', async () => {
    const job = {
      submitReportJob: jest.fn(),
      runReport: jest.fn(async () => ({
        report: 'Z', jobName: 'J', jobCount: '1', jobStatus: 'F', output: 'out', notes: []
      }))
    };
    const deps = makeDeps({ job });
    await new ReportHandlers(deps.variants, deps.job)
      .handle('runReport', { report: 'z', variant: 'V', params: { A: 'b' }, waitSeconds: 120 });
    expect(job.runReport).toHaveBeenCalledWith({ report: 'Z', variant: 'V', params: { A: 'b' }, waitSeconds: 120 });
    // 999 超出 schema/handler 界（5..300）→ InvalidParams
    await expect(new ReportHandlers(deps.variants, deps.job)
      .handle('runReport', { report: 'z', waitSeconds: 999 }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('dispatches submitReportJob through the injected client', async () => {
    const deps = makeDeps();
    await new ReportHandlers(deps.variants, deps.job)
      .handle('submitReportJob', { report: 'Z', variant: 'V' });
    expect(deps.job.submitReportJob).toHaveBeenCalledWith({ report: 'Z', variant: 'V' });
  });

  it('rejects invalid report names before any client call', async () => {
    const deps = makeDeps();
    const handlers = new ReportHandlers(deps.variants, deps.job);
    for (const tool of ['getReportVariants', 'runReport', 'submitReportJob']) {
      await expect(handlers.handle(tool, { report: 'BAD NAME!' }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(handlers.handle(tool, {}))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    expect(deps.variants.getReportVariants).not.toHaveBeenCalled();
    expect(deps.job.submitReportJob).not.toHaveBeenCalled();
  });

  it('maps semantic errors to InvalidParams and masks infrastructure errors', async () => {
    const failing = makeDeps({
      job: { submitReportJob: jest.fn(async () => { throw new Error('submitReportJob: report job submission failed: boom'); }) }
    });
    const handlers = new ReportHandlers(failing.variants, failing.job);
    await expect(handlers.handle('submitReportJob', { report: 'R' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    const failingVariants = makeDeps({
      variants: { getReportVariants: jest.fn(async () => { throw new Error('reading VARID for R: boom'); }) }
    });
    await expect(new ReportHandlers(failingVariants.variants, failingVariants.job).handle('getReportVariants', { report: 'R' }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it('rejects unknown tools and non-string param values', async () => {
    const deps = makeDeps();
    const handlers = new ReportHandlers(deps.variants, deps.job);
    await expect(handlers.handle('noSuchTool', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    await expect(handlers.handle('runReport', { report: 'Z', params: { A: 1 } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
