import { AnalyzeLintHandlers } from '../handlers/AnalyzeLintHandlers';
import { ErrorCode } from '../lib/McpErrorCompat';

describe('AnalyzeLintHandlers', () => {
  const handlers = new AnalyzeLintHandlers();

  it('exposes one read-only tool', () => {
    const tools = handlers.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('analyzeLint');
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(tools[0]!._meta?.operationClass).toBe('read-only tenant');
  });

  it('supports only analyzeLint', () => {
    expect(handlers.supports('analyzeLint')).toBe(true);
    expect(handlers.supports('noSuchTool')).toBe(false);
  });

  it('rejects empty code as InvalidParams', async () => {
    await expect(handlers.handle('analyzeLint', { code: '   ' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects oversized code as InvalidParams', async () => {
    await expect(handlers.handle('analyzeLint', { code: 'x'.repeat(51 * 1024) }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects unknown tools as MethodNotFound', async () => {
    await expect(handlers.handle('noSuchTool', {}))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('analyzes real ABAP source with findings', async () => {
    const response = await handlers.handle('analyzeLint', {
      code: 'REPORT ztest.\nDATA lv_X TYPE i.\nMOVE 1 TO lv_x.\nexit.'
    });
    const result = response.structuredContent.result;
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((f: { ruleKey: string }) => f.ruleKey === 'exit_or_check')).toBe(true);
  });
});
