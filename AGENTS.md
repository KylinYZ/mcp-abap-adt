# 项目协作规则

## 项目定位

本项目内置完整 ADT 客户端，生产运行不依赖外部 `abap-adt-api` 包；上游来源和许可证记录在 `third-party/abap-adt-api/`。默认 `safe` 模式只开放七个受控 ABAP 源码变更与对象创建工具，`development` 增加安全调试、只读诊断和三组受控高级操作，`legacy-full` 在 DEV 上开放原始低层 ADT 能力和可选 SM21/ST22 运行日志分析。

## 当前分发状态

- `0.5.0` 已于 2026-08-18 以 `@kylinyz/mcp-abap-abap-adt-api` 发布到 npm；远程仓库为 `KylinYZ/mcp-abap-adt`，上游为 `mario-andreschak/mcp-abap-abap-adt-api`。
- 常规安装使用 `npx -y @kylinyz/mcp-abap-abap-adt-api@0.5.0`；本地开发、契约验证或未发布修改仍使用 `node` 启动当前源码构建的 `dist/index.js`。
- 不要给出不带作用域的 `npx mcp-abap-abap-adt-api`，那会解析到原作者的独立旧包；Marketplace/MCP Registry 状态仍需单独核验。

## 开发与验证

```powershell
npm install
npm test -- --runInBand
npm run build
git diff --check
```

当前 runtime catalog 基线为 `safe=7`、`development=124`、`diagnostic-readonly=99`、`legacy-full=161`、`development-workbench=87`、`business-readonly=17`、`operations-readonly=40`；仓库对象创建目录注册 31 类对象；自动化基线为 106 个测试套件、719 项测试。修改源码、`.env` 或构建输出后，必须硬重启 MCP 客户端，并用 healthcheck session 重置与旧 plan `PLAN_NOT_FOUND` 验收。

## 目录与约定

- `src/safe/`：安全策略、计划、确认、审计与变更工作流。
- `src/adt/`：内置 ADT 客户端；`src/adt/index.ts` 是 MCP 内部唯一稳定导入入口。
- `src/config/`、`src/lib/`：运行时配置、执行门控、限流、缓存和日志。
- `src/handlers/`：MCP 工具处理器；不要让低层写入绕过 profile 边界。
- `README.md`、`README.zh-CN.md`：项目概览和现役状态。
- `docs/使用指南.md`：中文安装、接入与操作权威指南。
- `.env.example`：配置字段和推荐默认值；不得提交真实 `.env` 或凭据。

## 安全边界

- 优先 CodeGraph 定位，再用 `rg` 做完整性确认。
- 对真实 SAP 调用保持串行；默认 `SAP_MCP_MAX_CONCURRENT_TOOLS=1`。
- QAS、PRD、缺失或非法系统角色对所有 Profile 都只能执行本地/只读工具；目录隐藏和 dispatch 拒绝必须同时保留。
- 源码变更/创建按既有确认策略执行。仓库对象创建只允许 Server 固定的可信 provider：Windows 默认使用 Explorer broker、中文原生窗口和一次性 named pipe，其他平台使用 MCP form；DDIC 属性、包迁移和 RAP apply 仍只允许 MCP form。上述高风险路径均不接受文字或调用方布尔降级。
- `DDIC_DOMAIN` 已留下 `ZZMCP_VT_DOM` 的真实 DEV 创建与 active 属性复读证据，但尚未完成独立清理，历史计划因已修复的空默认值比较问题保留 `OUTCOME_UNKNOWN`；因此成熟度仍为 `CONTROLLED_IMPLEMENTED`、目录仍为 `writable=false`，不得据此重放或扩大验证范围。
- 31 类创建侧活动已结束且每类都有明确结果，但 `REAL_DEV_VERIFIED` 仍为 0。后续目标是逐类产品化并在关闭验证开关后正式可写；接手入口为 `docs/evidence/repository-creation-productionization-handoff.md`，实施依据为 `docs/superpowers/plans/2026-08-25-repository-creation-productionization-plan.md`。当前验证开关仍为 true；每次真实操作仍独立确认，任一未知结果不得重放。
- 原始 `legacy-full` 写工具绕过受控 workflow，只用于明确的专家兼容场景；启用工具不等于获得真实写入授权。
- 远端写入、迁移、生成或发布结果未知时先只读核验，禁止盲目重试。
- 不创建或释放传输，不连接生产系统，不在未确认时执行真实写入。
- 汇报时区分自动化、真实 SAP 已验证和仍待运行环境确认的内容。
