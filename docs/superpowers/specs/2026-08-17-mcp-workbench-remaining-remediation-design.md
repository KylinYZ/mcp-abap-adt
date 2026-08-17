# MCP 与 SAP ABAP ADT Workbench 剩余问题修复设计

## 状态

- 日期：2026-08-17
- MCP 当前基线：`0.3.0`，提交 `8a40e52`
- Workbench 当前基线：`0.2.0`，提交 `31b6061`
- 目标版本：MCP `0.4.0`、Workbench `0.3.0`
- 用户已批准兼容式次版本升级

## 背景

任务 `019ff9f0-3146-7202-a1f4-7f9ab346a10e` 已完成内置 ADT 客户端、完整低层能力、受控 DDIC/包/RAP 工作流和安全调试 listener 生命周期。本设计不重复或替换这些工作。

当前自动化基线为 49 个 Jest 套件、353 项测试和通过的 TypeScript build。重新审计与只读 SAP 探针确认仍存在以下问题：

1. `dumps` 接受任意查询字符串并返回完整 feed；历史现场曾返回约 835 KB，且自由文本条件在目标版本发生转换错误。
2. `ddicElement` 面向 DDL element-info，不能可靠读取经典透明表字段。
3. development 与 diagnostic-readonly 的工具目录约为 58 KB 和 38 KB，三类 Workbench 任务都加载了大量无关工具。
4. Workbench 的 MCP 契约校验依赖源码字符串、固定数量和测试文本，不能证明实际运行时目录及 schema。
5. Workbench 有静态 eval 定义，但没有保留真实模型输出、基线、评分和人工评审结果。
6. 缺少高层系统能力概览、ABAP 成员级源码读取和受控 ATC/ABAP Unit 执行流程。
7. 部分文档把 ST22 摘要描述成包含当前解析器未提供的字段，并保留了已经过期的应用加载状态。

## 设计目标

1. 保持现有工具名、输入和正常返回契约；所有改进通过新增工具、可选字段或新增 profile 完成。
2. 保持 DEV 受控执行、QAS/PRD 只读、原生确认、未知远端结果不盲重试。
3. 为三个 Workbench Skill 提供任务型最小工具目录，降低模型选择成本和上下文开销。
4. 用运行时行为而非源码字符串证明 MCP/Workbench 契约。
5. 将静态 eval、真实模型 benchmark、真实 SAP 证据和未验证项清晰分开。

## 非目标

- 不删除或重命名 `safe`、`development`、`diagnostic-readonly`、`legacy-full`。
- 不改变现有 `dumps`、`ddicElement`、`tableContents`、`runQuery` 等低层工具的正常返回结构。
- 不自动执行真实 SAP 写入、ATC、ABAP Unit、程序、trace 或 transport release。
- 不把配置中的系统角色、host 或 client 当成已验证的 SAP 连接事实。
- 不为降低远端调用数而移除源码漂移、transport、语法、激活、重读或恢复检查。

## 方案选择

### 方案 A：仅修现有缺陷

只新增受限 ST22 与经典表 schema 工具，并增强契约校验。风险低，但工具目录、模型评测和高层工作流缺口仍存在，不能完成“修复全部剩余可修复问题”的目标。

### 方案 B：兼容式分层升级

保留全部旧契约，新增高层工具、任务型 profile、动态契约校验、模型 benchmark 和文档同步。该方案满足目标并允许现有调用方按原配置继续运行。

### 方案 C：替换旧工具目录

删除大部分低层工具，只保留任务型 facade。上下文最小，但会破坏已有 profile 和专家兼容场景，不符合兼容要求。

采用方案 B。

## MCP 高层只读工具

### `readRuntimeDumps`

输入：

- `from`、`to`：必填 ISO-8601 时间；转换为目标 SAP feed 接受的本地时间值。
- `limit`：可选，默认 20，范围 1..50。
- `user`、`objectName`、`runtimeError`、`exception`：可选精确或 contains 条件；每项做长度和字符集限制。

行为：

1. 要求非空时间窗，拒绝反向时间和超过配置上限的窗口。
2. 只使用 feed 声明支持的 `datetime`、`user`、`objectName`、`runtimeError`、`exception` 属性和 operator 生成 `$query`。
3. 不接受调用方传入原始 feed 查询语法。
4. 扩展内置 dump 解析器，读取 entry 的 `published`、`updated`；新增字段为可选字段，保持旧 `dumps` 兼容。
5. 返回最多 `limit` 条精简摘要、feed 更新时间、`returnedCount`、`feedCount` 和 `truncated`。
6. 不自动读取完整 dump 正文、源码、SM21、trace 或 debugger。

错误：

- 输入错误返回稳定的请求错误，不访问 SAP。
- SAP 不支持声明的属性或查询时返回兼容性错误，不退回无界 `dumps`。
- 超时或响应过大时返回受限错误，不包含原始响应。

只读 SAP 探针已确认当前目标 feed 声明 `paging=50`，支持 `datetime`、`user`、`objectName`、`runtimeError`、`exception`，结构化时间范围查询成功。

### `describeClassicTable`

输入：

- `tableName`：必填、标准化为大写，只接受一个合法 ABAP Dictionary 标识符。

行为：

1. 调用数据预览协议执行系统生成的 `SELECT * FROM <table> WHERE 1 = 0`。
2. 只返回列元数据：`name`、`type`、`description`、`keyAttribute`、`colType`、`isKeyFigure`、`length`。
3. 若结果包含任何数据行，工具失败关闭，不向调用方返回行值。
4. 不接受任意 SQL、WHERE 条件或调用方字段列表。

只读 SAP 探针已确认经典表 `T000` 返回 17 个字段元数据和 0 行值。

### `inspectSapSystem`

输入为空。

行为：

1. 返回 MCP 本地配置身份和 `sapConnectionVerified: false` 的初始状态。
2. 分别尝试最小 ADT discovery、feed capability 和 object-type capability；一个能力失败不抹掉其他证据。
3. 返回每项 `CONFIRMED`、`UNAVAILABLE` 或 `FAILED`，并给出受限原因类别。
4. 只有响应中明确存在 release/product 字段时才返回系统版本；不从语法、工具存在或配置推断版本。
5. 不返回 credential、cookie、CSRF token、完整 URL query 或底层响应正文。

### `getAbapMemberSource`

输入：

- `objectName`、`objectType`、`memberName`，以及可选 `version`。
- 支持首版可证明具有稳定 source range 的 class method、class include/member 和 function module。

行为：

1. 使用现有对象解析器获取准确 ADT URL，不接受调用方拼接 URL。
2. 读取 object structure/elements 和完整源码，按服务器返回的范围裁剪一个成员。
3. 返回成员身份、范围、源码片段和完整源码 hash，但不缓存片段作为写入基线。
4. 范围不存在、重名或越界时失败，不使用文本正则猜测方法边界。
5. 任何源码修改仍从 `inspectAbapObject` 的完整源码开始，并使用现有 preview/apply。

## 受控质量检查工作流

新增三个 development-profile 工具：

- `previewQualityCheck`
- `runQualityCheck`
- `getQualityCheckStatus`

### 计划模型

`previewQualityCheck` 接受：

- `kind`：`ABAP_UNIT` 或 `ATC`。
- 1..20 个准确对象身份。
- ATC 可选 variant；未提供时只读取并返回目标系统默认/可用 variant，不擅自选择组织标准。
- 风险说明、预期范围和可选超时，但不接受任意底层 URI。

Preview 只解析对象、验证 DEV/profile/allow-list、读取必要元数据并创建短期 plan；不执行测试或 ATC。

`runQualityCheck` 只接受 `qualityPlanId`，打开一次 MCP 原生 form，明确显示种类、对象、variant、潜在运行负载和测试代码可能具有副作用。没有原生 form 时失败关闭，不提供文字降级。

确认后：

1. 重新验证 plan 绑定的 host、client、user、role、profile、对象和必要元数据。
2. 恰好调用一次现有 `unitTestRun` 或 `createAtcRun`。
3. 读取并返回受限结果或可追踪 run/worklist 标识。
4. 请求结果未知时标记 `UNKNOWN_OUTCOME`，只允许状态读取；绝不自动重跑。
5. 不申请 ATC exemption，不修改联系人，不运行程序，不创建 trace，不发布或释放 transport。

质量计划沿用现有 plan store 的容量、TTL、payload 清理、绑定上下文和审计模式，但使用独立类型，避免与源码、调试或高级操作 plan 混用。

## 任务型 profile

新增并保留旧 profile：

| Profile | 用途 | 写/执行边界 |
| --- | --- | --- |
| `development-workbench` | ABAP 开发、源码根因、受控修改、受控调试、受控质量检查 | 仅 DEV；所有高风险操作走 facade 与原生确认 |
| `business-readonly` | DDIC、经典表 schema、有限数据、业务链路证据 | 所有角色只读 |
| `operations-readonly` | 系统能力、ST22、SM21、inactive、revision、现有 trace/debug 状态 | 所有角色只读 |

集合必须显式列出工具名，不以“所有 read-only”自动扩张。任何新增工具未分类、重复、出现在错误 profile 或使 QAS/PRD 暴露执行工具时，启动和测试失败。

旧 profile 的工具名集合和正常返回契约保持不变；新增高层只读工具可加入旧 development/diagnostic/legacy，但旧工具不会被移除。最终数量由实现后运行时目录锁定，不在设计阶段猜测。

验收记录每个 profile 的 `tools/list` UTF-8 字节数。三个任务型 profile 必须分别小于它们替代的 development 或 diagnostic-readonly 目录，并在 Workbench 文档中记录实测值。

## Workbench 路由

三个 Skill 分别使用：

- `sap-abap-development` → `sap-dev` / `development-workbench`
- `sap-business-data-diagnosis` → DEV/QAS/PRD 对应实例 / `business-readonly`
- `sap-system-operations-diagnosis` → DEV/QAS/PRD 对应实例 / `operations-readonly`

环境仍由用户或已有上下文明确选择。Skill 不因为 profile 更窄而跨实例补工具，也不把隐藏工具名作为绕过方式。

## 动态契约校验

Workbench `validate-mcp-contract.mjs` 改为：

1. 验证 MCP package/version 和 build 入口。
2. 在隔离子进程中以假的非敏感连接配置实例化已构建服务器。
3. 对每个 profile/role 读取真实 runtime catalog。
4. 校验准确工具名集合、唯一性、input schema、readOnly/destructive/idempotent annotations 和 operation classification。
5. 直接 dispatch 伪造的 QAS/PRD 写工具，证明在 handler/ADT 调用前被拒绝。
6. 校验新增高层工具存在于正确 profile，原始危险工具未进入任务型 profile。
7. 校验 MCP、Claude plugin、Codex plugin、README 和 capability 文档版本一致。

源码字符串搜索只用于补充陈旧事实扫描，不再作为运行契约的主要证据。

## Skill 评测

### 静态 eval

保留并扩展现有三组 Skill eval、trigger eval 和 cross-skill routing，覆盖：

- bounded ST22；
- classic table schema；
- system capability 的部分成功；
- member source 与完整写入基线的区分；
- ATC/Unit preview、原生确认、未知结果不重跑；
- 三个任务型 profile 的正确路由。

### 真实模型 benchmark

按照 `skill-creator`：

1. 冻结 `0.2.0` Skill 快照作为 baseline。
2. 选择 2..3 个代表性 prompt，每个同时运行新 Skill 和旧 Skill。
3. 保存真实输出、timing、token、断言评分和分析。
4. 使用官方 `eval-viewer/generate_review.py` 生成评审页面。
5. 由用户人工检查输出；静态 contract 页面不能冒充模型 benchmark。

不执行真实 SAP 写入的 eval 只评估工作流选择。任何真实 ATC/Unit 或 SAP 写入需要新的操作级授权和单独证据文件。

## 文档一致性

更新 MCP 与 Workbench 文档：

- 工具和 profile 数量从运行时生成或由动态契约验证。
- ST22 只声明实际解析并返回的字段。
- 经典表 schema 指向 `describeClassicTable`，不再建议用业务数据 preview 猜字段。
- 区分源码构建通过、真实 SAP 只读验证、真实执行/写入未验证、Codex 插件加载未验证。
- 历史 `93/79/79`、`0.3.0` 和 `0.2.0` 证据保留时必须明确标注历史基线。
- 修复本地链接、anchor、版本、commit、测试数量和 profile 字节数漂移。

## 测试设计

### MCP 自动化

- Dump query builder：时间边界、字符限制、操作符、时区、limit、截断和 parser 时间字段。
- Classic table schema：合法表名、零行 SQL、字段映射、意外数据行失败关闭。
- System inspection：全部成功、部分失败、release 缺失和错误脱敏。
- Member source：准确 range、越界、重名、不支持对象和完整 hash。
- Quality workflow：preview 无执行、单次确认、单次调用、漂移拒绝、QAS/PRD 拒绝、UNKNOWN_OUTCOME 不重跑、payload 清理。
- Profile：旧集合兼容、新集合准确、QAS/PRD 全部 local/read-only、目录字节数上限。
- 现有 49/353 全量回归和 TypeScript build。

### Workbench 自动化

- 三个 Skill quick validation。
- plugin manifest validation。
- 动态 MCP runtime contract。
- JSON、Markdown 链接、版本和陈旧事实扫描。
- 静态 eval review 生成。
- 真实模型 benchmark 及人工评审。

### 真实 SAP

无需新授权即可执行的最终只读验收：

- DEV/QAS/PRD `inspectSapSystem`；
- bounded ST22；
- `describeClassicTable` 零行业务值；
- 支持对象的 member source；
- 三个任务型 profile 的目录和角色边界。

不在本目标中自动执行：

- ABAP Unit、ATC；
- source/DDIC/package/RAP/debug 写或控制；
- transport release；
- Codex UI 插件安装权限提升。

未执行项必须记录为环境或授权边界，不能用 fake client 测试替代真实 SAP 结论。

## 实施顺序

1. 新增高层只读工具及定向测试。
2. 新增任务型 profile 并测量目录。
3. 新增受控质量检查 plan、确认和状态工具。
4. 强化 Workbench 动态契约校验。
5. 更新三个 Skill、references、manifests、eval 和文档。
6. 执行模型 benchmark 与人工评审。
7. 执行完整自动化和已授权的真实 SAP 只读验收。
8. 完成要求逐项审计后再关闭目标。

## 完成标准

只有以下条件同时满足才可标记完成：

1. 现有 profile/工具正常契约兼容，MCP `0.4.0` 全量测试与 build 通过。
2. 四个高层只读能力及质量检查 workflow 有覆盖核心分支的自动化。
3. QAS、PRD、缺失和未知角色不能看到或 dispatch 任何新增执行/写入工具。
4. Workbench `0.3.0` 使用任务型 profile，动态契约校验真实 runtime catalog。
5. 目录字节数实测下降并写入文档。
6. Skill 静态 eval 和真实模型 benchmark 分开保存，人工评审完成。
7. 文档、版本、数量、链接和证据边界一致。
8. 新高层只读工具完成 DEV/QAS/PRD 真实只读验收；未授权执行项明确列为未验证。

