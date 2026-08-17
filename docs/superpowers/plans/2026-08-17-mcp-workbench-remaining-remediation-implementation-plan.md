# MCP 与 SAP ABAP ADT Workbench 剩余问题修复实施计划

> 状态（2026-08-17）：实现、自动化、构建、动态契约、DEV/QAS/PRD 真实只读验收和模型人工评审均已完成。设计的 8 项完成标准全部具有当前证据。

## 执行合同

本计划实施已批准的设计：

- `docs/superpowers/specs/2026-08-17-mcp-workbench-remaining-remediation-design.md`
- MCP 目标版本 `0.4.0`
- Workbench 目标版本 `0.3.0`

保留现有 profile、工具名和正常返回契约。新增写入或执行能力只在 DEV 通过高层 facade、短期计划和一次 MCP 原生确认开放；QAS、PRD、缺失和未知角色保持 local/read-only。远端结果未知时只读核验，不自动重试。

## Phase 1：受限 ST22 与经典表 schema

### 1.1 ST22 parser 与 query builder

修改：

- `src/adt/api/feeds.ts`
- `src/adt/index.ts`
- 新增 `src/read/RuntimeDumpReader.ts`
- 新增 `src/__tests__/RuntimeDumpReader.test.ts`
- 补充 `src/__tests__/AdtFeedParsing.test.ts`

步骤：

1. 先为 dump entry 的 `published`、`updated` 解析添加失败测试。
2. 添加纯函数 query builder 测试：必填时间窗、最大窗口、limit、可选筛选、字符限制、时区格式和注入拒绝。
3. 实现可选时间字段，保持旧 `Dump` 调用方兼容。
4. 实现只由受支持属性生成的 `$query`，不接受 raw query。
5. 实现默认 20、最大 50 的精简结果和 `truncated` 元数据。

### 1.2 经典表 schema

修改：

- 新增 `src/read/ClassicTableInspector.ts`
- 新增 `src/__tests__/ClassicTableInspector.test.ts`

步骤：

1. 先测试表名标准化、非法标识符拒绝和零行 SQL。
2. 使用 `tableContents(table, 1, false, SELECT * ... WHERE 1 = 0)`。
3. 只映射字段元数据；若 values 非空则失败关闭。
4. 不提供 SQL、WHERE 或字段列表透传。

### 1.3 高层只读 handler

修改：

- 新增 `src/handlers/HighLevelReadHandlers.ts`
- 修改 `src/index.ts`
- 修改 `src/config/ToolOperationPolicy.ts`
- 修改 `src/lib/requestLimits.ts`
- 新增 `src/__tests__/HighLevelReadHandlers.test.ts`
- 修改 `src/__tests__/ToolCatalogIntegrity.test.ts`

先注册：

- `readRuntimeDumps`
- `describeClassicTable`

验收：

```powershell
npm test -- --runInBand src/__tests__/RuntimeDumpReader.test.ts src/__tests__/ClassicTableInspector.test.ts src/__tests__/HighLevelReadHandlers.test.ts
npm run build
```

## Phase 2：系统能力与成员级源码

### 2.1 系统能力概览

修改：

- 新增 `src/read/SystemInspector.ts`
- 修改 `src/handlers/HighLevelReadHandlers.ts`
- 新增 `src/__tests__/SystemInspector.test.ts`

实现：

1. 本地身份与远端证据分开。
2. discovery、feed、object-type 能力独立捕获成功/失败。
3. 只在返回值明确包含版本字段时报告 release/product。
4. 错误只保留类别、HTTP status 和受限摘要。

### 2.2 成员级源码

修改：

- 新增 `src/read/AbapMemberSourceReader.ts`
- 修改 `src/handlers/HighLevelReadHandlers.ts`
- 新增 `src/__tests__/AbapMemberSourceReader.test.ts`

实现：

1. 复用 `AbapObjectResolver` 的服务器端对象解析。
2. 以 object structure/elements 返回的范围定位成员。
3. 读取完整源码后按经过校验的范围裁剪。
4. 返回完整源码 hash，但禁止片段成为写入基线。
5. 无准确 range、重名或越界时失败，不使用正则猜测。

注册：

- `inspectSapSystem`
- `getAbapMemberSource`

验收：

```powershell
npm test -- --runInBand src/__tests__/SystemInspector.test.ts src/__tests__/AbapMemberSourceReader.test.ts src/__tests__/HighLevelReadHandlers.test.ts
npm run build
```

## Phase 3：任务型 profile 与上下文预算

修改：

- `src/config/ToolProfiles.ts`
- `src/safe/types.ts`
- `src/safe/SafetyPolicy.ts`
- `src/index.ts`
- `src/__tests__/SafeAbapHandlers.test.ts`
- `src/__tests__/ToolCatalogIntegrity.test.ts`
- 新增 `src/__tests__/ToolCatalogBudget.test.ts`
- `.env.example`

新增：

- `development-workbench`
- `business-readonly`
- `operations-readonly`

步骤：

1. 先定义每个 profile 的显式工具名集合和失败测试。
2. 保持四个旧 profile 的旧工具名集合不减少。
3. 为每个新 profile 验证 DEV/QAS/PRD/unknown 角色。
4. 测量 runtime `tools/list` UTF-8 字节数；新 profile 必须小于替代目录。
5. 更新健康检查和配置文档中的合法 profile 枚举。

验收：

```powershell
npm test -- --runInBand src/__tests__/ToolCatalogIntegrity.test.ts src/__tests__/ToolCatalogBudget.test.ts src/__tests__/SafetyPolicy.test.ts
npm run build
```

## Phase 4：受控 ATC/ABAP Unit

新增：

- `src/safe/QualityCheckPlanStore.ts`
- `src/safe/QualityCheckWorkflow.ts`
- `src/safe/QualityCheckConfirmation.ts`
- `src/safe/qualityTypes.ts`
- `src/handlers/SafeQualityHandlers.ts`
- 对应五组测试文件

修改：

- `src/index.ts`
- `src/config/ToolOperationPolicy.ts`
- `src/config/ToolProfiles.ts`
- `src/lib/serverGuardrails.ts`
- `src/lib/requestLimits.ts`
- `src/safe/SafetyPolicy.ts`
- `src/__tests__/ToolCatalogIntegrity.test.ts`
- `src/__tests__/serverGuardrails.test.ts`

工具：

- `previewQualityCheck`
- `runQualityCheck`
- `getQualityCheckStatus`

测试先覆盖：

1. Preview 不执行远端测试。
2. 仅 DEV + development-workbench 可创建或运行。
3. run 只接受 plan ID，并使用一次原生 form；无 form 时失败关闭。
4. 确认前不占用 SAP gate；确认后的完整执行在一个 gate 内。
5. 对象、variant 或上下文漂移在执行前拒绝。
6. 恰好一次底层 run；超时/取消/不确定响应标记 `UNKNOWN_OUTCOME`。
7. `UNKNOWN_OUTCOME` 不自动重跑，只允许状态读取。
8. terminal 状态清理私有 payload；审计不包含源码、业务值或完整测试结果。

验收：

```powershell
npm test -- --runInBand src/__tests__/QualityCheckPlanStore.test.ts src/__tests__/QualityCheckWorkflow.test.ts src/__tests__/QualityCheckConfirmation.test.ts src/__tests__/SafeQualityHandlers.test.ts
npm run build
```

## Phase 5：Workbench 动态契约与版本

修改 Workbench：

- `scripts/validate-mcp-contract.mjs`
- 新增 `scripts/runtime-catalog-probe.mjs`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `README.md`
- `references/mcp/setup-three-instances.md`
- `references/mcp/profile-capabilities.md`
- 其他引用 profile/版本的 reference

动态契约步骤：

1. 子进程加载 MCP `dist/index.js`，使用假的非敏感配置实例化服务器。
2. 输出每个 profile/role 的真实 catalog、schema、annotations、operation class 和字节数。
3. 校验旧 profile 兼容、新 profile 准确、角色边界、危险 raw 工具缺席和 QAS/PRD dispatch 拒绝。
4. 校验 MCP/package/plugin/docs 版本一致。
5. 移除将源码字符串和测试文本作为主要证据的断言。

版本：

- MCP package/server 元数据升级 `0.4.0`。
- Workbench 正式 manifest 升级 `0.3.0`；Codex cachebuster 仅使用批准的 helper。

## Phase 6：Skill、文档与评测

修改：

- 三个 `skills/*/SKILL.md`
- 三个 `skills/*/evals/evals.json`
- 三个 `skills/*/evals/trigger-evals.json`
- `evals/cross-skill-routing.json`
- `references/mcp/runtime-diagnostics.md`
- `references/shared/tool-routing.md`
- `references/shared/safety-boundaries.md`
- `evals/README.md`
- MCP README、中文指南、CHANGELOG、AGENTS、`.env.example`

步骤：

1. 三个 Skill 切换到任务型 profile 和新增高层工具。
2. 修复 ST22 字段、classic DDIC 和 app pickup 的过期表述。
3. 增加质量检查原生确认、不盲重试和未授权执行边界。
4. 扫描旧数量、版本、日期、链接和 anchor。
5. 运行三 Skill quick validation、plugin validation、JSON/Markdown 链接检查和静态 review 生成。

## Phase 7：真实模型 benchmark

按照 `skill-creator`：

1. 复制当前 `0.2.0` Skill 为只读 baseline 快照。
2. 创建 2..3 个代表性 eval prompt 和客观断言。
3. 同时运行 new_skill 与 old_skill，保存 outputs、timing、token 和 grading。
4. 聚合 benchmark 并生成官方 review HTML。
5. 请用户人工评审；根据反馈迭代 Skill。

模型 eval 不调用真实 SAP 写入。需要 SAP 数据的 prompt 使用已有脱敏证据或明确限制为工作流方案。

## Phase 8：最终验证与完成审计

MCP：

```powershell
npm run check:adt-imports
npm test -- --runInBand
npm run build
git diff --check
```

Workbench：

```powershell
node scripts/validate-mcp-contract.mjs ..\mcp-abap-abap-adt-api
node scripts/generate-static-eval-review.mjs ..\mcp-abap-abap-adt-api
```

补充：

- 三 Skill quick validation。
- plugin manifest validation。
- JSON parse、Markdown links、敏感信息、绝对本地路径、陈旧事实扫描。
- runtime catalog 名称、数量、字节数和角色矩阵报告。
- DEV/QAS/PRD 新高层只读工具真实验收；输出脱敏。

不自动验证：

- ATC/ABAP Unit 真实执行。
- SAP 写入或调试控制。
- WindowsApps ACL 阻断的 Codex 插件安装。

最终逐项对照设计完成标准。证据不足的项目保持未完成或明确列为授权/环境边界，不能以测试替代。

## 2026-08-17 完成审计

| 设计完成标准 | 状态 | 当前证据 |
| --- | --- | --- |
| 1. 兼容既有 profile/工具契约，MCP `0.4.0` 全量测试与 build 通过 | 已证明 | `npm run check:adt-imports`、61 个 Jest 套件/421 项测试、`npm run build` 和 `git diff --check` 通过；现有正常返回契约由全量回归覆盖。 |
| 2. 四个高层只读能力与质量检查 workflow 覆盖核心分支 | 已证明 | `RuntimeDumpReader`、`ClassicTableInspector`、`SystemInspector`、`AbapMemberSourceReader`、`QualityCheckWorkflow`、确认与 plan store 的定向测试全部通过。 |
| 3. QAS/PRD/缺失/未知角色不能看到或 dispatch 新增执行工具 | 已证明 | 目录完整性测试覆盖四类非 DEV 角色；Workbench 动态校验完成 14 次隐藏工具直接 dispatch 拒绝。 |
| 4. Workbench `0.3.0` 使用任务型 profile 并验证真实 runtime catalog | 已证明 | 动态校验启动 35 个 runtime 会话；DEV 目录为 `development-workbench=81`、`business-readonly=17`、`operations-readonly=40`。 |
| 5. 目录字节数实测下降并写入文档 | 已证明 | 运行时实测为 `59,894`、`8,553`、`26,446` UTF-8 字节；现役说明记录于 Workbench `references/mcp/profile-capabilities.md`。 |
| 6. 静态 eval 与真实模型 benchmark 分开保存，人工评审完成 | 已证明 | 静态页包含 58 个 contract case 且不含模型输出；独立模型 workspace 保留两组新旧配对输出、评分、`benchmark.json`、官方 `review.html` 和 `feedback.json`。新版 10/10，`0.2.0` 基线 4/10；用户已于 2026-08-17 明确评审通过。 |
| 7. 文档、版本、数量、链接和证据边界一致 | 已证明 | MCP/Workbench 版本、目录数量和真实 SAP 边界已同步；三个 Skill、插件 manifest、全部 JSON、本地 Markdown 链接、个人绝对路径、凭据字面量和两仓 `diff --check` 均通过最终检查。 |
| 8. 新高层只读工具完成 DEV/QAS/PRD 真实验收 | 已证明 | 独立源构建进程在三环境通过 `inspectSapSystem`、有界 ST22、`T000` 零业务行 schema 和 `RFC_SYSTEM_INFO` member-source 验收；证据已脱敏保存于 Workbench `evals/live-sap-readonly-0.4.0-2026-08-17.*`。 |

真实 ATC、ABAP Unit、SAP 写入、调试控制、trace 创建和 transport release 未执行，继续作为授权边界明确标记为未验证；它们不是本设计要求自动执行的验收项。Codex 当前进程是否拾取新插件仍需在重新安装或刷新后的新任务中确认，不能由源码校验代替。
