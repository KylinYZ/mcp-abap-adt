# MCP ABAP ADT 性能与资源护栏实施计划

> 状态：已实施并完成自动化验证。本文中的 9 套件、41 项测试是实施前历史基线；当前基线为 18 套件、131 项测试。真实 SAP 性能与并发专项验证仍待执行。

## 1. 实施目标

依据已批准的设计，在不改变正常范围内工具契约、不削弱安全变更自动回滚的前提下，为 `safe` 与 `legacy-full` 全部工具增加以下能力：

- ADT 底层真实 HTTP 超时。
- 共享 stateful `ADTClient` 的 FIFO 有界执行门控。
- 查询默认数量、硬上限及响应字节保护。
- 变更计划、源码缓存和确认挑战的容量与生命周期控制。
- 普通日志级别过滤和安全审计串行写入。
- 工具定义缓存、准确覆盖率统计及配置文档。

设计依据：`docs/superpowers/specs/2026-08-12-performance-guardrails-design.md`。

## 2. 当前基线与工作区保护

- 当前版本：`0.1.1`。
- 当前验证基线：9 个测试套件、41 个测试通过，`npm run build` 通过。
- 当前工作区已有未提交修改，涉及 `README.md`、安全确认流程、测试和设计文档。
- 实施前必须执行 `git status --short` 和目标文件定向 diff；不得覆盖、回退或格式化用户现有改动。
- 除非用户另行授权，不创建提交、不修改分支、不清理 `.codegraph/` 或其他未跟踪文件。

## 3. 总体实施顺序

每项任务采用测试先行：先增加失败测试，再实现最小代码，通过定向测试后才进入下一项。中央入口最后接入已经通过单元测试的组件，降低一次性修改 `src/index.ts` 的风险。

## 4. 任务一：集中解析运行护栏配置

### 修改文件

- 新增 `src/config/RuntimeGuardrails.ts`
- 新增 `src/__tests__/RuntimeGuardrails.test.ts`
- 后续修改 `.env.example`、`README.md`、`README.zh-CN.md`

### 先写测试

覆盖：

1. 空环境使用全部批准默认值。
2. 每个整数配置接受上下边界。
3. 拒绝非数字、小数、非有限值、超出范围值。
4. 拒绝默认查询行数大于最大查询行数。
5. 拒绝默认搜索数量大于最大搜索数量。
6. 日志级别只接受 `error/warn/info/debug`。
7. 缓存最大条目为 `0` 时允许关闭缓存。

定向命令：

```powershell
npx jest src/__tests__/RuntimeGuardrails.test.ts --runInBand
```

### 最小实现

导出：

```typescript
interface RuntimeGuardrails {
  adtTimeoutMs: number;
  maxConcurrentTools: number;
  maxQueuedTools: number;
  queryDefaultRows: number;
  queryMaxRows: number;
  searchDefaultResults: number;
  searchMaxResults: number;
  maxResponseBytes: number;
  sourceCacheMaxEntries: number;
  sourceCacheMaxItemBytes: number;
  sourceCacheTtlMs: number;
  changePlanMaxEntries: number;
  rollbackFailedRetentionMs: number;
  logLevel: LogLevel;
}
```

提供 `RuntimeGuardrails.fromEnvironment(environment)` 或等价纯函数。解析失败使用包含环境变量名、收到值和允许范围的启动错误。新增代码不使用 `any`。

## 5. 任务二：实现 FIFO 有界执行门控

### 修改文件

- 新增 `src/lib/ToolExecutionGate.ts`
- 新增 `src/__tests__/ToolExecutionGate.test.ts`

### 先写测试

覆盖：

1. 并发上限为 1 时，两个 Promise 不重叠执行。
2. 按进入顺序执行等待任务。
3. 当前任务抛错后仍释放执行槽。
4. 队列达到上限时立即以 429 拒绝，且回调未执行。
5. 并发上限大于 1 时不超过配置数量。
6. 队列上限为 0 时无空闲槽即拒绝。

定向命令：

```powershell
npx jest src/__tests__/ToolExecutionGate.test.ts --runInBand
```

### 最小实现

实现一个只负责计数、FIFO 排队和释放的类：

```typescript
run<T>(operation: () => Promise<T>): Promise<T>
```

队列满时抛出 `McpError(429, ...)`。不得在门控中识别工具名、读取参数、做日志或实现重试。

将 `BaseHandler` 中未被调用的 `checkRateLimit`、`rateLimiter` 和本地自定义错误码移除，避免保留两套过载机制。仅移除确认未被任何 Handler 调用的代码。

## 6. 任务三：实现请求数量和响应字节保护

### 修改文件

- 新增 `src/lib/requestLimits.ts`
- 新增 `src/__tests__/requestLimits.test.ts`
- 后续修改 `src/index.ts`

### 先写测试

覆盖：

1. `tableContents.rowNumber` 缺失时填入查询默认值。
2. `runQuery.rowNumber` 缺失时填入查询默认值。
3. `searchObject.max` 缺失时填入搜索默认值。
4. 正整数且不超过上限时原值保持不变。
5. 拒绝 0、负数、小数、字符串、`NaN`、无穷值和超限值。
6. 不修改与数量限制无关的参数。
7. 不修改原始 arguments 对象，返回浅复制结果。
8. UTF-8 中文和多字节字符按字节而非 JavaScript 字符数计算。
9. 多个文本 content 累加后超过限制时抛出 413。
10. 非文本 content 不参与文本响应限制。
11. 超限错误不包含原始完整响应。

定向命令：

```powershell
npx jest src/__tests__/requestLimits.test.ts --runInBand
```

### 最小实现

导出两个纯函数：

```typescript
applyToolArgumentLimits(toolName, argumentsValue, guardrails)
assertToolResponseSize(toolResult, maxResponseBytes)
```

第一版只绑定设计已确认的三个字段：`tableContents.rowNumber`、`runQuery.rowNumber`、`searchObject.max`。不要推测 `createAtcRun.maxResults` 或其他参数具有相同业务语义；后续只有核实依赖 API 契约后才纳入。

参数超限抛出 400，响应超限抛出 413。不得静默截断、修改 SQL 或自动分页。

## 7. 任务四：接入服务器中央入口

### 修改文件

- 修改 `src/index.ts`
- 新增或扩展 `src/__tests__/serverGuardrails.test.ts`

### 接入步骤

1. 在构造 Handler 前解析 `RuntimeGuardrails`。
2. 创建 `ADTClient` 时传入 `{ timeout: guardrails.adtTimeoutMs }`。
3. 创建一个 `ToolExecutionGate` 实例。
4. `CallToolRequestSchema` 收到请求后：
   - 浅复制并应用参数数量限制；
   - 使用共享 `ADTClient` 的操作进入执行门控；确认等待和纯本地状态/健康检查不占 gate；
   - 执行原有 safe/legacy 分发；
   - 统一序列化结果；
   - 检查响应字节上限；
   - 任何异常仍由现有统一错误出口转换为 `isError: true`。
5. 在服务器构造期间生成一次 safe、legacy 和最终 profile 工具列表；`tools/list` 只返回已缓存列表。
6. 将底部启动逻辑提取为 `main()`，只在直接运行入口时启动，避免测试导入模块时自动连接 stdio。

### 测试重点

- mock `ADTClient` 构造器收到 timeout。
- safe 与 legacy-full 工具列表内容保持现状。
- 连续两次 `tools/list` 不再次调用 Handler 的 `getTools()`。
- 两个 SAP 工具调用经过同一个执行门控；确认等待期间本地状态和健康检查仍可完成。
- 参数限制发生在 ADT 方法调用前。
- 响应超限经过统一错误转换。

如果直接测试 `AbapAdtServer` 需要大规模模拟 SDK，优先把“构造工具目录”和“执行受保护工具调用”提取成小型纯函数测试，不拆分整套服务器目录结构。

定向命令：

```powershell
npx jest src/__tests__/serverGuardrails.test.ts --runInBand
npm run build
```

## 8. 任务五：将源码缓存改为受限 LRU

### 修改文件

- 修改 `src/lib/sourceCache.ts`
- 新增 `src/__tests__/sourceCache.test.ts`
- 修改 `src/handlers/ObjectSourceHandlers.ts`
- 修改 `src/handlers/AuthHandlers.ts`
- 保持 `src/handlers/CodeAnalysisHandlers.ts` 的缓存读取契约

### 先写缓存单元测试

覆盖：

1. 正常 set/get。
2. TTL 到期后 get 返回空并删除条目。
3. get 更新 LRU 顺序。
4. 超过条目上限时淘汰最久未使用项。
5. 单项 UTF-8 字节数超限时不缓存。
6. 最大条目为 0 时缓存禁用。
7. clear 删除全部条目。
8. 测试可注入 `now()`，不使用真实等待。

### Handler 行为测试

覆盖：

1. 带 `startLine/maxLines` 的分页请求缓存命中时不调用 SAP，并返回 `sourceOrigin: "cache"`。
2. 分页缓存未命中时调用 SAP、尝试缓存并返回 `sourceOrigin: "sap"`。
3. 不带分页参数的完整读取继续访问 SAP，避免把可能陈旧的缓存当成权威源码。
4. `setObjectSource` 成功后更新缓存。
5. `logout/dropSession` 成功后清空缓存。
6. `syntaxCheckCode` 仍可复用缓存源码。

### 最小实现

保留模块级 `sourceCache` 导出，内部改为可配置的 `SourceCache` 类或等价封装。服务器启动时配置一次；不要建立通用缓存框架。

分页切行沿用现有返回契约，只增加 `sourceOrigin`。修复 `startLine` 超过总行数时 `returnedLines` 可能为负的问题，并增加对应测试。

定向命令：

```powershell
npx jest src/__tests__/sourceCache.test.ts --runInBand
npx jest src/__tests__/ObjectSourceHandlers.test.ts --runInBand
```

## 9. 任务六：收紧变更计划生命周期

### 修改文件

- 修改 `src/safe/types.ts`
- 修改 `src/safe/ChangePlanStore.ts`
- 扩展 `src/__tests__/ChangePlanStore.test.ts`
- 必要时小幅修改 `src/safe/AbapChangeWorkflow.ts`
- 扩展 `src/__tests__/AbapChangeWorkflow.test.ts`

### 数据模型最小变化

为计划增加终态时间或等价字段，用于计算 `ROLLBACK_FAILED` 保留期。完整源码字段保持字符串类型；清理时置为空字符串，避免把所有工作流调用改成可选值。增加内部方法集中清空：

```typescript
purgePayload(plan): void
```

清空 `originalSource`、`targetSource` 和完整 `diff`，保留哈希、diff 摘要、语法消息、阶段和错误信息。

### 先写测试

覆盖：

1. `APPLIED`、`ROLLED_BACK`、`EXPIRED`、`FAILED` 立即清空大字段。
2. `PREVIEWED`、`APPLYING` 保留大字段。
3. `ROLLBACK_FAILED` 在保留期内保留大字段。
4. `ROLLBACK_FAILED` 到期后清空大字段但保留状态记录。
5. 达到最大数量时先删除最旧、可删除的终态记录。
6. 不删除有效 `PREVIEWED`、`APPLYING` 或保留期内的 `ROLLBACK_FAILED`。
7. 无法安全腾出容量时，创建计划失败且现有计划不受影响。
8. 现有自动回滚测试仍证明 originalSource 在回滚完成前可用。
9. 状态 view 从不暴露完整源码。

### 清理触发点

在 `create/get/view/beginApply/setStatus` 的入口或出口调用同一个惰性清理方法。不得新增 interval；不得在清理过程中进行文件或 SAP I/O。

定向命令：

```powershell
npx jest src/__tests__/ChangePlanStore.test.ts src/__tests__/AbapChangeWorkflow.test.ts --runInBand
```

## 10. 任务七：清理确认挑战生命周期

### 修改文件

- 修改 `src/safe/AbapChangeConfirmation.ts`
- 扩展 `src/__tests__/AbapChangeConfirmation.test.ts`

### 先写测试

覆盖：

1. 访问确认入口时惰性清理所有已过期挑战。
2. 当前计划过期或不再是 `PREVIEWED` 时删除对应挑战。
3. 确认成功后删除挑战。
4. 错误短语不泄漏 expected hash，挑战只保留到到期时间。
5. 重复创建同一计划挑战时只保留最新绑定值。

不增加后台定时器，不把挑战持久化到磁盘。

定向命令：

```powershell
npx jest src/__tests__/AbapChangeConfirmation.test.ts --runInBand
```

## 11. 任务八：日志降噪和审计可靠串行化

### 修改文件

- 修改 `src/lib/logger.ts`
- 新增 `src/__tests__/logger.test.ts`
- 修改 `src/safe/AuditLogger.ts`
- 扩展 `src/__tests__/AuditLogger.test.ts`

### 普通日志测试

覆盖：

1. 默认 `warn` 不写 `info/debug`。
2. 禁用级别在构造时间戳和 JSON 前返回；通过 spy 验证 `stderr.write` 未调用。
3. `warn/error` 正常写 stderr。
4. 配置 `info/debug` 后对应日志可见。
5. 日志元数据不由框架自动加入工具参数或源码。

模块提供一次性 `configureLogLevel(level)`，由服务器在构造 Handler 前调用。不要在每条日志中重复读取环境变量。

### 审计测试

覆盖：

1. 并发调用 append 时生成顺序稳定、每行可解析的 JSONL。
2. 目录只初始化一次。
3. 某次 append 失败不会让内部 Promise 链永久处于 rejected；后续调用可再次尝试。
4. 初始化失败后允许下一次 append 重试创建目录。
5. 现有脱敏测试继续通过。

实现时使用实例内 Promise tail 串行写入，但每次 `append` 仍等待自己的写入完成并传播错误。不得批量缓存或吞掉审计失败。

定向命令：

```powershell
npx jest src/__tests__/logger.test.ts src/__tests__/AuditLogger.test.ts --runInBand
```

## 12. 任务九：覆盖率与文档同步

### 修改文件

- 修改 `jest.config.js`
- 修改 `.env.example`
- 修改 `README.md`
- 修改 `README.zh-CN.md`
- 必要时修改 `CHANGELOG.md`

### 覆盖率配置

增加：

```javascript
collectCoverageFrom: [
  'src/**/*.ts',
  '!src/__tests__/**'
]
```

为新增纯函数护栏设置定向门禁：

- `RuntimeGuardrails.ts`：statements/lines 95%，branches 85%。
- `ToolExecutionGate.ts`：statements/lines/functions 100%，branches 90%。
- `requestLimits.ts`：statements/lines 95%，branches 90%。
- `sourceCache.ts`：statements/lines 90%，branches 85%。
- `ChangePlanStore.ts`：保持或提高当前约 90% 的 statements 覆盖率。

不要立即设置全仓库高阈值，因为此前未加载的 legacy Handler 会使真实总体覆盖率显著下降。报告真实覆盖率，不通过排除生产文件美化数字。

### 文档内容

- 为全部新增环境变量记录默认值、范围和生产建议。
- 明确默认单并发是为保护共享 stateful 会话。
- 明确查询超限拒绝，不静默截断。
- 明确源码分页是会话内缓存分页，不是 SAP 服务端分页。
- 明确写请求超时后结果未知，禁止盲目重试。
- 明确审计日志由部署环境负责容量告警、轮转和归档。
- MCP JSON 配置和 `.env` 示例同步更新。

## 13. 任务十：全量验证与真实环境检查单

### 自动验证

依次执行：

```powershell
npx jest src/__tests__/RuntimeGuardrails.test.ts --runInBand
npx jest src/__tests__/ToolExecutionGate.test.ts --runInBand
npx jest src/__tests__/requestLimits.test.ts --runInBand
npx jest src/__tests__/sourceCache.test.ts --runInBand
npx jest src/__tests__/ChangePlanStore.test.ts src/__tests__/AbapChangeWorkflow.test.ts --runInBand
npx jest src/__tests__/AbapChangeConfirmation.test.ts --runInBand
npx jest src/__tests__/logger.test.ts src/__tests__/AuditLogger.test.ts --runInBand
npm test -- --runInBand
npm run build
```

再执行：

```powershell
rg -n ": any|<any>|any\[\]" src/config src/lib/ToolExecutionGate.ts src/lib/requestLimits.ts
git status --short
git diff --check
```

新增代码出现 `any`、测试覆盖率门禁失败、现有 41 个测试回归或 TypeScript 编译失败时不得进入真实 SAP 验证。

### 真实 SAP 开发环境验证

只在明确允许的 DEV 主机、客户端和命名空间执行：

1. 普通读取在默认 60 秒内完成。
2. 调试、ATC、trace 长请求没有被通用超时错误覆盖专用超时。
3. 同时发起两个工具时，第二个进入队列且 SAP 会话不交叉。
4. 队列满时请求未到达 SAP。
5. 查询 200、5000、5001 行分别验证默认、上限和超限拒绝。
6. 宽表响应达到字节上限时返回结构化错误且不泄漏完整结果。
7. 大源码首次分页访问 SAP，后续分页命中缓存；完整读取仍刷新 SAP。
8. 安全变更成功后计划大字段已清理。
9. 模拟激活失败时自动回滚仍使用精确 originalSource。
10. 写入超时时先核验 SAP 状态，不自动重试。
11. 审计文件连续 JSONL 可解析，目录权限和磁盘告警有效。

真实 SAP 未完成前，最终汇报必须把“代码/测试/编译已验证”与“SAP 会话、性能、锁和超时未验证”分开。

## 14. 完成定义

- 所有新增护栏默认启用并覆盖 `safe` 与 `legacy-full`。
- 正常范围内现有工具名称、输入字段和成功响应主体保持兼容。
- 自动回滚能力不被削弱，终态或过期计划不再长期持有完整源码。
- 查询超限在调用 SAP 前拒绝，响应超限在返回 MCP 客户端前拒绝。
- 默认成功请求不再输出 info 日志，安全审计仍逐条可靠落盘。
- 全量测试、定向覆盖率和 TypeScript 构建通过。
- 文档、示例配置与实现一致。
- 工作区原有改动被保留，没有无关清理或提交。
