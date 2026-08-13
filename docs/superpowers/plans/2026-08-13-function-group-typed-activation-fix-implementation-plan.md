# 函数组 Typed Activation 修复实施计划

## 目标

修复安全对象创建流程中新建函数组激活失败的问题：让 `FUNCTION_GROUP` 使用包含 `FUGR/F` 和父包 URI 的 typed activation；同时补齐激活失败的脱敏诊断和激活请求结果不确定时的只读判定，避免误删可能已经激活成功的对象。

本次只修复对象创建流程，不实现函数模块接口参数维护，不改变程序激活方式，不创建或释放传输请求，不写生产系统。

## 实施原则

- 以已提交设计 `docs/superpowers/specs/2026-08-13-function-group-typed-activation-fix-design.md` 为唯一范围基线。
- 先补失败测试，再修改实现。
- `PROGRAM` 保持字符串激活；`FUNCTION_GROUP` 和 `FUNCTION_MODULE` 使用 typed activation。
- 激活明确返回失败时允许进入现有安全补偿；激活请求抛异常时先只读核对 active/inactive 状态，不能确定时禁止自动删除。
- 不记录完整 SAP 响应、源码、凭据、Cookie、CSRF Token、用户标识或锁句柄。
- 工作区存在未提交 SM21 修改；所有编辑基于当前磁盘内容，提交时只纳入本修复的文件和精确代码块。
- 自动化和构建通过不等于真实 SAP DEV 已验证；真实复测必须重新预览并获得用户明确确认。

## 任务 1：用回归测试锁定激活请求契约

文件：

- 修改 `src/__tests__/AbapObjectCreationWorkflow.test.ts`

步骤：

1. 将现有“新函数组 + 首个函数模块”测试拆分出可观察的激活参数，不再只记录是否调用 `activate`。
2. 增加函数组成功路径断言：
   - 使用 typed overload。
   - `adtcore:uri` 等于创建后解析出的实际函数组 URI。
   - `adtcore:type` 为 `FUGR/F`。
   - `adtcore:name` 为函数组名。
   - `adtcore:parentUri` 为开发包 URI。
   - `preauditRequested` 保持既定值。
3. 保留并强化函数模块断言：类型为 `FUGR/FF`，父 URI 为函数组 URI。
4. 增加程序回归断言：仍使用字符串重载，不受本修复影响。
5. 先运行定向测试，确认函数组 typed activation 测试在修改实现前失败。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts
```

## 任务 2：增加脱敏激活失败诊断

文件：

- 修改 `src/safe/AbapObjectCreationWorkflow.ts`
- 视类型需要局部修改 `src/safe/creationTypes.ts`
- 修改 `src/__tests__/AbapObjectCreationWorkflow.test.ts`

步骤：

1. 新增小型纯函数，将 `ActivationResult` 转换为安全诊断：
   - `inactiveCount`。
   - 与当前对象名称、类型或 URI 匹配的 inactive 对象引用。
   - SAP 短消息列表。
2. 诊断只保留 URI、类型、名称和父 URI，不保留用户字段、传输任务内容或完整响应。
3. `activate` 明确返回 `success=false` 时继续抛出 `ACTIVATION_FAILED / activate`，并把安全诊断放入错误 `details`。
4. 没有短消息时使用稳定错误摘要，不把空字符串或底层对象序列化给调用方。
5. 增加测试证明错误详情包含安全诊断，同时不包含源码、锁句柄、Cookie、凭据或用户字段。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts src/__tests__/errors.test.ts
```

## 任务 3：实现函数组 Typed Activation

文件：

- 修改 `src/safe/AbapObjectCreationWorkflow.ts`
- 修改 `src/__tests__/AbapObjectCreationWorkflow.test.ts`

步骤：

1. 抽取内部激活对象引用构造逻辑，避免函数组和函数模块重复拼装字段。
2. 对 `FUNCTION_GROUP` 构造：
   - URI：`actualObjectUrl`。
   - 类型：`FUGR/F`。
   - 名称：`objectName`。
   - 父 URI：计划解析出的 `parentPath`，即开发包 URI。
3. 对 `FUNCTION_MODULE` 继续构造 `FUGR/FF` 和父函数组 URI。
4. 两类函数对象均调用 typed overload；`PROGRAM` 继续使用现有字符串重载。
5. typed activation 成功后仍执行活动版本解析或源码复读，不能把 HTTP 成功直接视为业务成功。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts
```

## 任务 4：保护激活请求结果不确定场景

文件：

- 修改 `src/safe/AbapObjectCreationWorkflow.ts`
- 视状态字段需要局部修改 `src/safe/creationTypes.ts`
- 修改 `src/__tests__/AbapObjectCreationWorkflow.test.ts`

步骤：

1. 区分两类失败：
   - `activate` 返回 `success=false`：SAP 已明确报告失败，可按现有规则补偿。
   - `activate` 抛出超时、连接重置或其他请求异常：远端结果未知，不能直接删除。
2. 请求异常后只读检查同一对象：
   - 先按 `active` 版本解析；成功且身份匹配时，把激活视为已完成，继续后续复核，不重发激活请求。
   - active 未确认时，再按非活动版本解析；若能精确证明对象仍为本计划创建的 inactive 对象，可抛出明确激活失败并允许现有补偿。
   - active 与 inactive 均无法可靠确认时，标记结果不确定，禁止自动删除，计划进入需要人工检查的终态。
3. 不新增自动重试，不调用低层 `legacy-full` 写工具，不绕过原生确认。
4. 增加三类测试：异常后 active 已存在、异常后仅 inactive 存在、异常后状态无法判断。
5. 验证状态无法判断时 `deleteObject` 从未被调用，错误结果清楚列出需检查的对象和阶段。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts src/__tests__/CreationPlanStore.test.ts
```

## 任务 5：同步中文文档和现场验证记录

文件：

- 修改 `README.zh-CN.md`
- 修改 `docs/使用指南.md`
- 修改 `CHANGELOG.md`
- 不修改英文 README，除非现有英文事实会因本修复变错；若必须修改，只同步必要事实

步骤：

1. 记录 `PROGRAM ZMCP_CREATE_TEST` 已在 SAP DEV 创建、激活并复读成功，且对象保留。
2. 记录第一次函数组计划在激活失败后安全补偿成功，函数模块未创建，无对象残留。
3. 说明修复采用函数组 typed activation，并保留真实 SAP DEV 复测尚未完成的边界。
4. 说明激活请求结果不确定时先只读判定，无法判定则禁止自动补偿和盲目重试。
5. 继续明确函数模块接口参数维护尚未实现，Fiddler 抓包属于后续第二阶段。

验证：

```powershell
rg -n "ZMCP_CREATE_TEST|ZMCP_IF_TEST|typed activation|接口参数|盲目重试|COMPENSATED" README.zh-CN.md docs/使用指南.md CHANGELOG.md
```

## 任务 6：完整自动化与提交快照验证

先验证完整工作区：

```powershell
npm test -- --runInBand
npm run build
git diff --check
```

然后精确暂存本修复文件和混合文件中的本修复代码块，确认暂存差异不包含 SM21，再从 Git 索引生成独立快照执行：

```powershell
npm test -- --runInBand --coverage=false
npm run build
git diff --cached --check
```

验收重点：

- 函数组 typed activation 参数准确。
- 程序和函数模块现有行为没有回归。
- 明确激活失败仍可安全补偿。
- 激活结果未知时不自动删除。
- 错误、计划视图和审计不泄露敏感内容。
- 暂存提交能够脱离未提交 SM21 代码独立测试和构建。

## 任务 7：提交修复

提交内容：

- 函数组 typed activation 实现。
- 激活失败安全诊断与未知结果保护。
- 对应回归测试。
- 必要的中文文档事实同步。

提交不得包含：

- SM21 源码、测试、SAP 类或文档。
- `.claude` 等用户现有未提交文件。
- 真实 SAP 对象创建结果之外的无关清理。

## 任务 8：真实 SAP DEV 复测（需再次明确确认）

代码提交并重启 MCP 后，先只读确认：

- `ZMCP_IF_TEST` 不存在。
- `Z_MCP_IF_TEST` 不存在。
- `ZMCP_CREATE_TEST` 仍存在且源码正确。
- `S4HK900011` 仍未释放。

然后重新调用 `previewAbapObjectCreation`，向用户展示：

- 开发包 `Z001`。
- 传输请求 `S4HK900011`。
- 函数组 `ZMCP_IF_TEST`。
- 函数模块 `Z_MCP_IF_TEST`。
- 完整函数模块源码。
- 补偿警告和新计划编号。

只有用户再次明确确认后才应用。成功后执行只读复核：

- 计划状态为 `APPLIED`。
- 函数组和函数模块均能按活动版本读取。
- 函数模块源码复读只出现允许的换行规范化或完全一致。
- 无遗留锁，且对象保留用于 Fiddler 抓包。

如果仍失败或结果不确定，立即停止，不自动重试；记录计划状态、对象状态和传输检查缺口，等待用户决定下一步。

## 提交策略

1. 本实施计划单独提交。
2. 代码、测试和必要中文文档作为一个聚焦修复提交。
3. 真实 SAP DEV 复测结果若需要写入文档，复测后再单独提交验收记录，避免把代码验证与运行环境验证混为一谈。
