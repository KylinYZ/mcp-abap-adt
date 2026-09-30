# 分级执行门设计（分域双会话：read-only 并发 / 写入串行）

- 日期：2026-09-30
- 状态：设计已获用户批准（2026-09-30 会话，含分域双客户端修订），进入实施
- 背景事故：2026-09-30 上午 sap-demo `classComponents` 并行双超时——偶发慢请求 × 全局串行门排队 × MCP 客户端 30 秒计时（含排队时间）三者放大；当日复测同 URL 均秒回，定性偶发非缺陷，但暴露了全局串行门的易用性问题
- 用户要求：尽可能向 VSP 靠拢，更多考虑易用性；采用 VSP 式**分域多会话**模型（读写各自独立 SAP 会话）

## 1. 目标与非目标

**目标**：单 MCP 进程内，

- `read-only` 类工具（objectStructure、classComponents、getObjectSource、runQuery、searchObject 等 150+ 个）走独立**读槽**（默认并发 2）与独立**读域会话**（永远 stateless）；
- 写入/锁链/调试类工具保持**写槽**串行（=1）与独立**写域会话**（按需 stateful）；
- 受控链 preview → apply 的互斥语义零变化。

**非目标**：

- 跨进程共享门。多 MCP 进程（sap-adt / sap-dev / sap-demo）之间的写互斥完全依赖 SAP 全局对象锁与传输登记锁，进程内门只治理自己进程内的流量。
- `local` 类工具（healthcheck、各受控链 status、analyzeDependencyGraph 等）继续不过 SAP 门，行为不变。
- 不新增工具、不改变任何工具的入参/返回结构/可见 profile。

## 2. 设计原则（向 VSP 靠拢，易用性优先）

VSP 的会话模型是直接参照：按语义域（debug 域、amdp 域）分配长连接，域内共享、懒创建、断线自动重建，**调用方完全不感知连接管理**。本设计沿用同一思想并推广到 HTTP 会话与执行槽：

1. **调用方零感知**：槽位与会话路由完全自动（按工具既有操作分类），agent 不需要知道门与会话域的存在，工具入参与返回结构零变化。
2. **默认即优化**：部署者零配置即获得收益（读槽默认并发 2）；想调整只动一个环境变量。
3. **分域资源隔离**：读写各持独立会话与独立槽位——与 VSP 的 debugWS/amdpWS 各持一条连接（Basic Auth 下各一 SAP 会话）同构。
4. **失败可读**：读槽打满时 429 错误消息明确告知原因与重试时机，不是裸超时。

## 3. 架构总览：双域客户端 + 双槽

核心变化：ADT 客户端从**单例单会话**改为**双域双会话**（分域是本设计的地基，槽位叠加在其上）：

| 域 | SAP 会话 | 会话模式 | 创建时机 | 服务对象 |
|---|---|---|---|---|
| 读域 | 恒 1 个 | **永远 stateless** | 懒创建：首个读请求才登录 | 读槽（read-only 类工具） |
| 写域 | 0–1 个 | 按需 stateful（锁链域内闭环：LOCK→PUT→UNLOCK 同一会话） | 懒创建：首个写操作才登录；无写操作则整进程不创建 | 写槽（写入/锁链/调试/受控 apply） |

- **结构性隔离**：读请求物理上到不了写会话；写会话在写域内串行（写槽=1）——两边都不存在"并发打同一 SAP 会话"的情形。这取代了单客户端方案下"stateless 头 + stateful cookie 大概率无害"式的论证。
- **认证**：bearer/SSO 模式下两域共享同一 token（对应 VSP `applyWSAuth` 取 REST 存活 cookie 的语义）；Basic Auth 下两域各自登录，即两个独立 SAP 会话（对应 VSP 的 WS 独立会话形态）。
- **keepalive**：两域各自实例内置现有 120 秒心跳，互不影响。
- **进程内 SAP 会话数**：常态 1（仅读域），有写操作时最多 2——与 VSP"cookie 模式 1 / 多域最多 3"同类形态。

## 4. 门结构

保留现有 `ToolExecutionGate` 类不动（干净的信号量：`run()` + FIFO 队列 + 429 背压），实例从 1 个变 2 个，**槽与域绑定**：

| 槽 | 配置变量 | 默认 | 范围 | 覆盖规则 |
|---|---|---|---|---|
| 写槽（绑写域） | `SAP_MCP_MAX_CONCURRENT_TOOLS` | 1 | 1–8 | 分类为 source-mutation / debug-control / advanced-mutation / other-mutation 等非 read-only 且未豁免的 SAP 工具（语义收窄：从"全局门"变为"写槽门"） |
| 读槽（绑读域） | `SAP_MCP_MAX_READ_CONCURRENT_TOOLS`（新增） | 2 | 1–8 | `read-only` 类全部工具（含 previewXxx 受控预检、previewQualityCheck 等只读语义工具） |

（质量执行类内部：previewQualityCheck 属 read-only 类走读槽；runQualityCheck 在豁免清单不过门。）

- 两槽独立排队、独立 429 背压（队列上限共用现有 `SAP_MCP_MAX_QUEUED_TOOLS`）。
- **读写互不占对方槽、互不串会话**：写操作执行（写域 stateful）时，读槽照常在读域服务。
- **豁免清单不变**：`usesSapExecutionGate` 现有豁免（确认型 apply 防自我死锁、本地 status 工具、healthcheck/sapDoctor/sap 外层豁免）原样保留；确认型 apply 在确认层内部自持**写槽**（`applyConfirmed` 等内部调用点指向写槽实例 + 写域客户端），互斥语义与今天一致。

## 5. 分类复用与 sap 委托链

- **槽与会话路由复用现有分类**：`toolOperationClass()`（`src/config/ToolOperationPolicy.ts`）——`read-only` → 读槽+读域，其余 SAP 类 → 写槽+写域，`local` 与豁免 → 不过门（读域/写域皆不触碰）。不新造分类体系。启动期 `CLASSIFIED_TOOL_NAMES` 校验已保证无未分类工具；代码兜底：分类缺失按**写槽+写域**处理（保守方向）。
- **`sap` 任务工具是唯一语义修正点**：`sap` 归在 read-only 类但可委托写 action。它外层豁免门，内部委托回调 `executionGate.run(() => dispatchTool(toolName, ...))`（`src/index.ts:875`）今天无差别占全局槽、走单客户端——分级后该回调按**被委托工具**的分类路由：委托 getObjectSource → 读槽+读域；委托 edit 类 → 写槽+写域。回调已携带 toolName，改动局部。

## 6. 分域实施方式（AdtClient 双实例）

- `AdtClient` 类保留，新增构造参数 `domain: 'read' | 'write'`：
  - **读域实例**：`stateful` setter 抛错（类型层锁死"读域永不 stateful"，测试断言点）；
  - **写域实例**：现有 stateful 切换逻辑原样（写路径 handler 已显式 `stateful = stateful`）。
- **handlers 按语义注入对应域实例**（装配集中在 `src/index.ts`）：
  - 纯写 handler（ObjectLockHandlers、ObjectDeletionHandlers、MessageTextHandlers、DdicHandlers、受控链 SafeAdvanced 等）→ 注入写域；
  - 纯读 handler（ClassHandlers、QueryHandlers、FeedHandlers、DiscoveryHandlers、ATC/Trace/Revision 等分析类）→ 注入读域；
  - 混合 handler（ObjectSourceHandlers：读源+写源；SafeAbapHandlers：受控链 preview 读 + apply 写；TransportHandlers：查询+受控创建/清理）→ 持双引用，方法内按读/写语义选用。
- **SessionSupervisor 绑写域**：stateful 会话恢复语义只对写域有意义（读域无状态可恢复）。
- **AuthHandlers（logon/logoff/dropSession）**：作用于两域（实施时按现有语义映射，logoff 两域都清）。

## 7. 多进程（多 MCP 会话）边界

多 MCP 进程是既成事实（sap-adt / sap-dev / sap-demo 三个 server 常驻）。会话数按进程类型分述：

| 进程 | SAP 会话数 | 说明 |
|---|---|---|
| 本仓库（纯 REST，分域后） | 常态 1、最多 2 | 读域恒 1；写域懒创建 0–1 |
| sap-adt（VSP） | cookie 模式 1（REST+两条 WS 共享）；Basic Auth 模式最多 3（REST/debugWS/amdpWS 各一） | — |

- 跨进程写互斥：依赖 SAP 全局对象锁（ENQUEUE）与传输登记锁，结果安全但另一进程会收到锁冲突错误；受控链 plan 状态机进程本地，不跨进程防重。
- 纪律（不做产品化）：改源码/`.env`/`dist` 后所有 MCP 客户端全部硬重启（版本漂移是多会话最实际的坑）；不同进程不并发写同一对象。不做跨进程文件锁——SAP 全局锁已兜底写安全。

## 8. 与 VSP 会话模型的对照

| 维度 | VSP（sap-adt） | 本设计 |
|---|---|---|
| 隔离维度 | 语义域（debug / amdp）各持一条 WS 长连接 | 操作类别（读 / 写）各持一个 HTTP 会话 + 一个并发槽 |
| 调用方感知 | 零感知，域连接懒创建、断线重建 | 零感知，槽与会话按分类自动路由、懒创建 |
| 会话模式 | Basic Auth 下各域独立 SAP 会话；cookie 模式共享 | Basic Auth 下读写独立 SAP 会话；bearer/SSO 共享 token |
| 进程内会话数 | cookie 1 / Basic Auth 最多 3 | 常态 1 / 最多 2 |
| 进程间 | 不共享，写互斥依赖 SAP 全局锁 | 同 |

## 9. 测试与验证

- **单测**（新增/改造）：
  - 分域：读域实例 `stateful` setter 抛错；写域懒创建（无写操作不触发第二次登录，以登录计数断言）；写域 stateful 期间读域照常服务（交叉隔离）。
  - 槽隔离：读槽并发进行时写操作正确排队；写槽占用时读槽照常服务；两槽 429 背压独立。
  - `sap` 委托链：按被委托工具分类路由（读 action → 读槽读域、写 action → 写槽写域）。
  - 豁免零变化：现有 gate 相关测试全数保留并通过；确认型 apply 内部自持写槽的死锁防护回归。
- **配置**：`SAP_MCP_MAX_READ_CONCURRENT_TOOLS` 边界校验（1–8、非整数报错），与 `RuntimeGuardrails` 既有模式一致。
- **回归**：179 suites / 1926 tests 全绿；`npm run build`；`npm run check:repository-creation-coverage`；`git diff --check`。
- **真机验证**（明确授权后，sap-demo.env）：① 并行发 `classComponents`×2 实测读槽并发生效（与事故场景对照）；② 一次受控链 preview → apply 走通验证写域写槽语义回归；③ 读域并发期间无第二次 SAP 登录。

## 10. 审计与日志

门排队/占用与域会话事件（懒创建、stateful 切换）写入现有 debug 日志（`SAP_MCP_LOG_LEVEL=debug` 可见槽别、域别、等待时长），不新增审计文件——门是流量治理不是安全边界，安全边界仍是 profile 分层 + 确认链。

## 11. 实施范围（文件清单）

| 文件 | 改动 |
|---|---|
| `src/config/RuntimeGuardrails.ts` | 新增 `maxReadConcurrentTools` 配置（含边界校验） |
| `src/lib/serverGuardrails.ts` | `executeGuardedToolCall` 的 `useSapGate: boolean` 改为槽选择 `'none' \| 'read' \| 'write'`；`usesSapExecutionGate` 保留 |
| `src/adt/AdtClient.ts` | 新增 `domain` 构造参数；读域禁 stateful |
| `src/index.ts` | 双门实例、双域客户端装配、handlers 按语义注入、`sap` 委托回调按分类路由、确认链内部调用点指向写槽 |
| `src/handlers/*`（混合型） | ObjectSourceHandlers / SafeAbapHandlers / TransportHandlers 等持双域引用，方法内按语义选用 |
| `src/lib/ToolExecutionGate.ts` | 不动 |
| 测试 | RuntimeGuardrails、gate 分级、分域隔离、FocusedTask 委托、现有 gate 测试回归 |

**版本与文档**：CHANGELOG 记录行为变化与配置项；`docs/使用指南.md` 补充两个环境变量说明；`AGENTS.md` 安全边界表述更新为"写入走写域串行槽、只读走读域并发槽（默认 2）、读写分域独立 SAP 会话"。
