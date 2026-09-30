# 项目协作规则

## 项目定位

本项目是带内置 ADT 客户端的 SAP ABAP MCP 服务。生产运行不依赖外部
`abap-adt-api` 包；上游来源和许可证见 `third-party/abap-adt-api/`。
默认 `focused` profile（别名 `developer`）面向开发人员，提供开发工作台能力；`business` 与 `operations` 分别是业务顾问和运维只读入口；`expert` 保留 DEV 专家兼容面。`safe`、`development` 等旧 profile 继续兼容。
新用户入口与能力分层见 `docs/产品定位.md`；不要把兼容 profile 名称重新写成产品入口。
## 当前发布与事实基线

- 当前版本：`0.9.0`（MCP v2 双栈：原生 2026-07-28 + 2025 兼容，证据见 docs/evidence/mcp-v2-dual-era-verified.md）；npm 包：`abap-ai-workbench-mcp@0.9.0`。
- 远程仓库：`KylinYZ/mcp-abap-adt`；上游：`mario-andreschak/mcp-abap-abap-adt-api`。
- 当前源码 profile 目录：`safe=7`、`development=195`、`diagnostic-readonly=146`、`legacy-full=209`、`development-workbench=162`、`business-readonly=18`、`operations-readonly=49`。
- 仓库对象创建目录固定 31 类：`REAL_DEV_VERIFIED=28`、`CONTROLLED_IMPLEMENTED=1`、`AUTOMATION_VERIFIED=2`；成熟度以 `docs/evidence/repository-creation-maturity-evidence.json` 为准。
- 自动化基线：179 个 Jest suites、1926 个 tests（2026-09-30）。VSP 能力对齐：54/71（MCP_SUPERSET=13）；analysis.history 的 loads、transport-crossref 结构边、where_used_config、usage_examples 与 knowledge-queries 的 fm_test_data 目录层均已真机验证；离线三工具已由组合链真机验证覆盖核心路径。当前进度见 `docs/evidence/transport-crossref-real-dev-verified.md`、`docs/evidence/where-used-config-real-dev-verified.md`、`docs/evidence/usage-examples-real-dev-verified.md` 与 `docs/evidence/fm-test-data-real-dev-verified.md`。
- 真实 SAP smoke 默认使用 `sap-demo.env`（所有者 2026-09-22 指示；sap-dev 上 S4HK900009 已不可用）。
- 运行时要求：Node.js >=22.14.0（`.nvmrc` 为 22；Node 18/20 已 EOL，自 0.7.0 起不再支持——为 RFC 基座 open-rfc 的支持合同对齐）。

## 开发与验证

```powershell
npm install
npm test -- --runInBand
npm run build
npm run check:repository-creation-coverage
git diff --check
```

真实 SAP smoke 仅在明确授权且使用专用 DEV 配置时运行：

```powershell
npm run test:repository-productionization-runtime -- "C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env"
npm run test:repository-verified-domain-preview -- "C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env" ZVPV001
```

修改源码、`.env` 或 `dist` 后必须硬重启 MCP 客户端，并确认新 healthcheck session 与旧 plan `PLAN_NOT_FOUND`。

## 目录约定

- `src/adt/`：内置 ADT 客户端；`src/adt/index.ts` 是稳定内部入口。
- `src/safe/`：安全策略、计划、确认、成熟度证据和受控工作流。
- `src/config/`、`src/lib/`：配置、profile、执行门控、限流、缓存和日志。
- `src/handlers/`：MCP 工具处理器；低层写入不得绕过 profile 边界。
- `docs/使用指南.md`：中文安装、接入、工具和运维权威指南；`docs/agent-setup-prompt.md` 是发给 agent 的自动安装配置提示词。
- `docs/evidence/`：真实 DEV 证据、成熟度 manifest 和当前创建矩阵。
- `PROGRESS.md`、`BLOCKED.md`：精简状态与阻塞索引；历史细节留在证据/CHANGELOG。
- `.env.example`：配置字段示例；不得提交真实 `.env` 或凭据。

## 安全边界

- 先用 CodeGraph 定位，再用 `rg` 做完整性确认。
- 真实 SAP 调用走分级执行门（2026-09-30 起）：写入/锁链/受控 apply 走写槽串行（`SAP_MCP_MAX_CONCURRENT_TOOLS=1`）；read-only 工具走读槽并发（`SAP_MCP_MAX_READ_CONCURRENT_TOOLS=2`）并绑定读域 stateless 会话（`SAP_MCP_STATELESS_READS=true`，读槽安全性的前提）；受控链只读 preview 挂写槽（绑定写域 stateful 主会话，保证 stateful 永无并发）。
- QAS、PRD、缺失或未知系统角色只允许本地/只读工具；隐藏和 dispatch 拒绝必须同时保留。
- 所有受控写入必须经过 server 生成的 preview plan、一次原生确认和 apply；不得接受调用方确认布尔值、任意 URL、XML、JSON、媒体类型或 lock handle。唯一例外：`SAP_MCP_CONFIRMATION_MODE=auto`（默认 native）时部署者显式授权跳过人工确认，apply 一次调用直接执行；该模式仅 DEV 角色可配置（非 DEV 启动即报错），仅由部署环境变量控制、调用方无任何参数可触发，审计如实记 `confirmationMode=auto-config`，plan 状态机与漂移校验保持不变。
- `REAL_DEV_VERIFIED` 只能由完整 create/readback/transport/cleanup/absence 证据启用；未知结果不得重放或自动删除。
- 传输请求：**仅创建**与**仅删空请求**两个动作对 AI 放开——创建走受控创建链（`previewTransportCreation` → 原生确认 → `applyTransportCreation`，创建后必须读回验证）；删除走受控清理链（`previewTransportCleanup` → 原生确认 → `applyTransportCleanup`），preview 强制核验三条红线：未释放（状态 D）+ 零对象 + 本人属主，任一不满足即拒。两链均仅 DEV + development/development-workbench。释放、改属主、加用户、删非空/他人请求与直改 E071/E071K 一律禁止；sap-demo 真机已验证（创建 SMOKE OK、4 个残留空请求受控删除+缺席复核，证据见 `docs/evidence/transport-creation-real-dev-verified.md`）。不连接生产，不执行数据库写操作。
- 报告时明确区分自动化、真实 SAP 已验证、部署状态和仍待环境确认的内容。

## 证据与历史

当前创建状态以 `docs/evidence/repository-validation-campaign-matrix.md` 为准；交接入口为 `docs/evidence/repository-creation-productionization-handoff.md`。`PROGRESS.md` 与 `BLOCKED.md` 只保留当前结论和历史 issue 索引，不再复制逐次会话流水账。
