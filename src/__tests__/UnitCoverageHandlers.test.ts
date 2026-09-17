import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { UnitCoverageHandlers } from '../handlers/UnitCoverageHandlers';
import type { UnitCoverageClient, UnitCoverageResult } from '../adt/UnitCoverageApi.js';

/**
 * UnitCoverageHandlers 工具层测试（mock 注入客户端，绝不连接真实 SAP）。
 * 对齐 CdsDependencyHandlers.test.ts 基准，覆盖：getTools 名称唯一性与执行型
 * 元数据、supports 边界、参数校验（对象类型/命名白名单/复合格式/档位枚举）、
 * 分派与规范化输入、上游错误传播与响应脱敏、未知工具拒绝。
 */

/** 构造被测工具的样例执行结果（裁剪 JSON：执行状态+覆盖率数字）。 */
const sampleCoverageResult: UnitCoverageResult = {
  objectName: 'ZCOVERAGE_DEMO',
  objectType: 'PROGRAM',
  objectUri: '/sap/bc/adt/programs/programs/ZCOVERAGE_DEMO',
  flags: { harmless: true, dangerous: false, critical: false, short: true, medium: true, long: false },
  execution: {
    testClasses: [
      {
        name: 'ZCL_COVERAGE_DEMO_TEST',
        alertCount: 0,
        status: 'passed',
        testMethods: [{ name: 'TEST_PASS', executionTime: 12, alertCount: 0, status: 'passed' }]
      }
    ],
    summary: { testClassCount: 1, testMethodCount: 1, alertCount: 0 }
  },
  coverage: {
    statements: { total: 140, covered: 85, percent: 60.71 },
    branches: { total: 20, covered: 5, percent: 25 },
    procedures: { total: 0, covered: 0, percent: 0 },
    sourceCoverage: {}
  }
};

/** 构造 runUnitCoverage 为 jest mock 的注入客户端。 */
function mockClient(): UnitCoverageClient {
  return { runUnitCoverage: jest.fn().mockResolvedValue(sampleCoverageResult) };
}

describe('UnitCoverageHandlers tool catalog', () => {
  it('publishes a single uniquely named executing coverage tool', () => {
    const tools = new UnitCoverageHandlers(mockClient()).getTools();
    const names = tools.map(tool => tool.name);

    // 名称唯一（与项目工具目录完整性基线同口径）
    expect(names).toEqual(['runUnitCoverage']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares executing (non-readonly, non-destructive) metadata on the tool', () => {
    const tool = new UnitCoverageHandlers(mockClient()).getTools()[0];

    // 执行型语义：运行用户代码但零对象修改，与 unitTestRun 同级——非只读、
    // 非破坏、不可重复幂等；无需 preview 确认（对齐 VSP focused GetCodeCoverage）
    expect(tool.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true
    });
    expect(tool._meta).toEqual({ operationClass: 'mutating tenant', approvalRequired: false });
  });

  it('constrains the input schema with enums, name bounds and no extra properties', () => {
    const schema = new UnitCoverageHandlers(mockClient()).getTools()[0].inputSchema;

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['objectType', 'objectName']);
    expect(schema.properties.objectType).toMatchObject({ enum: ['PROGRAM', 'CLASS', 'FUNCTION_MODULE'] });
    expect(schema.properties.objectName).toMatchObject({ minLength: 1, maxLength: 57 });
    expect(schema.properties.riskLevel).toMatchObject({ enum: ['HARMLESS', 'DANGEROUS', 'CRITICAL'], optional: true });
    expect(schema.properties.duration).toMatchObject({ enum: ['SHORT', 'MEDIUM', 'LONG'], optional: true });
  });

  it('claims exactly its tool name via supports()', () => {
    const handlers = new UnitCoverageHandlers(mockClient());
    expect(handlers.supports('runUnitCoverage')).toBe(true);
    expect(handlers.supports('unitTestRun')).toBe(false);
    expect(handlers.supports('sap')).toBe(false);
  });
});

describe('UnitCoverageHandlers dispatch and validation', () => {
  it('dispatches with a normalized query and wraps the result as structured content', async () => {
    const client = mockClient();
    const handlers = new UnitCoverageHandlers(client);

    const response = await handlers.handle('runUnitCoverage', {
      objectType: 'PROGRAM',
      objectName: ' zcoverage_demo '
    });

    // 小写与首尾空白在服务端规范化；未提供的档位保持缺省（undefined 透传，
    // 由 API 层展开为上游默认标志集）
    expect(client.runUnitCoverage).toHaveBeenCalledWith({
      objectType: 'PROGRAM',
      objectName: 'ZCOVERAGE_DEMO'
    });
    expect(response.structuredContent).toEqual({ status: 'success', result: sampleCoverageResult });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('passes through explicit riskLevel and duration selections', async () => {
    const client = mockClient();
    await new UnitCoverageHandlers(client).handle('runUnitCoverage', {
      objectType: 'FUNCTION_MODULE',
      objectName: 'ZFG_COV/ZFM_COV',
      riskLevel: 'CRITICAL',
      duration: 'LONG'
    });

    expect(client.runUnitCoverage).toHaveBeenCalledWith({
      objectType: 'FUNCTION_MODULE',
      objectName: 'ZFG_COV/ZFM_COV',
      riskLevel: 'CRITICAL',
      duration: 'LONG'
    });
  });

  it.each([
    ['missing objectType', { objectName: 'ZCOVERAGE_DEMO' }],
    ['objectType outside the allowlist', { objectType: 'TABLE', objectName: 'ZFOO' }],
    ['missing objectName', { objectType: 'CLASS' }],
    ['blank objectName', { objectType: 'CLASS', objectName: '   ' }],
    ['objectName over 57 characters', { objectType: 'CLASS', objectName: 'Z'.repeat(58) }],
    ['objectName with illegal characters', { objectType: 'PROGRAM', objectName: 'Z(A)' }],
    ['non-string objectName', { objectType: 'CLASS', objectName: 42 }],
    ['FUNCTION_MODULE without composite form', { objectType: 'FUNCTION_MODULE', objectName: 'ZFM_ONLY' }],
    ['riskLevel outside the enum', { objectType: 'CLASS', objectName: 'ZCL_X', riskLevel: 'EXTREME' }],
    ['duration outside the enum', { objectType: 'CLASS', objectName: 'ZCL_X', duration: 'ETERNAL' }],
    ['lowercase enum value is rejected strictly', { objectType: 'CLASS', objectName: 'ZCL_X', riskLevel: 'critical' }]
  ])('rejects invalid input (%s) with InvalidParams', async (_label, args) => {
    const client = mockClient();
    const handlers = new UnitCoverageHandlers(client);

    await expect(handlers.handle('runUnitCoverage', args as Record<string, unknown>))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 校验失败必须发生在进入底层客户端之前
    expect(client.runUnitCoverage).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    // 上游（客户端/低层）抛出的 MCP 语义错误必须原样透传，不得吞成 500
    const requestError = new McpError(ErrorCode.InvalidParams, 'query rejected');
    const client = mockClient();
    (client.runUnitCoverage as jest.Mock).mockRejectedValue(requestError);

    await expect(new UnitCoverageHandlers(client).handle('runUnitCoverage', { objectType: 'CLASS', objectName: 'ZCL_X' }))
      .rejects.toBe(requestError);
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = mockClient();
    (client.runUnitCoverage as jest.Mock).mockRejectedValue(new Error('SECRET_REMOTE_BODY'));

    await expect(new UnitCoverageHandlers(client).handle('runUnitCoverage', { objectType: 'CLASS', objectName: 'ZCL_X' }))
      .rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.not.stringContaining('SECRET_REMOTE_BODY')
      });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new UnitCoverageHandlers(mockClient());
    await expect(handlers.handle('getCodeCoverage', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
