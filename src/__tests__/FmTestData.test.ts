/**
 * 函数模块测试数据目录 API 测试（diagnostics.knowledge-queries 的
 * fm_test_data 目录层子集）。SQL 通道全 mock，不连接 SAP。
 * 行形态对齐真机取证（2026-09-25，sap-demo EUFUNC 实查）。
 */
import { getFmTestDataSets } from '../adt/FmTestDataApi';

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
});
