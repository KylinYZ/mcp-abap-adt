# 项目协作规则

## 项目定位

本项目是带内置 ADT 客户端的 SAP ABAP MCP 服务。生产运行不依赖外部
`abap-adt-api` 包；上游来源和许可证见 `third-party/abap-adt-api/`。
默认 `focused` profile（别名 `developer`）面向开发人员，提供开发工作台能力；`business` 与 `operations` 分别是业务顾问和运维只读入口；`expert` 保留 DEV 专家兼容面。`safe`、`development` 等旧 profile 继续兼容。
新用户入口与能力分层见 `docs/产品定位.md`；不要把兼容 profile 名称重新写成产品入口。
## 当前发布与事实基线

- 当前版本：`0.6.0`；npm 包：`@kylinyz/mcp-abap-abap-adt-api@0.6.0`。
- 远程仓库：`KylinYZ/mcp-abap-adt`；上游：`mario-andreschak/mcp-abap-abap-adt-api`。
- profile 目录：`safe=7`、`development=124`、`diagnostic-readonly=99`、`legacy-full=161`、`development-workbench=90`、`business-readonly=18`、`operations-readonly=41`。
- 仓库对象创建目录固定 31 类：`REAL_DEV_VERIFIED=28`、`CONTROLLED_IMPLEMENTED=1`、`AUTOMATION_VERIFIED=2`；成熟度以 `docs/evidence/repository-creation-maturity-evidence.json` 为准。
- 自动化基线：109 个 Jest suites、793 个 tests（2026-09-04）。

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
- `docs/使用指南.md`：中文安装、接入、工具和运维权威指南。
- `docs/evidence/`：真实 DEV 证据、成熟度 manifest 和当前创建矩阵。
- `PROGRESS.md`、`BLOCKED.md`：精简状态与阻塞索引；历史细节留在证据/CHANGELOG。
- `.env.example`：配置字段示例；不得提交真实 `.env` 或凭据。

## 安全边界

- 先用 CodeGraph 定位，再用 `rg` 做完整性确认。
- 真实 SAP 调用保持串行，默认 `SAP_MCP_MAX_CONCURRENT_TOOLS=1`。
- QAS、PRD、缺失或未知系统角色只允许本地/只读工具；隐藏和 dispatch 拒绝必须同时保留。
- 所有受控写入必须经过 server 生成的 preview plan、一次原生确认和 apply；不得接受调用方确认布尔值、任意 URL、XML、JSON、媒体类型或 lock handle。
- `REAL_DEV_VERIFIED` 只能由完整 create/readback/transport/cleanup/absence 证据启用；未知结果不得重放或自动删除。
- 不连接生产，不创建或释放传输，不修改 E071/E071K，不执行数据库写操作。
- 报告时明确区分自动化、真实 SAP 已验证、部署状态和仍待环境确认的内容。

## 证据与历史

当前创建状态以 `docs/evidence/repository-validation-campaign-matrix.md` 为准；交接入口为 `docs/evidence/repository-creation-productionization-handoff.md`。`PROGRESS.md` 与 `BLOCKED.md` 只保留当前结论和历史 issue 索引，不再复制逐次会话流水账。
