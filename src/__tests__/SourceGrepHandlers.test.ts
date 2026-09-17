import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { SourceGrepHandlers } from '../handlers/SourceGrepHandlers';
import type { SourceGrepClient } from '../adt/SourceGrepApi.js';

/**
 * SourceGrepHandlers 工具层测试（mock 注入客户端，绝不连接真实 SAP）。
 * 覆盖：getTools 名称唯一性与只读元数据、supports 边界、参数校验
 * （包名/对象名/正则/数值边界/类型白名单）、分派与规范化输入、
 * 上游错误传播与响应脱敏、未知工具拒绝。
 */

/** grepPackage 的样例成功结果（对齐 API 层返回形状）。 */
const samplePackageResult = {
  scope: 'package' as const,
  packageName: 'ZPKG',
  pattern: 'counter',
  caseInsensitive: false,
  objects: [
    {
      objectName: 'ZREP_HIT',
      objectType: 'PROG/P',
      objectUri: '/sap/bc/adt/programs/programs/zrep_hit',
      matchCount: 1,
      matches: [{ lineNumber: 2, matchedLine: 'DATA lv_counter TYPE i.' }]
    }
  ],
  totalMatches: 1,
  searchedObjects: 1,
  skipped: [],
  truncated: false,
  message: 'Found 1 match(es) across 1 object(s) in package ZPKG'
};

/** 构造两个方法均为 jest mock 的注入客户端。 */
function mockClient(): SourceGrepClient {
  return {
    grepPackage: jest.fn().mockResolvedValue(samplePackageResult),
    grepObjects: jest.fn().mockResolvedValue({
      scope: 'objects',
      pattern: 'todo',
      caseInsensitive: false,
      objects: [],
      totalMatches: 0,
      searchedObjects: 1,
      skipped: [],
      truncated: false,
      message: 'No matches found in 1 object(s)'
    })
  };
}

describe('SourceGrepHandlers tool catalog', () => {
  it('publishes two uniquely named read-only source grep tools', () => {
    const tools = new SourceGrepHandlers(mockClient()).getTools();
    const names = tools.map(tool => tool.name);

    // 名称唯一（与项目工具目录完整性基线同口径）
    expect(names).toEqual(['grepPackage', 'grepObjects']);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of tools) {
      // 全部只读：注解与 _meta 必须声明 read-only tenant、无需确认
      expect(tool.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
      });
      expect(tool._meta).toEqual({ operationClass: 'read-only tenant', approvalRequired: false });
      // schema 边界：禁止额外属性
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }

    // grepPackage schema：包名与正则必填、长度受限；数值参数有界
    const packageSchema = tools[0].inputSchema.properties;
    expect(tools[0].inputSchema.required).toEqual(['packageName', 'pattern']);
    expect(packageSchema.packageName).toMatchObject({ minLength: 1, maxLength: 40 });
    expect(packageSchema.pattern).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(packageSchema.maxResults).toMatchObject({ minimum: 1, maximum: 500 });
    expect(packageSchema.contextLines).toMatchObject({ minimum: 0, maximum: 5 });

    // grepObjects schema：对象列表 1..20，单个对象需 name+objectType 枚举
    const objectsSchema = tools[1].inputSchema.properties;
    expect(tools[1].inputSchema.required).toEqual(['objects', 'pattern']);
    expect(objectsSchema.objects).toMatchObject({ minItems: 1, maxItems: 20 });
    const items = objectsSchema.objects?.items;
    expect(items).toMatchObject({
      required: ['name', 'objectType'],
      additionalProperties: false
    });
    expect(items?.properties?.objectType).toMatchObject({
      enum: ['PROG', 'CLAS', 'INTF', 'FUGR', 'INCL', 'DDLS']
    });
  });

  it('claims exactly its two tool names via supports()', () => {
    const handlers = new SourceGrepHandlers(mockClient());
    expect(handlers.supports('grepPackage')).toBe(true);
    expect(handlers.supports('grepObjects')).toBe(true);
    expect(handlers.supports('searchObject')).toBe(false);
    expect(handlers.supports('sap')).toBe(false);
  });
});

describe('SourceGrepHandlers dispatch and normalization', () => {
  it('dispatches grepPackage with normalized package name and default flags', async () => {
    const client = mockClient();
    const handlers = new SourceGrepHandlers(client);

    const response = await handlers.handle('grepPackage', {
      packageName: ' zpkg ',
      pattern: 'counter'
    });

    // 小写与首尾空白在服务端规范化；布尔/数值缺省补默认值
    expect(client.grepPackage).toHaveBeenCalledWith({
      packageName: 'ZPKG',
      pattern: 'counter',
      caseInsensitive: false,
      maxResults: 100,
      contextLines: 0
    });
    expect(response.structuredContent).toEqual({ status: 'success', result: samplePackageResult });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('dispatches grepObjects with normalized object references', async () => {
    const client = mockClient();
    const handlers = new SourceGrepHandlers(client);

    await handlers.handle('grepObjects', {
      objects: [
        { name: ' zcl_a ', objectType: 'CLAS' },
        { name: 'ZPROG_A', objectType: 'PROG' }
      ],
      pattern: 'todo',
      caseInsensitive: true,
      contextLines: 2
    });

    expect(client.grepObjects).toHaveBeenCalledWith({
      objects: [
        { name: 'ZCL_A', objectType: 'CLAS' },
        { name: 'ZPROG_A', objectType: 'PROG' }
      ],
      pattern: 'todo',
      caseInsensitive: true,
      contextLines: 2
    });
  });

  it('keeps objectTypes filter and explicit bounds in the normalized package input', async () => {
    const client = mockClient();
    const handlers = new SourceGrepHandlers(client);

    await handlers.handle('grepPackage', {
      packageName: 'ZPKG',
      pattern: 'x',
      objectTypes: ['prog', 'CLAS/OC'],
      maxResults: 500,
      contextLines: 5
    });

    expect(client.grepPackage).toHaveBeenCalledWith({
      packageName: 'ZPKG',
      pattern: 'x',
      objectTypes: ['PROG', 'CLAS/OC'],
      caseInsensitive: false,
      maxResults: 500,
      contextLines: 5
    });
  });
});

describe('SourceGrepHandlers validation', () => {
  it.each([
    ['missing packageName', { pattern: 'x' }],
    ['packageName with invalid characters', { packageName: 'Z-PKG', pattern: 'x' }],
    ['packageName over 40 characters', { packageName: 'Z'.repeat(41), pattern: 'x' }],
    ['missing pattern', { packageName: 'ZPKG' }],
    ['empty pattern', { packageName: 'ZPKG', pattern: '   ' }],
    ['pattern over 256 characters', { packageName: 'ZPKG', pattern: 'x'.repeat(257) }],
    ['syntactically invalid regex', { packageName: 'ZPKG', pattern: '[unclosed' }],
    ['maxResults below the lower bound', { packageName: 'ZPKG', pattern: 'x', maxResults: 0 }],
    ['maxResults above the upper bound', { packageName: 'ZPKG', pattern: 'x', maxResults: 501 }],
    ['non-integer maxResults', { packageName: 'ZPKG', pattern: 'x', maxResults: 1.5 }],
    ['contextLines above the bound', { packageName: 'ZPKG', pattern: 'x', contextLines: 6 }],
    ['non-boolean caseInsensitive', { packageName: 'ZPKG', pattern: 'x', caseInsensitive: 'yes' }],
    ['objectTypes not an array', { packageName: 'ZPKG', pattern: 'x', objectTypes: 'PROG' }],
    ['objectTypes entry with invalid characters', { packageName: 'ZPKG', pattern: 'x', objectTypes: ['PROG P'] }]
  ])('rejects invalid grepPackage input (%s) with InvalidParams', async (_label, args) => {
    const client = mockClient();
    const handlers = new SourceGrepHandlers(client);

    await expect(handlers.handle('grepPackage', args as Record<string, unknown>))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    // 校验失败必须发生在进入底层客户端之前
    expect(client.grepPackage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing objects', { pattern: 'x' }],
    ['objects not an array', { objects: 'ZPROG', pattern: 'x' }],
    ['empty objects array', { objects: [], pattern: 'x' }],
    ['more than 20 objects', { objects: Array.from({ length: 21 }, () => ({ name: 'ZA', objectType: 'PROG' })), pattern: 'x' }],
    ['object without name', { objects: [{ objectType: 'PROG' }], pattern: 'x' }],
    ['object with invalid name characters', { objects: [{ name: 'Z A', objectType: 'PROG' }], pattern: 'x' }],
    ['object with type outside the allowlist', { objects: [{ name: 'ZA', objectType: 'TABL' }], pattern: 'x' }],
    ['missing pattern', { objects: [{ name: 'ZA', objectType: 'PROG' }] }],
    ['invalid regex', { objects: [{ name: 'ZA', objectType: 'PROG' }], pattern: 'a**b' }]
  ])('rejects invalid grepObjects input (%s) with InvalidParams', async (_label, args) => {
    const client = mockClient();
    const handlers = new SourceGrepHandlers(client);

    await expect(handlers.handle('grepObjects', args as Record<string, unknown>))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(client.grepObjects).not.toHaveBeenCalled();
  });

  it('propagates request-level MCP errors unchanged', async () => {
    // 上游（客户端/低层）抛出的 MCP 语义错误必须原样透传，不得吞成 500
    const requestError = new McpError(ErrorCode.InvalidParams, 'query rejected');
    const client = mockClient();
    (client.grepPackage as jest.Mock).mockRejectedValue(requestError);

    await expect(new SourceGrepHandlers(client).handle('grepPackage', { packageName: 'ZPKG', pattern: 'x' }))
      .rejects.toBe(requestError);
  });

  it('sanitizes unexpected upstream failures without leaking remote details', async () => {
    const client = mockClient();
    (client.grepObjects as jest.Mock).mockRejectedValue(new Error('SECRET_REMOTE_BODY'));

    await expect(
      new SourceGrepHandlers(client).handle('grepObjects', {
        objects: [{ name: 'ZA', objectType: 'PROG' }],
        pattern: 'x'
      })
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.not.stringContaining('SECRET_REMOTE_BODY')
    });
  });

  it('rejects unknown tool names with MethodNotFound', async () => {
    const handlers = new SourceGrepHandlers(mockClient());
    await expect(handlers.handle('grepPackages', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
