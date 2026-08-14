# 安全调试监听器生命周期设计

## 状态

- 日期：2026-08-14
- 状态：设计已确认，经参考实现复核修订，尚未实施
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
- 当前普通 MCP 调用与调试控制共用连接模型，尚未明确区分 listener/断点所需的无状态客户端与每个已 Attach debuggee 所需的独立有状态客户端。
- `abap-adt-api` 8.4.1 没有显式 detach 操作；现有 API 只有 Step、Continue、Jump 和 Terminate，不能把 logout、dropSession 或关闭本地视图宣称为安全 detach。

这些问题会导致监听器占住所有后续 SAP 工具调用、删除动作无法真正取消底层 HTTP、重启后身份漂移，以及“未捕获 debuggee”被误报为成功。

## 目标

建立一个可取消、可查询、可审计的 DEV 调试监听器生命周期，使 AI 调试适合以下受控用途：

1. 用户明确要求对一个由用户自行触发的外部 HTTP、RFC 或 OData 请求进行调试。
2. MCP 在取得原生确认后创建有期限的监听器并立即返回。
3. 用户继续使用 MCP 做只读现场分析，并在捕获明确 debuggee 后决定是否 Attach。
4. Attach、授权、每次 Step 或 Continue、变量修改、跳转和终止仍遵守各自确认边界。
5. 删除、到期、正常退出和异常恢复具有明确状态，不盲目重放远端控制动作。
6. Attach 后根据 SAP 返回的 post-mortem、dump 和 stepping 能力进入可控制或仅检查模式，不能把已经结束或不可单步的上下文当作活跃调试会话。

## 非目标

本次不建设：

- 自动生成或部署 HTTP/RFC/OData 触发端点。
- 自动替用户重放业务请求。
- 自动循环 Step、自动 Continue 或无人值守调试代理。
- listener 超时后的自动重连、自动接管其他客户端 listener，或容量满时自动 Attach/Continue 释放 debuggee。
- 在关闭线程、MCP 退出或清理失败时隐式执行 Continue、Terminate 或变量修改。
- Eclipse ADT 或 SAP GUI 的完整调试器替代品。
- QAS/PRD 调试控制。
- 未经明确指令的 Attach、断点、栈导航、变量修改、跳转或终止。
- 把长轮询伪装成可取消的 `Promise.race`；底层网络请求必须真正收到取消信号。
- 第一阶段保存或回放完整调用栈和变量快照；replay 作为后续独立阶段评估。

只读诊断仍是默认路径。主动调试是 DEV 中的高级、可选、最后手段，只有静态源码、ST22、SM21、数据和已有运行证据不足以确定根因时才使用。

## 安全边界

### Profile 与系统角色

- `development + DEV`：可使用安全调试控制门面。
- `diagnostic-readonly + DEV/QAS/PRD`：只允许现有只读调试现场读取，不允许创建/删除监听器、设置/删除断点、Attach、保存设置、Step、Continue、栈导航、跳转、终止或变量修改。
- `safe`：不注册调试工具。
- `legacy-full`：保留原始底层调试工具名称、参数和正常返回契约；该 profile 仍是显式高风险模式，不代表经过安全门面保护。但 `SAP_MCP_SYSTEM_ROLE!=DEV` 时，创建/删除 listener、断点、Attach、设置、控制和变量修改仍由服务器级策略门拒绝，QAS/PRD 只读边界不能通过 profile 绕过。

所有安全调试控制继续要求：

- `SAP_MCP_SYSTEM_ROLE=DEV`。
- SAP host 和 client 位于允许列表。
- 目标用户位于 `SAP_MCP_ALLOWED_DEBUG_USERS`；允许配置多个用户。
- `SAP_MCP_AUDIT_PATH` 可写。
- MCP 客户端支持原生 `elicitation.form`。
- 每个高风险动作由用户明确指令，并按既定粒度取得原生确认。

安全调试不提供文字确认降级。

## 总体架构

### `DebugTerminalIdentityProvider`

单独管理 SAP 标准的机器级 `terminalId`：

- Windows 优先读取 `HKCU\Software\SAP\ABAP Debugging\TerminalID`。
- Windows 注册表确认不存在该值，或当前平台不是 Windows 时，读取 `~/.SAP/ABAPDebugging/terminalId`；Windows 注册表查询因权限或命令错误失败时关闭失败，不能降级生成另一套 identity。
- 两处都没有值时生成 RFC 4122 UUID v4，去除连字符并转为大写，原子写入上述用户级标准文件；不主动修改注册表。
- `terminalId` 不按 SAP host、client、SAP 用户或 MCP 工作区分片，也不写入 MCP 的 scope identity 文件。
- 读取已有值时只裁剪首尾空白；结果必须为 1 到 128 个不含控制字符的 ASCII 字符。为空、超长、包含控制字符或文件无法安全读写时关闭失败，不能在同一次启动中静默切换身份。新生成值固定为 32 位大写十六进制字符。

这样可以与同一台机器上的 SAP GUI/ADT 调试身份保持一致，也避免 MCP 为每个连接制造彼此不兼容的“机器身份”。

### `DebugIdentityStore`

管理 MCP server instance 身份以及连接/源码范围派生值。该设计不依赖插件传递工作区信息，因此 MCP 单独启动时保持完整能力：

- `ideId`：首次使用时生成 opaque UUID v4，去除连字符并转为大写，之后在当前 identity 文件中持久化复用。它不是 UI5 hash，也不编码 host、client、用户或路径信息。
- `identityPathHash`：规范化 identity 文件绝对路径的 SHA-256，用于检测文件被复制或移动到另一个 server instance scope；文件只保存哈希，不保存可逆的本地绝对路径。
- `scopeHash`：规范化 SAP host、三位 client、解析后的大写目标 SAP 用户、`ideId` 和 `identityPathHash` 的 SHA-256，用于隔离 listener 状态、计划和审计记录；它不是 SAP 的 `terminalId` 或 `ideId`。目标用户为空时先解析为当前 `SAP_USER`，不能让空值和显式当前用户形成两个 scope。
- `clientId`：按连接 scope 和规范化 ADT 源码 URI 确定性派生，格式为 `24:` 加 `base64url(SHA-256(scopeHash + "\\0" + canonicalAdtSourceUri))`，总长 46 个 ASCII 字符。相同连接和源码范围稳定复用，不同源码范围互不占用断点所有权，也不暴露本地路径。

identity 文件只保存格式版本、`ideId`、`identityPathHash` 和创建时间；`scopeHash` 与 `clientId` 在运行时派生，`terminalId` 由独立 provider 管理。文件不保存密码、Cookie、debuggee、调用栈、变量、授权或监听器状态。写入采用临时文件加原子替换；文件损坏、路径哈希不匹配或无法安全写入时关闭失败，不能静默生成第二套身份继续运行。插件需要隔离不同工作区时可以配置不同 identity 路径，但 MCP 不依赖插件才能生成身份。

路径规范化使用绝对路径、折叠 `.`/`..` 和统一分隔符；Windows 额外统一盘符与大小写，其他平台保留大小写。identity 与 terminal 文件创建时拒绝符号链接/重解析点目标，并使用当前用户可读写的最小权限，避免另一个本地账户替换调试身份。

`canonicalAdtSourceUri` 必须来自 ADT 返回的对象/内容 URI，移除行号和 range fragment 后按 URI 规则规范化；不能使用用户输入的本地文件路径或仅以源码文件名派生。

`clientId` 的字符集、长度和断点所有权稳定性必须通过 `abap-adt-api` 契约测试及真实 DEV 断点创建/删除验收；不通过时不得发布安全断点能力，也不得退回调用方自填任意 ID。

### `DebugClientFactory`

调试连接与普通 MCP 调用隔离：

- 每个 listener 长轮询使用独立 client instance，并以 stateless 语义调用；listener 查询/删除以及 Attach 前的断点创建/删除使用短生命周期 stateless client，不能与长轮询共用一个可被取消或关闭的实例。
- 每个捕获并确认 Attach 的 debuggee 创建一个新的 `ADTClient`，在 discovery/Attach 前显式设置为 stateful；该客户端只属于一个 `debuggeeId`。
- 已 Attach 会话的栈、变量和控制命令只使用该 debuggee 的 stateful client，不能切回普通 MCP client，也不能与另一个 debuggee 共用 Cookie 或会话状态。
- `DebugSessionRegistry` 持有每个会话客户端、状态和清理 Promise；listener、会话和普通连接分别集中关闭，任何失败都单独记录，不能因一个连接退出而遗漏其他连接。

### `DebugListenerManager`

独立管理长轮询，不占用主 `ToolExecutionGate` 的 SAP 单并发槽，并只使用 `DebugClientFactory` 创建的 stateless client。每个监听器拥有：

- 服务器生成的 `listenerId`。
- SAP host、client、debugging mode 和目标用户。
- 当前服务器管理的调试身份引用。
- 独立 `AbortController`。
- 创建、到期和终结时间。
- 当前生命周期状态。
- 受控 debuggee 摘要或错误摘要。

同一个 host、client、debugging mode、目标用户和调试身份只能存在一个非终态监听器。重复创建一律以 `LISTENER_ALREADY_ACTIVE` 拒绝，同时返回现有 `listenerId` 和受控状态摘要，不能启动第二个长轮询或修改原 listener 的 TTL。

冲突预检与真正进入 `debuggerListen` 之间仍可能发生竞态。底层调用若返回 conflict，生命周期管理器将 listener 置为 `FAILED` 并返回 `LISTENER_CONFLICT`；不得自动重试、删除远端 listener 或进入 takeover 流程。

### `DebugLifecycleStateStore`

在审计目录内原子保存 listener 和 Attach session 的最小生命周期元数据，用于进程重启后的保守恢复判断。它与长期 identity 文件分开：

- identity 文件长期稳定。
- listener 状态有 TTL，可进入终态并被有界清理。
- 每条 listener 状态同时索引原 `debugOperationPlanId` 和服务器生成的 `listenerId`，使 MCP 重启后仍能通过原计划 ID 查询恢复结果。
- 每条 Attach session 状态保存 `sessionId`、Attach plan ID、`listenerId`、`scopeHash`、受控 debuggee 摘要、分类结果、创建/终结时间和 `cleanupRequired`；重启后所有非终态记录先转为 `UNKNOWN`。
- 终态记录默认保留 24 小时；容量沿用安全计划上限。容量已满且没有可淘汰终态记录时，拒绝创建新 listener 或 Attach session。
- 不持久化底层 AbortController、SAP 会话 Cookie、可恢复 Attach 凭据、调用栈、变量、调试授权或控制命令。持久化摘要只用于核对和清理提示，不能恢复 session 或授权。

### `DebugControlWorkflow`

继续负责不可变计划、原生确认、Attach 上下文、授权、单次控制命令、变量漂移检查和审计。`CREATE_LISTENER` 与 `DELETE_LISTENER` 改为委托 `DebugListenerManager`；Attach 通过 `DebugClientFactory` 建立独立 stateful session，其他操作仍通过主执行门按 session 串行执行。

### `abap-adt-api`

底层库增加可选 `AbortSignal` 支持：

- `RequestOptions` 接受 `signal?: AbortSignal`。
- Axios 请求配置透传 `signal`。
- `debuggerListen` 通过向后兼容的可选请求选项或重载接收 signal。
- 取消错误可被调用方可靠地区分，不能伪装成普通网络失败。

MCP 公开发布只能依赖包含该能力的正式 `abap-adt-api` 版本。开发期间可以使用本地 link 验证，但发布版本不依赖未发布的 Git commit 或 `node_modules` 补丁。

## 身份文件用途

SAP 使用 `terminalId + ideId` 标识监听客户端，断点还使用 `clientId` 标识所有者。如果 MCP 每次重启都产生新值，SAP 会把它当成另一个客户端，导致旧监听器无法查询或删除、断点所有权漂移，或监听器与断点使用不同身份。

机器级 terminal 文件解决的是“这台机器是谁”，MCP identity 文件解决的是“哪个 MCP server instance 在调试”。二者都不解决“当前正在调试什么”。监听器状态、debuggee、Attach session 和授权均不写入 identity 文件。

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

### Attach 会话状态

listener 捕获 debuggee 与成功 Attach 是两个不同生命周期。每个 Attach session 使用独立 stateful client，并具有以下状态：

- `ATTACHING`：已取得确认，正在建立 SAP 调试会话。
- `ACTIVE_CONTROL`：Attach 返回可单步、不是 post-mortem 且没有 dump ID；只有该状态可以申请短期控制授权。
- `INSPECTION_ONLY`：Attach 返回 `isPostMortem=true`、存在 dump ID，或 `isSteppingPossible=false`；只允许读取调用栈、源码位置和变量，不创建控制授权。
- `RELEASED`：只读复查能够证明 debuggee 已结束或调试会话已释放。
- `FAILED`：Attach 确定失败，且可以证明没有建立远端会话。
- `UNKNOWN`：连接中断、关闭本地客户端或清理失败后，无法证明 SAP 是否仍保留 Attach 状态；必须返回 `cleanupRequired: true`。

状态转换为：

```text
ATTACHING -> ACTIVE_CONTROL | INSPECTION_ONLY | FAILED | UNKNOWN
ACTIVE_CONTROL -> ACTIVE_CONTROL | RELEASED | UNKNOWN
INSPECTION_ONLY -> RELEASED | UNKNOWN
```

Attach 返回后先读取并保存 `isPostMortem`、dump ID 和 `isSteppingPossible`，完成分类后才能返回结果。`INSPECTION_ONLY` 中禁止 Step、Continue、run-to-line、go-to-stack、jump-to-line、Terminate 和变量修改；读取不同栈帧时只能使用已经证明不改变远端执行状态的读取 API。底层库没有这种 API 时仅返回当前可安全读取的 frame，并明确报告其他 frame 不可用，不能用控制型栈跳转模拟读取。

## 工具契约调整

### `previewDebugOperation`

安全门面的 `CREATE_LISTENER`、`DELETE_LISTENER`、`SET_BREAKPOINTS` 和 `DELETE_BREAKPOINT` 不再要求调用方提供 `terminalId`、`ideId` 或 `clientId`。服务器在解析计划时注入当前 identity，并把 identity 指纹而非完整可重用身份展示在计划视图中。

`CREATE_LISTENER` 输入保留：

- `kind`
- `debuggingMode`
- `targetUser`
- `checkConflict`
- `isNotifiedOnConflict`

安全门面始终执行独立冲突预检；旧调用方传入 `checkConflict=false` 不能关闭该预检。若发现同一受管理 identity 的现有 listener，返回 `LISTENER_ALREADY_ACTIVE`；若发现其他客户端 listener，返回 `LISTENER_CONFLICT` 和脱敏摘要。安全门面不提供 takeover，也不删除无法通过当前 `listenerId + identity` 证明归属的 listener。

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
- Attach session ID、`ATTACHING | ACTIVE_CONTROL | INSPECTION_ONLY | RELEASED | FAILED | UNKNOWN` 状态、post-mortem 标志、dump ID 和 stepping 能力摘要。
- 清理状态或脱敏错误摘要。

查询先读取进程内计划；计划因重启不存在时，使用原 `debugOperationPlanId` 从 `DebugLifecycleStateStore` 读取 listener 或 Attach session 的受控恢复视图。它不能恢复或重新消费原计划，也不能恢复 Attach 上下文和授权。

不得返回密码、Cookie、完整变量值、完整请求负载或未受控的 SAP 响应。

## Attach 与后续控制

只有 `DEBUGGEE_AVAILABLE` 的 listener 可以进入安全 Attach 预览。预览必须展示并冻结：

- SAP host 和 client。
- 目标 SAP 用户。
- `debuggeeId`。
- 程序、Include 和行号（SAP 返回时）。
- listener 与 identity 指纹。

应用 Attach 前再次比对 listener 状态和上述身份；发生用户、客户端、程序或 debuggee 漂移时拒绝。Attach 使用该 debuggee 的独立 stateful client。Attach 成功后先分类 session；只有 `ACTIVE_CONTROL` 才允许申请短期控制授权，`INSPECTION_ONLY` 始终只读。

后续边界保持不变：

- Step、Continue、run-to-line 和栈导航每次只执行一个用户明确指定的命令。
- Jump-to-line 和 terminate 每次建立新计划并取得原生确认。
- 每次变量修改单独预览和确认，应用前复读栈帧和旧值，漂移即拒绝。
- 重新 Attach、debuggee 改变、终止、授权过期、MCP 重启或显式撤销都会使授权失效。
- 远端结果不确定时只读复查，不自动重放控制动作。

控制授权 TTL 不是 Attach session TTL。授权过期时 session 仍保持 `ACTIVE_CONTROL` 并报告 `authorizationExpired: true`，不能自动 Continue 或宣称已经释放。用户可以明确请求重新授权；服务器必须重新核对 session、debuggee、用户、client 和当前栈后才发放新授权，或者按既定边界明确 Continue/确认 Terminate。

### Attach 释放协议

`abap-adt-api` 8.4.1 没有显式 `detachDebugger`。因此设计不能把以下动作称为 detach：

- 关闭本地视图或 MCP tool 调用。
- `ADTClient.logout()`。
- `dropSession()`。
- 隐式执行 `stepContinue`。

`ACTIVE_CONTROL` 若已经通过只读证据确认 debuggee 自然结束，可直接进入 `RELEASED`。否则用户必须明确选择并执行一次 Continue 或 Terminate；Continue 仍按单次明确命令执行，Terminate 仍需要独立计划和原生确认。命令完成后使用只读 API 核验 debuggee 已结束或远端会话已释放，才能进入 `RELEASED`；Continue 只运行到下一个断点时仍保持 `ACTIVE_CONTROL`。

`INSPECTION_ONLY` 不执行任何控制动作。只有在只读证据确认 dump/debuggee 已结束后才能关闭本地 session 并进入 `RELEASED`；否则关闭客户端后进入 `UNKNOWN`，返回 `cleanupRequired: true`。

释放核验只接受明确证据，例如 SAP 返回 `debuggeeEnded`、Terminate 的确定成功结果，或后续只读调试状态明确不存在该 debuggee。超时、断线、空响应、logout/dropSession 成功或本地 socket 关闭都不是释放证据；无法取得明确证据时保持 `UNKNOWN`。

任何 MCP 退出、TTL、网络中断或用户关闭本地 session 都不得自动 Continue、Terminate、dropSession 或修改变量。关闭网络连接后如果无法证明远端释放，持久化 `UNKNOWN`。安全门面对 detach 请求返回 `DEBUG_DETACH_UNSUPPORTED`，并说明当前可选的明确 Continue、经确认的 Terminate，或只读复查路径。

实施 Attach 生命周期前必须完成一次协议研究：确认 SAP ADT 是否存在可公开实现且语义明确的 detach 请求。若找到，必须先在 `abap-adt-api` 中提供正式 API、单元测试和真实 DEV 验收；若未找到，则按上述保守协议发布，不得用隐式 Continue 或 logout 冒充 detach。

## 取消、TTL 与退出

### 用户删除

`DELETE_LISTENER` 仍是有副作用操作，必须先预览并取得原生确认。取消底层 HTTP 不是删除成功的替代；生命周期管理器还必须执行 SAP 端 listener 清理和复查。删除 listener 不等于释放已 Attach session，工具结果必须分别报告两种资源。

### TTL

创建确认中显示 listener 到期时间。初始确认同时授权该 listener 在 TTL 到期时进行有界清理，因此 TTL 清理不再次弹框。清理仍需取消 HTTP、删除 SAP listener、复查并审计；结果不确定则进入 `UNKNOWN`。TTL 只授权清理 listener，不授权对已 Attach debuggee 执行 Continue、Terminate、dropSession 或其他控制动作。

### 正常 MCP 退出

服务器关闭钩子按以下顺序执行有界清理：先取消 listener HTTP，再删除并复查 SAP listener，然后核对 Attach session 状态，再关闭各 session client，最后关闭普通 MCP client。清理有总超时，超时后记录 `UNKNOWN` 并退出，不能无限阻塞 MCP 关闭。对尚未证明远端释放的 Attach session，只关闭本地网络资源并记录 `cleanupRequired: true`，不得自动执行控制动作。

### 异常退出与重启

崩溃或强制终止可能来不及清理。新进程启动时：

1. 读取持久化的非终态 listener 元数据。
2. 将它们先标为 `UNKNOWN`，不能宣称仍在监听。
3. 使用稳定 identity 做只读 listener 核对。
4. 若确认远端不存在，转为 `ENDED_WITHOUT_DEBUGGEE`，记录恢复原因为 `PROCESS_RESTART_NO_REMOTE_LISTENER` 并终结本地状态；不能宣称已成功捕获或完成了显式删除。
5. 若远端仍存在或无法判断，返回 `cleanupRequired: true`；不自动恢复监听、不自动 Attach、不自动删除，等待用户明确确认 `DELETE_LISTENER`。

重启后所有 Attach 上下文和控制授权均失效，即使找到了旧 debuggee 也必须重新经过安全流程。持久化的非终态 Attach session 一律先进入 `UNKNOWN`；只允许只读核对，不自动 Continue、Terminate、dropSession、重建 stateful client 或恢复授权。

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
- Attach session 创建、`ACTIVE_CONTROL`/`INSPECTION_ONLY` 分类、释放确认或 `UNKNOWN`。
- detach 请求被拒绝，以及用户明确选择 Continue 或 Terminate 的独立授权链。

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

- `SAP_MCP_DEBUG_IDENTITY_PATH` 只保存 server instance `ideId` 和 `identityPathHash`，不保存 machine `terminalId`、`scopeHash` 或 `clientId`。
- 为空时固定使用审计目录下的 `debug-identity/identity.json`；显式路径用于隔离多个 MCP instance 或插件工作区。文件中的规范化路径哈希必须严格匹配。`v0.3.0` 不提供 identity 迁移工具；需要移动时继续显式指向原路径，或先确认远端 listener、断点和 session 已清理，再由用户明确建立新 identity。
- machine `terminalId` 固定使用 Windows SAP 注册表或 `~/.SAP/ABAPDebugging/terminalId`，不增加 MCP 私有路径配置。
- `SAP_MCP_DEBUG_LISTENER_TTL_SECONDS` 范围为 60 到 3600 秒，默认 900 秒。
- 配置非法、terminal/identity 目录不可写或 development 实例无法取得稳定身份时拒绝启动安全调试能力。

## 参考实现取舍

对 `vscode_abap_remote_fs` `v2.8.3`（提交 `cfbb0fc4e998d59cfe00d23ca2164fe22d598428`）的 CodeGraph 与源码复核确认，以下设计可借鉴：

- SAP 标准 machine `TerminalID` 来源和用户目录 fallback。
- workspace 持久化的 opaque `ideId`。
- 连接与源码范围确定性的 breakpoint `clientId`。
- listener/断点使用 stateless client，每个 debuggee 使用独立 stateful client。
- Attach 后读取 post-mortem、dump 和 stepping capability，并降级到 inspection-only。
- 集中持有 listener、debug session 和普通连接，退出时逐项清理并记录失败。

以下行为不采用：

- listener 自动循环、超时自动重连或自动接管其他客户端。
- 达到最大线程数时自动 Attach 并循环 Continue。
- 关闭线程时隐式 Continue，失败后自动 dropSession。
- 允许 PRD 在警告后主动调试。
- 第一阶段默认录制或回放调用栈和变量。

这些取舍保留参考实现中经过实战验证的身份与连接隔离思路，同时维持 MCP 的逐次明确指令、原生确认、QAS/PRD 只读和未知结果不重放边界。

## 后续 replay 阶段

replay/快照可以帮助 AI 比较不同断点或单步后的调用栈、源码位置和变量摘要，但不属于第一阶段 listener 修复。后续单独设计时至少需要：

- 默认不记录完整变量值，按字段规则脱敏并允许显式排除变量。
- 限制栈深、变量递归深度、集合行数、单次快照字节数、总步数和总文件大小。
- 明确保留期限和用户删除能力，MCP 重启后不自动恢复录制。
- 快照只用于分析，不可作为自动重放 Step、Continue、变量修改或业务请求的输入。

## 插件与三个 Skill

`sap-abap-adt-workbench` 继续保持一个插件、三个 Skill：

- `sap-abap-development`：拥有 DEV 安全调试流程。更新 `safe-debug-workflow.md`，明确 listener 后台状态、服务器身份、外部请求由用户触发、Attach 核对和逐次控制。
- `sap-business-data-diagnosis`：只读查询业务记录；当根因需要动态代码路径时，把证据交给 development，不自行启动调试。
- `sap-system-operations-diagnosis`：只读处理 ST22、SM21 和运行环境证据；当最终责任对象是 ABAP 源码或需要 DEV 调试时，把 dump ID、时间、用户、client、程序、Include 和行号交给 development。post-mortem handoff 默认进入 `INSPECTION_ONLY`，不能申请调试控制授权。

Skill 不宣称可以自动触发业务请求，也不把 AI 调试描述为常规首选手段。MCP 本身保持可独立使用，插件只是提供路由、操作规范和安全工作流。

## 兼容与发布

发布顺序：

1. 为 `abap-adt-api` 实现并发布 AbortSignal 支持。
2. 完成显式 detach 协议研究并记录结论；若存在正式协议，先在 `abap-adt-api` 实现和验证，若不存在则冻结 `DEBUG_DETACH_UNSUPPORTED` 保守契约。
3. MCP 升级到 `v0.3.0`，依赖包含取消能力的正式库版本，实现标准身份、客户端隔离、listener 和 Attach session 状态机。
4. 插件升级到 `v0.2.0`，更新 development Skill、共享 MCP 参考和 eval。
5. replay/快照如需建设，另立规格和版本，不并入本次发布。

兼容原则：

- 原始 `legacy-full` 调试工具名称、参数和普通返回契约不因安全 listener 改造而变化。
- `legacy-full` 的原始长轮询仍保持同步返回契约，但必须传递 MCP 请求取消信号；所有 profile 在 QAS/PRD 都受服务器级调试只读策略约束。
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

- terminalId 的 Windows registry、标准文件 fallback、首次原子创建、非法值和写入失败路径。
- server instance identity 首次创建、重启复用、路径隔离、损坏关闭失败和原子写入。
- Windows/非 Windows 路径规范化、符号链接/重解析点拒绝和 identity 最小文件权限。
- `clientId` 对相同连接/源码稳定、不同源码隔离、字符集和固定长度符合契约。
- 旧 identity 参数相等时兼容、不相等时拒绝。
- listener/断点使用 stateless client；每个 debuggee 使用不同 stateful client，且不复用普通 MCP 会话。
- 创建 listener 立即返回，且不占主 SAP 单并发槽。
- 同 scope 重复 listener 被拒绝或返回同一实例。
- 冲突预检后的竞态 conflict 进入 `FAILED/LISTENER_CONFLICT`，不会重试或 takeover。
- `undefined` 分类为 `ENDED_WITHOUT_DEBUGGEE`。
- DELETE、TTL 和正常退出真实触发 AbortSignal、SAP 清理与复查。
- 异常重启进入 `UNKNOWN`，不自动恢复、Attach 或删除。
- debuggee 元数据结构校验、Attach 身份漂移拒绝和授权失效。
- Attach 返回 post-mortem、dump ID 或不可 stepping 时进入 `INSPECTION_ONLY`，全部控制动作被拒绝。
- `ACTIVE_CONTROL` 自然结束，或明确 Continue/经确认 Terminate 后，仍需取得明确释放证据才能进入 `RELEASED`。
- 控制授权过期不改变 session 状态；重新授权必须复核完整上下文。
- 只有 `debuggeeEnded`、确定的 Terminate 或只读状态不存在等明确证据可以进入 `RELEASED`，空响应、logout 和 socket 关闭仍为 `UNKNOWN`。
- detach 明确返回 `DEBUG_DETACH_UNSUPPORTED`；logout、dropSession 和关闭本地 session 不得返回成功 detach。
- listener TTL、容量满、线程关闭和 MCP 退出均不会自动 Attach、Continue、Terminate、dropSession 或重连。
- 审计脱敏和状态迁移完整。
- `DebugLifecycleStateStore` 只恢复 listener/session 摘要，不恢复 Cookie、Attach 上下文、授权或控制命令。
- QAS/PRD 不注册安全调试控制工具，且 `legacy-full` 原始控制调用也被服务器级策略拒绝。
- 原始 `legacy-full` 工具契约回归。
- 全量 Jest、TypeScript build 和 `git diff --check` 通过。

### 插件

- 三个 Skill 的触发和交接 eval。
- development 中“先静态诊断，必要时才调试”的路径。
- 未明确要求调试控制时保持只读。
- 明确要求 listener、断点、Attach 或单步时使用正确安全门面。
- QAS/PRD 控制请求被拒绝并转为只读证据方案。
- ST22/post-mortem 交接进入 `INSPECTION_ONLY`，不会建议 Continue、Terminate、栈跳转或变量修改。

## 真实 DEV 验收

真实验收只使用专用、可恢复、无副作用的 DEV 测试资产和一个由用户自行触发的已知外部 HTTP、RFC 或 OData 请求。完整通过条件：

1. 设置目标断点并确认 SAP 返回。
2. 创建 listener，工具立即返回 `LISTENING`。
3. 普通只读工具仍可调用，证明 listener 未占主执行门。
4. 用户从 SAP 外部正常触发请求。
5. 状态进入 `DEBUGGEE_AVAILABLE`，并显示正确用户、client、程序、Include 和行号。
6. 预览并确认 Attach。
7. 验证 session 被分类为 `ACTIVE_CONTROL`；另用受控 dump 样本验证 `INSPECTION_ONLY`，但不对其执行控制动作。
8. 授权当前 active 调试会话。
9. 读取调用栈和变量。
10. 用户明确要求并执行一次 Step。
11. 用户明确要求 Continue，或单独确认 Terminate；只读复查证明 session 已释放。
12. 撤销授权，删除 listener 和断点，确认 listener、breakpoint 和 debug session 均无残留。

跳转、终止和变量修改保留能力，但只有准备了专用无副作用 debuggee 时才做真实验证；不能为了发布强行在业务事务上验证。

## 完成标准

- listener 长轮询可被真实取消，不再依赖约 100 小时超时。
- `CREATE_LISTENER` 不阻塞后续 SAP 工具。
- `undefined` 不再被报告为成功捕获。
- 调试身份由服务器稳定管理，多个 SAP 实例和用户互不污染。
- machine `terminalId`、server-instance `ideId` 和 source-scoped `clientId` 的来源、范围和持久化边界明确。
- listener/断点、每个 Attach session 和普通 MCP 调用使用隔离的客户端生命周期。
- Attach 前核对用户、client、程序和 debuggee。
- post-mortem、dump 或不可 stepping 会话只能进入 `INSPECTION_ONLY`。
- 未实现显式 detach 时不伪造释放成功，不自动 Continue 或 dropSession；无法证明释放时返回 `UNKNOWN/cleanupRequired`。
- 重启后不恢复旧授权，不自动控制未知 debuggee。
- DEV 调试控制保持明确指令和原生确认；QAS/PRD 保持只读。
- MCP 可独立使用，插件继续维持一个插件、三个职责清晰的 Skill。
