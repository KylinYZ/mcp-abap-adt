# 安全 ABAP 对象创建实施计划

## 目标

在默认 `safe` 模式中增加受控的 ABAP 对象创建流程，使模型能够在不依赖 SAP GUI 预建空壳的情况下创建并部署 `PROGRAM`、`FUNCTION_GROUP` 和 `FUNCTION_MODULE`。首期不维护函数模块接口参数，不创建或释放传输请求，不写生产系统。

## 实施原则

- 复用现有安全策略、确认机制、串行执行门控、审计、超时和参数/响应限制。
- 创建流程与源码修改流程分离，避免把不同的失败恢复语义混在 `AbapChangeWorkflow` 中。
- 对外只接受业务字段，不接受模型提供的 ADT URL、锁句柄或激活引用。
- 预览零写入；应用只消费预览时冻结的对象图、源码和传输。
- 自动补偿只能删除由当前计划明确创建并再次证明身份的对象。
- 当前工作区已有其他未提交修改；所有编辑以磁盘当前内容为基础，提交时只纳入本功能文件和精确代码块。

## 任务 1：补齐创建领域类型与错误模型

文件：

- 新增 `src/safe/creationTypes.ts`
- 修改 `src/safe/errors.ts`
- 新增 `src/__tests__/CreationTypes.test.ts`
- 修改 `src/__tests__/errors.test.ts`

步骤：

1. 定义 `PROGRAM`、`FUNCTION_GROUP`、`FUNCTION_MODULE` 的判别联合输入类型。
2. 定义规范化对象描述、创建计划、阶段、状态、已创建对象和补偿结果。
3. 增加创建专用错误码及明确的下一步提示。
4. 测试非法对象图、字段组合、状态和错误响应。

验证：

```powershell
npm test -- --runInBand src/__tests__/CreationTypes.test.ts src/__tests__/errors.test.ts
```

## 任务 2：实现对象图解析与只读预检查

文件：

- 新增 `src/safe/AbapCreationResolver.ts`
- 新增 `src/__tests__/AbapCreationResolver.test.ts`
- 局部扩展 `src/safe/types.ts` 中的 `SafeAdtClient`

步骤：

1. 解析并大写对象类型、名称、包和父函数组。
2. 限制对象图只能是单个受支持对象，或“新函数组 + 其首个函数模块”。
3. 验证命名空间、包非 `$TMP`、源码必填/禁止规则和源码首尾框架。
4. 使用精确名称、ADT 类型和 URI 三重条件证明目标不存在。
5. 验证现有包和父函数组，内部推导创建、源码、锁定和激活 URL。
6. 对搜索歧义、父对象缺失、目标已存在和非法 URL 输入返回专用错误。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapCreationResolver.test.ts
```

## 任务 3：实现创建计划存储

文件：

- 新增 `src/safe/CreationPlanStore.ts`
- 新增 `src/__tests__/CreationPlanStore.test.ts`

步骤：

1. 实现短期计划 ID、TTL、容量限制和一次性消费。
2. 实现 `PREVIEWED`、`APPLYING`、`APPLIED`、`COMPENSATED`、`COMPENSATION_FAILED`、`FAILED`、`EXPIRED` 状态。
3. 终态清除完整源码，只保留哈希、对象身份、阶段和恢复证据。
4. `COMPENSATION_FAILED` 按现有回滚失败保留策略延迟清理，便于人工恢复。

验证：

```powershell
npm test -- --runInBand src/__tests__/CreationPlanStore.test.ts
```

## 任务 4：实现创建工作流

文件：

- 新增 `src/safe/AbapObjectCreationWorkflow.ts`
- 新增 `src/__tests__/AbapObjectCreationWorkflow.test.ts`
- 局部扩展 `src/safe/AuditLogger.ts`
- 局部复用 `src/safe/sourceTools.ts`

步骤：

1. 预览时执行策略、传输格式、对象图、父对象、目标不存在和 ADT 名称验证。
2. 校验传输请求仍未释放，并与包或父对象上下文一致。
3. 返回完整待部署源码、哈希、执行顺序和非事务补偿警告；不调用锁定、创建、写入、激活或删除。
4. 应用前重新验证策略、传输和目标不存在。
5. 按依赖顺序创建对象，并在每次创建后解析实际对象身份。
6. 对程序和函数模块执行锁定、整段源码写入、语法检查、解锁和激活。
7. 对函数组只验证 SAP 生成的活动对象、包和源码链接，不覆盖函数池主源码。
8. 复读程序和函数模块源码，只容忍换行归一化。
9. 任一步骤失败后按反向依赖顺序补偿；身份不确定时停止自动删除并返回人工检查信息。
10. 审计记录计划、对象、阶段、传输、哈希、确认和补偿状态，不记录完整源码或敏感值。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts src/__tests__/AuditLogger.test.ts
```

## 任务 5：接入确认机制和 safe 工具目录

文件：

- 新增 `src/safe/AbapCreationConfirmation.ts`
- 新增 `src/__tests__/AbapCreationConfirmation.test.ts`
- 修改 `src/handlers/SafeAbapHandlers.ts`
- 修改 `src/__tests__/SafeAbapHandlers.test.ts`
- 修改 `src/index.ts`
- 修改 `src/__tests__/serverGuardrails.test.ts`

步骤：

1. 复用原生 `elicitation.form` 和显式启用的文字降级确认语义。
2. 增加 `previewAbapObjectCreation`、`applyAbapObjectCreation`、`getAbapObjectCreationStatus` 三个工具。
3. 标注预览为只读租户操作、应用为需批准的租户写操作、状态为本地只读操作。
4. 确认等待不占用 SAP 执行槽；确认完成后的完整应用和补偿在同一个 FIFO gate 中执行。
5. 保持 `legacy-full` 原有工具及返回契约不变。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapCreationConfirmation.test.ts src/__tests__/SafeAbapHandlers.test.ts src/__tests__/serverGuardrails.test.ts
```

## 任务 6：中文文档与配置同步

文件：

- 修改 `README.zh-CN.md`
- 修改 `docs/使用指南.md`
- 修改 `.env.example`（仅在新增配置确有必要时）
- 修改 `CHANGELOG.md`

步骤：

1. 将默认 `safe` 工具数量和能力边界更新为源码修改加对象创建。
2. 增加三种受支持对象图的中文 JSONC 示例。
3. 明确函数组源码由 SAP 生成、函数接口参数仍未支持、补偿不是数据库事务。
4. 明确代码验证、SAP DEV 实测、传输内容检查和生产验证是不同层次。
5. 不修改英文文档，除非现有英文声明会因工具数量变化而变成错误事实；若必须修改，仅同步事实，不新增英文设计文档。

验证：

```powershell
rg -n "四个工具|只支持受控修改|previewAbapObjectCreation|FUNCTION_GROUP|函数模块接口" README.zh-CN.md docs/使用指南.md README.md
```

## 任务 7：完整自动化验证

执行：

```powershell
npm test -- --runInBand
npm run build
git diff --check
```

验收重点：

- 现有源码变更测试全部通过。
- 新增创建测试覆盖成功路径和每个远程阶段的失败注入。
- `safe` 与 `legacy-full` 都经过中央参数、响应、超时和串行门控。
- 预览测试证明没有任何 SAP 写调用。
- 终态计划和审计均不泄露完整源码、确认短语、锁句柄或凭据。

## 任务 8：真实 SAP DEV 验证（需单独明确确认）

真实验证会创建、激活并可能删除 SAP 对象，不能由代码实现授权自动推导。自动化验证完成后，先向用户展示：

- 精确测试对象名。
- 使用的现有未释放传输请求。
- 预览结果和完整源码。
- 成功后保留还是清理测试对象。
- 故障注入及补偿会执行哪些删除操作。

得到明确确认后，依次验证程序、函数组、函数模块和失败补偿，并分别记录激活、源码复读、锁、传输内容和清理结果。不得连接生产系统，不得创建或释放传输请求。

## 提交策略

1. 实施计划单独提交。
2. 功能代码、测试和必要文档作为一个聚焦提交，精确暂存文件或代码块。
3. 不纳入当前工作区原有 SM21、文档或其他未提交修改，除非它们与本功能发生不可分割的同文件重叠；发生重叠时保留当前内容并只提交本功能增量。

