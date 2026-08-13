# SM21 系统日志读取与分析实施计划

> 依据已批准设计：`docs/superpowers/specs/2026-08-13-sm21-runtime-log-analysis-design.md`。本计划原先的 RFC 客户端步骤已被 2026-08-13 批准的 ADT HTTP SICF 方案替代；不创建 Git 提交，不覆盖现有未提交修改。

## 1. 目标与范围

交付两部分同版本工件：

1. 直接使用标准 SM21 类的 `ZCL_MCP_SM21_ADT_HTTP` SICF Handler 源码与部署说明。
2. MCP 内 `sm21Read`、`analyzeRuntimeErrors` 工具与受控 ADT HTTP 客户端。

保持 ST22 的现有 `dumps` 能力、中央执行门控、响应字节限制和 safe/legacy-full 分层；新工具仅在 `legacy-full` 可见，不增加任何 SAP 写操作。

## 2. 任务一：ABAP HTTP 服务部署工件

新增 `sap/adt-http/ZCL_MCP_SM21_ADT_HTTP.abap` SICF Handler 与部署说明。代码包含 `S_ADMI_FCD=SM21` 检查、24 小时窗口、1—500 页大小、输入过滤、标准类 `CL_SYSLOG_FILTER`/`CL_SYSLOG` 调用、统一 JSON 输出和异常映射。

因 `CL_SYSLOG` 的返回对象在 Basis 版本间可能不同，部署工件必须将版本相关解析标注为唯一适配点，并提供 SE24/SE37 语法调整清单；不得假装可在仓库端编译 ABAP。

## 3. 任务二：复用会话的 ADT HTTP 适配层

通过公开的 `ADTClient.httpClient.request()` 调用固定路径 `/sap/bc/z-mcp/sm21`，重用 Cookie、CSRF、认证和超时，不引入 `node-rfc`、SAP NW RFC SDK、JCo、NCo、RFC destination 或额外凭据。自定义服务不放在 `/sap/bc/adt` 下，避免被 ADT 框架资源路由拒绝。返回值映射为窄的 SM21 DTO；权限、参数、网络和远端异常映射为安全 MCP 错误。

## 4. 任务三：参数边界和 SM21 Handler

新增纯函数解析 ISO 时间、限制 24 小时窗口、校验页大小、限制每类过滤数量和验证 offset。新增 handler：`sm21Read` 接受筛选参数，通过 ADT HTTP 适配层返回分页结果；只在 `legacy-full` 注册；不使用 `any`，不以 `runQuery` 读取任何 SM21 底层表。

## 5. 任务四：ST22 关联分析

新增纯函数将 `dumps` 摘要与 SM21 行做保守关联：窗口重叠与至少一个强字段（用户、程序、事务码、实例或消息 ID）才形成关联；仅时间邻近返回“候选”且低证据等级。分析结果明确 `partial`、截断与未关联事件。

`analyzeRuntimeErrors` 先读取 ADT HTTP SM21，再读取 ST22 摘要；两者都通过现有 SAP 执行门控，且不重试。

## 6. 任务五：服务器、配置和文档

扩展运行配置、工具目录与分发，同时保持 `safe` 的四工具清单。更新 `.env.example`、双语 README、使用指南和 changelog：明确需要先部署/授权 SICF HTTP 服务，但无 MCP 主机新增依赖。

## 7. 任务六：测试和验证

先为纯参数校验、ADT HTTP 映射、日志关联、工具注册和 handler 写 Jest 测试；模拟 HTTP 客户端和 ADT dump 调用。执行定向 Jest、全量 Jest、TypeScript 构建和 `git diff --check`。

真实 SAP DEV 验证留给部署后：SE37 激活与授权、与 SM21 同筛选窗口抽样比对、无权限拒绝、边界值/游标、MCP 读和 ST22 关联。最终必须把本地验证和 SAP 环境验证分开汇报。
