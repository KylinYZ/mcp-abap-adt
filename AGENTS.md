# 项目协作规则

## 项目定位

本项目内置完整 ADT 客户端，生产运行不依赖外部 `abap-adt-api` 包；上游来源和许可证记录在 `third-party/abap-adt-api/`。默认 `safe` 模式只开放七个受控 ABAP 源码变更与对象创建工具，`development` 增加安全调试、只读诊断和三组受控高级操作，`legacy-full` 在 DEV 上开放原始低层 ADT 能力和可选 SM21/ST22 运行日志分析。

## 当前分发状态

- `0.4.0` 已于 2026-08-18 以 `@kylinyz/mcp-abap-abap-adt-api` 发布到 npm；远程仓库为 `KylinYZ/mcp-abap-adt`，上游为 `mario-andreschak/mcp-abap-abap-adt-api`。
- 常规安装使用 `npx -y @kylinyz/mcp-abap-abap-adt-api@0.4.0`；本地开发、契约验证或未发布修改仍使用 `node` 启动当前源码构建的 `dist/index.js`。
- 不要给出不带作用域的 `npx mcp-abap-abap-adt-api`，那会解析到原作者的独立旧包；Marketplace/MCP Registry 状态仍需单独核验。

## 开发与验证

```powershell
npm install
npm test -- --runInBand
npm run build
git diff --check
```

当前 runtime catalog 基线为 `safe=7`、`development=118`、`diagnostic-readonly=98`、`legacy-full=161`、`development-workbench=81`、`business-readonly=17`、`operations-readonly=40`；自动化基线为 61 个测试套件、430 项测试。修改源码、`.env` 或构建输出后，必须重启 MCP 客户端。

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
- 源码变更/创建按既有确认策略执行；新增 DDIC、包迁移和 RAP apply 只允许 MCP 原生 form 确认，不提供文字降级。
- 原始 `legacy-full` 写工具绕过受控 workflow，只用于明确的专家兼容场景；启用工具不等于获得真实写入授权。
- 远端写入、迁移、生成或发布结果未知时先只读核验，禁止盲目重试。
- 不创建或释放传输，不连接生产系统，不在未确认时执行真实写入。
- 汇报时区分自动化、真实 SAP 已验证和仍待运行环境确认的内容。
