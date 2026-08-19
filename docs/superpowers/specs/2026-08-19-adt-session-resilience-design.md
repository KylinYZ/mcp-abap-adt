# ADT 会话自愈与凭据边界设计

日期：2026-08-19

状态：待用户审阅

## 1. 背景与现状

MCP 进程在 `src/index.ts` 中创建一个共享的 `ADTClient`，并固定设置为 `stateful`。SAP GUI 的登录状态与该 HTTP 客户端的 Cookie、CSRF Token 和 ADT Session 完全独立。

当前 `src/adt/AdtHTTP.ts` 只在非 stateful 会话中自动登录；stateful 会话遇到 `401`、CSRF 失效或 `400 Session timed out` 时直接向上抛错。后台保活每 120 秒请求一次 compatibility graph，但失败会被空 `catch` 吞掉。于是 MCP 只能通过进程重启清理旧会话。

## 2. 目标与非目标

### 目标

1. 失效的 stateful ADT 会话可以受控恢复，不再依赖重启 MCP。
2. 只有明确分类为只读的工具允许自动重放，最多一次。
3. 写入、锁、激活、调试控制、质量执行和传输操作绝不盲目重试。
4. 并发请求共享同一个恢复 Promise，避免重复登录和 Cookie 互相覆盖。
5. 保活失败可见，`healthcheck` 返回脱敏的会话健康摘要。
6. 普通只读操作尽量使用无状态客户端；需要会话连续性的工作流继续使用 stateful 客户端。
7. SAP 密码不再放入 `config.toml`；服务支持受控的外部凭据提供器，并保留明确的开发环境迁移边界。

### 非目标

- 不修改 SAP GUI 的登录机制，也不试图读取 SAP GUI 会话。
- 不自动恢复已明确由用户执行的 `logout`。
- 不为写操作猜测远端结果，不实现通用的任意 ADT 方法重放。
- 不在本次设计中引入 RFC、JCo、NCo 或新的 SAP 连接协议。
- 不把真实凭据写入仓库、测试快照、日志、审计记录或错误响应。

## 3. 方案比较

### 方案 A：只修改 `AdtHTTP.request()`

在底层看到登录错误后清理会话并自动重新请求。

优点是改动小；缺点是底层无法知道上层操作是否会产生副作用，写请求也会被重放，无法满足“写操作禁止盲重试”。不采用。

### 方案 B：在 MCP 工具分发层按操作分类恢复（推荐）

保留 `AdtHTTP` 的单次请求语义，在 `src/index.ts` 的工具执行边界使用现有 `toolOperationClass()` 判断是否为 `read-only`。只读工具失败且被确认是会话失效时，调用统一会话监督器恢复后重放一次；其他操作原样失败并返回“远端结果未知”的安全错误。

优点是能复用现有权限分类，副作用边界清晰，修改集中；缺点是一个只读工具内部可能已经完成部分读取，需要重新执行整个只读 handler。该行为对只读工具可接受。

### 方案 C：所有读取改为独立 stateless client，再保留 stateful 写客户端

创建共享 stateful 写客户端和懒加载的 stateless 读客户端，并为只读 handler 注入读客户端。

优点是普通读取不依赖长生命周期 Session；缺点是现有 handler 既有纯读也有预览/计划混合流程，全面拆分会扩大改动面。作为方案 B 的配套渐进实施，不作为唯一恢复机制。

## 4. 推荐架构

### 4.1 会话监督器

新增 `src/lib/SessionSupervisor.ts`，持有 stateful `ADTClient` 的受控恢复状态：

```text
SessionSupervisor
├─ classifyAuthFailure(error)
├─ reconnectIfNeeded(observedGeneration)
├─ withReadRecovery(operation)
├─ markKeepaliveResult(result)
├─ markExplicitLogout()
└─ snapshot()
```

监督器不直接执行任意 ADT 方法，只负责会话生命周期、互斥和健康状态。底层 `AdtHTTP` 新增一个明确的内部会话重置入口，统一清理 Cookie、CSRF Token、Session 标记和失效 Bearer 状态，然后调用登录；stateful 模式在重置后保持不变。

### 4.2 恢复互斥与 generation

监督器维护：

- `generation`：每次成功重登递增；
- `reconnectPromise`：同一时刻最多一个重登；
- `explicitlyLoggedOut`：用户主动登出后的禁止自动登录标记；
- `sessionStartedAt`、`lastReconnectAt`、`lastKeepaliveAt`；
- `lastFailure`：仅保存脱敏的错误类型、HTTP 状态和时间。

恢复算法：

1. 工具开始时记录当前 `generation`。
2. 只读操作失败后分类错误。
3. 如果不是会话失效，直接返回原错误。
4. 如果已是 `explicitlyLoggedOut`，不自动登录。
5. 如果 generation 已变化，说明其他请求已恢复，直接重放一次。
6. 否则创建或等待唯一的 `reconnectPromise`。
7. 恢复成功后只允许当前只读操作再执行一次。

### 4.3 失败分类

只将以下情况视为可恢复登录失效：

- HTTP `401`；
- HTTP `403` 且 `x-csrf-token=Required`；
- CSRF 异常；
- HTTP `400` 且 SAP 明确返回 `Session timed out`。

连接超时、DNS、TLS、普通业务 `400`、权限不足和服务器 `500` 不触发重新登录。

### 4.4 读写重试边界

工具执行边界复用 `ToolOperationPolicy.ts`：

| 操作分类 | 会话恢复 | 原请求重放 |
| --- | --- | --- |
| `local` | 否 | 否 |
| `read-only` | 是 | 最多一次 |
| `source-mutation` | 可报告失效 | 禁止 |
| `debug-control` | 可报告失效 | 禁止 |
| `advanced-mutation` | 可报告失效 | 禁止 |
| `quality-execution` | 可报告失效 | 禁止 |
| `other-mutation` | 可报告失效 | 禁止 |

写操作失败时返回稳定错误码，例如 `SAP_SESSION_EXPIRED_WRITE_UNKNOWN`，提示调用方先读取对象、计划或操作状态；不得自动再次执行写入。

## 5. Stateless 读客户端拆分

在 `AbapAdtServer` 中保留一个 stateful 主客户端，并通过 `statelessClone` 创建共享只读客户端。第一阶段只迁移纯读取 handler；包含锁、写入、调试 Attach、激活或变更计划 apply 的 handler 保持使用 stateful 客户端。

迁移规则：

- 纯 legacy 读取 handler 构造时注入 stateless client；
- safe workflow 的 preview 仍使用 stateful client，以保证 preview/apply 的对象身份和哈希核验链一致；
- 同一个 stateless client 允许底层自动登录，但不保存 stateful Session；
- 所有写入和需要连续 Session 的操作继续经过现有 `ToolExecutionGate`。

这样可以减少普通查询对共享 stateful 会话的依赖，同时保留受控写工作流的完整会话语义。

## 6. 保活与健康状态

保活失败不再使用空 `catch`。失败时：

1. 记录脱敏错误摘要；
2. 将状态标为 `degraded`；
3. 不在定时器中无限重登；
4. 下一次允许恢复的只读调用负责触发一次受控恢复。

`healthcheck` 仍明确表示这是 MCP 本地健康检查，但增加非敏感的 `session` 摘要：

```json
{
  "status": "healthy",
  "scope": "mcp-process",
  "sapConnectionVerified": false,
  "session": {
    "mode": "stateful",
    "state": "connected | degraded | disconnected | explicitly-logged-out",
    "generation": 3,
    "sessionAgeSeconds": 812,
    "lastKeepaliveAt": "2026-08-19T00:00:00.000Z",
    "lastReconnectAt": "2026-08-19T00:00:00.000Z",
    "lastErrorType": "session-timeout"
  }
}
```

不得返回 Cookie、CSRF Token、Session ID、Authorization header、密码或完整 SAP 错误正文。

## 7. 主动登出与重启语义

- `login`：清除 `explicitlyLoggedOut`，执行一次受控登录。
- `logout`：标记 `explicitlyLoggedOut=true`；即使远端登出请求失败，也必须清理本地凭据状态，防止后台自动登录。
- `dropSession`：只重置当前 ADT Session，不等同于用户主动登出；清理完成后恢复部署时配置的会话模式（当前默认是 stateful），后续允许恢复。
- MCP 进程重启：所有内存状态消失，首次 SAP 调用重新建立会话。

## 8. 回滚开关与配置

为保证分阶段上线，每个新增行为都有独立开关：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `SAP_MCP_SESSION_RECOVERY` | `true` | 关闭后恢复为会话失效即返回错误，不改变写操作边界 |
| `SAP_MCP_STATELESS_READS` | `false` | DEV 验证前关闭普通只读 handler 的 stateless 分流 |
| `SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL` | `false` | 迁移完成后设为 `true`，禁止 `SAP_PASSWORD` 回退 |

开关只在进程启动时读取，不允许通过 MCP 工具动态改变；启动摘要只显示开关状态，不显示凭据值。

## 9. 凭据边界

新增 `CredentialProvider` 接口，默认生产模式使用外部命令提供器：

- 配置只保存绝对命令路径和凭据目标名，不保存密码；
- 使用 `execFile` 参数数组，不经过 shell 拼接；
- 标准输出只接受单个密码值，标准错误永不写入日志；
- 读取失败时服务启动失败，不回退到空密码；
- `SAP_PASSWORD` 仅作为开发/迁移兼容项，并在启动日志中给出脱敏警告；生产可用 `SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL=true` 禁止回退；
- 凭据轮换只需重启 MCP 或显式 `login`，不会进入工具参数。

迁移完成后，Codex `config.toml` 只保留 `SAP_MCP_ENV_FILE`、Profile、系统角色和凭据目标，不再出现 `SAP_PASSWORD`。

## 10. 测试与验收

### 单元测试

- 401、403 CSRF、400 Session timed out 的分类；
- 普通 400、超时、权限错误不触发恢复；
- 两个并发恢复请求只产生一次登录；
- generation 变化时第二个请求不重复登录；
- 只读工具最多重放一次；
- 每类写工具都验证不重放；
- logout 后只读调用不会自动登录；
- keepalive 失败会产生 `degraded` 摘要；
- 健康响应不包含 Cookie、Token、密码和原始错误正文；
- 外部凭据提供器使用 `execFile`，不经过 shell，不记录输出。

### 自动化验证

```powershell
npm test -- --runInBand
npm run build
npm run check:adt-imports
git diff --check
```

### 真实 SAP 验收

在专用 DEV 环境执行：

1. 建立 MCP 会话并完成一次只读调用；
2. 使 ADT Session 过期，验证下一次只读调用自动恢复且只执行一次；
3. 让一次写操作在响应前断开，验证不会自动重放，并能返回未知结果提示；
4. 验证 keepalive 失败后 `healthcheck` 显示 `degraded`；
5. 调用 `logout` 后验证不会被后台自动登录；
6. 验证 stateless 读取与 stateful 写工作流互不污染。

真实 SAP、不同 SAP 版本、代理断线和 Codex 客户端重启行为在未实测前均不宣称已验证。

## 11. 发布与回滚

发布顺序：

1. 先发布会话监督器和只读一次重试；
2. 再启用健康摘要和非静默保活；
3. 在 DEV 验证后迁移纯读 handler 到 stateless client；
4. 最后切换外部凭据提供器并禁止生产密码回退。

任何阶段出现行为回归时，可通过环境开关关闭自动恢复或 stateless 读分流，回到“失败即返回”的安全行为；不得通过重新启用写入自动重试来规避问题。
