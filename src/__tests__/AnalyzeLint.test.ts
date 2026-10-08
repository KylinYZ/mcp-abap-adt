import { analyzeLint } from '../adt/AnalyzeLintApi';

/**
 * AnalyzeLintApi 测试：本地 abaplint 引擎（真实 @abaplint/core，无 SAP 交互）。
 */
describe('analyzeLint（本地 abaplint 引擎）', () => {
  it('flags real quality issues in ABAP source', async () => {
    const result = await analyzeLint({
      code: 'REPORT ztest.\nDATA lv_X TYPE i.\nWRITE lv_x.\nMOVE 1 TO lv_x.\nexit.'
    });
    expect(result.version).toBe('Standard');
    expect(result.findings.length).toBeGreaterThan(0);
    const keys = result.findings.map(f => f.ruleKey);
    expect(keys).toContain('exit_or_check');
    expect(keys).toContain('obsolete_statement');
    expect(result.errorCount + result.warningCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('auto-detects the object type from code content (CLASS -> .clas.abap)', async () => {
    const result = await analyzeLint({
      code: 'CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\nENDCLASS.'
    });
    expect(result.filename).toBe('zcl_demo.clas.abap');
  });

  it('honors an explicit filename hint', async () => {
    const result = await analyzeLint({
      code: 'DEFINE VIEW zview AS SELECT FROM t001 { KEY mandt }',
      filename: 'zview.ddls.asddls'
    });
    expect(result.filename).toBe('zview.ddls.asddls');
  });

  it('clean code produces zero findings', async () => {
    const result = await analyzeLint({
      code: 'REPORT zclean.\nDATA lv_ok TYPE i.\nlv_ok = 1.\nWRITE lv_ok.'
    });
    expect(result.errorCount).toBe(0);
    expect(result.findings.length).toBe(0);
  });

  it('truncates findings at maxFindings and reports it', async () => {
    // 多行冗余空行 + keyword_case 等大量 finding，cap=3 触发截断
    const lines: string[] = ['REPORT zbig.'];
    for (let i = 0; i < 60; i += 1) lines.push(`DATA lv_x${i} TYPE i.`);
    const result = await analyzeLint({ code: lines.join('\n'), maxFindings: 3 });
    expect(result.truncated).toBe(true);
    expect(result.findings.length).toBe(3);
    expect(result.notes.some(n => n.includes('truncated'))).toBe(true);
  });

  it('rejects empty and oversized code at the parameter layer', async () => {
    await expect(analyzeLint({ code: '   ' })).rejects.toThrow(/non-empty/);
    await expect(analyzeLint({ code: 'x'.repeat(51 * 1024) })).rejects.toThrow(/50KB limit/);
  });

  it('supports Cloud syntax version', async () => {
    const result = await analyzeLint({
      code: 'CLASS zcl_cloud DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS zcl_cloud IMPLEMENTATION.\nENDCLASS.',
      version: 'Cloud'
    });
    expect(result.version).toBe('Cloud');
  });
});
