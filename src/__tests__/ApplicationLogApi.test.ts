import { readApplicationLog, createApplicationLogClient } from '../adt/ApplicationLogApi.js';
import type { AdtHTTP } from '../adt/AdtHTTP.js';

/**
 * ApplicationLogApi 只读契约测试（mock HTTP 层，绝不连接真实 SAP）。
 * XML 样例模拟真实 ADT 数据预览（datapreview/freestyle）响应结构
 * （tableData > 重复的 columns 元素，每个内含 metadata + dataSet>data，
 * 与 VSP client.go parseTableContents 的 Go 结构一致），断言四类内容：
 *   1. 请求契约：端点 URL、HTTP 方法、Accept/Content-Type 头、rowNumber 查询参数；
 *   2. SQL 拼装：BALHDR 列清单/排序逐字对齐 VSP applog.go，过滤条件、
 *      大写规范化、单引号转义、防全表扫描的时间窗边界；
 *   3. 解析结果：精简 JSON 条目（条件字段缺省）、列名大小写容错、
 *      空结果为空数组；
 *   4. 容错语义：结构异常不抛错、HTTP 错误原样传播。
 */

/** 构造仅含 request mock 的 AdtHTTP 假会话（对齐 CdsDependencyApi 测试写法）。 */
function http(body: string): AdtHTTP {
  return { request: jest.fn().mockResolvedValue({ body, status: 200, headers: {} }) } as unknown as AdtHTTP;
}

/** 取 mock 会话收到的请求配置（[url, config] 形状）。 */
function lastRequest(client: AdtHTTP): { url: string; config: Record<string, any> } {
  const [url, config] = (client.request as jest.Mock).mock.calls[0];
  return { url, config };
}

/** SQL 请求体折行后断言用：把所有空白压成单空格。 */
function flattenSql(body: unknown): string {
  return String(body).replace(/\s+/g, ' ').trim();
}

/**
 * 构造一列数据（一个重复的 <columns> 元素，内含 metadata + dataSet>data）。
 * 真实 ADT 数据预览响应的每列是一个 <columns> 兄弟元素（VSP client.go
 * parseTableContents 的 Go 结构 `Columns []struct{...} xml:"columns"` 证实），
 * 解析层 xmlArray(raw, "tableData", "columns") 依赖该形状。
 */
function column(name: string, values: string[], length = 0): string {
  return `  <columns>
    <metadata name="${name}" type="C" keyAttribute="false" length="${length || Math.max(...values.map(v => v.length), 1)}"/>
    <dataSet>
${values.map(v => `      <data>${v}</data>`).join('\n')}
    </dataSet>
  </columns>`;
}

/** 包装成真实感 tableData 响应（默认命名空间，解析层 removeNSPrefix 兼容）。 */
function tableDataXml(columns: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tableData xmlns="http://www.sap.com/adt/datapreview/tabledata">
${columns.join('\n')}
</tableData>`;
}

/** 空结果响应：columns 存在但无列。 */
const EMPTY_TABLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tableData xmlns="http://www.sap.com/adt/datapreview/tabledata">
  <columns/>
</tableData>`;

/** 两条日志头的真实感响应：第一条字段齐全，第二条子对象/外部 ID/消息数为空。 */
const TWO_ROWS_XML = tableDataXml([
  column('LOGNUMBER', ['00000000000000001234', '00000000000000001235'], 22),
  column('LOG_HANDLE', ['0A1B2C3D4E5F60718293A4B5C6D7E8F9', '1B2C3D4E5F60718293A4B5C6D7E8F90A'], 32),
  column('OBJECT', ['ZSALES', 'ZSALES'], 20),
  column('SUBOBJECT', ['ZORDER', ''], 20),
  column('EXTNUMBER', ['SO-4711', ''], 100),
  column('ALDATE', ['20260901', '20260901'], 8),
  column('ALTIME', ['101530', '080000'], 6),
  column('ALUSER', ['YANGP', 'DOEJ'], 12),
  column('ALPROG', ['ZSALES_POST', 'ZINVOICE_CREATE'], 40),
  column('ALMODE', ['W', ''], 1),
  column('MSG_CNT_AL', ['3', '0'], 4)
]);

describe('ApplicationLogApi readApplicationLog (read-only BAL log headers)', () => {
  it('posts a bounded balhdr SELECT to the datapreview freestyle endpoint and parses trimmed entries', async () => {
    const client = http(TWO_ROWS_XML);
    const result = await readApplicationLog(client, {
      object: ' zsales ',
      objectSubobject: 'zorder',
      externalId: 'SO-4711',
      userName: 'yangp',
      timeFrom: '2026-09-01T00:00:00',
      timeTo: '2026-09-07',
      maxResults: 10
    });

    // 请求契约：端点/方法/头/行数上限逐字对齐 VSP client.go RunQuery（第 1241-1266 行）
    const { url, config } = lastRequest(client);
    expect(url).toBe('/sap/bc/adt/datapreview/freestyle');
    expect(config.method).toBe('POST');
    expect(config.qs).toEqual({ rowNumber: 10 });
    expect(config.headers).toEqual({ Accept: 'application/*', 'Content-Type': 'text/plain' });

    // SQL 契约：列清单/排序逐字对齐 VSP applog.go 第 80/84 行；
    // 过滤值大写规范化（zsales→ZSALES、yangp→YANGP），时间窗换算为天粒度
    const sql = flattenSql(config.body);
    expect(sql).toContain(
      'SELECT lognumber, log_handle, object, subobject, extnumber, aldate, altime, aluser, alprog, almode, msg_cnt_al FROM balhdr'
    );
    expect(sql).toContain(
      "WHERE object = 'ZSALES' AND subobject = 'ZORDER' AND extnumber = 'SO-4711' AND aluser = 'YANGP' AND aldate >= '20260901' AND aldate <= '20260907'"
    );
    expect(sql).toContain('ORDER BY aldate DESCENDING, altime DESCENDING');

    // 精简 JSON：核心标识恒输出，空值/零值字段缺省；时间戳为 ALDATE+ALTIME 合并
    expect(result).toEqual({
      entries: [
        {
          logNumber: '00000000000000001234',
          logHandle: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
          object: 'ZSALES',
          subObject: 'ZORDER',
          externalId: 'SO-4711',
          timestamp: '2026-09-01T10:15:30',
          user: 'YANGP',
          program: 'ZSALES_POST',
          mode: 'W',
          messageCount: 3
        },
        {
          logNumber: '00000000000000001235',
          logHandle: '1B2C3D4E5F60718293A4B5C6D7E8F90A',
          object: 'ZSALES',
          timestamp: '2026-09-01T08:00:00',
          user: 'DOEJ',
          program: 'ZINVOICE_CREATE'
        }
      ],
      count: 2,
      truncated: false,
      appliedFilter: {
        object: 'ZSALES',
        objectSubobject: 'ZORDER',
        externalId: 'SO-4711',
        userName: 'YANGP',
        dateWindow: { from: '20260901', to: '20260907' },
        maxResults: 10
      }
    });
  });

  it('runs an unfiltered bounded query (default cap 100) when no filter is given', async () => {
    const client = http(TWO_ROWS_XML);
    const result = await readApplicationLog(client);

    // 无任何过滤：不拼 WHERE，maxResults 缺省 100 兜底（对齐 VSP applog.go 第 74-77 行）
    const { config } = lastRequest(client);
    expect(config.qs).toEqual({ rowNumber: 100 });
    const sql = flattenSql(config.body);
    expect(sql).not.toContain(' WHERE ');
    expect(sql).toContain('ORDER BY aldate DESCENDING, altime DESCENDING');

    expect(result.entries).toHaveLength(2);
    expect(result.appliedFilter).toEqual({ maxResults: 100 });
  });

  it('doubles single quotes in filter values (the only Open SQL literal escape)', async () => {
    const client = http(EMPTY_TABLE_XML);
    await readApplicationLog(client, { externalId: "O'BRIEN-4711" });

    // 对齐 VSP applog.go 第 142-145 行 sqlQuote：值内单引号翻倍，无法逃出字面量
    expect(flattenSql(lastRequest(client).config.body)).toContain("extnumber = 'O''BRIEN-4711'");
  });

  it('wraps long SQL at blanks outside quotes and keeps every line within the ABAP line limit', async () => {
    const client = http(EMPTY_TABLE_XML);
    const longId = 'X'.repeat(100);
    await readApplicationLog(client, { externalId: longId, timeFrom: '2026-09-01', timeTo: '2026-09-30' });

    // 对齐 VSP client.go wrapSQL：数据预览把请求体装入 255 字符 ABAP 源行，
    // 必须在引号外空白处主动折行；字面量本身绝不能被切开
    const body = String(lastRequest(client).config.body);
    const lines = body.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
    expect(body).toContain(`'${longId}'`);
  });

  it.each([
    ['a non-ISO bound', '20260901', '2026-09-07'],
    ['an impossible calendar date', '2026-02-30', '2026-09-07'],
    ['a reversed window', '2026-09-07', '2026-09-01'],
    ['a window wider than 31 days', '2026-01-01', '2026-02-02']
  ])('rejects %s before any HTTP call', async (_label, timeFrom, timeTo) => {
    const client = http('');
    await expect(readApplicationLog(client, { timeFrom, timeTo })).rejects.toThrow(/time(From|To| window)/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('accepts a time window of exactly 31 days', async () => {
    const client = http(EMPTY_TABLE_XML);
    await readApplicationLog(client, { timeFrom: '2026-01-01', timeTo: '2026-02-01' });

    const sql = flattenSql(lastRequest(client).config.body);
    expect(sql).toContain("aldate >= '20260101'");
    expect(sql).toContain("aldate <= '20260201'");
  });

  it('supports one-sided windows (only timeTo)', async () => {
    const client = http(EMPTY_TABLE_XML);
    await readApplicationLog(client, { timeTo: '2026-09-30' });

    const sql = flattenSql(lastRequest(client).config.body);
    expect(sql).not.toContain('aldate >=');
    expect(sql).toContain("aldate <= '20260930'");
  });

  it('rejects an out-of-range maxResults before any HTTP call', async () => {
    const client = http('');
    await expect(readApplicationLog(client, { maxResults: 0 })).rejects.toThrow(/maxResults/);
    await expect(readApplicationLog(client, { maxResults: 501 })).rejects.toThrow(/maxResults/);
    await expect(readApplicationLog(client, { maxResults: 10.5 })).rejects.toThrow(/maxResults/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('flags truncated when the row count reaches the maxResults cap', async () => {
    const client = http(tableDataXml([
      column('LOGNUMBER', ['00000000000000001234'], 22),
      column('LOG_HANDLE', ['0A1B2C3D4E5F60718293A4B5C6D7E8F9'], 32),
      column('OBJECT', ['ZSALES'], 20)
    ]));
    const result = await readApplicationLog(client, { maxResults: 1 });

    // 行数打满上限即保守标记可能截断（对齐 sm21Read 的 truncated 语义）
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('returns an empty entry list when the log has no matching headers', async () => {
    const client = http(EMPTY_TABLE_XML);
    const result = await readApplicationLog(client, { object: 'ZNOTHING' });

    // 空结果为空数组而非错误（对齐 CdsDependencyApi 容错语义）
    expect(result.entries).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('returns an empty entry list instead of failing on an unexpected payload', async () => {
    const client = http('this is not xml');
    const result = await readApplicationLog(client);

    expect(result.entries).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('tolerates lower-case column names returned by the data preview', async () => {
    const client = http(tableDataXml([
      column('lognumber', ['00000000000000009999'], 22),
      column('log_handle', ['HANDLE9'], 32),
      column('object', ['ZLOW'], 20)
    ]));
    const result = await readApplicationLog(client);

    // 列名大小写随系统漂移：cell() 依次尝试原样/小写/大写键（对齐 VSP cell 语义）
    expect(result.entries).toEqual([
      { logNumber: '00000000000000009999', logHandle: 'HANDLE9', object: 'ZLOW' }
    ]);
  });

  it('omits the timestamp for an unparseable date and falls back to midnight for a bad clock', async () => {
    const client = http(tableDataXml([
      column('LOGNUMBER', ['00000000000000000777', '00000000000000000778'], 22),
      column('OBJECT', ['ZODD', 'ZODD'], 20),
      column('ALDATE', ['notadate', '20260902'], 8),
      column('ALTIME', ['', ''], 6)
    ]));
    const result = await readApplicationLog(client);

    // 一条日期异常的日志仍是日志：丢字段不丢行（对齐 VSP parseSAPStamp 语义）
    expect(result.entries).toEqual([
      { logNumber: '00000000000000000777', object: 'ZODD' },
      { logNumber: '00000000000000000778', object: 'ZODD', timestamp: '2026-09-02T00:00:00' }
    ]);
  });

  it('propagates upstream HTTP errors unchanged', async () => {
    const failure = new Error('HTTP 500');
    const client = { request: jest.fn().mockRejectedValue(failure) } as unknown as AdtHTTP;
    await expect(readApplicationLog(client, { object: 'ZSALES' })).rejects.toBe(failure);
  });
});

describe('ApplicationLogClient binding', () => {
  it('binds the read-only capability to one AdtHTTP session', async () => {
    const client = http(EMPTY_TABLE_XML);
    const bound = createApplicationLogClient(client);

    await bound.readApplicationLog({ object: 'ZSALES' });

    // 绑定后调用必须落在同一注入会话上，且为只读 POST（数据预览查询）
    const calls = (client.request as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/sap/bc/adt/datapreview/freestyle');
    expect(calls[0][1].method).toBe('POST');
  });
});
