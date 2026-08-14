# 安全调试监听器生命周期实施计划

## 状态与范围

- 日期：2026-08-14
- 状态：待实施
- 设计依据：`docs/superpowers/specs/2026-08-14-safe-debug-listener-lifecycle-design.md`
- 已发布 MCP 基线：`v0.2.0`，提交 `86adc02`
- 当前源码基线：提交 `d72743e`（包含已确认设计与参考实现取舍）
- 当前计划提交前基线：32 个 Jest 套件、246 项测试通过，TypeScript build 通过
- 配套插件：`D:\MyDev\SAP\sap-abap-adt-workbench`，当前版本 `0.1.0`，当前不是 Git 仓库
- 底层依赖：`abap-adt-api@8.4.1`；当前工作区没有可修改的 `abap-adt-api` 源码仓库

本计划只实现已确认的第一阶段：可取消 listener、稳定调试身份、连接隔离、Attach 分类、保守释放、QAS/PRD 全局只读，以及一个插件中的三个 Skill。replay、完整变量快照、自动触发业务请求、自动重连、自动 Attach、自动 Step/Continue 和无人值守调试不进入本次范围。

## 当前缺口

实施以当前磁盘代码为准，不能假设设计已经落地：

1. `src/index.ts` 的 `CallToolRequestSchema` handler 只接收 `request`，没有传递 MCP SDK 的 `RequestHandlerExtra.signal`。
2. `abap-adt-api@8.4.1` 的 `RequestOptions` 没有 `signal`，`AxiosHttpClient` 也没有把 signal 传给 Axios。
3. `debuggerListen` 固定使用 360000000 ms（约 100 小时）超时，并在主共享 `ADTClient` 上执行。
4. `DebugControlWorkflow` 只持有一个 `SafeDebugClient`，listener、断点、Attach、栈、变量和控制命令共享同一连接状态。
5. listener 返回 `undefined` 后，当前工作流仍会把操作计划标为 `APPLIED/success`，没有独立 listener 生命周期。
6. `terminalId`、`ideId` 和 `clientId` 仍由调用方输入，没有稳定、可审计的服务器身份来源。
7. Attach 成功后只保存一个按用户索引的内存上下文，没有独立 stateful client、session 状态、post-mortem/dump/stepping 分类或重启恢复摘要。
8. `legacy-full` 在 QAS/PRD 仍能列出并分发原始写入和调试控制工具；现有 `SafetyPolicy.assertDebugControlAllowed` 只保护安全门面。
9. 服务器关闭只关闭 MCP transport，没有有界清理 listener、Attach client 和普通 ADT client 的明确顺序。
10. `sap-abap-adt-workbench` 的 safe debug 参考仍描述旧的同步 listener/直接 Attach 流程。

## 发布依赖与硬门槛

按以下顺序交付，不能跳过前置版本：

```text
Phase 0 detach 协议结论
  -> Phase 1 abap-adt-api 正式版本（AbortSignal；可选真实 detach）
    -> Phase 2-6 MCP v0.3.0
      -> Phase 7 插件 v0.2.0
        -> Phase 8 自动化、真实 DEV 与公开发布
```

硬门槛：

- 不直接修改或发布 `node_modules/abap-adt-api`。
- MCP 的 `package.json` 只能依赖已发布且锁文件可解析的正式 `abap-adt-api` 版本。
- 在 detach 协议没有证据前，不实现名为 detach 的成功路径，不把 `logout`、`dropSession`、关闭本地 client 或隐式 Continue 包装为 detach。
- 在真实取消测试未通过前，不把 listener 放到后台，也不宣称 listener 可删除或可在退出时清理。
- 在非 DEV 跨 profile 测试未通过前，不发布 MCP `v0.3.0`。
- 插件只编排 MCP 已经实现并验证的能力，不能用 Skill 文字弥补服务器端策略缺口。

## Phase 0：完成 detach 协议研究并冻结结论

### 产出文件

- 新增 `docs/research/2026-08-14-adt-debug-detach-protocol.md`
- 必要时修订 `docs/superpowers/specs/2026-08-14-safe-debug-listener-lifecycle-design.md`，但任何语义变化需再次由用户确认

### 研究步骤

1. 以 `vscode_abap_remote_fs v2.8.3` 提交 `cfbb0fc4e998d59cfe00d23ca2164fe22d598428` 为行为参考，记录它关闭调试会话时实际调用的 ADT 请求、Continue、dropSession 和本地连接清理边界。
2. 检查 SAP ADT 可观察请求或公开实现，确认是否存在语义明确的显式 detach 请求。只记录实际 endpoint、HTTP method、query/header/body、响应和错误；不依据方法名猜测。
3. 在专用 DEV debuggee 上做最小协议验证时，先得到用户对该次真实调试的明确授权。只允许无副作用测试资产，不能在业务事务或 QAS/PRD 上探测。
4. 区分以下结果：远端明确释放、debuggee 自然结束、只关闭 HTTP/session、本地未知、Continue 到下一断点、Terminate 确定结束。
5. 写出单一结论：
   - `DETACH_SUPPORTED`：存在可复现、不会继续/终止业务执行的独立协议；或
   - `DETACH_UNSUPPORTED`：没有足够证据，实现冻结为保守拒绝。

### 验收门槛

- 研究文档包含版本、请求证据、SAP 环境角色、测试资产、观察结果和未验证项。
- `logout`、`dropSession`、socket close 和空响应均不能作为释放证据。
- 如果结论为 `DETACH_SUPPORTED`，Phase 1 必须先在 `abap-adt-api` 提供正式 API 和测试；如果为 `DETACH_UNSUPPORTED`，MCP 对 `DETACH` 请求固定返回 `DEBUG_DETACH_UNSUPPORTED`。
- 未完成本门槛时，可以实现通用 AbortSignal，但不能合并 Attach 释放实现。

## Phase 1：在 `abap-adt-api` 实现真实请求取消

本阶段在单独的 `abap-adt-api` 源码 checkout 中完成。开始前先确认上游当前分支、测试布局和贡献规范；下面的源码路径以 8.4.1 发布包映射出的模块为准，测试文件路径按上游现有布局落位。

### 修改文件

- 修改 `src/AdtHTTP.ts`
- 修改 `src/AxiosHttpClient.ts`
- 修改 `src/api/debugger.ts`
- 修改 `src/AdtClient.ts`
- 修改公开导出入口（仅在新增取消判定 helper 或 detach API 时）
- 新增/扩展 Axios、AdtHTTP 和 debugger 单元测试
- 若 Phase 0 证明支持 detach，新增对应 debugger API 测试和 README/API 文档

### 先写失败测试

覆盖：

1. `RequestOptions.signal` 原样进入 Axios request config。
2. 已经挂起的真实本地 HTTP 请求被 `AbortController.abort()` 后立即结束，不等待 timeout。
3. 调用方可以通过稳定 helper 或稳定错误码识别取消，不能把取消分类为普通网络失败或 SAP 业务错误。
4. 未传 signal 的所有既有请求保持兼容。
5. `debuggerListen` 的 debuggee、listener conflict、`undefined`、普通错误和取消分别可区分。
6. AbortSignal 作为最后一个可选 options 参数或等价兼容重载接入，不改变现有六个位置参数调用。
7. 如果有 detach：只调用 Phase 0 已证明的 endpoint，并覆盖成功、明确失败、超时/断线未知；不得自动 Continue 或 dropSession。

### 最小实现

1. 为 `ClientOptions/RequestOptions/HttpClientOptions` 增加 `signal?: AbortSignal`。
2. `AxiosHttpClient.toAxiosConfig` 只负责透传 `signal`，不自行构造 controller 或实现 `Promise.race`。
3. 为 `debuggerListen` 增加向后兼容的可选请求 options，内部把 signal 传给 `h.request`。
4. 暴露稳定的取消判定方式，使 MCP 不需要穿透 Axios 私有错误结构。
5. 只有 Phase 0 为 `DETACH_SUPPORTED` 时才新增 `debuggerDetach`；否则不增加伪 API。

### 验证与发布

```powershell
npm test -- --runInBand
npm run build
git diff --check
```

- 使用本地 link 只做 MCP 集成开发，不进入 MCP 锁文件或公开发布产物。
- 发布下一个正式 semver 版本并记录 tag/commit、取消错误契约和 detach 结论。
- 在 MCP 升级依赖后重新安装并确认 `package-lock.json` 只指向正式版本。

## Phase 2：实现稳定身份、client factory 和生命周期存储

### 修改文件

- 新增 `src/safe/DebugTerminalIdentityProvider.ts`
- 新增 `src/safe/DebugIdentityStore.ts`
- 新增 `src/safe/DebugClientFactory.ts`
- 新增 `src/safe/DebugLifecycleStateStore.ts`
- 新增 `src/safe/DebugSessionRegistry.ts`
- 修改 `src/safe/debugTypes.ts`
- 修改 `src/safe/SafetyPolicy.ts`
- 修改 `src/config/RuntimeGuardrails.ts`（只放资源/关闭超时等运行护栏）
- 修改 `src/index.ts`
- 新增每个组件对应的 `src/__tests__/*.test.ts`

### 任务 2.1：机器级 `terminalId`

先写测试覆盖：

- Windows 注册表值优先于文件。
- 注册表明确不存在时回退到 `~/.SAP/ABAPDebugging/terminalId`。
- 注册表访问错误与“值不存在”分开处理；访问错误关闭失败。
- 非 Windows 只读标准文件路径。
- 首次生成 32 位大写十六进制 UUID 并原子写入。
- 已有值只裁剪首尾空白；空值、控制字符、非 ASCII、超过 128 字符均拒绝。
- 符号链接/重解析点、目录不可写、最小文件权限设置失败、原子替换失败均关闭失败，不在同一启动中生成第二个身份。

实现时把注册表读取、平台、home 目录、随机 UUID 和文件操作作为可注入边界，避免单元测试修改真实用户注册表和 home 文件。

### 任务 2.2：server-instance identity 与 `clientId`

先写测试覆盖：

- 首次创建和重启复用同一 `ideId`。
- identity 文件只含格式版本、`ideId`、`identityPathHash` 和创建时间。
- 规范化绝对路径在 Windows 统一盘符、分隔符和大小写；其他平台保留大小写。
- 文件移动、路径哈希不一致、损坏、符号链接/重解析点或写入失败均关闭失败。
- 目标用户为空时先解析为当前 `SAP_USER`，显式当前用户和空值产生同一 `scopeHash`。
- 相同 scope 与 canonical ADT source URI 产生稳定的 46 字符 `clientId`；不同源码 URI、host、client、用户或 `ideId` 产生不同值。
- URI 规范化移除 line/range fragment，但不把本地路径、显示名或仅文件名作为输入。

### 任务 2.3：client factory 与 registry

`DebugClientFactory` 从同一份已验证连接配置创建三类 client：

- 每个 listener 长轮询：独立 stateless client；不能与查询、删除或断点请求共用。
- listener 查询/删除和 Attach 前的断点创建/删除：每次使用独立的短生命周期 stateless client。
- 每个 debuggee：独立 stateful client。
- 普通 MCP：保留现有共享 client，但不再承担 safe listener 或 Attach session。

测试证明：

- 不同 debuggee 不共享 client、Cookie 或 stateful session。
- listener 取消/关闭不会登出普通 client 或另一个 session client。
- factory 不记录密码、Cookie 或 Authorization header。
- registry 为每个资源持有单一关闭 Promise，多次关闭幂等，但不会把本地关闭报告为远端释放。

### 任务 2.4：持久化最小生命周期摘要

`DebugLifecycleStateStore` 使用审计目录下独立 JSON 文件，采用临时文件加原子替换。覆盖：

- listener 同时按 `listenerId` 和原 `debugOperationPlanId` 查询。
- Attach session 保存 `sessionId`、Attach plan、listener、scope、脱敏 debuggee 摘要、分类、时间和 `cleanupRequired`。
- 启动时所有非终态记录先转 `UNKNOWN`。
- 终态默认保留 24 小时；容量沿用计划容量，不能淘汰活跃/未知恢复记录来制造空间。
- 不保存 AbortController、Cookie、完整变量、完整栈、授权、控制命令或可恢复 Attach 凭据。
- 并发状态迁移串行写入；写入失败使新控制动作关闭失败。

### 接入门槛

- 仅 `development` profile 且 `SAP_MCP_SYSTEM_ROLE=DEV` 时初始化安全调试身份；QAS/PRD 即使误配 `development` profile，也不应因没有 debug identity 而影响只读启动。
- `safe`、`diagnostic-readonly` 和 `legacy-full` 不依赖安全门面的 identity 初始化；DEV `legacy-full` 继续按原始工具契约接收调用方身份。
- `SAP_MCP_DEBUG_IDENTITY_PATH` 为空时固定解析为 `<SAP_MCP_AUDIT_PATH>/debug-identity/identity.json`。
- `SAP_MCP_DEBUG_LISTENER_TTL_SECONDS` 范围 60-3600 秒，默认 900 秒。
- 不修改真实用户 terminal 文件、注册表或审计目录做单元测试。

## Phase 3：实现后台 listener 生命周期和请求取消

### 修改文件

- 新增 `src/safe/DebugListenerManager.ts`
- 修改 `src/safe/DebugControlWorkflow.ts`
- 修改 `src/safe/DebugOperationPlanStore.ts`
- 修改 `src/safe/debugTypes.ts`
- 修改 `src/handlers/SafeDebugHandlers.ts`
- 修改 `src/handlers/DebugHandlers.ts`
- 修改 `src/lib/serverGuardrails.ts`
- 修改 `src/index.ts`
- 新增 `src/__tests__/DebugListenerManager.test.ts`
- 扩展 `DebugControlWorkflow.test.ts`、`DebugOperationPlanStore.test.ts`、`SafeDebugHandlers.test.ts` 和 `serverGuardrails.test.ts`

### 任务 3.1：服务器托管 identity

1. `CREATE_LISTENER`、`DELETE_LISTENER`、`SET_BREAKPOINTS` 和 `DELETE_BREAKPOINT` 不再要求新调用方提供 `terminalId`、`ideId` 或 `clientId`。
2. v0.3.0 暂时接受旧字段，但仅允许与服务器派生值完全一致；不一致返回 `DEBUG_IDENTITY_MISMATCH`。
3. `DELETE_LISTENER` 使用服务器生成的 `listenerId`。无 `listenerId` 的兼容请求只有在当前 scope 恰好存在一个受管理非终态 listener 时才能解析。
4. 计划视图只返回 identity 指纹，不返回可重用的完整身份值。

### 任务 3.2：创建 listener 立即返回

`DebugListenerManager.create` 必须：

1. 在主 gate 内完成策略、identity、冲突预检、唯一性、容量和审计预检查。
2. 原子创建 `LISTENING` 状态、独立 stateless client 和 `AbortController`。
3. 持有并观察后台 `debuggerListen` Promise。
4. 立即返回 `listenerId`、`LISTENING`、到期时间和 identity 指纹。
5. 后台结果先做结构校验，再映射为 `DEBUGGEE_AVAILABLE`、`ENDED_WITHOUT_DEBUGGEE`、`CANCELLED`、`FAILED` 或 `UNKNOWN`。

测试使用可控 deferred Promise 和 fake timer，证明：

- apply 不等待 listener 长轮询结束。
- listener 不占用普通 `ToolExecutionGate`，随后一个普通只读 SAP 调用可以执行。
- 同 scope 第二个 listener 返回 `LISTENER_ALREADY_ACTIVE` 和现有受控摘要。
- 预检后的远端 conflict 进入 `FAILED/LISTENER_CONFLICT`，不重试、不 takeover。
- `undefined` 进入 `ENDED_WITHOUT_DEBUGGEE`，绝不表示捕获成功。
- 非空但缺少 `DEBUGGEE_ID`、用户、client 或关键 identity 的畸形 payload 进入 `UNKNOWN/INVALID_DEBUGGEE_PAYLOAD` 并要求清理，不能进入 `DEBUGGEE_AVAILABLE` 或 Attach。
- 后台拒绝始终被观察，不产生 unhandled rejection。

### 任务 3.3：删除、TTL 和重启恢复

删除顺序固定为：abort 长轮询、等待有界收敛、调用 SAP 删除 listener、只读复查、写入终态和审计。测试覆盖用户删除、TTL、正常退出、取消竞态、删除超时、复查空响应、状态写失败和进程重启。

- TTL 的原始创建确认只授权 listener 清理，不授权 Attach、Continue、Terminate 或变量修改。
- 清理确定完成才进入 `CANCELLED`；无法证明则进入 `UNKNOWN/cleanupRequired`。
- 重启只读核对稳定 identity；不恢复长轮询、不自动 Attach、不自动删除。
- 远端明确不存在时进入 `ENDED_WITHOUT_DEBUGGEE`，原因记录为 `PROCESS_RESTART_NO_REMOTE_LISTENER`，不能伪装成用户删除成功。

### 任务 3.4：传递 MCP 请求 signal

1. `CallToolRequestSchema` handler 改为接收 `(request, extra)`。
2. `executeGuardedToolCall` 和分发链显式传递 `extra.signal`，不通过全局变量保存当前 request signal。
3. 原始 `legacy-full debuggerListen` 保持同步返回契约，但使用当前 MCP request signal。
4. safe 后台 listener 只使用自身 controller；创建请求返回后不能继续绑定原 request signal。
5. 测试证明前台取消释放执行槽，后台 listener 删除释放真实 HTTP，且两类 signal 互不影响。

## Phase 4：重构 Attach、授权、控制和释放协议

### 修改文件

- 修改 `src/safe/DebugControlWorkflow.ts`
- 修改 `src/safe/DebugSessionAuthorizationStore.ts`
- 修改 `src/safe/DebugSessionRegistry.ts`
- 修改 `src/safe/DebugLifecycleStateStore.ts`
- 修改 `src/safe/debugTypes.ts`
- 修改 `src/handlers/SafeDebugHandlers.ts`
- 修改 `src/safe/AuditLogger.ts`
- 扩展对应单元测试

### 任务 4.1：Attach 只能来自已捕获 listener

1. `ATTACH` 预览只接受 `DEBUGGEE_AVAILABLE` 的受管理 listener。
2. 冻结 listener、identity 指纹、host、client、目标用户、debuggeeId、程序、Include 和行号。
3. payload 显示 `IS_ATTACH_IMPOSSIBLE=true`、debuggeeId 缺失或 listener identity 不完整时，在预览阶段拒绝，不创建计划或 stateful client。
4. apply 前重读并逐项比较；任何漂移拒绝，不创建 stateful client。
5. 每个确认后的 debuggee 由 factory 新建独立 stateful client，先注册 `ATTACHING` 再执行 Attach。
6. Attach 连接中断时记录 `UNKNOWN/cleanupRequired`，不自动重试或换 client Attach。

### 任务 4.2：分类为 control 或 inspection

Attach 返回后组合解析 Attach response 的 `isPostMortem`、`isSteppingPossible` 与 listener 已冻结 debuggee payload 中的 dump ID；不能假设 dump ID 一定存在于 Attach response：

- 任一 post-mortem、dump 或 `isSteppingPossible=false` -> `INSPECTION_ONLY`。
- 只有非 post-mortem、无 dump 且明确可 stepping -> `ACTIVE_CONTROL`。
- 字段缺失或响应形状不明不能乐观进入控制态；返回 `UNKNOWN` 或保守 `INSPECTION_ONLY`，并记录缺失证据。

`INSPECTION_ONLY` 只允许经证明不改变远端状态的当前栈、源码位置和变量读取。Step、Continue、run-to-line、go-to-stack、jump-to-line、Terminate 和变量修改全部在客户端调用前拒绝。

### 任务 4.3：授权绑定 session 而不是用户全局

1. `DebugSessionAuthorizationStore` 上下文增加 `sessionId`、listenerId、scopeHash 和分类。
2. 只有 `ACTIVE_CONTROL` 可以创建授权。
3. 授权过期只改变授权状态，session 仍为 `ACTIVE_CONTROL` 并报告 `authorizationExpired: true`。
4. 重新授权必须复核 session、debuggee、用户、client 和当前栈。
5. re-Attach、debuggee 漂移、session 释放/未知、Terminate、重启和显式 revoke 均使授权失效。

### 任务 4.4：逐动作控制和释放证据

- `executeDebugCommand` 每次只处理一个明确命令，并通过对应 session client 串行执行。
- Step/Continue/run-to-line 后重读状态；Continue 到下一断点仍保持 `ACTIVE_CONTROL`。
- jump、Terminate 和每个变量修改继续使用独立计划和原生确认。
- 变量 apply 在同一 session client 上复读 stack 与旧值，任何漂移拒绝。
- 只有 `debuggeeEnded`、确定的 Terminate 结果或只读状态明确不存在该 debuggee 才进入 `RELEASED`。
- timeout、断线、空响应、logout、dropSession 或本地 client close 均进入/保持 `UNKNOWN`。
- 若 Phase 0 为不支持 detach，操作 parser 对 `DETACH` 固定返回 `DEBUG_DETACH_UNSUPPORTED`，不新增成功 detach 工具。

### 任务 4.5：有界关闭

在 `AbapAdtServer` 增加显式、幂等的关闭协调器，顺序为：

1. 停止接受新的调试生命周期创建。
2. 冻结新的 Attach、授权和控制动作，并为每个 session 等待已经取得执行租约的在途命令有界收敛；不通过关闭 client 抢断 Step、Continue、Terminate 或变量修改。
3. abort 所有 listener HTTP。
4. 有界删除并复查 SAP listener。
5. 只读核对 Attach session；在途命令超时或未证明释放的记录写为 `UNKNOWN/cleanupRequired`，且不得自动重放。
6. 关闭 session clients。
7. 关闭普通 ADT client 的本地网络资源；不能把 logout/dropSession 记为 detach。
8. 最后调用 MCP transport `close()`。

session registry 为 Attach、栈/变量读取和控制命令提供同一把逐 session 租约/串行锁；关闭协调器与工具 handler 共享该状态，避免“检查后关闭”竞态。总超时到达后逐项记录未完成资源并退出，不能无限等待，也不能为了清理而自动 Continue、Terminate、dropSession 或修改变量。

## Phase 5：收紧 QAS/PRD 与 `legacy-full` 的服务器级策略

### 修改文件

- 新增 `src/config/ToolOperationPolicy.ts` 或等价局部策略模块
- 修改 `src/config/ToolProfiles.ts`
- 修改 `src/safe/SafetyPolicy.ts`
- 修改 `src/index.ts`
- 扩展 `SafetyPolicy.test.ts`、`SafeAbapHandlers.test.ts` 和 `serverGuardrails.test.ts`
- 新增原始 `DebugHandlers` 的最小契约/取消测试

### 实现要求

1. 用服务器拥有的工具分类表区分 local、read-only、source mutation、debug control 和其他 mutation；不能相信工具 annotations 或调用方声明。每个可注册或可 dispatch 的工具必须恰好归入一类，新增/未知/重复分类在启动和 CI 中关闭失败。
2. `SAP_MCP_SYSTEM_ROLE` 为 QAS/PRD 时，所有 profile 只能执行 local/read-only 工具。缺失或非法 role 不能被解释为 DEV，最多只允许 local/read-only。安全 apply 已有策略仍保留，不能作为唯一防线。
3. 非 DEV 的 `legacy-full` 工具目录不宣传原始写入/调试控制；即使旧客户端直接调用被隐藏名称，dispatch 仍以 `POLICY_DENIED` 拒绝。
4. DEV `legacy-full` 保留原始工具名、参数和正常返回契约；只为 `debuggerListen` 增加 request signal 传递，不包裹安全计划。
5. QAS/PRD 允许的调试读取仅为 `debuggerListeners`、`debuggerStackTrace`、`debuggerVariables` 和 `debuggerChildVariables` 等明确白名单；创建/删除 listener、断点、Attach、设置、Step/Continue、栈控制和变量修改全部拒绝。
6. QAS/PRD 源码读取保持允许，源码/对象/传输/trace/配置/数据写入不能通过 `legacy-full` 绕过。

### 对抗性测试

建立 profile x role 表驱动测试，至少覆盖 `safe/development/diagnostic-readonly/legacy-full` 与 `DEV/QAS/PRD`：

- QAS/PRD raw `debuggerAttach`、`debuggerStep`、`debuggerSetVariableValue` 未调用底层 client。
- QAS/PRD raw `setObjectSource`、对象创建/删除、transport release 和 trace 配置未调用底层 client。
- stale catalog 名称直调仍被 dispatch 拒绝。
- 注册目录、dispatch switch 与分类表做集合相等测试；漏分类或仅隐藏但仍可直调的工具使测试失败。
- 缺失/非法 system role 下任意 source/debug/other mutation 均未调用底层 client。
- DEV `legacy-full` 的现有正常返回结构不变。
- `diagnostic-readonly` 的工具数量和白名单由源码动态核对，不只断言一个容易过期的总数。

## Phase 6：MCP 工具契约、配置、文档与版本

### 修改文件

- 修改 `.env.example`
- 修改 `README.md`
- 修改 `README.zh-CN.md`
- 修改 `docs/使用指南.md`
- 修改 `CHANGELOG.md`
- 修改 `package.json`、`package-lock.json` 和 `server.json`
- 必要时修改 `AGENTS.md` 中已经过期的自动化基线

### 文档内容

1. 新增 identity path、listener TTL、标准 terminalId 来源和多用户 allow-list 示例。
2. 用最终注册代码重新统计各 profile 工具数量；不沿用 v0.2.0 数字。
3. 给出 CREATE listener -> 用户外部触发 -> status -> Attach -> 分类 -> 授权 -> 单动作 -> 释放核对 -> listener/断点清理的完整中文示例。
4. 明确 MCP 可以脱离插件单独使用，即使插件不传 workspace 也能维持安全身份；需要隔离多个实例时再显式配置不同 identity path。
5. 明确 post-mortem/dump 是 `INSPECTION_ONLY`，active debug 是最后手段。
6. 明确不支持 detach 时的三个事实：不自动 Continue，不用 logout/dropSession 伪造释放，未知结果需要人工清理。
7. 区分自动化 fake-ADT、底层取消集成测试、真实 DEV、QAS/PRD 只读验证和未验证项。
8. 同步 source-built/publication 现状；只有 npm/Registry 真实发布后才给安装命令。
9. 明确 `SAP_MCP_SYSTEM_ROLE` 是部署方声明的信任边界，服务器不能自动推断真实景观角色；每个实例必须显式配置 role、host/client allow-list，并通过 healthcheck/启动摘要核对，不能把误标为 DEV 的 PRD 描述成服务器可自动识别。

### 版本

- MCP 目标版本：`0.3.0`。
- `server.json`、package metadata、README 与 tag 必须一致；不能让未来发布字段冒充已发布事实。
- `abap-adt-api` 精确依赖版本和 lockfile integrity 必须来自 Phase 1 正式发布。

## Phase 7：升级一个插件中的三个 Skill

本阶段修改 `D:\MyDev\SAP\sap-abap-adt-workbench`。该目录当前不是 Git 仓库；实施前先由用户确认公开仓库位置或初始化策略，不能把 MCP 仓库的 commit 当作插件版本历史。

### 插件与共享参考

修改：

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `README.md`
- `references/mcp/safe-debug-workflow.md`
- `references/mcp/profile-capabilities.md`
- `references/shared/safety-boundaries.md`
- `references/shared/environment-routing.md`
- `references/shared/evidence-and-handoff.md`（仅增加 listener/session handoff 字段）
- `scripts/validate-mcp-contract.mjs`
- `evals/README.md`
- `evals/cross-skill-routing.json`

目标公开版本为 `0.2.0`。本地 Codex 迭代时使用 `plugin-creator` 的 cachebuster helper，只替换 `+codex.<token>`，不手改 marketplace，也不靠递增正式 semver 刷缓存。

### `sap-abap-development`

修改：

- `skills/sap-abap-development/SKILL.md`
- `skills/sap-abap-development/evals/evals.json`
- `skills/sap-abap-development/evals/trigger-evals.json`

要求：

- 默认顺序固定为静态源码、ST22/SM21、业务数据/现有状态，证据不足且用户明确要求时才进入 DEV active debug。
- 写清 listener 创建立即返回、外部请求必须由用户触发、状态轮询、Attach 身份核对和 `ACTIVE_CONTROL/INSPECTION_ONLY` 分流。
- 每个 listener、断点、Attach、设置、Jump、Terminate 和变量修改遵守对应计划/确认边界；Step/Continue 每次只执行一个明确命令。
- 不建议自动循环、自动重连、takeover、自动请求重放或用 logout/dropSession detach。
- QAS/PRD 只读，即使用户要求改 profile 或调用 raw tool 也不绕过。

### `sap-system-operations-diagnosis`

修改：

- `skills/sap-system-operations-diagnosis/SKILL.md`
- `skills/sap-system-operations-diagnosis/evals/evals.json`
- `skills/sap-system-operations-diagnosis/evals/trigger-evals.json`

要求：

- 保持 ST22、SM21、连接、权限、版本和现有调试状态的只读责任。
- handoff 带上 dump ID、时间、时区、用户、client、程序、Include、行号、post-mortem/dump/stepping 证据。
- post-mortem handoff 明确进入 `INSPECTION_ONLY`，不能建议 Continue、Terminate、栈控制或变量修改。
- 需要 active DEV debug 时交给 development，不在 operations 内创建 listener 或 Attach。

### `sap-business-data-diagnosis`

修改：

- `skills/sap-business-data-diagnosis/SKILL.md`
- `skills/sap-business-data-diagnosis/evals/evals.json`
- `skills/sap-business-data-diagnosis/evals/trigger-evals.json`

要求：

- 仍只读查询 DDIC/业务数据，不自行调试。
- 当数据证据指向动态代码路径时，handoff 精确业务键、时间、client、调用/接口线索和已排除假设。
- 不声称 Skill 可以自动重放业务请求；触发动作仍由用户在受控 DEV 外部执行。

### Skill 与插件评测

至少新增以下离线/路由案例：

1. 用户只问 dump 根因，没有明确要求 debug，保持只读。
2. DEV 明确请求创建 listener，说明立即返回和用户外部触发，不声称已捕获。
3. listener `ENDED_WITHOUT_DEBUGGEE` 不被解释为成功。
4. listener 返回畸形或 `IS_ATTACH_IMPOSSIBLE` 的 debuggee 时不进入 Attach。
5. Attach 结果为 post-mortem/dump/不可 stepping，只做 inspection。
6. QAS/PRD 或 `legacy-full` 绕过请求被拒绝。
7. 用户要求自动连续 Continue、自动 takeover 或退出时 Continue，被拒绝。
8. 用户要求 detach，明确当前是否支持；不建议 logout/dropSession。
9. 授权过期后 session 仍在，不宣称已释放。
10. operations -> development 和 business-data -> development handoff 不重复收集已有证据。
11. 同为 ST22，运行责任域/日志关联请求路由 operations，源码根因/修复请求路由 development。

执行 `skill-creator` 评测循环：

1. 修改 Skill 前先把当前 `0.1.0` 三个 Skill 和共享参考快照到插件目录之外的评测 workspace，避免基线被本轮编辑覆盖或进入插件发布包。
2. 更新三个 Skill 的 `evals/evals.json` 和 `trigger-evals.json`，并同步 cross-skill routing eval。
3. 对每个新增行为做 with-skill 与旧版快照对照运行；同一轮同时启动成对样本并记录 timing。
4. 生成客观 assertions，保存 grading 和 benchmark。
5. 使用 `eval-viewer/generate_review.py --static ...` 生成评审页面，由用户审阅后再迭代。
6. 不把静态 eval 定义或模型输出冒充真实 SAP 验证。

插件验证：

```powershell
node scripts/validate-mcp-contract.mjs ..\mcp-abap-abap-adt-api
python C:\Users\068157\.codex\skills\skill-creator\scripts\quick_validate.py skills\sap-abap-development
python C:\Users\068157\.codex\skills\skill-creator\scripts\quick_validate.py skills\sap-business-data-diagnosis
python C:\Users\068157\.codex\skills\skill-creator\scripts\quick_validate.py skills\sap-system-operations-diagnosis
python C:\Users\068157\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .
```

本地安装验证使用 `update_plugin_cachebuster.py` 和既有本地 marketplace 名称重新安装，然后在新任务中测试；不手改 marketplace 文件。

## Phase 8：完整自动化与真实 DEV 验收

### MCP 自动化

```powershell
npm test -- --runInBand
npm run build
git diff --check
```

另外执行：

- Markdown 本地链接检查。
- 旧版本、旧工具数量、旧 listener 同步语义和 `detach=logout/dropSession` 禁止词审计。
- `rg` 核对所有 raw debug/write handler 都经过服务器级非 DEV 策略；CodeGraph 只用于定位，不作为完整性证明。
- 用集合测试证明注册目录、dispatch 与工具分类完全一致，并覆盖缺失/非法 system role 的默认只读行为。
- 使用假 HTTP server 证明 AbortSignal 真实中止网络请求，而不只是让上层 Promise 提前返回。
- 检查进程关闭时在途 session 命令有界收敛或记为 `UNKNOWN`，关闭后没有活动 timer、未观察 Promise 或打开的 listener/session client。

### 真实 DEV 验收前置条件

- 用户再次明确授权本次真实调试控制。
- 使用专用、无副作用、可恢复测试资产和允许用户。
- 用户负责从 SAP 外部正常触发 HTTP/RFC/OData 请求；MCP 不自动重放。
- 展示精确断点、listener TTL、debug 用户、测试程序/Include 和清理步骤。
- QAS/PRD 不执行任何控制验证。

### 真实 DEV 顺序

1. 验证标准 `terminalId`、持久化 `ideId` 和 source-scoped `clientId` 的稳定性。
2. 设置专用断点并复读确认所有权。
3. 创建 listener，确认立即返回 `LISTENING`。
4. listener 等待期间执行一个普通只读 ADT 调用，证明主 gate 未被占用。
5. 用户外部触发请求，轮询到 `DEBUGGEE_AVAILABLE`。
6. 预览并原生确认 Attach，核对用户、client、程序、Include 和行号。
7. active 样本进入 `ACTIVE_CONTROL`；受控 dump 样本进入 `INSPECTION_ONLY`。
8. 对 active session 授权并读取栈/变量。
9. 用户明确要求后只执行一次 Step；复读新栈。
10. 用户明确要求一次 Continue，或独立确认 Terminate；只读复查取得明确释放证据。若 Continue 停在下一个断点则保持 `ACTIVE_CONTROL` 并停止验收，不自动继续；完整释放路径应使用预先设计为一次 Continue 后自然结束的无副作用样本。
11. 验证授权 revoke、listener 删除、断点删除和状态复查。
12. 重启 MCP，确认旧授权不恢复，非终态摘要先进入 `UNKNOWN`，且没有自动 Attach/删除/Continue。

跳转、Terminate 和变量修改保留能力，但只有专用无副作用 debuggee 准备完成并逐项得到明确授权时才做真实验证。不能为了发布覆盖率在真实业务事务上强行执行。

## 提交与发布策略

### `abap-adt-api`

1. 协议研究文档与代码分开提交。
2. AbortSignal/API、测试和文档作为聚焦提交。
3. 通过上游 CI 后发布正式版本并记录 tag/commit。

### `mcp-abap-abap-adt-api`

1. 本实施计划单独提交。
2. identity/client factory/store、listener、Attach/policy 可按可独立验证的阶段提交；每个提交必须保持 build 和相关测试通过。
3. 版本/README/使用指南只在最终工具目录和契约冻结后提交。
4. 不提交、删除或修改现有未跟踪 `.claude/`。
5. 发布 `v0.3.0` 前执行完整自动化和已授权的真实 DEV 验收；真实未执行项必须如实标记。

### `sap-abap-adt-workbench`

1. 先确认/建立其独立 Git 仓库和公开发布目标。
2. 三个 Skill、共享参考、eval、manifest 和 README 作为一个可审查版本提交。
3. 本地 cachebuster 只用于 Codex 刷新，不替代正式 `0.2.0` tag。
4. 公开发布前保留 GPL-3.0、THIRD-PARTY-NOTICES 和 `sap-skills` 来源/借鉴说明，不复制私有连接、账号或业务数据。

## 完成标准

- listener 的底层 HTTP 可以被真实取消，创建后立即返回且不占主 SAP gate。
- `undefined`、冲突、取消、失败和未知结果各有不同状态。
- `terminalId`、`ideId` 和 `clientId` 来源稳定、边界明确且无敏感持久化。
- listener/断点、每个 Attach debuggee 和普通 MCP 分别使用正确 client 生命周期。
- Attach 只来自受管理 listener，漂移会拒绝；post-mortem/dump/不可 stepping 只能 inspection。
- 授权绑定具体 session，过期不等于 session 释放。
- 没有真实 detach 时明确拒绝；没有明确远端证据时保持 `UNKNOWN/cleanupRequired`。
- 正常退出、TTL、重启和异常均不会自动重连、Attach、Continue、Terminate、dropSession 或修改变量。
- 正常退出不会抢断在途控制动作；超时或结果不确定时只记为 `UNKNOWN/cleanupRequired`，不自动重放。
- QAS/PRD 以及缺失/非法 system role 在所有 profile 下源码和调试都只读，`legacy-full` 不能绕过；工具漏分类时关闭失败。
- MCP 可独立使用；插件仍是一个插件、三个职责清晰的 Skill。
- MCP 自动化、底层取消测试、插件 eval 和真实 DEV 证据分别报告，不互相替代。
