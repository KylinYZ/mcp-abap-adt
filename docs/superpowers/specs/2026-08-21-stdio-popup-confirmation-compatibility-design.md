# stdio 弹窗确认兼容设计

> 实施状态（2026-08-24）：Windows provider 已采用 Explorer broker + 临时 UTF-8 BOM PowerShell helper + 一次性 named pipe；MCP App 路径因隔离未验证而固定拒绝。Codex Desktop cancel/apply 回传已通过，且 repository apply/status 的 execution-gate 重入自锁已修复。真实 DEV Domain 已创建并 active 复读；清理和成熟度晋级仍待独立授权。

## 1. 背景

当前 SAP MCP Server 通过标准 MCP `elicitation/create` 请求原生 `form` 确认。普通 MCP Client 的内存端到端测试可以完成以下闭环：

```text
tools/call
  -> elicitation/create
  -> ElicitResult
  -> tools/call result
```

Codex Desktop 在同时启用 `unified_exec` 与 `tool_call_mcp_elicitation` 时，可以展示表单并记录正确结果：

```json
{
  "action": "accept",
  "content": {
    "decision": "apply"
  }
}
```

但该结果未回到原始 MCP stdio session，导致 Server 永久等待。此问题位于宿主的嵌套请求桥接链路，不能通过关闭 `unified_exec`、文字确认、调用方布尔值或 Server 伪造结果规避。

本设计在不启动本地端口的前提下，为 stdio MCP 增加可信弹窗确认兼容层。

## 2. 目标

- 保留现有 stdio 传输和 Codex 自动启用的 `unified_exec`。
- 保留不可变计划、单次确认、TTL、指纹、上下文绑定和未知结果停止语义。
- 为 Codex 提供不依赖嵌套 `elicitation/create` response 的弹窗确认通道。
- 不向 Agent 暴露可伪造的 `confirmed=true`、文字口令或普通聊天确认。
- 不改变 SAP apply、补偿、激活、复读和审计的业务语义。
- cancel、关闭、超时、格式错误和断开必须安全结束，不执行或重放 SAP mutation。

## 3. 非目标

- 不关闭或降级 `unified_exec`。
- 不修改 Codex Desktop 安装文件或 runtime。
- 不启动 HTTP、SSE、WebSocket 或其他本地监听端口。
- 不把计划模式 `request_user_input` 当作 Server 可信确认。
- 不在本次兼容改造中提前提升任何对象的 `REAL_DEV_VERIFIED` 成熟度。
- 不复用历史 pending plan，不直接调用底层 ADT create。

## 4. 方案比较

### 4.1 MCP App 确认面板

Server 在 preview 结果中提供确认 App 资源。App 显示对象名、包、传输、计划指纹、过期时间以及 Apply/Cancel。用户操作后，App 通过宿主允许的 App-to-Server 工具调用提交一次性 challenge。

优点：确认界面位于 Codex 内，继续使用 stdio，不产生嵌套 Server-to-client request。

限制：必须先证明当前 Codex 能把确认工具限制为 App 可调用、模型不可直接调用。若当前 MCP App 能力无法建立该隔离，App 方案不得进入生产路径。

### 4.2 Windows 原生弹窗适配器

Server 写入一次性临时 helper 脚本，并通过 Explorer broker 在交互桌面启动。计划摘要和一次性 challenge 只经当前请求的 Windows named pipe 传递；辅助进程显示 Windows 原生 Apply/Cancel 弹窗，通过同一 pipe 返回结构化结果后退出，脚本随后删除。

优点：不依赖 MCP 嵌套请求或本地端口；确认结果直接返回 Server；普通 Agent 无法调用辅助进程内部接口。

限制：仅适用于有交互桌面的 Windows。无桌面 session、辅助进程启动失败或窗口超时必须安全取消。

### 4.3 选择

当前实现按 Server session 固定 provider：

1. Windows 的 `auto` 固定使用已验证的 Windows 原生弹窗。
2. 其他环境使用已协商成功的标准 MCP form；若没有可靠通道，则返回 `CONFIRMATION_UNSUPPORTED`。
3. `mcp-app` 在 App-only 隔离未验证前固定返回 `CONFIRMATION_UNSUPPORTED`，不保留半可用探针路径。

一次 apply 请求只能选择一个通道。请求开始后禁止超时切换到另一通道，避免用户看到双弹窗或同一计划被确认两次。

## 5. 架构

现有 `RepositoryObjectCreationConfirmation` 保持唯一确认入口，在其与具体 UI 之间增加一个最小接口：

```ts
interface RepositoryCreationConfirmationProvider {
  readonly mode: 'mcp-form' | 'mcp-app' | 'windows-native';
  confirm(request: RepositoryCreationConfirmationRequest): Promise<RepositoryCreationDecision>;
}
```

`RepositoryCreationConfirmationRequest` 仅包含界面需要的只读字段：

- `creationPlanId`
- `summary`
- `objectKind`
- `objectName`
- `packageName`
- `transportRequest`
- `payloadFingerprint`
- `expiresAt`
- `challengeId`

challenge 的 secret、SAP 凭据、完整 payload、URL、lock handle 和任意写入参数不得进入 UI 数据。

Provider 只返回：

```ts
type RepositoryCreationDecision =
  | { action: 'apply'; challengeId: string }
  | { action: 'cancel'; challengeId: string };
```

Provider 无权调用 workflow apply。`RepositoryObjectCreationConfirmation` 完成 challenge 校验和原子消费后，才调用现有 `applyConfirmed(creationPlanId)`。

## 6. Challenge 与信任边界

每次 apply 尝试创建一个仅内存保存的一次性 challenge，绑定：

- `creationPlanId`
- 完整 `payloadHash`
- MCP session 身份
- SAP host、client、user、role 和 tool profile
- 对象类型、对象名、父对象和传输
- confirmation provider mode
- 创建时间和不超过计划 TTL 的过期时间

challenge 状态为 `PENDING | CONSUMED | CANCELLED | EXPIRED`。只有 `PENDING` 可以通过一次原子状态转换进入 `CONSUMED`。

以下情况全部拒绝：

- challenge 不存在、已消费、已取消或过期；
- plan 不再是 `PREVIEWED`；
- plan、payload hash、session 或 SAP 上下文不匹配；
- provider mode 与 challenge 不匹配；
- 返回动作或结构不合法；
- Apply 前策略、对象缺失状态或受控验证边界发生变化。

拒绝确认不得调用 SAP。重复点击只会得到明确的已消费错误，不得重放 mutation。

## 7. MCP App 能力探针

MCP App 路径必须通过一个无 SAP mutation 的启动期或首次使用探针，证明：

1. Codex 能渲染本 Server 提供的 App 资源。
2. App 能将用户动作送回同一个 MCP Server session。
3. 确认入口对普通模型工具目录不可见或不可调用。
4. App 提交的 challenge 与当前 plan/session 可验证绑定。
5. App 关闭、宿主取消和超时均能结束 pending confirmation。

任一条件无法证明时，MCP App provider 标记为 unavailable；不得仅因界面能显示就判定可用。

## 8. Windows 原生弹窗协议

Windows helper 由 Server 通过隐藏 broker 请求 Explorer 在当前交互用户桌面启动，界面使用系统原生对话框。Server 为每次 challenge 创建一次性 Windows named pipe（不是 TCP 监听端口），发送一行有界 JSON，helper 返回一行有界 JSON。这样 Codex 的沙箱进程与实际桌面 Session 不一致时，确认框仍能投递到用户桌面。

请求示例：

```json
{
  "challengeId": "opaque-id",
  "title": "SAP DEV controlled creation",
  "message": "Create DDIC_DOMAIN ZZMCP_VT_DOM in package Z001?",
  "transportRequest": "S4HK900009",
  "payloadFingerprint": "cae28dc3b16437ac",
  "expiresAt": "2026-08-21T02:08:46.576Z"
}
```

响应只允许：

```json
{"challengeId":"opaque-id","action":"apply"}
```

或：

```json
{"challengeId":"opaque-id","action":"cancel"}
```

helper 不持有 SAP 凭据，不读取 `.env`，不连接网络，不执行 MCP 或 ADT 调用。窗口关闭等同 cancel；进程异常、输出超限、额外输出、解析失败和超时均由 Server 解释为安全取消。Explorer broker 只负责启动 helper，不承载确认结果；结果只能经当前 challenge 的 named pipe 返回。

## 9. Provider 选择与配置

新增一个默认安全的 provider 选择配置，建议值为：

```text
SAP_MCP_CONFIRMATION_PROVIDER=auto
```

允许值：

- `auto`：Windows 选择 Windows native，其他平台选择标准 MCP form；无可靠通道则拒绝。
- `mcp-app`：探针失败即拒绝，不降级。
- `windows-native`：仅 Windows 交互桌面可用。
- `mcp-form`：保留当前标准行为，适合已正确支持 elicitation 的 Client。

provider 在 Server session 建立后固定。配置不提供 text、boolean、chat 或 disabled-and-apply 等不可信选项。

## 10. 超时、取消与断开

- confirmation timeout 继续取计划剩余 TTL 与 60 秒的较小值。
- 外层 `tools/call` 取消时，pending challenge 立即取消；后续迟到结果不得消费。
- Provider 返回 cancel、窗口关闭或超时后，原始调用必须返回明确的 declined/cancelled 结果或受控错误。
- 确认完成但 workflow 尚未开始时发生断开，不得由其他请求重放。
- workflow 一旦开始，继续沿用现有计划单次消费和 `OUTCOME_UNKNOWN` 语义。
- Server shutdown 清空所有 pending challenge；重启后不存在可恢复的确认授权。

## 11. 审计

确认审计只记录：

- plan ID
- payload fingerprint
- provider mode
- action
- challenge 状态
- 创建、响应和消费时间
- session 的非敏感关联标识

不得记录 challenge secret、SAP 密码、完整 payload、源码、属性文档或 helper 原始环境。

## 12. 测试

### 12.1 Provider 合同测试

- apply、cancel、关闭、timeout、malformed response。
- challenge ID 不匹配、过期、重复消费、跨 session 和错误 provider。
- 外层取消后迟到 apply 不执行 workflow。

### 12.2 stdio 端到端测试

1. 启动 Server。
2. Client 初始化并调用 preview。
3. 调用 apply。
4. Provider 得到用户决定。
5. 原始 `tools/call` 必须结束。
6. workflow apply 恰好调用一次。
7. cancel、timeout 和 malformed response 均调用零次。
8. 并发重复确认只能有一个成功消费 challenge。

### 12.3 MCP App 探针测试

- App 资源可渲染。
- App 动作回到原 session。
- 普通 Client 工具目录不存在确认入口。
- 模型直接调用确认入口被协议层或 Server 策略拒绝。

若上述隔离测试无法实现，MCP App provider 不得标记为 available。

### 12.4 Windows helper 测试

- 使用可注入的 helper process adapter 模拟结构化响应。
- 验证 stderr、额外 stdout、超长输出、异常退出和超时安全取消。
- Windows 真实 UI smoke 仅验证窗口和管道，不连接 SAP。

### 12.5 SAP 安全验收

1. 独立只读确认 `ZZMCP_VT_DOM` 不存在。
2. 使用 `writable=false` 的 `DDIC_DOMAIN` 创建全新 preview plan。
3. 用户在新 provider 中选择 Apply。
4. 确认闭环应完成，随后 workflow 在任何 SAP 写入前返回 `POLICY_DENIED`。
5. 独立只读复核对象、active/inactive 读取和传输均无变化。
6. 只有该闭环稳定后，才单独开启现有 REAL DEV validation gate 做真实验证。

## 13. 实施顺序

1. 提取最小 confirmation provider 接口和 challenge store。
2. 保持标准 MCP form provider 兼容现有 Client。
3. 实现并运行 MCP App 能力与隔离探针。
4. 探针通过则接入 MCP App provider；未通过则不保留半可用路径。
5. 实现 Windows native provider 和无 SAP UI smoke。
6. 完成 provider、挑战、并发、取消和 stdio 端到端测试。
7. 构建并重启 MCP Client。
8. 先执行 `writable=false` 的零 mutation 真实宿主验收。
9. 确认闭环稳定后，再按独立授权执行真实 DEV validation。

## 14. 验收标准

- 不启动任何本地监听端口。
- `unified_exec` 保持启用。
- 用户能看到明确的 Apply/Cancel 弹窗或内嵌确认面板。
- 决定直接进入 Server 的可信确认通道，不经过 Agent 布尔值或聊天文字。
- 原始工具调用在 apply、cancel、timeout 和 malformed response 下都能终止。
- workflow apply 最多一次，重复、断线和迟到响应不得重放。
- 未通过能力隔离验证的 MCP App 不得投入使用。
- 真实 DEV 写入只在确认闭环和既有 REAL DEV validation gate 均通过后执行。
