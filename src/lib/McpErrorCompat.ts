/**
 * MCP v1 → v2 迁移的错误兼容层（0.9.0）。
 *
 * 背景：生产依赖已从 @modelcontextprotocol/sdk（v1）切换到
 * @modelcontextprotocol/server（v2，双栈 2026-07-28 + 2025 era）。
 * v1 的 McpError/ErrorCode 被全仓约 85 个文件引用；v2 的错误模型改为
 * SdkError（字符串 code），与现有代码和既有 wire 语义不兼容。
 *
 * 实测定型（docs/evidence/mcp-v2-migration-api-probe.md 第 3 条）：
 * v2 低层 Server 的 handler 抛出"带数字 code 的普通 Error"时，
 * code / message / data 会原样透传到 JSON-RPC wire——包括业务码
 * （429 队列满、413 参数超限）与 v1 保留段（-32001 RequestTimeout）。
 * 因此本兼容层用与 v1 完全同构的 Error 子类承载，不引入 SdkError，
 * 保证存量断言（约 300 处 ErrorCode.* / McpError 构造）行为不变。
 */
export class McpError extends Error {
  /** JSON-RPC 错误码；业务码（429/413 等）与标准码均直接透传 wire */
  readonly code: number;
  /** 可选结构化错误数据，透传到 JSON-RPC error.data */
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    // 与 v1 McpError 完全同构：message 属性带 "MCP error <code>: " 前缀
    // （存量序列化与测试断言依赖该格式）
    super(`MCP error ${code}: ${message}`);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/**
 * 与 v1 @modelcontextprotocol/sdk 的 ErrorCode 枚举值完全对齐。
 * 项目实际使用成员：InternalError / InvalidParams / MethodNotFound /
 * RequestTimeout（后者仅存在于旧 elicitInput 超时语义，MRTR 化后逐步退场）。
 */
export const ErrorCode = {
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  UrlElicitationRequired: -32042,
} as const;

/**
 * elicitation 相关类型从 v2 server 包重新导出：
 * safe/ 确认类与 handler 的 port 接口（确认请求参数、确认结果）
 * 继续使用与 v1 同名同构的类型，import 来源统一指向本兼容层。
 */
export type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/server';
