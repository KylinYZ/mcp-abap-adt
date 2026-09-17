import { InstallDiagnosticsHandlers } from '../handlers/InstallDiagnosticsHandlers.js';
import type { InstallDiagnosticsClient } from '../adt/InstallDiagnosticsApi.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * InstallDiagnosticsHandlers 目录与分派契约测试（mock 客户端，零 SAP 往返）。
 * 断言与既有只读处理器测试同口径：目录/注解、supports 边界、分派、
 * 错误脱敏与未知工具拒绝。
 */

function clientMock(): InstallDiagnosticsClient {
  return {
    checkInstallPrerequisites: jest.fn(async () => ({
      localRuntime: { node: 'v22.0.0' },
      zadtVspHelper: { installed: false, objects: [] },
      abapGit: { status: 'not_installed' as const, detail: '404' },
      notes: ['note']
    }))
  };
}

describe('InstallDiagnosticsHandlers tool catalog', () => {
  it('publishes one uniquely named read-only tool', () => {
    const handlers = new InstallDiagnosticsHandlers(clientMock());
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['checkInstallPrerequisites']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    }
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new InstallDiagnosticsHandlers(clientMock());
    expect(handlers.supports('checkInstallPrerequisites')).toBe(true);
    expect(handlers.supports('installAbapGit')).toBe(false);
  });
});

describe('InstallDiagnosticsHandlers dispatch and validation', () => {
  it('dispatches and wraps the report', async () => {
    const client = clientMock();
    const handlers = new InstallDiagnosticsHandlers(client);
    const result = await handlers.handle('checkInstallPrerequisites', {});
    expect(client.checkInstallPrerequisites).toHaveBeenCalledWith();
    expect(result.structuredContent.status).toBe('success');
  });

  it('propagates request-level MCP errors unchanged', async () => {
    const client = clientMock();
    (client.checkInstallPrerequisites as jest.Mock).mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'shaped'));
    const handlers = new InstallDiagnosticsHandlers(client);
    await expect(handlers.handle('checkInstallPrerequisites', {}))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining('shaped') });
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = clientMock();
    (client.checkInstallPrerequisites as jest.Mock).mockRejectedValueOnce(new Error('secret-host 500'));
    const handlers = new InstallDiagnosticsHandlers(client);
    await expect(handlers.handle('checkInstallPrerequisites', {}))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('checkInstallPrerequisites failed.')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new InstallDiagnosticsHandlers(clientMock());
    await expect(handlers.handle('installZadtVsp', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
