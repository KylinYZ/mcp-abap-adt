# MCP v2 双栈迁移 API 定型实测（步骤 0 证据）

- 日期：2026-09-29
- 环境：Windows / Node 22.22.2；沙盒独立目录安装 `@modelcontextprotocol/server@2.2.0`、`@modelcontextprotocol/client@2.2.0`、`@modelcontextprotocol/sdk@1.29.0`（v1 对照）
- 目的：在改造仓库前，把 0.9.0 迁移（v1 SDK → v2 双栈）的每个 API 假设变成实测结论
- 方法：低层 `Server` + `serveStdio`（默认 `legacy:'serve'`）组成双栈试验服务器，注册 `tools/list`/`tools/call` 方法字符串 handler（含 ctx 探针、错误探针、elicitInput 探针、MRTR 两轮探针），分别用三种客户端打：v1 SDK client（=现有 43 个冒烟脚本形态）、v2 client 默认（legacy era）、v2 client `versionNegotiation: { mode: 'auto' }` + `supportedProtocolVersions` 含 `2026-07-28`（modern era）

## 实测结论（9 项）

| # | 实测项 | 结论 |
|---|---|---|
| 1 | `serveStdio` factory 与低层 `Server` | 官方类型 `McpServerFactory = (ctx: McpRequestContext) => McpServer \| Server \| Promise<...>` 明确接受低层 Server；实测 legacy/modern 两个 era 均正常服务。`McpRequestContext.era: 'legacy'\|'modern'` 可在工厂内感知 |
| 2 | handler ctx 形态 | `ctx.mcpReq` 含 `id/method/_meta/envelope/inputResponses/droppedInputResponseKeys/requestState()/signal/send/notify`，ServerContext 另有 `log`（deprecated）、`elicitInput`、`requestSampling`（后两者 modern era throw）。`server.getClientCapabilities()` 存在且返回客户端能力（form elicitation port 数据来源） |
| 3 | 错误透传（shim 定型依据） | handler 抛普通 `Error` 且带数字 `code`（如 429）→ **code 原样透传 JSON-RPC wire**（v1/v2 客户端均按 429 收到）；`SdkError`（字符串 code）→ wire `-32603`。结论：McpErrorCompat 与 v1 McpError 完全同构（Error 子类 + 数字 code），业务码 429/413 语义不变 |
| 4 | era encode seam | modern era 下 handler 返回裸结果（无 resultType）→ SDK 自动补 `_meta`（serverInfo envelope）、`ttlMs`、`cacheScope`、`resultType`；legacy era 字节等价 2025 行为 |
| 5 | `elicitInput`（legacy 路径） | legacy 连接（v1 与 v2 客户端）上 `ctx.mcpReq.elicitInput` 正常工作，行为同 v1 `server.elicitInput`；modern 连接上 throw 明确错误（指路 `inputRequired`） |
| 6 | MRTR modern era | `inputRequired({ inputRequests: { key: inputRequired.elicit(params) }, requestState })` + 重入时 `acceptedContent(ctx.mcpReq.inputResponses, key)` + `ctx.mcpReq.requestState()` 回显完整工作；**v2 modern client 内置自动驱动**：一次 `callTool` 内透明完成确认+重试 |
| 7 | MRTR legacy era（shim） | 同一 MRTR 代码路径在 legacy 连接上被 `legacyInputRequiredShim`（默认开启）自动转为 `elicitation/create` 服务器→客户端请求并重入 handler；**v1 SDK client 的 `ElicitRequestSchema` handler 能直接接住 shim 帧**（实测收到 2 帧并 accept）→ 现有 43 个 v1 冒烟脚本确认链零改兼容 |
| 8 | v2 client era 控制 | v2 client 默认 `versionNegotiation: 'legacy'`（保守默认）；`{ mode: 'auto' }` + `supportedProtocolVersions` 含 2026 条目才走 `server/discover` 探测进 modern。stdio 上 auto 探测会另起短命兄弟进程 |
| 9 | CJS require | `require('@modelcontextprotocol/server')` 与 `require('@modelcontextprotocol/server/stdio')`（以及 client 对应路径）CJS 构建全部可用，本项目 tsc commonjs 输出兼容 |

## 对迁移方案的定型修订

1. 外壳：`main()` → `serveStdio(() => new AbapAdtServer(password))`，`AbapAdtServer extends` v2 低层 `Server`，`setRequestHandler('tools/list'/'tools/call', ...)` 方法字符串形式——零注册层重写。
2. 错误面：`src/lib/McpErrorCompat.ts` 导出 v1 同构 `McpError`（Error 子类、数字 code 透传）与 `ErrorCode` 常量、re-export `ElicitResult`/`ElicitRequestFormParams`（v2 类型）；~85 文件 import 批量替换。生产依赖不再含 v1 SDK（scripts 冒烟用的 v1 client 移 devDependencies，互操作已实测）。
3. 确认流：**MRTR 单一代码路径**（modern 原生 + legacy 经 shim），两端透明验证通过；`elicitInput` 仅作为 legacy 显式路径保留于 MRTR 之外的可选兜底不再依赖。
4. `requestState` 必须完整性保护（SDK 不做）：按 spec 用 HMAC（`createRequestStateCodec`）或沿用项目 PlanStore 指纹校验，实施时二选一并记录。

## 关键试验脚本形态（复现用）

试验服务器（完整版见本文件 git 历史/沙盒，核心结构）：

```js
import { Server, inputRequired, acceptedContent } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
serveStdio((fctx) => {                       // fctx.era = 'legacy' | 'modern'
  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const got = acceptedContent(ctx.mcpReq.inputResponses, 'confirm');
    if (!got) return inputRequired({
      inputRequests: { confirm: inputRequired.elicit({ mode: 'form', message, requestedSchema }) },
      requestState: JSON.stringify({ planId }),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ accepted: got }) }] };
  });
  return server;
});
```

- v1 客户端：`Client` + `StdioClientTransport`（@modelcontextprotocol/sdk/client/*）+ `setRequestHandler(ElicitRequestSchema, ...)` → MRTR 经 shim 自动完成。
- v2 modern 客户端：`new Client(info, { capabilities, supportedProtocolVersions: ['2026-07-28', ...], versionNegotiation: { mode: 'auto' } })` → MRTR 经自动驱动透明完成。
