# 分级执行门设计（read-only 并发 / 写入串行）

- 日期：2026-09-30
- 状态：设计已获用户批准（2026-09-30 会话），进入实施
- 背景事故：2026-09-30 上午 sap-demo `classComponents` 并行双超时——偶发慢请求 × 全局串行门排队 × MCP 客户端 30 秒计时（含排队时间）三者放大，两调用双双超时；当日复测同 URL 均秒回，定性偶发非缺陷，但暴露了全局串行门的易用性问题
- 用户要求：尽可能向 VSP 靠拢，更多考虑易用性

## 1. 目标与非目标

**目标**：单 MCP 进程内，`read-only` 类工具（objectStructure、classComponents、getObjectSource、runQuery、searchObject 等 150+ 个）走独立并发槽；写入/锁链/调试类工具保持全局串行；受控链 preview → apply 的互斥语义零变化。

**非目标**：

- 跨进程共享门。多 MCP 进程（sap-adt / sap-dev / sap-demo）之间的写互斥完全依赖 SAP 全局对象锁与传输登记锁，进程内门只治理自己进程内的流量，两层边界清晰、互不感知。
- `local` 类工具（healthcheck、各受控链 status、analyzeDependencyGraph 等）继续不过 SAP 门，行为不变。
- 不新增工具、不改变任何工具的入参/返回结构/可见 profile。

## 2. 设计原则（向 VSP 靠拢，易用性优先）

VSP 的会话模型给了直接参照：按语义域（debug 域、amdp 域）分配长连接，域内共享、懒创建、断线自动重建，**调用方完全不感知连接管理**。分级门沿用同一思想：

1. **调用方零感知**：槽位路由完全自动（按工具的既有操作分类），agent 不需要知道门的存在，工具入参与返回结构零变化，不需要改任何使用习惯或提示词。
2. **默认即优化**：部署者零配置即获得收益（读槽默认并发 2）；想调整只动一个环境变量。
3. **分域资源隔离**：资源按语义类别隔离（读/写两槽），而非全局一把锁——与 VSP 按域分连接同构，是把项目既有实践推广到执行门。
4. **失败可读**：读槽打满时 429 错误消息明确告知原因与重试时机，不是裸超时。

## 3. 门结构

保留现有 `ToolExecutionGate` 类不动（它是干净的信号量：`run()` + FIFO 队列 + 429 背压），实例从 1 个变 2 个：

| 槽 | 配置变量 | 默认 | 范围 | 覆盖规则 |
|---|---|---|---|---|
| 写槽 | `SAP_MCP_MAX_CONCURRENT_TOOLS` | 1 | 1–8 | 分类为 source-mutation / debug-control / advanced-mutation / other-mutation 等非 read-only 且未豁免的 SAP 工具（语义收窄：`SAP_MCP_MAX_CONCURRENT_TOOLS` 从"全局门"变为"写槽门"） |
| 读槽 | `SAP_MCP_MAX_READ_CONCURRENT_TOOLS`（新增） | 2 | 1–8 | `read-only` 类全部工具（含 previewXxx 受控预检、quality 类 previewQualityCheck 等只读语义工具） |

（质量执行类内部：previewQualityCheck 属 read-only 类走读槽；runQualityCheck 在豁免清单不过门。）

- 两槽独立排队、独立 429 背压（队列上限共用现有 `SAP_MCP_MAX_QUEUED_TOOLS`）。
- **读写互不占对方槽**：一个写操作执行时，读槽照常服务；反之亦然。唯一的跨槽约束是它们最终共享同一个 ADT HTTP 客户端（见第 5 节安全性论证）。
- **豁免清单不变**：`usesSapExecutionGate` 现有豁免（确认型 apply 防自我死锁、本地 status 工具、healthcheck/sapDoctor/sap 外层豁免）原样保留。确认型 apply 在确认层内部自持**写槽**（`applyConfirmed` 等内部 `executionGate.run` 调用点改指写槽实例），互斥语义与今天完全一致。

## 4. 分类复用与 sap 委托链

- **槽选择复用现有分类**：直接使用 `toolOperationClass()`（`src/config/ToolOperationPolicy.ts`），`read-only` → 读槽，其余 SAP 类 → 写槽，`local` 与豁免 → 不过门。不新造分类体系，避免两套分类漂移。启动期 `CLASSIFIED_TOOL_NAMES` 校验已保证无未分类工具；代码兜底：分类缺失按**写槽**处理（保守方向）。
- **`sap` 任务工具是唯一语义修正点**：`sap` 归在 read-only 类但可委托写 action。它外层豁免门（`usesSapExecutionGate('sap') = false`），内部委托走注入回调 `executionGate.run(() => dispatchTool(toolName, ...))`（`src/index.ts:875`）——今天是无差别占全局槽，分级后该调用点必须按**被委托工具**的分类选槽：委托 getObjectSource 占读槽，委托 edit 类占写槽。回调已携带 toolName，改动局部。

## 5. 并发读安全性论证

读槽并发（默认 2）之所以安全，逐点核对：

- **login 单飞已存在**：`AdtHTTP.loginPromise` 复用机制保证并发请求不会触发多次登录；无重复认证、无 cookie 竞态窗口。
- **CSRF token 回填并发无害**：`FETCH_CSRF_TOKEN` 机制下首个响应回填，stateless GET 不依赖该头，并发下最多多取一次。
- **cookie 更新并发无害**：`updateCookies` 按响应各自 set 同一会话的 cookie，stateless 会话下顺序无关。
- **read-only 类全程 stateless**：这是分类的既有约定。新增一条测试断言固化——read-only 集合内工具不得切 stateful 会话（防止未来有人把 stateful 工具误挂进 read-only 分类后并发踩锁）。
- **keepalive 定时器**与并发读请求同时飞行：stateless 下 `compatibility/graph` 心跳与业务请求无冲突。

## 6. 多进程（多 MCP 会话）边界

多 MCP 进程是既成事实（sap-adt / sap-dev / sap-demo 三个 server 常驻，各自独立进程、独立 SAP 登录会话）。边界按进程类型分述：

| 进程 | SAP 会话数 | 说明 |
|---|---|---|
| 本仓库（纯 REST） | 恒 1 | 单 AdtHTTP 客户端、单会话；分级门治理进程内读并发 |
| sap-adt（VSP） | cookie 模式 1（REST+两条 WS 共享）；Basic Auth 模式最多 3（REST/debugWS/amdpWS 各一） | cookie 共享模式下 REST 锁链与 WS 调试上下文同会话，边调试边跑写链会互相干扰——**调试会话别和写链混在 sap-adt 一个进程里同时跑** |

- 跨进程写互斥：依赖 SAP 全局对象锁（ENQUEUE）与传输登记锁，结果安全但另一进程会收到锁冲突错误；受控链 plan 状态机进程本地，不跨进程防重。
- 纪律（不做产品化）：改源码/`.env`/`dist` 后所有 MCP 客户端全部硬重启（版本漂移是多会话最实际的坑）；不同进程不并发写同一对象。不做跨进程文件锁——SAP 全局锁已兜底写安全。

## 7. 与 VSP 会话模型的对照

| 维度 | VSP（sap-adt） | 本设计 |
|---|---|---|
| 隔离维度 | 语义域（debug / amdp）各持一条 WS 长连接 | 操作类别（读 / 写）各持一个并发槽 |
| 调用方感知 | 零感知，域连接懒创建、断线重建 | 零感知，槽路由按分类自动完成 |
| 进程间 | 不共享，各自独立 SAP 会话 | 不共享，写互斥依赖 SAP 全局锁 |
| 会话关系 | WS 与 REST 可共享同一 SAP 会话（cookie 模式） | 单 REST 会话，读并发共享该会话（stateless 安全，见第 5 节） |

## 8. 测试与验证

- **单测**（新增/改造）：
  - 两槽隔离：读槽并发进行时写操作正确排队；写槽占用时读槽照常服务。
  - 429 背压：两槽队列上限独立生效。
  - `sap` 委托链：按被委托工具分类选槽（读 action → 读槽、写 action → 写槽）。
  - 豁免零变化：现有 gate 相关测试全数保留并通过；确认型 apply 内部自持写槽的死锁防护回归。
  - read-only 分类不切 stateful 会话的断言。
- **配置**：`SAP_MCP_MAX_READ_CONCURRENT_TOOLS` 边界值校验（1–8、非整数报错），与 `RuntimeGuardrails` 既有模式一致。
- **回归**：179 suites / 1926 tests 全绿；`npm run build`；`npm run check:repository-creation-coverage`；`git diff --check`。
- **真机验证**（明确授权后，sap-demo.env）：① 串行发 `classComponents`×2 实测读槽并发生效；② 一次受控链 preview → apply 走通验证写槽语义回归。与本次超时事故同场景对照。

## 9. 审计与日志

门排队/占用写入现有 debug 日志（`SAP_MCP_LOG_LEVEL=debug` 可见槽别、等待时长），不新增审计文件——门是流量治理不是安全边界，安全边界仍是 profile 分层 + 确认链。

## 10. 实施范围（文件清单）

| 文件 | 改动 |
|---|---|
| `src/config/RuntimeGuardrails.ts` | 新增 `maxReadConcurrentTools` 配置（含边界校验） |
| `src/lib/serverGuardrails.ts` | `executeGuardedToolCall` 的 `useSapGate: boolean` 改为槽选择（读/写/豁免）；`usesSapExecutionGate` 保留 |
| `src/index.ts` | 门实例 1→2；`tools/call` 装配传槽选择；`sap` 委托回调按分类选槽；确认链内部 `applyConfirmed` 等调用点指向写槽 |
| `src/handlers/FocusedTaskHandlers.ts` | 委托回调签名不变（已携带 toolName），槽选择在回调实现内完成 |
| `src/lib/ToolExecutionGate.ts` | 不动 |
| 测试 | `RuntimeGuardrails`、gate 分级、FocusedTask 委托、现有 gate 测试回归 |

**版本与文档**：CHANGELOG 记录行为变化与配置项；`docs/使用指南.md` 补充两个环境变量说明；`AGENTS.md` 安全边界的"真实 SAP 调用保持串行"表述更新为"写入串行、只读按读槽并发（默认 2）"。
