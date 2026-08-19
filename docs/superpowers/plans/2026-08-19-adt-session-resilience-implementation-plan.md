# ADT 会话自愈与凭据边界实现计划

对应规格：[2026-08-19-adt-session-resilience-design.md](../specs/2026-08-19-adt-session-resilience-design.md)

## 实施顺序

### 1. 底层会话重置能力

修改：`src/adt/AdtHTTP.ts`、`src/adt/AdtClient.ts`、`src/adt/AdtException.ts`

- 增加显式 `reconnect()` 入口，只清理本地 Cookie、CSRF Token、Session 状态和 Bearer 缓存，然后重新登录。
- 保持部署时配置的 `stateful` 模式；`dropSession()` 在请求完成或失败后恢复原会话模式。
- `logout()` 使用 `finally` 清理本地状态；保留重新 `login()` 所需的构造凭据，不把它们写入日志或响应。
- 将 `401`、CSRF 失效和 `400 Session timed out` 暴露为稳定的会话失效判定；普通网络/业务错误不纳入。
- 为 keepalive 增加脱敏事件回调，不改变底层请求的返回契约。

验收：现有 ADT HTTP 测试保持通过；新增测试验证清理顺序、模式恢复和错误分类。

### 2. 会话监督器与工具边界

新增：`src/lib/SessionSupervisor.ts`

修改：`src/lib/serverGuardrails.ts`、`src/index.ts`、`src/safe/errors.ts`

- 实现 `generation`、单一 `reconnectPromise`、`explicitlyLoggedOut` 和健康摘要。
- 在 `executeGuardedToolCall` 的 dispatch 边界增加恢复回调，避免把恢复逻辑散落到 handler。
- 只对 `toolOperationClass(toolName) === 'read-only'` 允许重登后重放一次。
- 写/调试/质量/传输等操作遇到会话失效时抛出 `SafeAbapError('REMOTE_RESULT_UNKNOWN', ...)`，不重放。
- `login`/`logout`/`dropSession` 由监督器同步更新状态；healthcheck 只返回脱敏摘要。
- 增加 `SAP_MCP_SESSION_RECOVERY` 开关，默认开启。

验收：并发恢复只有一次登录；第二个请求按 generation 跳过重复登录；写操作调用次数始终为 1。

### 3. keepalive 与健康状态

修改：`src/adt/AdtHTTP.ts`、`src/index.ts`、相关测试

- keepalive 失败调用监督器回调并标记 `degraded`，不得空吞异常。
- 健康摘要包含状态、generation、会话年龄、最近保活/重登时间和错误类型。
- 仍保留 `sapConnectionVerified: false` 的本地健康边界；不把摘要当成 SAP 连通性证明。

验收：模拟保活失败后 healthcheck 显示 `degraded`，且响应不包含 Cookie、Token、密码或原始响应正文。

### 4. stateless 读取分流

修改：`src/index.ts`、需要迁移的纯读 handler 构造点、`src/config/RuntimeGuardrails.ts` 或新增配置解析文件

- 创建共享 stateful client 和懒加载 stateless clone。
- 只迁移纯 legacy 读取 handler；safe preview/apply、锁、写入、调试 Attach 和质量执行继续使用 stateful client。
- 增加 `SAP_MCP_STATELESS_READS=false` 默认开关，DEV 验证后再启用。
- 保持所有 SAP 调用经过现有 execution gate，避免改变并发安全边界。

验收：开启分流后读取使用 stateless clone，写入仍使用主 stateful client；关闭开关后行为与当前版本一致。

### 5. 外部凭据提供器

新增：`src/config/CredentialProvider.ts` 及其测试

修改：启动配置解析、`.env.example`、README/中文使用指南

- 支持绝对命令路径 + credential target 的外部提供器；使用 `execFile` 参数数组，不使用 shell。
- 标准输出仅接受单一密码值；标准错误只作为脱敏启动错误，不进入日志。
- `SAP_PASSWORD` 保留迁移兼容，但打印一次脱敏警告；`SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL=true` 时拒绝回退。
- 不修改真实 `.env`、Codex `config.toml` 或用户凭据；文档提供迁移步骤和权限检查。

验收：命令注入测试、输出清理测试、缺凭据启动失败测试、兼容回退测试。

### 6. 自动化与现场验收

先执行：

```powershell
npm test -- --runInBand
npm run build
npm run check:adt-imports
git diff --check
```

再在专用 DEV 做会话过期、只读恢复、写操作未知结果、keepalive degraded、logout 禁止自动登录和 stateless/stateful 隔离验证。未连接真实 SAP 前，不声称现场验收完成。

## 文件边界

本计划只允许修改会话、凭据、健康状态、测试和对应文档；不得顺手清理无关代码，不修改生成的 `dist`，不改真实 `.env`，不提交密码或 Cookie。
