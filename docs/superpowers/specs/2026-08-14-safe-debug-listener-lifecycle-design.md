# 安全调试监听器生命周期设计

## 状态

- 日期：2026-08-14
- 状态：设计已确认，尚未实施
- MCP 仓库：`mcp-abap-abap-adt-api`
- 配套插件：`sap-abap-adt-workbench`
- 当前 MCP 基线：`v0.2.0`（提交 `86adc02`）

## 背景

当前 `development` profile 已提供监听器、断点、Attach、调试设置、单步、继续、栈导航、跳转、终止和变量修改的安全门面，但真实 DEV 验证暴露了监听器生命周期缺口：

- MCP 请求处理器没有接收和传递 SDK 提供的 `RequestHandlerExtra.signal`。
- `abap-adt-api` 8.4.1 的请求选项没有 `AbortSignal`，Axios 请求也没有传递 `signal`。
- `debuggerListen` 是最长约 100 小时的长轮询；当前实现把它放在主 SAP 单并发门内等待。
- `debuggerListen` 在超时或终止时可返回 `undefined`，当前工作流却统一把结果记为 `APPLIED`。
- 安全门面要求调用方提供 `terminalId`、`ideId` 和 `clientId`，但这些值应是稳定的调试客户端身份，而不是每次调用临时编造的字符串。

这些问题会导致监听器占住所有后续 SAP 工具调用、删除动作无法真正取消底层 HTTP、重启后身份漂移，以及“未捕获 debuggee”被误报为成功。

## 目标

建立一个可取消、可查询、可审计的 DEV 调试监听器生命周期，使 AI 调试适合以下受控用途：

1. 用户明确要求对一个由用户自行触发的外部 HTTP、RFC 或 OData 请求进行调试。
2. MCP 在取得原生确认后创建有期限的监听器并立即返回。
3. 用户继续使用 MCP 做只读现场分析，并在捕获明确 debuggee 后决定是否 Attach。
4. Attach、授权、每次 Step 或 Continue、变量修改、跳转和终止仍遵守各自确认边界。
5. 删除、到期、正常退出和异常恢复具有明确状态，不盲目重放远端控制动作。

## 非目标

本次不建设：

- 自动生成或部署 HTTP/RFC/OData 触发端点。
- 自动替用户重放业务请求。
- 自动循环 Step、自动 Continue 或无人值守调试代理。
- Eclipse ADT 或 SAP GUI 的完整调试器替代品。
- QAS/PRD 调试控制。
- 未经明确指令的 Attach、断点、栈导航、变量修改、跳转或终止。
- 把长轮询伪装成可取消的 `Promise.race`；底层网络请求必须真正收到取消信号。

只读诊断仍是默认路径。主动调试是 DEV 中的高级、可选、最后手段，只有静态源码、ST22、SM21、数据和已有运行证据不足以确定根因时才使用。

## 安全边界

### Profile 与系统角色

- `development + DEV`：可使用安全调试控制门面。
- `diagnostic-readonly + DEV/QAS/PRD`：只允许现有只读调试现场读取，不允许创建/删除监听器、设置/删除断点、Attach、保存设置、Step、Continue、栈导航、跳转、终止或变量修改。
- `safe`：不注册调试工具。
- `legacy-full`：保留原始底层调试工具及现有参数契约；该 profile 仍是显式高风险模式，不代表经过安全门面保护。

所有安全调试控制继续要求：

- `SAP_MCP_SYSTEM_ROLE=DEV`。
- SAP host 和 client 位于允许列表。
- 目标用户位于 `SAP_MCP_ALLOWED_DEBUG_USERS`；允许配置多个用户。
- `SAP_MCP_AUDIT_PATH` 可写。
- MCP 客户端支持原生 `elicitation.form`。
- 每个高风险动作由用户明确指令，并按既定粒度取得原生确认。

安全调试不提供文字确认降级。

## 总体架构

### `DebugIdentityStore`

管理安全调试门面使用的稳定客户端身份：

- `terminalId`：机器级稳定 GUID。Windows 优先读取 `HKCU\Software\SAP\ABAP Debugging` 中已有的标准值；不存在时生成 RFC 4122 GUID 并写入 identity 文件，不主动修改注册表。
- `ideId`：使用与 ADT 兼容的 UI5 hash 算法，从稳定 MCP 工作区身份生成。
- `clientId`：当前 MCP 调试实例的稳定断点所有者标识。
- `scopeHash`：SAP host、client、SAP 用户和 MCP 工作区身份的组合哈希，用于隔离多个实例并检测文件误用。

identity 文件只保存上述身份、格式版本和创建时间，不保存密码、Cookie、debuggee、调用栈、变量、授权或监听器状态。写入采用临时文件加原子替换；文件损坏、scope 不匹配或无法安全写入时关闭失败，不能静默生成第二套身份继续运行。

### `DebugListenerManager`

独立管理长轮询，不占用主 `ToolExecutionGate` 的 SAP 单并发槽。每个监听器拥有：

- 服务器生成的 `listenerId`。
- SAP host、client、debugging mode 和目标用户。
- 当前服务器管理的调试身份引用。
- 独立 `AbortController`。
- 创建、到期和终结时间。
- 当前生命周期状态。
- 受控 debuggee 摘要或错误摘要。

同一个 host、client、debugging mode、目标用户和调试身份只能存在一个非终态监听器。重复创建一律以 `LISTENER_ALREADY_ACTIVE` 拒绝，同时返回现有 `listenerId` 和受控状态摘要，不能启动第二个长轮询或修改原 listener 的 TTL。

### `DebugListenerStateStore`

在审计目录内原子保存最小生命周期元数据，用于进程重启后的保守恢复判断。它与长期 identity 文件分开：

- identity 文件长期稳定。
- listener 状态有 TTL，可进入终态并被有界清理。
- 每条 listener 状态同时索引原 `debugOperationPlanId` 和服务器生成的 `listenerId`，使 MCP 重启后仍能通过原计划 ID 查询恢复结果。
- 终态记录默认保留 24 小时；容量沿用安全计划上限。容量已满且没有可淘汰终态记录时，拒绝创建新 listener。
- 不持久化底层 AbortController、SAP 会话 Cookie、Attach 上下文、调试授权或变量值。

### `DebugControlWorkflow`

继续负责不可变计划、原生确认、Attach 上下文、授权、单次控制命令、变量漂移检查和审计。`CREATE_LISTENER` 与 `DELETE_LISTENER` 改为委托 `DebugListenerManager`，其他操作仍通过主执行门串行执行。

### `abap-adt-api`

底层库增加可选 `AbortSignal` 支持：

- `RequestOptions` 接受 `signal?: AbortSignal`。
- Axios 请求配置透传 `signal`。
- `debuggerListen` 通过向后兼容的可选请求选项或重载接收 signal。
- 取消错误可被调用方可靠地区分，不能伪装成普通网络失败。

MCP 公开发布只能依赖包含该能力的正式 `abap-adt-api` 版本。开发期间可以使用本地 link 验证，但发布版本不依赖未发布的 Git commit 或 `node_modules` 补丁。

## 身份文件用途

SAP 使用 `terminalId + ideId` 标识监听客户端，断点还使用 `clientId` 标识所有者。如果 MCP 每次重启都产生新值，SAP 会把它当成另一个客户端，导致旧监听器无法查询或删除、断点所有权漂移，或监听器与断点使用不同身份。

identity 文件解决的是“这个 MCP 调试客户端是谁”，不解决“当前正在调试什么”。监听器状态、debuggee 和授权均不写入 identity 文件。

## 状态模型

操作计划状态与监听器运行状态分开表达，避免把“创建监听任务已接受”和“已经捕获 debuggee”混为一谈。

### 操作计划状态

- `PREVIEWED`
- `APPLYING`
- `APPLIED`
- `FAILED`
- `UNKNOWN`
- `EXPIRED`

计划的 `APPLIED` 只表示已确认的创建或删除命令成功交给生命周期管理器，不表示 listener 已经捕获 debuggee。

### 监听器状态

- `LISTENING`：后台长轮询正在等待 debuggee。
- `DEBUGGEE_AVAILABLE`：收到明确且通过结构校验的 debuggee。
- `ENDED_WITHOUT_DEBUGGEE`：底层正常返回 `undefined`，或远端明确结束但没有 debuggee。
- `CANCELLED`：用户删除、TTL 或正常 MCP 退出导致取消并完成清理。
- `FAILED`：确定失败，且可以安全说明远端未成功。
- `UNKNOWN`：异常退出、连接中断或清理结果无法确认。

两套状态分别转换：

```text
plan: PREVIEWED -> APPLYING -> APPLIED | FAILED | UNKNOWN
plan: PREVIEWED -> EXPIRED

listener after an applied CREATE_LISTENER plan:
LISTENING -> DEBUGGEE_AVAILABLE | ENDED_WITHOUT_DEBUGGEE | CANCELLED | FAILED | UNKNOWN
DEBUGGEE_AVAILABLE -> CANCELLED | UNKNOWN
```

`undefined` 必须把 listener 状态映射为 `ENDED_WITHOUT_DEBUGGEE`，绝不能把 listener 结果表示为 `APPLIED`、`success` 或 `DEBUGGEE_AVAILABLE`。嵌套的计划状态可以保持 `APPLIED`，其含义仅是创建命令已被生命周期管理器接受。listener 不自动重启；需要继续等待时，用户重新创建并确认新的监听计划。

## 工具契约调整

### `previewDebugOperation`

安全门面的 `CREATE_LISTENER`、`DELETE_LISTENER`、`SET_BREAKPOINTS` 和 `DELETE_BREAKPOINT` 不再要求调用方提供 `terminalId`、`ideId` 或 `clientId`。服务器在解析计划时注入当前 identity，并把 identity 指纹而非完整可重用身份展示在计划视图中。

`CREATE_LISTENER` 输入保留：

- `kind`
- `debuggingMode`
- `targetUser`
- `checkConflict`
- `isNotifiedOnConflict`

`DELETE_LISTENER` 使用服务器返回的 `listenerId`，不能通过任意 identity 删除其他客户端的监听器。

为兼容 `v0.2.0` 调用方，`v0.3.0` 可暂时接受旧 identity 参数，但它们是可选兼容字段，且必须与服务器值完全一致；任何不一致都以 `DEBUG_IDENTITY_MISMATCH` 拒绝。兼容字段计划在 `v1.0.0` 移除。

旧版 `DELETE_LISTENER` 没有 `listenerId` 时，只有在 identity 完全匹配且当前 scope 恰好存在一个受管理的非终态 listener 时才允许解析；零个或多个候选都拒绝，不能按任意 identity 扩大删除范围。

### `applyDebugOperation`

确认 `CREATE_LISTENER` 后：

1. 在主执行门内完成策略、identity、重复 listener 和审计预检查。
2. 创建独立 AbortController 和持久化最小状态。
3. 启动后台 `debuggerListen`。
4. 立即返回 `status: LISTENING`、`listenerId`、到期时间和受控 identity 指纹。

后台 Promise 必须被生命周期管理器持有并处理完成或异常，不能形成未处理 rejection。

确认 `DELETE_LISTENER` 后：

1. 先触发对应 AbortController，终止本地长轮询。
2. 调用 SAP 删除 listener，并执行只读复查。
3. 只有清理结果确定时进入 `CANCELLED`；无法确认时进入 `UNKNOWN`。
4. 删除动作不盲目重试。

### `getDebugOperationStatus`

对 listener 计划返回：

- 原操作计划状态。
- `listenerId` 和 listener 生命周期状态。
- host、client、目标用户和 debugging mode。
- 创建、到期和终结时间。
- identity 指纹。
- 捕获后受控的 `debuggeeId`、用户、客户端、程序、Include 和行号。
- 清理状态或脱敏错误摘要。

查询先读取进程内计划；计划因重启不存在时，使用原 `debugOperationPlanId` 从持久化 listener 状态读取受控恢复视图。它不能恢复或重新消费原计划，也不能恢复 Attach 上下文和授权。

不得返回密码、Cookie、完整变量值、完整请求负载或未受控的 SAP 响应。

## Attach 与后续控制

只有 `DEBUGGEE_AVAILABLE` 的 listener 可以进入安全 Attach 预览。预览必须展示并冻结：

- SAP host 和 client。
- 目标 SAP 用户。
- `debuggeeId`。
- 程序、Include 和行号（SAP 返回时）。
- listener 与 identity 指纹。

应用 Attach 前再次比对 listener 状态和上述身份；发生用户、客户端、程序或 debuggee 漂移时拒绝。Attach 成功后才允许申请短期控制授权。

后续边界保持不变：

- Step、Continue、run-to-line 和栈导航每次只执行一个用户明确指定的命令。
- Jump-to-line 和 terminate 每次建立新计划并取得原生确认。
- 每次变量修改单独预览和确认，应用前复读栈帧和旧值，漂移即拒绝。
- 重新 Attach、debuggee 改变、终止、授权过期、MCP 重启或显式撤销都会使授权失效。
- 远端结果不确定时只读复查，不自动重放控制动作。

## 取消、TTL 与退出

### 用户删除

`DELETE_LISTENER` 仍是有副作用操作，必须先预览并取得原生确认。取消底层 HTTP 不是删除成功的替代；生命周期管理器还必须执行 SAP 端清理和复查。

### TTL

创建确认中显示 listener 到期时间。初始确认同时授权该 listener 在 TTL 到期时进行有界清理，因此 TTL 清理不再次弹框。清理仍需取消 HTTP、删除 SAP listener、复查并审计；结果不确定则进入 `UNKNOWN`。

### 正常 MCP 退出

服务器关闭钩子对全部非终态 listener 执行相同的有界清理。清理有总超时，超时后记录 `UNKNOWN` 并退出，不能无限阻塞 MCP 关闭。

### 异常退出与重启

崩溃或强制终止可能来不及清理。新进程启动时：

1. 读取持久化的非终态 listener 元数据。
2. 将它们先标为 `UNKNOWN`，不能宣称仍在监听。
3. 使用稳定 identity 做只读 listener 核对。
4. 若确认远端不存在，转为 `ENDED_WITHOUT_DEBUGGEE`，记录恢复原因为 `PROCESS_RESTART_NO_REMOTE_LISTENER` 并终结本地状态；不能宣称已成功捕获或完成了显式删除。
5. 若远端仍存在或无法判断，返回 `cleanupRequired: true`；不自动恢复监听、不自动 Attach、不自动删除，等待用户明确确认 `DELETE_LISTENER`。

重启后所有 Attach 上下文和控制授权均失效，即使找到了旧 debuggee 也必须重新经过安全流程。

## MCP 请求取消

`CallToolRequestSchema` handler 接收 SDK 的 `RequestHandlerExtra`，并把 `extra.signal` 传入可取消的前台调用。listener 后台任务使用自己的 AbortController，因为创建工具已经返回后，listener 生命周期不再等同于那次 MCP 请求生命周期。

两类 signal 不能混用：

- 请求 signal 取消当前尚未完成的工具调用。
- listener signal 由删除、TTL 或服务器关闭控制长轮询。

取消必须释放网络请求和相关资源。测试需要证明取消后新的普通 SAP 工具可以进入主执行门，且没有悬空 Promise 或未处理 rejection。

## 审计

新增或细化以下事件：

- listener 计划创建和确认。
- `LISTENING` 开始。
- `DEBUGGEE_AVAILABLE`。
- `ENDED_WITHOUT_DEBUGGEE`。
- 用户删除、TTL、正常退出导致的取消。
- 清理成功、失败或结果未知。
- 重启恢复核对。
- Attach 前身份匹配或漂移拒绝。

审计记录操作类型、host、client、目标用户、计划/listener/identity 哈希、状态迁移、原因、debuggee 摘要和脱敏错误。不得记录完整变量值、密码、Cookie、底层授权头、完整业务请求或完整调试配置文件。

## 配置

保留现有配置：

```text
SAP_MCP_TOOL_PROFILE=development
SAP_MCP_SYSTEM_ROLE=DEV
SAP_MCP_ALLOWED_HOSTS=dev.example.internal
SAP_MCP_ALLOWED_CLIENTS=300
SAP_MCP_ALLOWED_DEBUG_USERS=DEVUSER,TESTER
SAP_MCP_DEBUG_AUTH_TTL_SECONDS=900
SAP_MCP_AUDIT_PATH=D:\sap-mcp-audit
```

新增：

```text
SAP_MCP_DEBUG_IDENTITY_PATH=
SAP_MCP_DEBUG_LISTENER_TTL_SECONDS=900
```

- `SAP_MCP_DEBUG_IDENTITY_PATH` 为空时，在审计目录的调试身份子目录中按 scopeHash 保存 identity。
- 显式路径主要用于多工作区或迁移场景；仍必须通过 scopeHash 检查，不能复用到不同 SAP 上下文。
- `SAP_MCP_DEBUG_LISTENER_TTL_SECONDS` 范围为 60 到 3600 秒，默认 900 秒。
- 配置非法、identity 目录不可写或 development 实例无法取得稳定 identity 时拒绝启动安全调试能力。

## 插件与三个 Skill

`sap-abap-adt-workbench` 继续保持一个插件、三个 Skill：

- `sap-abap-development`：拥有 DEV 安全调试流程。更新 `safe-debug-workflow.md`，明确 listener 后台状态、服务器身份、外部请求由用户触发、Attach 核对和逐次控制。
- `sap-business-data-diagnosis`：只读查询业务记录；当根因需要动态代码路径时，把证据交给 development，不自行启动调试。
- `sap-system-operations-diagnosis`：只读处理 ST22、SM21 和运行环境证据；当最终责任对象是 ABAP 源码或需要 DEV 调试时，把 dump ID、时间、用户、client、程序、Include 和行号交给 development。

Skill 不宣称可以自动触发业务请求，也不把 AI 调试描述为常规首选手段。MCP 本身保持可独立使用，插件只是提供路由、操作规范和安全工作流。

## 兼容与发布

发布顺序：

1. 为 `abap-adt-api` 实现并发布 AbortSignal 支持。
2. MCP 升级到 `v0.3.0`，依赖包含该能力的正式库版本。
3. 插件升级到 `v0.2.0`，更新 development Skill、共享 MCP 参考和 eval。

兼容原则：

- 原始 `legacy-full` 调试工具名称、参数和普通返回契约不因安全 listener 改造而变化。
- `development` 安全门面新增正确状态和服务器身份；旧 identity 参数仅做严格相等兼容。
- QAS/PRD 源码和调试继续只读。
- 文档中的能力数量、工具列表和示例必须从最终注册代码重新统计，不能沿用旧数字。

## 自动化验证

### `abap-adt-api`

- signal 进入 Axios 配置。
- AbortController 取消真实挂起 HTTP。
- 取消错误可识别。
- 未传 signal 的现有调用保持兼容。
- `debuggerListen` 的正常 debuggee、`undefined`、错误和取消分支均有测试。

### MCP

- identity 首次创建、重启复用、scope 隔离、损坏关闭失败和原子写入。
- Windows registry 有值与无值两条 terminalId 路径。
- 旧 identity 参数相等时兼容、不相等时拒绝。
- 创建 listener 立即返回，且不占主 SAP 单并发槽。
- 同 scope 重复 listener 被拒绝或返回同一实例。
- `undefined` 分类为 `ENDED_WITHOUT_DEBUGGEE`。
- DELETE、TTL 和正常退出真实触发 AbortSignal、SAP 清理与复查。
- 异常重启进入 `UNKNOWN`，不自动恢复、Attach 或删除。
- debuggee 元数据结构校验、Attach 身份漂移拒绝和授权失效。
- 审计脱敏和状态迁移完整。
- QAS/PRD 不注册调试控制工具。
- 原始 `legacy-full` 工具契约回归。
- 全量 Jest、TypeScript build 和 `git diff --check` 通过。

### 插件

- 三个 Skill 的触发和交接 eval。
- development 中“先静态诊断，必要时才调试”的路径。
- 未明确要求调试控制时保持只读。
- 明确要求 listener、断点、Attach 或单步时使用正确安全门面。
- QAS/PRD 控制请求被拒绝并转为只读证据方案。

## 真实 DEV 验收

真实验收只使用专用、可恢复、无副作用的 DEV 测试资产和一个由用户自行触发的已知外部 HTTP、RFC 或 OData 请求。完整通过条件：

1. 设置目标断点并确认 SAP 返回。
2. 创建 listener，工具立即返回 `LISTENING`。
3. 普通只读工具仍可调用，证明 listener 未占主执行门。
4. 用户从 SAP 外部正常触发请求。
5. 状态进入 `DEBUGGEE_AVAILABLE`，并显示正确用户、client、程序、Include 和行号。
6. 预览并确认 Attach。
7. 授权当前调试会话。
8. 读取调用栈和变量。
9. 用户明确要求并执行一次 Step。
10. 撤销授权，删除 listener 和断点，确认没有残留。

跳转、终止和变量修改保留能力，但只有准备了专用无副作用 debuggee 时才做真实验证；不能为了发布强行在业务事务上验证。

## 完成标准

- listener 长轮询可被真实取消，不再依赖约 100 小时超时。
- `CREATE_LISTENER` 不阻塞后续 SAP 工具。
- `undefined` 不再被报告为成功捕获。
- 调试身份由服务器稳定管理，多个 SAP 实例和用户互不污染。
- Attach 前核对用户、client、程序和 debuggee。
- 重启后不恢复旧授权，不自动控制未知 debuggee。
- DEV 调试控制保持明确指令和原生确认；QAS/PRD 保持只读。
- MCP 可独立使用，插件继续维持一个插件、三个职责清晰的 Skill。
