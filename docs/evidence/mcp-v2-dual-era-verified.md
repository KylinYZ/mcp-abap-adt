# MCP v2 双栈迁移实证（0.9.0）

- 日期：2026-09-29
- 分支：`feat/mcp-v2-dual-era`
- 前置证据：`docs/evidence/mcp-v2-migration-api-probe.md`（步骤 0 沙盒定型）
- 背景问题：ZCode 0.16.9 对 MCP 服务器默认 auto 协商用 `server/discover` 探测 2026-07-28 era；v1 SDK 服务器不识别该 method（回 `-32601`），客户端按探测计划多轮等待（实测累计 15.5~19.5 秒），挤爆会话启动约 15 秒的工具注册窗口（611 工具缩水到 11 个且不补注册）。

## 迁移内容（0.8.4 → 0.9.0）

| 层 | 变更 |
|---|---|
| 依赖 | 生产 `@modelcontextprotocol/sdk@^1.4.1` → `@modelcontextprotocol/server@2.2.0`（精确锁定）；v1 SDK 移 devDependencies（43 个冒烟脚本的 2025 生态回归资产）+ `@modelcontextprotocol/client@2.2.0`（modern 测试/冒烟） |
| 外壳 | `main()` → `serveStdio(factory, { legacy: 'serve' })`：同一工厂双 era——modern（2026-07-28）客户端经 `server/discover` 探测进新协议；legacy（2025）客户端走 initialize 握手，行为与 0.8.x 一致 |
| 服务器 | `AbapAdtServer extends` v2 低层 `Server`；`setRequestHandler('tools/list'/'tools/call')` 方法字符串注册，自管工具目录零重写 |
| 错误面 | `src/lib/McpErrorCompat.ts`：与 v1 完全同构的 `McpError`（Error 子类 + 数字 code 透传 wire，含 429/413 业务码与 -32001 保留段）+ `ErrorCode` 常量 + elicitation 类型 re-export；全仓 108 文件 import 批量替换（83 单引号 + 25 双引号） |
| 确认流 | `src/lib/MrtrElicitation.ts`：MRTR 引擎——确认类 elicitInput port 语义不变；无响应轮抛 `ConfirmationRequiredError` → handler 转 `inputRequired` 结果；重试轮从 `inputResponses` 恢复。legacy 连接经 v2 官方 `legacyInputRequiredShim` 自动转 `elicitation/create`（v1 宿主零感知）；`requestState` HMAC 完整性保护（绑定 toolName+参数摘要+轮次，防跨工具/跨参数重放）。12 个确认注入点 + 6 确认类 + Provider + 4 直调 handler catch 面穿透改造（challenge 作废先于穿透放行） |
| 能力感知 | modern era 客户端能力在每请求 envelope：`currentClientCapabilities()` 合并读取（envelope 优先，回落 initialize 填充的实例能力） |

## 实证结果（本机，Node 22.22.2）

### 自动化
- `npm run build`：0 错误（CJS 输出，v2 双构建 require 路径验证）
- `npx jest --runInBand`：**174 suites / 1860 tests 全绿**（基线 172/1827；新增 `ModernProtocol.test.ts` 3 用例 + `ElicitationRouting.test.ts` 重写为双 era 4 用例 + 上会话 where-used-config 套件）
- `git diff --check`：通过
- `npm run check:repository-creation-coverage`：28 REAL_DEV_VERIFIED / 2 AUTOMATION / 1 CONTROLLED，缺证据 0

### 双 era 冒烟（`npm run test:mcp-dual-era`，可复跑）
```
PASS dual-era smoke: discover=510ms, modern(tools=158, wire2026=true, health=true), legacy(tools=158, health=true)
```
- 探针 1（裸 `server/discover` + 2026 envelope = ZCode auto 协商帧形态）：**510ms 明确应答** `supportedVersions:["2026-07-28"]` + serverInfo envelope——不再依赖超时回落，ZCode 0.16.9 auto 直连的根因消除
- 探针 2（v2 client modern 会话）：discover 协商进 modern era，tools/list 158 工具且 wire 带 `ttlMs`/`cacheScope`（era 编码层自动补齐），healthcheck 正常
- 探针 3（v1 SDK client legacy 会话，2025 宿主代表）：initialize 握手正常，158 工具，healthcheck 正常——向后兼容面锁定

### 确认流 MRTR 双 era（jest 内 `serveStdio` + InMemoryTransport 真实 era 路径）
- legacy era：preview → apply 触发 form 确认 → shim 转 `elicitation/create` 帧（wire 窃听断言）→ 客户端 accept → shim 驱动重入 → 单次 apply 完成；cancel / 畸形响应均不执行写入
- modern era：apply 返回 `input_required` → v2 client 自动驱动（确认→重试）→ 单次 callTool 完成
- 两个 era 走同一条确认类代码路径（MRTR 引擎），行为差异全部由 v2 SDK era 层吸收

## 客户端兼容矩阵（面向用户）

| 客户端 | 连接方式 | 结果 |
|---|---|---|
| ZCode 0.16.9（auto 默认） | `server/discover` 探测 | 秒级进 modern era，无需任何配置（可移除 `protocolVersion:"legacy"` 规避配置） |
| ZCode（legacy 显式配置） | initialize | 照常服务 |
| v1 SDK 宿主（Claude Desktop / Cursor 等未跟进 2026 的） | initialize | 照常服务（v1 client 冒烟锁定） |
| v2 SDK 宿主（modern 协商） | discover + envelope | 原生 2026-07-28 |

## 遗留与后续

- ZCode 0.16.9 真机端到端验收：需在装有 0.16.9 agent 的机子上以 auto 模式连接确认（本机 agent 0.13.3 无法复现其探测策略；协议面已由裸探测帧 + v2 client modern 会话双覆盖）
- 真实 DEV 确认链 smoke（message-text 等 11 个 `test:*-real-dev`）：待按惯例授权后用 `sap-demo.env` 复跑
- HTTP/Streamable 传输、tasks 官方扩展、subscriptions/listen：明确出界，未纳入
