/**
 * AMDP discovery 三件套测试：状态码分类、注入绑定、handler 工具面。
 * HTTP 层全部 mock，不连接 SAP。
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { checkAmdpDebugger, createAmdpDiscoveryClient } from '../adt/AmdpDiscoveryApi';
import { AmdpDiscoveryHandlers } from '../handlers/AmdpDiscoveryHandlers';
import type { AdtHTTP } from '../adt/AdtHTTP';

function httpWith(status: number, body?: string): AdtHTTP {
  return { request: jest.fn().mockResolvedValue({ status, body: body ?? '' }) } as unknown as AdtHTTP;
}
function httpRejecting(message: string): AdtHTTP {
  return { request: jest.fn().mockRejectedValue(new Error(message)) } as unknown as AdtHTTP;
}

describe('checkAmdpDebugger status classification (VSP probeAMDP semantics)', () => {
  it('treats HTTP 400 as available (resource exists and demands a mainId)', async () => {
    const result = await checkAmdpDebugger(httpWith(400));
    expect(result).toEqual({
      availability: 'available', message: 'AMDP debugger available', evidence: 'HTTP 400'
    });
  });

  it.each([200, 405])('treats HTTP %i as available', async status => {
    const result = await checkAmdpDebugger(httpWith(status));
    expect(result.availability).toBe('available');
    expect(result.evidence).toBe(`HTTP ${status}`);
  });

  it('treats HTTP 404 as unavailable', async () => {
    const result = await checkAmdpDebugger(httpWith(404));
    expect(result.availability).toBe('unavailable');
    expect(result.message).toMatch(/not available/);
  });

  it('treats other statuses as unknown without leaking the response', async () => {
    const result = await checkAmdpDebugger(httpWith(503, 'internal target details'));
    expect(result.availability).toBe('unknown');
    expect(result.evidence).toBe('HTTP 503');
  });

  it('classifies transport errors by code and never leaks upstream text', async () => {
    const notFound = await checkAmdpDebugger(httpRejecting('Request failed with status code 404'));
    expect(notFound.availability).toBe('unavailable');
    const badRequest = await checkAmdpDebugger(httpRejecting('Request failed with status code 400'));
    expect(badRequest.availability).toBe('available');
    const transport = await checkAmdpDebugger(httpRejecting('ECONNREFUSED 10.30.254.48'));
    expect(transport.availability).toBe('unknown');
    expect(transport.evidence).toBe('transport error');
  });

  it('treats the real-machine business error (mainId demanded) as available', async () => {
    // 真机形态（2026-09-18 实测）：本项目 ADT 客户端把 400 转成业务 Error，
    // 文本即 ADT 错误响应体的参数提示——这是资源存在的直接证据
    const result = await checkAmdpDebugger(httpRejecting('Parameter mainId could not be found.'));
    expect(result).toEqual({
      availability: 'available',
      message: 'AMDP debugger available',
      evidence: 'HTTP 400 (mainId required)'
    });
  });

  it('always asks the correct VSP-measured path (not the historical 404 path)', async () => {
    const mock = httpWith(400);
    await checkAmdpDebugger(mock);
    expect((mock.request as jest.Mock).mock.calls[0][0]).toBe('/sap/bc/adt/amdp/debugger/main');
  });

  it('binds the AdtHTTP session into the narrow client', async () => {
    const client = createAmdpDiscoveryClient(httpWith(400));
    const result = await client.checkAmdpDebugger();
    expect(result.availability).toBe('available');
  });
});

describe('AmdpDiscoveryHandlers', () => {
  const checkMock = jest.fn();
  const handlers = new AmdpDiscoveryHandlers({ checkAmdpDebugger: checkMock });

  beforeEach(() => checkMock.mockReset());

  it('claims exactly one read-only tool with no input', () => {
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['checkAmdpDebugger']);
    expect(tools[0].annotations.readOnlyHint).toBe(true);
    expect(tools[0]._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
    expect(tools[0].inputSchema.properties).toEqual({});
    expect(handlers.supports('checkAmdpDebugger')).toBe(true);
    expect(handlers.supports('other')).toBe(false);
  });

  it('returns the probe result through the success wrapper', async () => {
    checkMock.mockResolvedValue({ availability: 'available', message: 'AMDP debugger available', evidence: 'HTTP 400' });
    const result = await handlers.handle('checkAmdpDebugger', {});
    expect(result.structuredContent.result.availability).toBe('available');
  });

  it('rejects unknown tools and sanitizes upstream errors', async () => {
    await expect(handlers.handle('unknown', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    checkMock.mockRejectedValue(new Error('target system said something secret'));
    await expect(handlers.handle('checkAmdpDebugger', {})).rejects.toMatchObject({ code: ErrorCode.InternalError });
    checkMock.mockRejectedValue(new McpError(ErrorCode.InvalidParams, 'bad'));
    await expect(handlers.handle('checkAmdpDebugger', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
