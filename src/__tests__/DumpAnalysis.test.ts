/**
 * DumpAnalysisHandlers 测试：聚合纯函数 + handler 工具面两层。
 * 数据源（RuntimeDumpReader.read）全部 mock，不连接 SAP。
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { DumpAnalysisHandlers } from '../handlers/DumpAnalysisHandlers';
import { extractDumpFacets, findSimilarDumps, groupRuntimeDumps } from '../read/DumpAnalytics';
import type { RuntimeDumpSummary } from '../read/RuntimeDumpReader';

/** 构造一条真实感的 dump 摘要（categories: term=值, label=类别）。 */
function dump(
  id: string,
  runtimeError: string,
  program: string,
  at: string,
  user?: string
): RuntimeDumpSummary {
  return {
    id,
    author: user,
    categories: [
      { term: runtimeError, label: 'ABAP runtime error' },
      { term: program, label: 'Terminated ABAP program' }
    ],
    text: `${runtimeError} dump in ${program}`,
    type: 'ABAP Runtime Error',
    published: new Date(at),
    updated: new Date(at)
  };
}

describe('DumpAnalytics aggregation (pure functions)', () => {
  const samples = [
    dump('D1', 'CX_SY_ZERODIVIDE', 'ZREP_A', '2026-09-16T01:00:00Z', 'USER1'),
    dump('D2', 'CX_SY_ZERODIVIDE', 'ZREP_A', '2026-09-16T03:00:00Z', 'USER2'),
    dump('D3', 'CX_SY_ZERODIVIDE', 'ZREP_A', '2026-09-16T02:00:00Z', 'USER1'),
    dump('D4', 'CX_SY_OPEN_SQL_DB', 'ZREP_B', '2026-09-16T04:00:00Z', 'USER1'),
    dump('D5', 'MESSAGE_TYPE_X', 'SAPLSLST', '2026-09-16T05:00:00Z')
  ];

  it('extracts facets from categories with published timestamp', () => {
    const facets = extractDumpFacets(samples[0]);
    expect(facets).toEqual({
      runtimeError: 'CX_SY_ZERODIVIDE',
      program: 'ZREP_A',
      at: new Date('2026-09-16T01:00:00Z'),
      user: 'USER1'
    });
  });

  it('groups by error+program with count, users, and first/last', () => {
    const result = groupRuntimeDumps(samples);
    expect(result.totalDumps).toBe(5);
    // 频次降序：3 次的 ZERODIVIDE 组在前
    expect(result.groups[0]).toMatchObject({
      runtimeError: 'CX_SY_ZERODIVIDE',
      program: 'ZREP_A',
      count: 3,
      first: new Date('2026-09-16T01:00:00Z'),
      last: new Date('2026-09-16T03:00:00Z'),
      users: ['USER1', 'USER2']
    });
    expect(result.groups[0].dumpIds).toEqual(['D1', 'D2', 'D3']);
    expect(result.groups.map(g => g.count)).toEqual([3, 1, 1]);
  });

  it('breaks frequency ties by most recent occurrence', () => {
    // D4（04:00）与 D5（05:00）同频次：更晚发生的 D5 组排前
    const result = groupRuntimeDumps(samples);
    expect(result.groups[1].runtimeError).toBe('MESSAGE_TYPE_X');
    expect(result.groups[2].runtimeError).toBe('CX_SY_OPEN_SQL_DB');
  });

  it('returns empty groups for empty input (empty answer is not an error)', () => {
    const result = groupRuntimeDumps([]);
    expect(result.groups).toEqual([]);
    expect(result.totalDumps).toBe(0);
  });

  it('keeps entries without timestamps in the count but not in time bounds', () => {
    const noTime = { ...dump('D9', 'CX_SY_ZERODIVIDE', 'ZREP_A', '2026-09-16T02:00:00Z'), published: undefined, updated: undefined };
    const result = groupRuntimeDumps([samples[0], noTime]);
    expect(result.groups[0].count).toBe(2);
    expect(result.groups[0].first).toEqual(new Date('2026-09-16T01:00:00Z'));
    expect(result.groups[0].last).toEqual(new Date('2026-09-16T01:00:00Z'));
  });

  it('finds similar dumps with ordered occurrences and optional program filter', () => {
    const similar = findSimilarDumps(samples, 'cx_sy_zerodivide');
    expect(similar.count).toBe(3);
    expect(similar.users).toEqual(['USER1', 'USER2']);
    expect(similar.occurrences.map(o => o.id)).toEqual(['D1', 'D3', 'D2']);

    // 叠加程序过滤：只看 ZREP_A 的历史
    const narrowed = findSimilarDumps(samples, 'CX_SY_ZERODIVIDE', 'ZREP_A');
    expect(narrowed.count).toBe(3);
    expect(narrowed.program).toBe('ZREP_A');

    const otherProgram = findSimilarDumps(samples, 'CX_SY_ZERODIVIDE', 'ZREP_OTHER');
    expect(otherProgram.count).toBe(0);
    expect(otherProgram.occurrences).toEqual([]);
  });
});

describe('DumpAnalysisHandlers', () => {
  const readMock = jest.fn();
  const handlers = new DumpAnalysisHandlers({ read: readMock } as any);

  beforeEach(() => readMock.mockReset());

  it('claims exactly its two tool names with read-only metadata', () => {
    const tools = handlers.getTools();
    expect(tools.map(t => t.name).sort()).toEqual(['findSimilarDumps', 'groupRuntimeDumps']);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
    expect(handlers.supports('groupRuntimeDumps')).toBe(true);
    expect(handlers.supports('unknown')).toBe(false);
  });

  it('groups dumps read through the shared reader and echoes the window', async () => {
    readMock.mockResolvedValue({ dumps: [
      dump('D1', 'CX_SY_ZERODIVIDE', 'ZREP_A', '2026-09-16T01:00:00Z', 'USER1')
    ] });
    const result = await handlers.handle('groupRuntimeDumps', { from: '2026-09-16T00:00:00Z', to: '2026-09-16T23:00:00Z' });
    expect(readMock).toHaveBeenCalledWith({ from: '2026-09-16T00:00:00Z', to: '2026-09-16T23:00:00Z' });
    expect(result.structuredContent.result.groups).toHaveLength(1);
    expect(result.structuredContent.result.window).toEqual({ from: '2026-09-16T00:00:00Z', to: '2026-09-16T23:00:00Z' });
  });

  it('requires runtimeError for findSimilarDumps before touching the reader', async () => {
    await expect(handlers.handle('findSimilarDumps', { from: 'x', to: 'y', runtimeError: '   ' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('finds similar dumps through the shared reader', async () => {
    readMock.mockResolvedValue({ dumps: [
      dump('D4', 'CX_SY_OPEN_SQL_DB', 'ZREP_B', '2026-09-16T04:00:00Z', 'USER1')
    ] });
    const result = await handlers.handle('findSimilarDumps', {
      runtimeError: 'CX_SY_OPEN_SQL_DB', from: '2026-09-16T00:00:00Z', to: '2026-09-17T00:00:00Z'
    });
    expect(result.structuredContent.result.count).toBe(1);
    expect(result.structuredContent.result.occurrences[0].id).toBe('D4');
  });

  it('matches runtimeError client-side only (never passed to the server feed filter)', async () => {
    readMock.mockResolvedValue({ dumps: [] });
    await handlers.handle('findSimilarDumps', {
      runtimeError: 'CX_SY_ZERODIVIDE', from: 'x', to: 'y'
    });
    const readerArgs = readMock.mock.calls[0][0];
    // 服务端过滤只收时间窗/limit/user；异常匹配在客户端完成
    expect(readerArgs.runtimeError).toBeUndefined();
    expect(readerArgs.from).toBe('x');
  });

  it('sanitizes upstream errors as InternalError', async () => {
    readMock.mockRejectedValue(new Error('ADT responded with secret details'));
    // 脱敏断言：上游文本不得外泄，统一替换为 "<tool> failed."
    const rejection = await handlers.handle('groupRuntimeDumps', { from: 'x', to: 'y' }).catch(e => e);
    expect(rejection.code).toBe(ErrorCode.InternalError);
    // McpError 的 message 带标准 'MCP error -32603:' 前缀，核对业务文本与脱敏即可
    expect(String(rejection.message)).toContain('groupRuntimeDumps failed.');
    expect(String(rejection.message)).not.toContain('secret');
    expect(String(rejection.message)).not.toContain('secret');
  });

  it('passes through McpError unchanged', async () => {
    readMock.mockRejectedValue(new McpError(ErrorCode.InvalidParams, 'bad window'));
    await expect(handlers.handle('groupRuntimeDumps', { from: 'x', to: 'y' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects unknown tool names', async () => {
    await expect(handlers.handle('unknown', {}))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
