# 项目协作规则

## 项目定位

本项目基于 `abap-adt-api` 提供 MCP 服务；默认 `safe` 模式只开放七个受控 ABAP 源码变更与对象创建工具，`legacy-full` 在此基础上开放原始低层 ADT 能力和可选 SM21/ST22 运行日志分析。

## 当前分发状态

- 当前修改版尚未发布到 npm 或 MCP Registry，只支持源码安装。
- 使用本地 `node` 启动 `dist/index.js`；不要给出 `npx mcp-abap-abap-adt-api` 或 Marketplace 安装指引。
- `package.json` 与 `server.json` 中的 npm/Registry 字段是未来发布元数据，不代表已发布。

## 开发与验证

```powershell
npm install
npm test -- --runInBand
npm run build
git diff --check
```

当前自动化基线为 26 个测试套件、193 项测试。修改源码、`.env` 或构建输出后，必须重启 MCP 客户端。

## 目录与约定

- `src/safe/`：安全策略、计划、确认、审计与变更工作流。
- `src/config/`、`src/lib/`：运行时配置、执行门控、限流、缓存和日志。
- `src/handlers/`：MCP 工具处理器；不要让低层写入绕过 profile 边界。
- `README.md`、`README.zh-CN.md`：项目概览和现役状态。
- `docs/使用指南.md`：中文安装、接入与操作权威指南。
- `.env.example`：配置字段和推荐默认值；不得提交真实 `.env` 或凭据。

## 安全边界

- 优先 CodeGraph 定位，再用 `rg` 做完整性确认。
- 对真实 SAP 调用保持串行；默认 `SAP_MCP_MAX_CONCURRENT_TOOLS=1`。
- 修改 SAP 前必须预览完整 diff，并由 MCP 原生弹框或显式启用的文字降级确认。
- 不创建或释放传输，不连接生产系统，不在未确认时执行真实写入。
- 汇报时区分自动化、真实 SAP 已验证和仍待运行环境确认的内容。
