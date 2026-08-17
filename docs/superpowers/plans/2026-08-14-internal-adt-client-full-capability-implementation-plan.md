# 内置 ADT 客户端与完整 MCP 能力实施计划

## 状态与范围

- 日期：2026-08-14
- 状态：已完成（2026-08-14）
- 设计依据：`docs/superpowers/specs/2026-08-14-internal-adt-client-full-capability-design.md`
- MCP 计划前基线：提交 `a5b0623`
- MCP 发布基线：`v0.2.0`
- 内置源码来源：`D:\MyDev\SAP\abap-adt-api`
- 内置源码基线：`abap-adt-api@8.4.2` 加提交 `3cd8c17` 的可取消调试监听器
- 自动化基线：32 个 Jest 套件、246 项测试通过，TypeScript build 通过
- 配套插件：`D:\MyDev\SAP\sap-abap-adt-workbench`
- 插件基线：`0.1.0`，一个插件、三个 Skill，当前不是 Git 仓库

本计划把完整 ADT 客户端纳入 MCP 仓库，删除运行时 npm 依赖 `abap-adt-api`，注册当前缺失的 21 个原始工具，并为 DEV 增加三组共 6 个受控 preview/apply 工具。随后同步 MCP 文档、插件共享参考和三个 Skill，完成离线评测与分级真实 SAP 验证。

本计划不改变已冻结的调试 detach 结论，也不放宽现有源码、对象创建、调试、ST22 或 SM21 的安全边界。之前调试生命周期计划中的“先发布独立 `abap-adt-api` 新版本”依赖，在本计划实施后改为“在 MCP 内置客户端阶段保留并验证 `3cd8c17` 的 AbortSignal 和取消语义”；不再为了 MCP 构建或发布单独的客户端 npm 包。

### 完成与验证记录

- MCP `0.3.0` 实现提交为 `f7717fa7ec4dcf25610bedf87926ebdad3b98dd4`。
- `node scripts/check-adt-imports.mjs`、TypeScript build、49 个 Jest 套件和 353 项测试通过。
- `npm ls abap-adt-api --depth=0` 为空；MCP 运行时不再依赖外部 `abap-adt-api` 包。
- 内置客户端、21 个新增 raw 工具、6 个 raw 高级写工具、6 个受控高级工具和 `7/114/94/157` profile 目录契约已由自动化验证。
- 使用当前源码直接启动的 MCP `0.3.0` 子进程完成 DEV、QAS、PRD 只读验收；QAS/PRD 未暴露 mutation 工具，RAP availability 在测试系统返回 `false`。
- 未执行 DDIC、包迁移或 RAP 等真实 SAP 高级写入；Codex 当前会话对新插件和新 MCP 目录的重新加载仍需安装或重启后的新任务验证。

## 最终目标

实施完成后必须同时满足：

1. `package.json` 和 `package-lock.json` 不再包含 `abap-adt-api`。
2. `src/adt/index.ts` 成为 MCP 内部唯一稳定 ADT 导入入口。
3. 内置客户端保留 145 个实例可调用能力和 4 个静态 helper。
4. 当前 21 个缺失能力全部成为显式 MCP 工具，不提供任意方法名转发器。
5. Profile 的源码基准数量为：`safe=7`、`development=114`、`diagnostic-readonly=94`、`legacy-full=157`。
6. 15 个新增只读、校验或预览工具进入 `development`、`diagnostic-readonly` 和 `legacy-full`。
7. 6 个新增原始写工具只进入 DEV 角色下的 `legacy-full`；QAS/PRD 目录过滤和直接调用均拒绝。
8. `development` 只通过三组受控 preview/apply 工具执行新增高级写入。
9. preview 阶段零远端写入；apply 仅接受服务器计划 ID，并只使用 MCP 原生确认。
10. 写入、生成、发布和开发包迁移不自动重试；未知结果先做只读核验。
11. MCP 可以脱离插件独立运行；插件继续保持一个插件、三个职责清晰的 Skill。
12. 自动化、真实 DEV、QAS/PRD 只读验证和未验证项分别汇报。

## 实施顺序与硬门槛

```text
Phase 0 冻结基线与迁移清单
  -> Phase 1 完整客户端内置与行为等价
    -> Phase 2 注册 21 个原始工具
      -> Phase 3 受控高级操作计划基础设施
        -> Phase 4 三个 DEV 受控 workflow
          -> Phase 5 profile、role、dispatch 和自动化集成
            -> Phase 6 MCP 文档、版本和许可证
              -> Phase 7 插件与三个 Skill
                -> Phase 8 真实 SAP 分级验收与发布
```

硬门槛：

- Phase 1 未通过现有 32 套测试、build、客户端表面校验和导入审计前，不注册新工具。
- Phase 2 的 21 个原始工具必须全部有明确 schema、注解、参数限制、响应限制和 handler 测试。
- 受控 apply 在没有原生确认能力时关闭失败；不得使用文字确认降级。
- QAS/PRD 不能只靠工具目录隐藏写操作；直接构造旧请求或隐藏工具名也必须在 dispatch 前拒绝。
- 任一远端写入响应超时、断线或无法证明结果时，不自动重试，不自动做反向破坏操作。
- 不修改真实 `.env`，不写入账号、密码、Cookie、CSRF token、Authorization header 或业务数据样本。
- 不修改、删除或提交当前未跟踪的 `.claude/`。
- 每一阶段使用独立提交，且提交时 build 和该阶段相关测试必须通过。

## Phase 0：冻结基线和可重复迁移清单

### 产出文件

- 新增 `src/__tests__/AdtClientSurface.test.ts`
- 新增 `src/__tests__/fixtures/adt-client-surface.json`
- 必要时新增 `scripts/check-adt-imports.mjs`

### 任务 0.1：记录双仓库基线

记录并在实施日志中核对：

- MCP 基线提交 `a5b0623`，工作树只允许保留既有 `?? .claude/`。
- 客户端基线提交 `3cd8c17`，其父版本提交 `43f6dc7` 对应 `8.4.2`。
- `D:\MyDev\SAP\abap-adt-api\src` 是迁移源；`node_modules/abap-adt-api` 不是来源。
- 迁移生产源码时排除 `*.test.ts` 和 `src/test/**`，测试在 MCP 测试布局下单独移植。

### 任务 0.2：建立能力表面固定测试

先写一个会失败的表面测试，固定以下事实：

- `ADTClient.prototype` 公开实例方法共 143 个。
- `hasTransportConfig` 和 `isProposalMessage` 两个实例可调用属性存在。
- 合计 145 个实例可调用能力。
- `ADTClient.mainInclude`、`ADTClient.isMainInclude`、`ADTClient.classIncludes`、`ADTClient.textElementsUrl` 4 个静态 helper 存在；稳定入口继续保留上游已有的相关 named exports。
- 21 个当前缺失能力逐项存在，名称与设计规格一致。

`adt-client-surface.json` 只保存稳定名称清单，不保存函数源码或生成时间。测试对实际集合做双向比较，缺失和意外新增都失败；未来同步上游时必须显式审查并更新清单。

### 任务 0.3：建立导入审计

`scripts/check-adt-imports.mjs` 检查：

1. `src/**` 不再出现包导入 `from 'abap-adt-api'` 或等价 require。
2. `src/handlers/**`、`src/safe/**` 和 `src/sm21/**` 只能从 `../adt/index.js` 或相应层级的稳定入口导入。
3. 只有 `src/adt/index.ts` 可以聚合 `src/adt/api/**` 深层模块。
4. 测试类型导入也使用内置入口，避免开发依赖悄悄保留旧包。

### Phase 0 验证

表面测试在客户端尚未迁入时应按预期失败；导入审计应准确列出当前旧包导入位置。确认失败原因来自待实施缺口后进入 Phase 1，不把预期失败提交到主分支。

## Phase 1：完整客户端内置与行为等价

### 生产源码

从客户端仓库迁入并保留目录结构：

- 新增 `src/adt/index.ts`
- 新增 `src/adt/AdtClient.ts`
- 新增 `src/adt/AdtException.ts`
- 新增 `src/adt/AdtHTTP.ts`
- 新增 `src/adt/AxiosHttpClient.ts`
- 新增 `src/adt/requestLogger.ts`
- 新增 `src/adt/utilities.ts`
- 新增 `src/adt/api/*.ts`

迁入 `src/adt/api` 下全部 26 个生产模块，包括 RAP Generator、文本元素、增强、对象结构、重构、调试、ATC、trace 和 transport 等模块。不要把上游 `*.test.ts` 放入生产目录，也不要迁入依赖真实 SAP 的 `src/test/**` 集成测试。

### 第三方归属文件

- 新增 `third-party/abap-adt-api/LICENSE`
- 新增 `third-party/abap-adt-api/BASELINE.md`

`BASELINE.md` 明确记录：

- 上游仓库 URL 和 MIT License。
- 上游版本 `8.4.2`、版本提交 `43f6dc7` 和迁入提交 `3cd8c17`。
- `3cd8c17` 增加的取消语义及其对应测试。
- MCP 内部入口、目录映射和本地差异。
- 后续同步流程：比较上游基线、审查生产文件差异、运行表面测试和全部 MCP 测试。

### 任务 1.1：机械迁入，不做顺带重构

1. 保留上游文件名、类型名和 API 模块划分。
2. 只调整内部相对导入所需的路径和 MCP TypeScript/Jest 兼容项。
3. 不在迁移提交中重命名客户端方法、清理风格、升级 XML 映射或改变 HTTP 行为。
4. 保留 `stateful`、`httpClient`、`classIncludes` 和现有 MCP 使用的其他非方法入口。
5. 保留 `debuggerListen` 的 AbortSignal 透传和稳定取消判定。

### 任务 1.2：直接依赖与锁文件

修改：

- `package.json`
- `package-lock.json`

删除 `abap-adt-api`，添加客户端当前使用的直接依赖：

- `axios`：`^1.15.2`
- `fast-xml-parser`：`^5.7.2`
- `fp-ts`：`^2.16.7`
- `html-entities`：`^2.5.2`
- `io-ts`：`^2.2.21`
- `io-ts-reporters`：`^2.0.1`
- `sprintf-js`：`^1.1.3`

不顺带升级这些范围。`package-lock.json` 的 resolved 版本与 integrity 是可重复安装的最终权威；安装后检查锁文件不存在间接残留的 `node_modules/abap-adt-api`。

### 任务 1.3：统一改用本地稳定入口

修改所有当前旧包导入，至少覆盖：

- `src/index.ts`
- `src/handlers/*.ts`
- `src/safe/*.ts`
- `src/sm21/*.ts`
- `src/__tests__/*.ts`

导入规则：

- `src/index.ts` 使用 `./adt/index.js`。
- `src/handlers/**`、`src/safe/**`、`src/sm21/**` 使用 `../adt/index.js`。
- `src/__tests__/**` 使用 `../adt/index.js`。
- 不允许 handler 深层导入 `../adt/api/*.js`。

### 任务 1.4：移植离线客户端测试

在 MCP 测试布局中移植或重写以下确定性覆盖：

- `src/__tests__/AdtAxiosHttpClient.test.ts`
- `src/__tests__/AdtDebuggerCancellation.test.ts`
- `src/__tests__/AdtRapGenerator.test.ts`
- `src/__tests__/AdtTraceParsing.test.ts`

测试重点：

1. Axios config 原样接收 AbortSignal。
2. 本地挂起 HTTP 请求可被真实 abort，不等到超时。
3. 取消与普通网络错误、SAP 业务错误可区分。
4. RAP helper 的路径、query、content type、JSON/XML 转换和响应解析保持基线行为。
5. XML 编解码、trace 解析和现有客户端请求头保持等价。
6. 未传 signal 的旧调用保持兼容。

### 任务 1.5：阶段一兼容性门槛

阶段一完成时，工具注册代码和 profile 白名单不增加任何名称。测试必须证明：

- `safe=7`
- `development=93`
- `diagnostic-readonly=79`
- `legacy-full=136`
- 现有 schema、annotations、`_meta`、`content` 和 `structuredContent` 不变。
- 现有 ABAP preview/apply 仍只有一次服务器原生确认。
- SM21 仍复用同一个已认证 `httpClient`。

### Phase 1 验证

```powershell
node scripts/check-adt-imports.mjs
npm test -- --runInBand
npm run build
git diff --check
```

补充检查：

- `npm ls abap-adt-api` 不得显示安装依赖。
- `rg -n "abap-adt-api" src package.json package-lock.json` 只能命中项目名、说明性文本或明确允许的第三方归属记录，不能命中包依赖或源码导入。
- 运行表面测试，固定 145 个实例能力和 4 个静态 helper。

阶段提交建议：`refactor: 内置完整 ADT 客户端`

## Phase 2：注册 21 个原始 MCP 工具

### Handler 归属和文件

修改：

- `src/handlers/ObjectHandlers.ts`：`objectStructureElements`
- `src/handlers/CodeAnalysisHandlers.ts`：`typeHierarchy`、`objectEnhancements`
- `src/handlers/DdicHandlers.ts`：域、数据元素和文本元素 6 个工具
- `src/handlers/AtcHandlers.ts`：`atcDocumentation`
- `src/handlers/RefactorHandlers.ts`：开发包 preview/execute
- 新增 `src/handlers/RapGeneratorHandlers.ts`：9 个 RAP 工具
- 修改 `src/index.ts`：构造、catalog、dispatch
- 修改 `src/config/ToolProfiles.ts`：新增只读白名单和 profile 选择
- 新增 `src/config/ToolOperationPolicy.ts`：与原始写工具同阶段建立 role 过滤和 direct-dispatch 防线
- 修改 `src/safe/SafetyPolicy.ts`：提供工具操作分类所需的 role 判定
- 修改 `src/lib/requestLimits.ts`：新增有界参数规则
- 修改 `src/lib/serverGuardrails.ts`：新增工具的 gate 分类

新增或扩展测试：

- `src/__tests__/ObjectHandlers.test.ts`
- `src/__tests__/CodeAnalysisHandlers.test.ts`
- `src/__tests__/DdicHandlers.test.ts`
- `src/__tests__/AtcHandlers.test.ts`
- `src/__tests__/RefactorHandlers.test.ts`
- `src/__tests__/RapGeneratorHandlers.test.ts`
- `src/__tests__/SafeAbapHandlers.test.ts`
- `src/__tests__/requestLimits.test.ts`
- `src/__tests__/serverGuardrails.test.ts`
- 新增 `src/__tests__/ToolCatalogIntegrity.test.ts`

### 任务 2.1：先写 21 项契约测试

每个工具至少覆盖：

1. 工具名唯一且 schema 有明确 required 字段。
2. 参数按客户端方法签名映射，不接受任意方法名、URL 外字段或无限嵌套对象。
3. handler 只调用预期的一个客户端方法。
4. 正常返回沿用当前 BaseHandler 的 MCP 序列化契约。
5. 客户端错误经过现有错误映射，不泄露响应头、Cookie 或凭据。
6. 参数上限和响应上限实际生效。
7. annotations 与 `_meta.operationClass` 和真实副作用一致。

### 任务 2.2：注册 15 个只读、校验或预览工具

| 工具 | 主要输入 | 归属 |
|---|---|---|
| `objectStructureElements` | `objectUrl`、可选 `version` | ObjectHandlers |
| `typeHierarchy` | `url`、`body`、`line`、`offset`、可选 `superTypes` | CodeAnalysisHandlers |
| `objectEnhancements` | `sourceMainPath`、可选 `contextUri`、`includeSource` | CodeAnalysisHandlers |
| `getDomainProperties` | `domainUrl`、可选 `version` | DdicHandlers |
| `getDataElementProperties` | `dataElementUrl`、可选 `version` | DdicHandlers |
| `getTextElements` | `url`、可选 `category` | DdicHandlers |
| `atcDocumentation` | `docUri` | AtcHandlers |
| `changePackagePreview` | 受限 `refactoring`、`transport` | RefactorHandlers |
| `rapGenValidateInitial` | `genId`、`refObjectUri`、`packageName`、可选 `checks` | RapGeneratorHandlers |
| `rapGenGetSchema` | `genId`、`refObjectUri`、`packageName` | RapGeneratorHandlers |
| `rapGenGetContent` | `genId`、`refObjectUri`、`packageName` | RapGeneratorHandlers |
| `rapGenGetUiConfig` | `genId`、`refObjectUri`、`packageName` | RapGeneratorHandlers |
| `rapGenValidateContent` | `genId`、`refObjectUri`、受限 `content` | RapGeneratorHandlers |
| `rapGenPreview` | `genId`、`refObjectUri`、受限 `content` | RapGeneratorHandlers |
| `rapGenIsAvailable` | 可选 `genId` | RapGeneratorHandlers |

这些工具统一标记：

- `readOnlyHint: true`
- `destructiveHint: false`
- `_meta.operationClass: 'read-only tenant'`
- `_meta.approvalRequired: false`

`changePackagePreview` 和 RAP preview 虽可能触发远端计算，但不得落地修改；测试使用 mock 客户端证明没有 execute/generate/publish 调用。

### 任务 2.3：注册 6 个原始写工具

| 工具 | 主要输入 | 原始边界 |
|---|---|---|
| `setDomainProperties` | URL、properties、metadata、lockHandle、可选 transport | 调用方管理锁、激活和验证 |
| `setDataElementProperties` | URL、properties、metadata、lockHandle、可选 transport | 调用方管理锁、激活和验证 |
| `setTextElements` | URL、category、elements、lockHandle、可选 transport | 调用方管理锁、激活和验证 |
| `changePackageExecute` | 完整且有界的 preview refactoring | 不自动反向迁移 |
| `rapGenGenerate` | genId、refObjectUri、transport、content | 不自动删除或重试 |
| `rapGenPublishService` | `srvbName` | 不自动取消发布或重试 |

这些工具统一标记：

- `readOnlyHint: false`
- `destructiveHint: true`
- `idempotentHint: false`
- `_meta.operationClass: 'mutating tenant'`
- `_meta.approvalRequired: false`

`approvalRequired: false` 只表示原始 `legacy-full` 工具不包装 safe confirmation，不表示已获授权。它们必须带高风险说明，只在 DEV 角色的 `legacy-full` 目录可见，并受服务器 role policy 限制。`development` 不直接暴露这些原始写工具。

原始写工具和 role policy 必须在同一提交中落地：

- `ToolOperationPolicy.ts` 将全部当前 catalog 工具和新增工具分类为 local、read-only、source mutation、debug control、advanced mutation 或 other mutation。
- DEV `legacy-full` 可以列出并调用 6 个新增原始写工具。
- QAS/PRD 和缺失或非法 role 的目录过滤掉这 6 个名称。
- QAS/PRD 和缺失或非法 role 即使直接构造名称调用，也必须在 handler 和底层客户端之前返回 `POLICY_DENIED`。
- catalog、dispatch 和分类表做集合相等测试；未知、重复或漏分类时关闭失败。

### 任务 2.4：输入和响应限制

按现有 `RuntimeGuardrails` 和 `requestLimits` 风格增加局部限制：

- URL、对象名、包名、服务绑定名和 transport 有长度上限并拒绝控制字符。
- `checks`、文本元素和 RAP content 的数组长度、嵌套深度、键数量和 UTF-8 总字节数有上限。
- `includeSource=true` 的增强读取仍受统一响应字节上限约束。
- RAP schema/UI config 等字符串响应受统一 response guard 约束。
- 不在日志中序列化完整 RAP content、文本元素内容、DDIC properties 或服务响应。

### 任务 2.5：更新原始工具 profile

`ToolProfiles.ts` 增加 15 个只读名称。Phase 2 完成时，在尚未增加受控工具的中间状态锁定：

- `safe=7`
- `development=108`
- `diagnostic-readonly=94`
- `legacy-full=157`

对 21 个名称做集合测试：

- 15 个只读名称同时出现在 development、diagnostic-readonly、legacy-full。
- 6 个原始写名称只出现在 DEV legacy-full。
- safe 不增加任何工具。
- 所有 catalog 名称无重复。
- QAS/PRD 和缺失/非法 role 不列出 6 个原始写名称，直调时底层客户端调用数为零。

### Phase 2 验证

```powershell
npm test -- --runInBand
npm run build
git diff --check
```

阶段提交建议：`feat: 注册完整 ADT 原始工具`

## Phase 3：受控高级操作计划基础设施

### 新增文件

- `src/safe/advancedTypes.ts`
- `src/safe/AdvancedOperationPlanStore.ts`
- `src/safe/AdvancedOperationConfirmation.ts`
- `src/handlers/SafeAdvancedHandlers.ts`
- `src/__tests__/AdvancedOperationPlanStore.test.ts`
- `src/__tests__/AdvancedOperationConfirmation.test.ts`
- `src/__tests__/SafeAdvancedHandlers.test.ts`

### 任务 3.1：定义封闭的判别联合

`advancedTypes.ts` 只允许以下 operation kind：

- `SET_DOMAIN_PROPERTIES`
- `SET_DATA_ELEMENT_PROPERTIES`
- `SET_TEXT_ELEMENTS`
- `CHANGE_PACKAGE`
- `RAP_GENERATE`
- `RAP_PUBLISH_SERVICE`

每个 kind 有独立输入、预览摘要、漂移依据、恢复载荷和验证结果类型。不得包含 `methodName: string`、任意 URL 调用、任意 headers 或任意 JSON passthrough。

### 任务 3.2：实现短期、一次性的计划存储

沿用现有 `ChangePlanStore`、`CreationPlanStore` 和 `DebugOperationPlanStore` 的行为约束，但不把不同恢复语义强塞进现有 source plan 类型。

计划至少绑定：

- host、client、systemRole 和 toolProfile
- 目标对象或服务绑定
- operation kind
- transport
- 输入摘要与当前状态摘要
- 创建时间、到期时间和状态
- 执行所需最小私有载荷

状态至少覆盖：

- `PREVIEWED`
- `APPLYING`
- `APPLIED`
- `ROLLED_BACK`
- `PARTIAL_SUCCESS`
- `FAILED`
- `UNKNOWN_OUTCOME`
- `EXPIRED`
- `CANCELLED`

容量满时只淘汰可安全移除的终态计划，不淘汰活跃计划或仍需恢复的载荷。终态和过期时清除完整 properties、text elements、RAP content、lockHandle 和其他敏感载荷，只保留摘要、哈希、字节数和阶段结论。

### 任务 3.3：仅使用 MCP 原生确认

`AdvancedOperationConfirmation` 复用服务器现有 form elicitation 能力，但与允许兼容文字确认的源码工作流分开：

- apply 输入只有 `operationPlanId`。
- 不定义 `textConfirmation` 字段。
- 原生 elicitation 不可用、超时、取消或拒绝时不消费计划、不写 SAP。
- 确认页面显示操作类型、目标、transport、差异摘要和不可自动回滚提示。
- 用户接受后再进入 gate 内执行；等待用户确认期间不占 SAP gate。

### 任务 3.4：定义 6 个受控工具契约

`SafeAdvancedHandlers` 暴露：

- `previewDdicPropertyChange`
- `applyDdicPropertyChange`
- `previewPackageChange`
- `applyPackageChange`
- `previewRapOperation`
- `applyRapOperation`

preview 为只读 tenant、无需确认；apply 为 mutating tenant、需要确认、非幂等。preview 输出直接可读的字段级或对象级摘要，并在 `structuredContent` 返回计划 ID、到期时间、目标和有限状态；不得返回完整敏感原值或待写载荷。

### Phase 3 测试

至少覆盖：

- 计划过期、容量限制、跨 host/client/role 使用、重复执行和终态清理。
- 原生确认接受、拒绝、取消、超时和能力缺失。
- 确认前底层客户端写方法调用数为零。
- 不存在文字确认 schema 或环境变量降级路径。
- 日志和状态响应不包含完整 DDIC 值、文本、RAP content、凭据或 lock handle。

阶段提交建议：`feat: 建立高级操作确认计划`

## Phase 4：实现三个 DEV 受控 workflow

### 新增文件

- `src/safe/DdicPropertyChangeWorkflow.ts`
- `src/safe/PackageChangeWorkflow.ts`
- `src/safe/RapOperationWorkflow.ts`
- `src/__tests__/DdicPropertyChangeWorkflow.test.ts`
- `src/__tests__/PackageChangeWorkflow.test.ts`
- `src/__tests__/RapOperationWorkflow.test.ts`

### 任务 4.1：DDIC 属性与文本元素 workflow

preview 顺序：

1. 使用服务器允许的对象类型和对象名解析 ADT URL，不信任任意外部写 URL。
2. 调用 `SafetyPolicy` 检查 DEV、host/client、namespace、transport 和审计路径。
3. 读取当前 domain/data element/text elements。
4. 校验 properties、metadata、category 和 elements 的允许字段及大小。
5. 生成字段级差异和当前值哈希，保存恢复所需原值私有载荷。
6. 创建短期计划；不锁、不 set、不 activate。

apply 顺序：

1. 原生确认接受后重新检查 role、profile、host/client、namespace、transport 和计划 TTL。
2. 重新读取当前值并与计划摘要比较，漂移则返回 `STATE_DRIFT`。
3. 锁定对象并记录 lock handle，但不对外返回。
4. 只调用一次对应 setter。
5. 尽最大努力解锁；解锁错误不能覆盖主错误。
6. 按对象要求激活。
7. 重新读取并逐字段验证。
8. 验证失败时，用已保存原值尝试一次受控恢复，再次激活和复读验证。
9. 恢复成功返回 `ROLLED_BACK`；恢复失败返回 `ROLLBACK_FAILED`，同时保留主要错误和恢复错误的脱敏摘要。

测试矩阵：读取失败、漂移、锁失败、set 失败、解锁失败、激活失败、验证不一致、恢复成功、恢复失败、远端结果未知和成功路径。任何写入或恢复均只尝试一次。

### 任务 4.2：开发包迁移 workflow

preview：

1. 校验目标对象、旧包、新包和 transport。
2. 调用一次 `changePackagePreview`。
3. 返回旧包、新包、目标对象、影响对象和关键消息的有界摘要。
4. 保存 preview 结构的稳定摘要和执行所需最小载荷。

apply：

1. 原生确认后重新检查系统策略和 transport。
2. 再调用一次 `changePackagePreview`。
3. 比较目标包、影响对象集合、transport 和关键字段；漂移时不执行。
4. 只调用一次 `changePackageExecute`。
5. 使用对象结构或包元数据做只读复查。
6. 无法证明成功或失败时返回 `UNKNOWN_OUTCOME`。

禁止自动反向迁移、自动重试或根据异常文本猜测远端未执行。

### 任务 4.3：RAP 生成与发布 workflow

`previewRapOperation` 使用判别联合区分 `GENERATE` 和 `PUBLISH_SERVICE`。

生成 preview：

1. `rapGenIsAvailable`
2. `rapGenValidateInitial`
3. 必要时读取 schema/content/UI config 以验证输入边界
4. `rapGenValidateContent`
5. `rapGenPreview`
6. 返回预计对象清单、验证消息和 transport 摘要

生成 apply：

1. 原生确认后重新检查 role、host/client、package、namespace、transport 和 TTL。
2. 重跑关键 validation 和 preview。
3. 对象清单或关键验证结果漂移则终止。
4. 只调用一次 `rapGenGenerate`。
5. 按返回对象逐项只读核验，区分成功、部分成功和未知结果。

发布 preview：

1. 检查 RAP endpoint 可用性。
2. 校验服务绑定名和允许 namespace。
3. 读取当前可观察状态；无法读取时明确标记而不是假设未发布。
4. 返回目标系统身份、服务绑定和不可自动回滚提示。

发布 apply：

1. 重新检查策略和可观察状态。
2. 只调用一次 `rapGenPublishService`。
3. 只读核验发布状态；断线或响应丢失时返回 `UNKNOWN_OUTCOME`。

禁止自动删除生成对象、自动取消发布、自动重试或把部分成功包装为完全成功。

### 任务 4.4：统一阶段和错误

三个 workflow 统一记录：

- `VALIDATE`
- `PREVIEW`
- `CONFIRM`
- `DRIFT_CHECK`
- `LOCK`
- `EXECUTE`
- `UNLOCK`
- `ACTIVATE`
- `VERIFY`
- `ROLLBACK`

稳定错误至少覆盖：

- `POLICY_DENIED`
- `PLAN_EXPIRED`
- `PLAN_NOT_EXECUTABLE`
- `STATE_DRIFT`
- `VALIDATION_FAILED`
- `CONFIRMATION_REQUIRED`
- `CONFIRMATION_CANCELLED`
- `REMOTE_WRITE_FAILED`
- `VERIFICATION_FAILED`
- `ROLLBACK_FAILED`
- `UNKNOWN_OUTCOME`

阶段提交建议：`feat: 实现受控 DDIC 包迁移与 RAP 流程`

## Phase 5：profile、role、dispatch 和自动化集成

### 修改文件

- `src/index.ts`
- `src/config/ToolProfiles.ts`
- 扩展 `src/config/ToolOperationPolicy.ts`
- `src/safe/SafetyPolicy.ts`
- `src/lib/serverGuardrails.ts`
- `src/lib/requestLimits.ts`
- `src/__tests__/SafetyPolicy.test.ts`
- `src/__tests__/SafeAbapHandlers.test.ts`
- `src/__tests__/serverGuardrails.test.ts`
- 扩展 `src/__tests__/ToolCatalogIntegrity.test.ts`

### 任务 5.1：接入实例、catalog 和 dispatch

`src/index.ts`：

1. 构造 `RapGeneratorHandlers`。
2. 构造高级计划存储、三个 workflow、原生 confirmation 和 `SafeAdvancedHandlers`。
3. 将 21 个原始工具加入 legacy catalog。
4. 将 6 个受控工具作为独立参数传给 profile 选择。
5. dispatch 时先验证名称已注册，再执行服务器拥有的 operation policy。
6. preview 和远端读取走 SAP gate。
7. apply 的确认等待在 gate 外；确认接受后的漂移检查、写入、验证和恢复作为一个 gate 内原子工作单元。

### 任务 5.2：建立服务器拥有的操作分类

扩展 Phase 2 已建立的 `ToolOperationPolicy.ts`，把 6 个受控高级工具加入分类，并继续要求每个可注册、可 dispatch 的工具恰好分类为：

- `local-only`
- `read-only`
- `source-mutation`
- `debug-control`
- `advanced-mutation`
- `other-mutation`

分类表是服务器安全事实，不信任 handler annotations 或客户端传参。启动和测试必须验证 catalog、dispatch 和分类集合相等；未知、重复、漏分类均关闭失败。

### 任务 5.3：角色优先于 profile

执行规则：

- DEV：按 profile 正常选择工具。
- QAS/PRD：所有 profile 只允许 local/read-only。
- 缺失或非法 role：最多允许 local/read-only，不能默认 DEV。
- QAS/PRD 的 `legacy-full` 不列出 6 个新增原始写工具和 6 个受控工具。
- 即使旧客户端按名称直接调用隐藏工具，dispatch 也在调用底层客户端前返回 `POLICY_DENIED`。
- `diagnostic-readonly` 在 DEV/QAS/PRD 都不执行新增写入。

### 任务 5.4：锁定最终 profile 数量

在 DEV 角色的完整 catalog 上断言：

| Profile | 最终数量 |
|---|---:|
| `safe` | 7 |
| `development` | 114 |
| `diagnostic-readonly` | 94 |
| `legacy-full` | 157 |

其中 development 的 114 项由现有 93 项、15 个新增只读原始工具和 6 个受控工具组成。不要把 6 个原始写工具加入 development，也不要把受控工具重复加入 legacy-full。

QAS/PRD 的实际目录数量按 role 过滤后动态断言集合，不用一个容易误导的固定总数；测试重点是所有 mutation 名称缺失且直调拒绝。

### 任务 5.5：对抗性测试

建立 profile x role 表驱动测试，至少覆盖：

- QAS/PRD raw `setDomainProperties`、`changePackageExecute`、`rapGenGenerate`、`rapGenPublishService` 未调用底层客户端。
- QAS/PRD 直调三个受控 apply 未进入 confirmation，也未调用底层客户端。
- diagnostic-readonly 在 DEV 上也不能调用新增写入。
- stale catalog 名称和人为构造的隐藏工具名不能绕过 dispatch。
- 原生确认能力缺失时 apply 关闭失败。
- 过期、重复执行、漂移、锁/解锁、回滚、部分成功和未知结果各有稳定响应。
- 所有远端写方法调用次数不超过一次；UNKNOWN 后没有自动重试。
- 现有 136 个工具的正常返回契约没有因统一 policy 包装而改变。
- 工具名称、profile 集合、dispatch 分支和 operation policy 集合没有重复或遗漏。

### Phase 5 完整自动化

```powershell
node scripts/check-adt-imports.mjs
npm test -- --runInBand
npm run build
git diff --check
```

阶段提交建议：`feat: 集成完整能力安全策略`

## Phase 6：MCP 文档、版本和许可证

### 修改文件

- `README.md`
- `README.zh-CN.md`
- `docs/使用指南.md`
- `.env.example`
- `AGENTS.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `server.json`
- 必要时更新 `docs/superpowers/specs/2026-08-14-safe-debug-listener-lifecycle-design.md` 和对应计划中已失效的外部包发布依赖说明；不得改变已确认的调试安全语义

### 文档要求

1. 明确客户端已内置，安装和运行不需要 `abap-adt-api` 包。
2. 记录上游版本、提交、许可证、第三方目录和后续同步方法。
3. 从最终注册代码重新统计四个 profile 数量，不手抄中间状态。
4. 给出 21 个原始工具按域分类和 6 个受控工具的职责。
5. 明确 `legacy-full` 原始写工具不带 safe workflow，适合兼容和专家直接控制，不是推荐默认路径。
6. 给出 DDIC、包迁移、RAP 生成/发布的 preview -> 展示 -> apply -> 原生确认 -> 复查示例。
7. 明确 QAS/PRD 所有 profile 只读，`SAP_MCP_SYSTEM_ROLE` 是部署方声明边界，必须与 host/client allow-list 一起核对。
8. 明确写操作不自动重试，`UNKNOWN_OUTCOME` 后先只读核验。
9. 区分自动化测试、fake-client 集成测试、真实 DEV、QAS/PRD 只读验证和未验证端点。
10. README 保持导航和安装简洁，详细中文流程放在 `docs/使用指南.md`。

### 版本策略

- MCP 目标版本：`0.3.0`。
- `package.json`、`package-lock.json`、`server.json`、README 和 CHANGELOG 的版本必须一致。
- 未真正发布 npm 或 Registry 前，只描述 source-built 安装，不把未来发布命令写成已经可用。
- 发布 tag 前再次核对 `third-party/abap-adt-api/LICENSE` 和 `BASELINE.md`。

### 文档验证

- 检查所有本地 Markdown 链接目标存在。
- 搜索旧数量 `93/79/136`，只允许出现在明确标注“历史基线”的上下文。
- 搜索旧依赖安装说明和 `from 'abap-adt-api'` 示例。
- 搜索将文字确认描述为新增高级写入降级路径的错误说明。
- 搜索把 QAS/PRD `legacy-full` 描述为可写的过期内容。

阶段提交建议：`docs: 同步内置 ADT 完整能力`

## Phase 7：升级一个插件中的三个 Skill

本阶段修改 `D:\MyDev\SAP\sap-abap-adt-workbench`。该目录当前不是 Git 仓库；正式提交和公开发布前建立独立 Git 历史并配置用户确认的公开 remote，不能把 MCP 仓库提交当作插件版本历史。

### 插件与共享参考

修改：

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `README.md`
- `references/mcp/profile-capabilities.md`
- `references/mcp/setup-three-instances.md`
- `references/mcp/safe-source-workflow.md`
- 新增 `references/mcp/safe-advanced-workflows.md`
- `references/shared/tool-routing.md`
- `references/shared/safety-boundaries.md`
- `references/shared/environment-routing.md`
- `references/shared/evidence-and-handoff.md`
- `scripts/validate-mcp-contract.mjs`
- `evals/README.md`
- `evals/cross-skill-routing.json`

插件正式目标版本为 `0.2.0`，兼容 MCP `v0.3.0`。本地 Codex 刷新只使用 plugin-creator 的 cachebuster helper 替换 `+codex.<token>`；不手改 marketplace，不通过递增正式 semver 刷缓存。

### `sap-abap-development`

修改：

- `skills/sap-abap-development/SKILL.md`
- `skills/sap-abap-development/evals/evals.json`
- `skills/sap-abap-development/evals/trigger-evals.json`

要求：

- 使用 development profile 的新增只读工具做对象结构、类型层次、增强、DDIC、文本、ATC、开发包和 RAP 预览。
- DDIC 属性、文本元素、包迁移和 RAP 写入必须走三组受控 preview/apply。
- 展示 preview 后直接调用 apply，由 MCP 打开唯一原生确认；Skill 不再额外要求一次聊天文字确认。
- 不回退到 `legacy-full` 原始写工具。
- QAS/PRD 只读，即使用户要求切 profile 或按 raw tool 名调用也不绕过。
- 将 ST22/SM21、静态源码、数据证据和 active debug 保持为分级证据链；新增能力不能让 active debug 变成默认首选。

### `sap-business-data-diagnosis`

修改：

- `skills/sap-business-data-diagnosis/SKILL.md`
- `skills/sap-business-data-diagnosis/evals/evals.json`
- `skills/sap-business-data-diagnosis/evals/trigger-evals.json`

要求：

- 继续全程只读。
- 可使用 DDIC properties、文本元素、对象结构、类型层次和 RAP 可用性/预览补充数据模型证据。
- 表数据读取仍是业务链排查核心，不能把 DDIC 元数据等同于当前业务记录。
- 遇到需要源码修复、DDIC 写入或 RAP 生成时，带业务键、client、时间、表字段链和已排除假设 handoff 给 development。
- 不执行 set、execute、generate、publish 或任一受控 apply。

### `sap-system-operations-diagnosis`

修改：

- `skills/sap-system-operations-diagnosis/SKILL.md`
- `skills/sap-system-operations-diagnosis/evals/evals.json`
- `skills/sap-system-operations-diagnosis/evals/trigger-evals.json`

要求：

- 继续全程只读，负责 ST22、SM21、连接、认证、版本、ATC 文档、增强信息、RAP endpoint 可用性和现有运行状态。
- `atcDocumentation` 用于解释 ATC finding，不据此直接修改源码或申请豁免。
- RAP 可用性、validation 和 preview 只作为环境/兼容性证据，不生成或发布。
- 需要源码根因、修复、主动 DEV 调试或高级写入时 handoff 给 development。
- 不使用 `legacy-full` 绕过 profile，也不执行任何受控 apply。

### Skill 评测流程

按 skill-creator 的现有 Skill 改进流程执行：

1. 修改前将三个 Skill 和共享参考快照到插件目录之外的评测 workspace，作为旧版基线。
2. 更新每个 `evals/evals.json`，使用 `expectations` 保存可验证行为；更新 `trigger-evals.json` 和跨 Skill 路由集。
3. 对每个案例同一轮启动 with-skill 与旧版快照成对运行，并立即保存 timing。
4. 生成 `grading.json`，其 expectation 字段使用 `text`、`passed`、`evidence`。
5. 聚合 `benchmark.json`，比较通过率、耗时和 token，并记录不具区分度或高方差案例。
6. 使用 `eval-viewer/generate_review.py --static` 生成评审页面，先交给用户审阅，再根据反馈迭代。
7. 不把模型离线输出、fake client 或静态断言包装为真实 SAP 验证。

至少包含这些行为案例：

1. 开发者只问类型层次或增强点，保持只读，不产生 apply。
2. 开发者要求修改 domain 属性，必须先 preview，展示字段差异，再调用受控 apply。
3. 开发者要求直接调用 raw setter，拒绝 legacy-full fallback。
4. 包迁移 preview 漂移时停止，不 execute。
5. RAP 生成出现部分成功时报告对象清单，不自动删除或重试。
6. RAP 发布超时返回未知结果，先只读核验。
7. 业务数据排查使用表数据和 DDIC 元数据，但不写表或改 DDIC。
8. 运维排查使用 ATC 文档或 RAP availability，但不生成、发布或申请写操作。
9. QAS/PRD 上任何新增写入请求被拒绝。
10. development、business-data、operations 三个 Skill 对同一 ST22/数据/RAP 请求路由职责清楚，handoff 不重复收集已有证据。

### 插件验证

```powershell
node scripts/validate-mcp-contract.mjs ..\mcp-abap-abap-adt-api
python "$env:USERPROFILE\.codex\skills\skill-creator\scripts\quick_validate.py" skills\sap-abap-development
python "$env:USERPROFILE\.codex\skills\skill-creator\scripts\quick_validate.py" skills\sap-business-data-diagnosis
python "$env:USERPROFILE\.codex\skills\skill-creator\scripts\quick_validate.py" skills\sap-system-operations-diagnosis
python "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py" .
```

本地安装验证：

1. 使用 `update_plugin_cachebuster.py` 更新单一 Codex suffix。
2. 使用 `read_marketplace_name.py` 读取实际 marketplace 名称。
3. 使用 `codex plugin add sap-abap-adt-workbench@<已读取名称>` 重新安装。
4. 在新任务中验证三个 Skill 的触发和 MCP 工具目录。

不手改 `marketplace.json` 或 `config.toml`。插件阶段完成后在其独立仓库提交，建议提交：`feat: 支持内置 ADT 完整能力`

## Phase 8：真实 SAP 分级验收与发布

### 8.1 只读验证，无需写入授权

在用户指定测试系统按 15 项清单验证：

- 对象结构元素、类型层次和增强信息。
- domain、data element 和文本元素读取。
- ATC 文档读取。
- 开发包 preview。
- RAP availability、initial/content validation、schema、content、UI config 和 preview。

逐项记录：SAP 系统角色、client、SAP 版本、工具参数摘要、结果、权限/endpoint 不可用和未验证字段。endpoint 不可用是能力兼容性结论，不得改写为 MCP 实现成功。

### 8.2 工具目录和拒绝行为

核对三个实例：

- `sap-dev`：development，目标 114 个源码基准工具。
- `sap-qas`：diagnostic-readonly，只读目录。
- `sap-prd`：diagnostic-readonly，只读目录。

用只读方式验证 QAS/PRD 不列出新增写工具；直接调用拒绝由自动化 fake client 证明，真实 QAS/PRD 不发送试探性写请求。

### 8.3 DEV DDIC 与文本写入

必须再次取得用户对本次真实写入的明确授权，并由用户提供：

- 可清理的 Z/Y 测试对象。
- 既有、未释放且属于测试范围的 transport。
- 允许的 package 和 namespace。
- 预期字段变化与恢复方案。

先 preview 并展示差异，再调用 apply 触发原生确认。验证锁、写、解锁、激活、复读和必要的恢复证据。未得到授权时停留在 preview。

### 8.4 DEV 开发包迁移

单独取得用户确认。只使用无业务依赖的测试对象和明确的新旧 package；执行后只读核验。结果未知时停止，不自动迁回。

### 8.5 DEV RAP 生成与发布

只有系统支持 RAP Generator、用户提供专用测试目标并分别确认生成和发布时执行：

1. 先完成 availability、validation 和 preview。
2. 原生确认后生成一次。
3. 按对象清单复查。
4. 发布服务需要第二个独立计划和确认。
5. 不为了覆盖率自动删除对象、取消发布或重试未知结果。

### 8.6 发布前总验收

MCP：

```powershell
node scripts/check-adt-imports.mjs
npm test -- --runInBand
npm run build
git diff --check
```

另外检查：

- 全部工具集合、profile、dispatch 和 operation policy 一致。
- 145 个实例能力、4 个静态 helper 和 21 个新增原始工具名称完整。
- package/lockfile 无 `abap-adt-api` 依赖。
- Markdown 链接、版本、工具数量、许可证和第三方归属一致。
- git 工作树不包含 `.env`、审计日志、评测模型输出、真实 SAP 数据或 `.claude/`。

插件：

- MCP contract validator 通过。
- 三个 Skill quick validation 通过。
- plugin validation 通过。
- eval viewer 已由用户审阅，反馈已处理或明确记录。
- 独立 Git 仓库、GPL-3.0、THIRD-PARTY-NOTICES、公开 remote 和 tag 版本一致。

## 提交策略

### MCP 仓库

按可独立验证的阶段提交：

1. `refactor: 内置完整 ADT 客户端`
2. `feat: 注册完整 ADT 原始工具`
3. `feat: 建立高级操作确认计划`
4. `feat: 实现受控 DDIC 包迁移与 RAP 流程`
5. `feat: 集成完整能力安全策略`
6. `docs: 同步内置 ADT 完整能力`
7. `chore: 发布 0.3.0`

若某阶段需要拆分，拆分后的每个提交也必须 build 通过且不留下可从 profile 绕过的半成品写工具。不要提交、删除或修改现有 `.claude/`。

### 插件仓库

1. 建立独立 Git 历史并确认公开 remote。
2. 三个 Skill、共享参考、eval、manifest、README 和验证脚本作为一个可审查版本提交。
3. 正式版本 `0.2.0` 与 MCP `v0.3.0` 契约绑定。
4. 本地 cachebuster 不进入正式 tag 的基础 semver 决策。

## 最终完成标准

- MCP 在未安装 `abap-adt-api` 的干净环境中可以安装、构建、测试和启动。
- 内置客户端能力表面、许可证、基线提交和本地取消差异可审计。
- 21 个缺失能力全部有显式、有界、可测试的 MCP 工具。
- Profile 源码基准数量准确，无重复名称，无 catalog/dispatch/policy 漏项。
- 15 个新增只读能力可供开发、业务数据排查和系统运维使用。
- 6 个原始写工具只在 DEV legacy-full 可见，QAS/PRD 无法通过直调绕过。
- development 只通过三组受控 preview/apply 执行新增高级写入。
- 所有受控写入均在 preview 后使用一次 MCP 原生确认，确认前零写入。
- DDIC 和文本元素写入有验证和受控恢复；包迁移和 RAP 不执行不可靠的自动反向操作。
- 写入、生成、发布和迁移不盲目重试；未知和部分成功有明确结构化结果。
- 一个插件、三个 Skill 的路由、参考、eval 和 MCP contract 同步完成。
- MCP 可单独使用，插件不是运行时依赖。
- 自动化已验证、真实 SAP 已验证和仍未验证项在交付报告中清楚分开。
