import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { HighLevelReadHandlers } from '../handlers/HighLevelReadHandlers';

describe('HighLevelReadHandlers', () => {
  it('publishes four explicitly read-only high-level tools', () => {
    const handlers = new HighLevelReadHandlers({ read: jest.fn() } as never, { describe: jest.fn() } as never);

    expect(handlers.getTools()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'readRuntimeDumps',
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        _meta: { operationClass: 'read-only tenant', approvalRequired: false }
      }),
      expect.objectContaining({
        name: 'describeClassicTable',
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        _meta: { operationClass: 'read-only tenant', approvalRequired: false }
      }),
      expect.objectContaining({
        name: 'inspectSapSystem',
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false })
      }),
      expect.objectContaining({
        name: 'getAbapMemberSource',
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false })
      })
    ]));
  });

  it('dispatches system and member inspection through their bounded readers', async () => {
    const systemInspector = { inspect: jest.fn().mockResolvedValue({ sapConnectionVerified: true }) };
    const memberSources = { read: jest.fn().mockResolvedValue({ member: { name: 'RUN' } }) };
    const handlers = new HighLevelReadHandlers(
      { read: jest.fn() } as never,
      { describe: jest.fn() } as never,
      systemInspector as never,
      memberSources as never
    );

    await handlers.handle('inspectSapSystem', {});
    const input = { objectType: 'CLASS', objectName: 'ZCL_DEMO', memberName: 'RUN' };
    await handlers.handle('getAbapMemberSource', input);

    expect(systemInspector.inspect).toHaveBeenCalledTimes(1);
    expect(memberSources.read).toHaveBeenCalledWith(input);
  });

  it('returns structured and visible bounded dump results', async () => {
    const result = { feedUpdated: new Date(), returnedCount: 0, feedCount: 0, truncated: false, dumps: [] };
    const runtimeDumps = { read: jest.fn().mockResolvedValue(result) };
    const handlers = new HighLevelReadHandlers(runtimeDumps as never, { describe: jest.fn() } as never);
    const argumentsValue = { from: '2026-08-16T00:00:00+08:00', to: '2026-08-16T01:00:00+08:00', limit: 20 };

    const response = await handlers.handle('readRuntimeDumps', argumentsValue);

    expect(runtimeDumps.read).toHaveBeenCalledWith(argumentsValue);
    expect(response.structuredContent).toEqual({ status: 'success', result });
    expect(JSON.parse(response.content[0].text)).toEqual(JSON.parse(JSON.stringify({ status: 'success', result })));
  });

  it('sanitizes unexpected lower-level failures while preserving request errors', async () => {
    const requestError = new McpError(ErrorCode.InvalidParams, 'invalid window');
    const requestHandlers = new HighLevelReadHandlers({ read: jest.fn().mockRejectedValue(requestError) } as never, { describe: jest.fn() } as never);
    await expect(requestHandlers.handle('readRuntimeDumps', {})).rejects.toBe(requestError);

    const remoteHandlers = new HighLevelReadHandlers({ read: jest.fn() } as never, {
      describe: jest.fn().mockRejectedValue(new Error('SECRET_REMOTE_BODY'))
    } as never);
    await expect(remoteHandlers.handle('describeClassicTable', { tableName: 'T000' }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError, message: expect.not.stringContaining('SECRET_REMOTE_BODY') });
  });

  it('rejects unknown high-level tool names', async () => {
    const handlers = new HighLevelReadHandlers({ read: jest.fn() } as never, { describe: jest.fn() } as never);
    await expect(handlers.handle('rawDumpQuery', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
