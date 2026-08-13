# SM21 系统日志读取与分析设计

> 状态：ADT HTTP 实现已完成本地验证；本文档不代表 SAP 端 SICF 服务已创建、已激活或已授予 SM21 权限。

## 1. 目标

在现有 MCP 服务中增加第二阶段的只读运行故障观测能力：

- 保留已有 `dumps` ADT 工具读取 ST22 ABAP 短转储摘要的能力。
- 通过自定义 ADT HTTP SICF 服务读取 SM21 系统日志。
- 为 SM21 返回稳定、机器可读、分页且受限的结构化记录；MCP 可按时间、实例、用户、程序和事务码与 ST22 摘要关联。
- 将 SAP HTTP Handler 源码、部署步骤、权限要求和 MCP 配置随仓库交付，避免把 SAP GUI 显示程序当成远程接口。

## 2. 已核验事实

在目标 SAP 系统中通过只读 ADT 查到标准程序 `RSYSLOG`：

- 该程序属于系统包 `SYSLOG`，描述为“显示系统日志”。
- 它先检查授权对象 `S_ADMI_FCD`，字段值为 `SM21`。
- 它使用 `CL_SYSLOG_FILTER` 接收时间、实例、客户端、用户、事务码、工作进程、程序、包、消息号、事务 ID、上下文和连接过滤条件。
- 它调用 `CL_SYSLOG=>GET_INSTANCE_BY_FILTER( )` 读取日志，并把结果交给 `RSLG_DISPLAY` 做 SAP GUI 显示。

`RSLG_DISPLAY` 不是稳定的远程机器读取契约，因此不在 MCP 中直接调用。当前 `abap-adt-api` 依赖提供 `/sap/bc/adt/runtime/dumps`（ST22 类摘要），但未提供 SM21 的 ADT API 或 RFC 封装。

## 3. 方案选择

采用自定义、只读 SICF 服务 `/sap/bc/z-mcp/sm21`；它在 SAP 内部直接调用标准 `CL_SYSLOG_FILTER` / `CL_SYSLOG`，不依赖自定义函数模块。服务不能置于 `/sap/bc/adt` 下，因为该路径由 ADT 框架资源路由管理。

### 3.1 SAP 侧职责

函数模块在 SAP 内部创建 `CL_SYSLOG_FILTER`，调用 `CL_SYSLOG=>GET_INSTANCE_BY_FILTER( )`；不调用 SAP GUI 函数，不写入表、不更新配置、不创建锁或传输。

函数模块必须：

1. 使用 `AUTHORITY-CHECK OBJECT 'S_ADMI_FCD' ID 'S_ADMI_FCD' FIELD 'SM21'`，拒绝无权调用者。
2. 要求起止日期时间；最大查询窗口为 24 小时，防止全量扫描系统日志。
3. 对实例、用户、程序、事务码与消息号提供可选的包含过滤。
4. 限制每次返回 `1`—`500` 行；超限明确报错，不静默扩大。
5. 采用仅允许顺序翻页的数值 `offset`；每页返回下一 offset，调用方改变筛选条件时必须从 `0` 重新读取。
6. 返回统一字段：发生时间、实例、客户端、用户、程序、事务码、消息 ID/编号、严重级别、工作进程/进程、文本以及可选关联 ID。
7. 不在 HTTP 响应、SLG1 或短 dump 中记录密码、Cookie 或完整认证头。

SAP 标准类在不同 Basis 版本可能出现可见性或返回对象结构差异。因此 HTTP 类将把标准对象解析集中在一个适配点；部署时必须在实际系统语法检查、激活并与 SM21 的同筛选窗口抽样比对。

### 3.2 MCP 侧职责

MCP 在 `SAP_MCP_TOOL_PROFILE=legacy-full` 下暴露 `sm21Read` 和 `analyzeRuntimeErrors`，并复用现有 ADT 登录会话请求固定路径 `/sap/bc/z-mcp/sm21`。默认 `safe` 模式继续只暴露四个受控源码工具。

- `sm21Read` 只转发已校验的读取筛选、页大小和 offset；其响应保留 HTTP 服务返回的行、下一 offset、是否截断和读取范围。
- `analyzeRuntimeErrors` 读取指定时间窗的 ST22 摘要和 SM21 分页结果，以时间、实例、用户、程序、事务码、消息 ID 进行保守关联；输出证据、可能关联、未关联事件和明确的置信度，不把时间接近表述为因果关系。
- SM21 ADT HTTP 调用、ST22 ADT 调用均经过现有共享执行门控和响应字节上限；不增加自动重试、后台轮询或持久化日志库。

MCP 通过 `ADTClient.httpClient.request()` 调用固定路径，复用已有 Cookie、CSRF、认证和超时；不得把凭据拼入工具参数、响应、普通 stderr 日志或审计 JSONL。连接/认证失败应返回可执行的安全错误，不泄漏系统细节。

## 4. 工具契约

### `sm21Read`

必填输入：`fromDateTime`、`toDateTime`（ISO 8601，按 SAP 系统时区转换）。

可选输入：`instances`、`users`、`programs`、`tcodes`、`messageIds`、`severity`、`pageSize`、`offset`。

成功输出：

- `logs`：规范化的日志记录数组。
- `nextOffset`：仅在有更多结果时返回。
- `truncated`：服务端命中上限或仍有下一页时为真。
- `range`：实际系统时区、查询窗口和有效过滤条件。
- `source`：固定为 `SM21`。

### `analyzeRuntimeErrors`

必填输入同 `sm21Read`；可选输入为相同过滤条件及 `includeSt22`（默认真）。

成功输出包含：

- ST22 摘要、SM21 记录和关联组。
- 每个关联的匹配字段、时间差、证据等级和诊断建议。
- 分页/截断提示；一旦数据不完整，结论必须标记为部分观察。

第一版不读取 ST22 的完整 dump 正文，不自动打开程序源码，不执行 ATC、trace、调试器或任何修复操作。

## 5. 配置与权限

新增配置：

| 环境变量 | 默认 | 规则 | 用途 |
| --- | --- | --- | --- |
| `SAP_MCP_SM21_MAX_WINDOW_HOURS` | `24` | 1—24 | MCP 入口的时间范围上限，SAP HTTP Handler 仍独立强制 |
| `SAP_MCP_SM21_DEFAULT_PAGE_SIZE` | `100` | 1—500 | 默认返回行数 |
| `SAP_MCP_SM21_MAX_PAGE_SIZE` | `500` | 1—500 | 单页硬上限 |

现有 ADT 登录账号必须拥有 `S_ADMI_FCD = SM21`。不得通过匿名 SICF、`SAP_ALL` 或绕过 SM21 授权来使工具可用。

## 6. 错误处理

- SICF 服务未部署或未激活：工具返回明确错误；不降级为 SAP GUI 或表直接读取。
- 权限不足：返回“缺少 SM21 显示权限”，不回显 SAP 授权对象内部详情。
- 时间范围、页大小、offset 无效：在调用 SAP 前拒绝。
- HTTP 服务返回的部分实例读取失败：保留成功记录，返回失败实例和 `partial=true`，分析结论降级。
- 网络/远程异常：读取操作可由用户决定是否重试；不做自动重试，避免重复负载和掩盖问题。
- 响应过大：沿用现有 MCP 响应字节上限，提示缩小窗口或使用下一页。

## 7. 验证与验收

### 自动验证

- ABAP 源码作为部署工件进行静态检查；仓库测试覆盖 ADT HTTP 请求映射、时间/页大小限制、offset 边界、敏感字段不泄漏和关联算法。
- 使用模拟 ADT HTTP 客户端验证错误映射、部分读取与响应截断。
- 执行 `npm test -- --runInBand`、`npm run build` 和 `git diff --check`。

### SAP DEV 验证

1. 在 SE24 创建并激活 `ZCL_MCP_SM21_ADT_HTTP`，再在 SICF 激活 `/sap/bc/z-mcp/sm21`。
2. 使用有 `S_ADMI_FCD=SM21` 的测试账号请求一个 15 分钟窗口。
3. 在 SM21 用相同时间、实例和过滤条件抽样比对时间、消息、程序/用户和总数。
4. 测试无 SM21 权限账号，确认 HTTP 403 且不返回任何日志。
5. 测试超过 24 小时、页大小超过 500、无效 offset 和跨实例部分失败。
6. 从 MCP 调用 `sm21Read`，再使用有已知短 dump的窗口执行 `analyzeRuntimeErrors`，核对关联证据而非只看结论。

完成条件：SAP GUI 与 HTTP 服务同筛选窗口的结果可抽样一致；MCP 工具只读、受限、可分页且不会泄漏凭据；ST22 与 SM21 的关联明确标记为证据等级而非确定因果。

## 8. 非目标

- 不替代 SM21、ST22、ST11、SM50、SM66、STAD、ST05 或 SAT 的完整 GUI 功能。
- 不读取系统日志底层表作为跨版本接口。
- 不允许写入、删除、归档或确认 SM21 日志。
- 不为没有 SM21 权限的账号提供绕过路径。
- 不承诺不同 SAP 版本上的 `CL_SYSLOG` 对象结构一致；以实际 DEV 激活和比对为准。
