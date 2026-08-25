# 受控仓库对象创建平台 Phase 0/1 实施计划

## 1. 范围

本计划实施设计文档中的 Phase 0 和 Phase 1：统一平台骨架、现有三类型兼容、包创建和数据库表创建。后续对象族使用同一平台分批接入，不在本计划中一次性开放。

权威设计：`docs/superpowers/specs/2026-08-19-controlled-repository-object-creation-platform-design.md`。

## 2. 实施顺序

### Task 1：建立能力模型和 Registry

新增：

- `src/safe/repositoryCreationTypes.ts`
- `src/safe/RepositoryObjectCreationRegistry.ts`
- `src/safe/repositoryCreationCapabilities.ts`

要求：

- 定义五工具使用的稳定对象种类、成熟度和 availability 结果。
- 首批注册 `PROGRAM`、`FUNCTION_GROUP`、`FUNCTION_MODULE`、`PACKAGE`、`DATABASE_TABLE`。
- `writable` 只能由 `REAL_DEV_VERIFIED` 和当前 DEV/Profile availability 共同决定。
- capability 输出不得包含 SAP JAR 原文、任意 URL 或远端秘密。

测试：

- `src/__tests__/RepositoryObjectCreationRegistry.test.ts`
- 覆盖重复注册、未知类型、成熟度、不可用原因和输出稳定性。

### Task 2：增加 list/describe Handler

新增：

- `src/handlers/RepositoryObjectCreationHandlers.ts`

修改：

- `src/index.ts`
- `src/config/ToolProfiles.ts`
- `src/config/ToolOperationPolicy.ts`
- 工具目录和预算测试。

要求：

- 注册 `listRepositoryObjectCreationCapabilities` 和 `describeRepositoryObjectCreation`。
- 仅在 DEV 的 `development`、`development-workbench` 可见和可调度。
- QAS、PRD 和其他 Profile 双重拒绝。

测试：

- `src/__tests__/RepositoryObjectCreationHandlers.test.ts`
- `src/__tests__/ToolCatalogIntegrity.test.ts`
- `src/__tests__/ToolCatalogBudget.test.ts`

### Task 3：建立统一计划与 Workflow

新增：

- `src/safe/RepositoryObjectCreationPlanStore.ts`
- `src/safe/RepositoryObjectCreationWorkflow.ts`
- `src/safe/RepositoryObjectCreationConfirmation.ts`

要求：

- 实现 `PREVIEWED`、`APPLYING`、`APPLIED`、`FAILED`、`OUTCOME_UNKNOWN`、`COMPENSATED`、`COMPENSATION_FAILED`、`EXPIRED`。
- 计划绑定主机、客户端、SAP 用户、系统角色和 Profile。
- apply 只接受 plan id，并由服务端触发一次 native form elicitation。
- 不提供文字确认降级。
- 写请求结果未知时先只读核验，不重试、不盲删。

测试：

- `src/__tests__/RepositoryObjectCreationPlanStore.test.ts`
- `src/__tests__/RepositoryObjectCreationConfirmation.test.ts`
- `src/__tests__/RepositoryObjectCreationWorkflow.test.ts`

### Task 4：接入现有三类型兼容适配器

新增：

- `src/safe/adapters/AbapSourceCreationAdapter.ts`
- `src/safe/adapters/FunctionGroupCreationAdapter.ts`

修改：

- 现有 `AbapObjectCreationWorkflow` 只保留兼容门面，内部逐步委托新平台。

要求：

- 程序、函数组、函数模块的现有 safe 工具名称、Schema 和返回契约不变。
- 保留现有函数模块格式比较、激活顺序、未知结果和逆序补偿。

### Task 5：修正并类型化包 ADT 客户端

修改：

- `src/adt/api/objectcreator.ts`
- `src/adt/AdtClient.ts`
- `src/adt/index.ts`

新增必要的包请求模型和契约 fixture。

要求：

- basic/full validation 使用已确认的 query 名称，full 包含 `transportlayer`、`recordChanges=true`、`checkmode=full`。
- 创建使用 packages V2 XML 和精确 Accept/Content-Type。
- 移除硬编码 `YMU_RAP`。
- 固定 development、encapsulated、record changes，并使用真实父包。
- 解析 `201 Location` 和响应对象身份。

测试：

- 请求参数、XML、媒体类型、Location、SAP 错误和未知结果。

### Task 6：实现包适配器

新增：

- `src/safe/adapters/PackageCreationAdapter.ts`

要求：

- 核验父包、constraints、软件组件、传输层、名称空间和目标缺失。
- preview 返回固定安全属性和完整阶段图。
- apply 创建后读取并验证父包、软件组件、传输层和固定属性。
- 仅在能证明包由当前计划创建且为空时允许自动补偿删除。

### Task 7：实现表 DDL 生成和底层 ADT API

新增：

- `src/safe/tableDefinition.ts`
- `src/adt/api/tableCreation.ts`

修改：

- `src/adt/AdtClient.ts`
- `src/adt/index.ts`

要求：

- 结构化字段输入生成受控 table DDL。
- 支持内置类型、数据元素类型和 `CURR`/`QUAN` 引用。
- 禁止任意 annotation 注入。
- 实现 table shell、source main、`tableStatusCheck`、`abapCheckRun`、technical settings V2、working area/active 读取和独立激活。

测试：

- DDL 快照、非法类型、重复字段、引用缺失、引用类型错误、请求 URL、query、媒体类型和 XML。

### Task 8：实现数据库表适配器

新增：

- `src/safe/adapters/DatabaseTableCreationAdapter.ts`

要求：

- shell -> lock -> checks -> source PUT -> working-area verify -> unlock -> table activate -> settings lock/write/unlock/activate -> active verify。
- 所有远端写阶段串行。
- 表主体和技术设置分别记录激活及验证结果。
- 失败后只删除所有权明确的新表；未知结果停止补偿。

### Task 9：完成五工具和服务器接线

修改：

- `src/handlers/RepositoryObjectCreationHandlers.ts`
- `src/index.ts`
- `src/config/ToolProfiles.ts`
- `src/config/ToolOperationPolicy.ts`

要求：

- 补齐 preview/apply/status 三工具。
- apply 由 handler 内 confirmation 组件调用 Workflow，不接受外部确认布尔值。
- Profile 目录、dispatch、请求大小和响应大小限制全部覆盖。

### Task 10：文档与自动化收口

修改：

- `README.md`
- `README.zh-CN.md`
- `docs/使用指南.md`
- `.env.example`（仅在新增配置时）
- 工具目录、计数和契约 fixture。

运行：

```powershell
npm test -- --runInBand
npm run build
npm run check:adt-imports
git diff --check
```

必须区分自动化通过与真实 SAP 写入验证。

### Task 11：真实 SAP DEV 分级验证

1. list/describe availability。
2. 包和表 preview，确认零 mutation。
3. 原生确认后创建隔离子包并验证。
4. 原生确认后创建普通表并验证。
5. 验证 `CURR`/`QUAN` 引用和技术设置。
6. 检查锁、传输内容和测试对象清理。

任何写请求结果未知时停止，不重试。真实写入和清理由各自独立的原生确认保护。

## 3. 完成条件

- Phase 0/1 所有代码、测试和文档完成。
- `safe` 七工具契约不变。
- 新五工具只在合法 DEV `development`/`development-workbench` 出现。
- 包和数据库表只有在真实 DEV 完整验证后返回 `writable=true`。
- 自动化、真实 SAP、清理和仍未验证项分别有证据记录。
