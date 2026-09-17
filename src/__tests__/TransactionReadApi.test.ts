import {
  getTransaction,
  normalizeTransactionCode,
  createTransactionReadClient
} from '../adt/TransactionReadApi.js';

/**
 * TransactionReadApi 只读契约测试（mock SQL 通道，绝不连接真实 SAP）。
 * 断言四类内容：
 *   1. SQL 拼装契约：TSTC/TSTCT 两条 SELECT 逐字对齐（tcode 字面量引号转义）；
 *   2. 行解析：program/description 映射、无翻译缺失、无程序缺失；
 *   3. 注入与校验防线：事务码白名单、语言键校验、不存在事务码明确报错；
 *   4. 客户端绑定（decode=true 由绑定固定）。
 */

function runnerMock(rows: Record<string, unknown>[]) {
  const calls: string[] = [];
  const run = jest.fn(async (sql: string) => {
    calls.push(sql);
    const lower = sql.toLowerCase();
    if (lower.includes('from tstc')) {
      return { values: rows.filter(r => r.PGMNA !== undefined) };
    }
    if (lower.includes('from tstct')) {
      return { values: rows.filter(r => r.TTEXT !== undefined) };
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
  return Object.assign(run, { calls }) as unknown as
    ((sql: string, rowLimit?: number) => Promise<{ values?: Record<string, unknown>[] }>) & { calls: string[] };
}

describe('getTransaction (VSP GetTransaction 语义，TSTC/TSTCT 通道)', () => {
  it('reads program and description with both SELECTs', async () => {
    const runner = runnerMock([{ TCODE: 'SE38', PGMNA: 'SAPMS38M', TTEXT: 'ABAP Editor' }]);
    const result = await getTransaction(runner, { transaction: ' se38 ', language: 'en' });
    expect(runner.calls[0]).toBe("SELECT tcode, pgmna FROM tstc WHERE tcode = 'SE38'");
    expect(runner.calls[1]).toBe("SELECT ttext FROM tstct WHERE sprsl = 'EN' AND tcode = 'SE38'");
    expect(result.transaction).toBe('SE38');
    expect(result.program).toBe('SAPMS38M');
    expect(result.description).toBe('ABAP Editor');
    expect(result.language).toBe('EN');
  });

  it('returns no description when the target language has no translation', async () => {
    const runner = runnerMock([{ TCODE: 'SE38', PGMNA: 'SAPMS38M' }]);
    const result = await getTransaction(runner, { transaction: 'SE38', language: 'ZH' });
    expect(result.description).toBeUndefined();
    expect(result.program).toBe('SAPMS38M');
    expect(result.language).toBe('ZH');
  });

  it('degrades gracefully when the description channel fails (TSTCT restricted)', async () => {
    // 专用 DEV 实测：TSTCT datapreview 一律 Internal server error（环境级限制）
    const calls: string[] = [];
    const runner = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.toLowerCase().includes('from tstct')) throw new Error('Internal server error');
      if (sql.toLowerCase().includes('from tstc')) return { values: [{ TCODE: 'SE38', PGMNA: 'SAPMS38M' }] };
      throw new Error('unexpected: ' + sql);
    }) as any;
    const result = await getTransaction(runner, { transaction: 'SE38', language: 'EN' });
    expect(result.program).toBe('SAPMS38M');
    expect(result.description).toBeUndefined();
    expect(result.note).toContain('TSTCT');
  });

  it('reports a clear error for a transaction that does not exist', async () => {
    const runner = runnerMock([]);
    await expect(getTransaction(runner, { transaction: 'ZZZZ' })).rejects.toThrow(/does not exist in TSTC/);
  });

  it('rejects malformed transaction codes and language keys', async () => {
    const runner = runnerMock([]);
    await expect(getTransaction(runner, { transaction: "A';--" })).rejects.toThrow(/not a transaction code/);
    await expect(getTransaction(runner, { transaction: '' })).rejects.toThrow(/not a transaction code/);
    await expect(getTransaction(runner, { transaction: 'SE38', language: 'CHN' })).rejects.toThrow(/language key/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('normalizeTransactionCode', () => {
  it('upper-cases and whitelists', () => {
    expect(normalizeTransactionCode(' se38 ', 'x')).toBe('SE38');
    expect(normalizeTransactionCode('ZABC', 'x')).toBe('ZABC');
    expect(() => normalizeTransactionCode('A B', 'x')).toThrow();
    expect(() => normalizeTransactionCode('x'.repeat(21), 'x')).toThrow();
  });
});

describe('createTransactionReadClient binding', () => {
  it('binds runQuery with decode=true', async () => {
    const runQuery = jest.fn(async () => ({
      values: [{ TCODE: 'SE38', PGMNA: 'SAPMS38M' }, { TTEXT: 'ABAP Editor' }]
    }));
    const client = createTransactionReadClient({ runQuery });
    const result = await client.getTransaction({ transaction: 'SE38', language: 'EN' });
    expect(runQuery).toHaveBeenCalledWith(expect.stringContaining('FROM tstc'), 1, true);
    expect(result.program).toBe('SAPMS38M');
  });
});
