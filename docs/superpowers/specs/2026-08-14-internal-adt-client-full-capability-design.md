# 内置 ADT 客户端与完整 MCP 能力设计

## 状态

- 日期：2026-08-14
- 状态：已完成逐节设计确认，等待书面规格复核
- 目标仓库：`mcp-abap-abap-adt-api`
- 当前依赖基线：`abap-adt-api@8.4.1`
- 迁入源码基线：`abap-adt-api@8.4.2` 加提交 `3cd8c17` 的可取消调试监听器实现

## 背景

当前 MCP 通过 npm 包 `abap-adt-api` 创建共享 `ADTClient`，handlers、安全工作流、SM21/ST22 分析和大量类型定义都直接依赖该包。项目计划将完整 ADT 客户端源码迁入 MCP 仓库，使 MCP 不再依赖独立发布的 `abap-adt-api` 包，同时继续保留 MCP SDK、Axios、XML 解析和运行时类型校验等基础依赖。

迁入源码不能改变现有 MCP 的安全边界。完整客户端能力可以注册为 MCP 工具，但工具是否可见、是否允许执行以及是否需要确认，仍由 profile、系统角色和调用时策略共同决定。

## 目标

1. 将完整 ADT 客户端实现纳入 MCP 仓库并由本项目直接维护。
2. 删除 npm 依赖 `abap-adt-api`，改为本地稳定入口导入。
3. 保留完整客户端能力，不裁剪当前尚未使用的方法。
4. 将当前缺失的 21 项客户端能力注册为 MCP 工具。
5. 保持现有工具名、参数、返回结构、安全确认和审计行为兼容。
6. 对新增写入能力建立 DEV 受控预览和 MCP 原生确认流程。
7. 保证 QAS/PRD 与 `diagnostic-readonly` 只能执行只读、校验和预览操作。
8. 保留上游许可证、版本、提交和本地差异信息，支持后续审计和同步。

## 非目标

- 不创建第二个 npm 包、workspace、git submodule 或运行时下载步骤。
- 不发布独立的内置 ADT 客户端包。
- 不把所有 ADT 写方法开放给 `safe`、`development` 或非 DEV 系统直接执行。
- 不设计可以接收任意方法名和任意参数的通用调用工具。
- 不在本次迁移中改变现有 ABAP 源码、对象创建、调试或 SM21/ST22 工具契约。
- 不承诺所有 ADT 端点在每个 SAP 版本均可用；服务发现、权限和系统版本错误必须如实返回。

## 当前能力差异

### 统计口径

完整能力以 `ADTClient` 的公开可调用实例表面为主要边界：

- 143 个公开实例方法。
- 2 个公开可调用属性：`hasTransportConfig`、`isProposalMessage`。
- 合计 145 个实例可调用能力。
- 另有 4 个静态 helper。

当前 MCP 源码实际调用 124 个实例可调用能力，覆盖率约为 85.5%，并使用静态 helper `classIncludes`。此外，MCP 直接使用 `stateful` 和 `httpClient` 等客户端状态或基础设施入口。

“实际调用”表示当前源码存在调用路径，不表示每项能力都已在真实 SAP 系统逐项验证。

### 按能力域对比

| 能力域 | MCP 实际调用 | 完整能力 | 尚未调用 |
|---|---:|---:|---|
| 会话与 Discovery | 12 | 12 | 无 |
| 对象与源码生命周期 | 17 | 18 | `objectStructureElements` |
| 代码智能与源码辅助 | 17 | 19 | `typeHierarchy`、`objectEnhancements` |
| Transport | 16 | 16 | 无 |
| DDIC、数据、服务与文本 | 9 | 15 | 域属性、数据元素属性和文本元素读写 |
| ABAP Unit | 3 | 3 | 无 |
| abapGit | 10 | 10 | 无 |
| Debug | 13 | 13 | 无 |
| ATC | 10 | 11 | `atcDocumentation` |
| Trace | 9 | 9 | 无 |
| 重构 | 6 | 8 | `changePackagePreview`、`changePackageExecute` |
| RAP Generator | 0 | 9 | 全部 9 项 |
| Feeds 与 ST22 | 2 | 2 | 无 |

### 21 项新增原始工具

只读、校验或预览类共 15 项：

1. `objectStructureElements`
2. `typeHierarchy`
3. `objectEnhancements`
4. `getDomainProperties`
5. `getDataElementProperties`
6. `getTextElements`
7. `atcDocumentation`
8. `changePackagePreview`
9. `rapGenValidateInitial`
10. `rapGenGetSchema`
11. `rapGenGetContent`
12. `rapGenGetUiConfig`
13. `rapGenValidateContent`
14. `rapGenPreview`
15. `rapGenIsAvailable`

写入、生成或发布类共 6 项：

1. `setDomainProperties`
2. `setDataElementProperties`
3. `setTextElements`
4. `changePackageExecute`
5. `rapGenGenerate`
6. `rapGenPublishService`

## 核心决策

采用“完整内置、完整注册、分级开放”：

- 将完整 `abap-adt-api` 客户端源码迁入 MCP 仓库。
- 145 个实例可调用能力和 4 个静态 helper 均保留在内部模块中。
- 当前缺失的 21 项能力全部注册成显式 MCP 工具。
- 只读能力按 profile 开放。
- 6 项原始写工具只在 `legacy-full` 暴露。
- `development` 通过三组受控预览和 apply 工具执行这 6 类写操作。
- QAS/PRD 和 `diagnostic-readonly` 不注册新增 apply 工具，并在调用时再次拒绝写操作。

完整注册不等于任意场景允许执行。工具目录过滤用于改善客户端体验，调用时策略检查是不可绕过的安全边界。

## 代码结构

```text
mcp-abap-abap-adt-api/
├─ src/
│  ├─ adt/
│  │  ├─ index.ts
│  │  ├─ AdtClient.ts
│  │  ├─ AdtHTTP.ts
│  │  ├─ AxiosHttpClient.ts
│  │  ├─ AdtException.ts
│  │  ├─ requestLogger.ts
│  │  ├─ utilities.ts
│  │  └─ api/
│  ├─ handlers/
│  ├─ safe/
│  └─ index.ts
├─ third-party/
│  └─ abap-adt-api/
│     ├─ LICENSE
│     └─ BASELINE.md
└─ package.json
```

### 内部模块边界

- `src/adt/index.ts` 是 MCP 内部使用 ADT 客户端的唯一稳定入口。
- handlers、safe workflow 和 SM21/ST22 代码不得深层导入 `src/adt/api/*`。
- `src/adt/api/*` 保留上游模块组织，以降低同步补丁的理解成本。
- 内置客户端不作为 MCP 包的独立对外公共 API 承诺。
- `third-party/abap-adt-api/BASELINE.md` 记录上游仓库、版本、基线提交、本地取消能力提交和已知差异。
- `third-party/abap-adt-api/LICENSE` 保留 MIT License 原文。

### 依赖边界

删除：

- `abap-adt-api`

改为 MCP 直接依赖：

- `axios`
- `fast-xml-parser`
- `fp-ts`
- `html-entities`
- `io-ts`
- `io-ts-reporters`
- `sprintf-js`

依赖版本以迁入基线的锁定版本为起点，迁移阶段不顺带升级。

## Handler 归属

新增原始工具遵循现有 handler 分域，不创建一个任意方法转发器：

- 对象结构、类型层次和增强信息归入对象或代码分析 handler。
- 域、数据元素和文本元素读写归入 DDIC 相关 handler。
- `atcDocumentation` 归入现有 ATC handler。
- 开发包变更归入现有重构 handler。
- RAP Generator 新建独立 `RapGeneratorHandlers`，集中维护 9 个工具的 schema、注解和分发。

所有工具必须具有明确 JSON Schema、响应大小限制、只读或破坏性注解以及 profile 分类。不得直接透传未经限制的任意对象。

## Profile 与工具数量

| Profile | 当前数量 | 最终数量 | 变化 |
|---|---:|---:|---|
| `safe` | 7 | 7 | 不变 |
| `development` | 93 | 114 | 15 个只读原始工具和 6 个受控工具 |
| `diagnostic-readonly` | 79 | 94 | 15 个只读原始工具 |
| `legacy-full` | 136 | 157 | 21 个完整原始工具 |

### Profile 语义

- `safe`：继续只包含现有受控 ABAP 源码修改和对象创建工具。
- `development`：面向 DEV 开发 Skill，包含完整只读能力、受控调试和新增受控高级写入流程。
- `diagnostic-readonly`：面向业务排查与系统运维 Skill，只允许读取、校验和不落地预览。
- `legacy-full`：提供完整原始 ADT 能力，包括新增 6 个原始写工具，并保留高风险提示。

系统角色优先于 profile。即使配置错误地选择了可写 profile，QAS/PRD 仍必须在调用时拒绝新增写入、生成和发布操作。

## DEV 受控写入工具

新增三组显式工作流，共 6 个工具：

| 工具组 | 覆盖的底层操作 |
|---|---|
| `previewDdicPropertyChange` / `applyDdicPropertyChange` | 域属性、数据元素属性、文本元素写入 |
| `previewPackageChange` / `applyPackageChange` | 修改对象开发包 |
| `previewRapOperation` / `applyRapOperation` | RAP 生成、发布服务 |

不得提供能够执行任意 `ADTClient` 方法的通用受控写工具。每个预览输入使用有界的判别联合类型，明确允许的操作种类和字段。

### 通用流程

```text
读取现状或能力检查
  -> 输入校验
  -> 生成完整预览
  -> 保存短期操作计划
  -> 向用户返回预览
  -> apply 打开 MCP 原生确认
  -> 重新检查系统角色、计划有效期和状态漂移
  -> 执行一次写入
  -> 验证结果
  -> 记录审计与清理计划敏感载荷
```

### 计划约束

- apply 只接受服务器生成的计划 ID。
- 计划绑定系统主机、client、目标对象、操作类型和输入摘要。
- 计划有短 TTL 和容量上限。
- 计划只能成功执行一次。
- 计划状态漂移、过期或确认取消后不得继续执行。
- 原生确认不可用时拒绝执行；新增高级写入不支持文字确认降级。
- 计划状态响应不得返回完整源码、属性敏感值、调试变量值或凭据。

## 分域执行与恢复

### DDIC 属性与文本元素

预览阶段：

1. 读取当前属性或文本元素。
2. 校验目标对象、字段范围、Transport 和 DEV 策略。
3. 生成字段级差异并保存原值摘要与目标值。

apply 阶段：

1. 重新读取当前值并检查漂移。
2. 锁定目标对象。
3. 调用对应 setter，传入锁句柄和既有 Transport。
4. 释放锁并按对象要求激活。
5. 重新读取并逐字段验证。

若验证失败，使用原值尝试一次受控恢复并再次验证。恢复失败必须保留主要错误和恢复错误，不得把解锁或恢复错误覆盖为唯一错误。

### 修改开发包

预览阶段调用 `changePackagePreview`，返回旧包、新包、目标对象、影响对象和 Transport 信息。

apply 前重新调用 preview，并比较影响对象、目标包和关键返回字段。漂移时终止。

`changePackageExecute` 是服务端重构操作，不保证具备安全的原子反向操作。因此：

- 不自动执行反向迁移。
- 不自动重试。
- 执行后读取对象结构或包元数据验证。
- 无法确认结果时返回 `UNKNOWN_OUTCOME`，要求先只读核验。

### RAP 生成与发布

RAP 生成预览依次执行可用性检查、初始校验、内容校验和 `rapGenPreview`，返回预计生成对象清单、验证消息和 Transport。

apply 前重新执行关键校验和 preview，确认对象清单未漂移，然后只调用一次 `rapGenGenerate`。

发布服务预览至少返回服务绑定名、目标系统身份、可用性和当前可读取状态；确认后只调用一次 `rapGenPublishService`。

RAP 生成可能产生多个对象，发布也可能在远端完成但响应丢失，因此：

- 不自动删除已生成对象。
- 不自动取消发布。
- 不盲目重试生成或发布。
- 按返回对象逐项核验并区分成功、部分成功和未知结果。
- 将需要人工处理的对象列表放入结构化错误详情，但不得包含凭据或无限大响应。

## 错误模型

受控工作流统一记录以下阶段，未适用的阶段标记为跳过：

```text
VALIDATE
PREVIEW
CONFIRM
DRIFT_CHECK
LOCK
EXECUTE
UNLOCK
ACTIVATE
VERIFY
ROLLBACK
```

稳定错误类型至少覆盖：

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

保留上游 ADT 错误上下文、HTTP 状态和稳定的请求取消码，但对外错误不得泄露密码、Cookie、CSRF token、Authorization header 或完整敏感载荷。

读取请求只有在确认无副作用且现有客户端策略允许时才能重试。写入、生成、发布和开发包迁移一律不自动重试。

## 审计

沿用现有 JSONL 审计基础设施，并为新增工作流记录：

- 时间、系统身份、client 和系统角色。
- 工具名、操作种类、目标对象、Transport 和计划 ID。
- 预览摘要、确认方式和各阶段结果。
- 验证结论、回滚结论和未知结果对象清单。
- 参数与结果的摘要或哈希，而非完整敏感内容。

审计写入失败不得悄悄忽略。是否阻止远端写入沿用现有审计策略；远端写入已经发生后，审计失败不得触发盲目重试。

## 兼容性

第一阶段只替换客户端来源，不改变现有 136 个 `legacy-full` 工具和其他 profile 的契约。

兼容要求：

- 现有工具名、input schema、annotations 和 `_meta` 保持不变。
- 现有工具返回的 `content` 与 `structuredContent` 形状保持不变。
- ABAP 预览仍展示完整 Markdown diff，apply 仍只有一次服务器原生确认。
- QAS/PRD 源码只读策略、DEV 白名单、Transport 校验、漂移检查和回滚规则保持不变。
- 调试监听器取消能力保留 `3cd8c17` 中的稳定取消语义。
- SM21 继续复用内置客户端的已认证 HTTP client，并保持自定义 SICF 服务只读。

## 验证策略

### 静态与构建验证

- TypeScript 严格构建通过。
- `package.json` 和 lockfile 不再包含 `abap-adt-api`。
- 基础依赖成为直接依赖且版本被锁定。
- 内置客户端表面校验为 145 个实例可调用能力和 4 个静态 helper。
- 所有原 `abap-adt-api` 导入均改为本地稳定入口。
- `git diff --check` 通过。

### 自动化测试

- 迁入可离线运行的上游客户端单元测试，包括 HTTP、XML、RAP helper 和调试取消测试。
- 现有 MCP 测试全部通过。
- 为 21 个新原始工具测试 schema、参数映射、返回映射和错误映射。
- 校验工具数量为 `safe=7`、`development=114`、`diagnostic-readonly=94`、`legacy-full=157`。
- 校验所有 profile 无重复工具名。
- 校验新增 15 个只读工具具有正确只读注解和响应限制。
- 校验新增 6 个原始写工具只在 `legacy-full` 可见。
- 校验 QAS/PRD 在直接构造调用时仍拒绝新增写操作。
- 校验三个受控 workflow 在确认前零写入。
- 覆盖计划过期、重复执行、确认取消、状态漂移、锁失败、写失败、解锁失败、验证失败、回滚失败、部分成功和未知结果。
- 校验写操作从不自动重试。

### 真实 SAP 验证

真实测试按风险递增：

1. 在测试系统验证 15 个新增只读、校验和预览工具。
2. 验证不同 profile 的实际工具目录和拒绝行为。
3. 在 DEV 使用可清理的 Z 对象和用户指定的既有 Transport 验证 DDIC 与文本元素写入。
4. 在用户明确确认后验证开发包迁移。
5. 在系统支持 RAP Generator 且用户提供安全测试目标时验证 RAP 生成与发布。

QAS/PRD 只执行只读验证，不执行真实写入。自动化通过不等于真实 SAP 能力已验证，最终汇报必须分开说明。

## 实施阶段

### 阶段一：依赖内置与行为等价

- 迁入完整客户端源码、许可证和基线信息。
- 添加基础直接依赖并移除 `abap-adt-api`。
- 替换导入路径。
- 迁入离线单元测试。
- 保持所有现有工具和 profile 数量不变。

阶段一未通过等价验证时不得继续注册新工具。

### 阶段二：注册 21 个原始工具

- 扩展现有 handler 并新增 RAP handler。
- 添加明确 schema、注解、参数限制和响应限制。
- 更新只读白名单和 profile 选择。
- 达到 `diagnostic-readonly=94`、`legacy-full=157` 的目标。

### 阶段三：实现 DEV 受控高级写入

- 实现 DDIC、开发包和 RAP 三组 preview/apply workflow。
- 接入计划存储、原生确认、漂移检测、验证、审计和分域恢复。
- 达到 `development=114` 的目标。

### 阶段四：文档、Skill 与发布准备

- 根据最终源码更新 README、中文使用指南和配置说明。
- 更新一个插件、三个 Skill 的能力路由和安全规则。
- Skill 只引用 MCP 工具契约，不依赖已移除的 npm 包。
- 审计工具数量、链接、版本、许可证和公开发布元数据。

## 验收标准

1. MCP 可在未安装 `abap-adt-api` 包的环境中安装、构建和启动。
2. 内置客户端完整保留 145 个实例可调用能力和 4 个静态 helper。
3. 阶段一完成后，现有工具契约和安全行为没有回归。
4. 最终 21 个缺失能力均有显式原始 MCP 工具。
5. 最终 profile 数量准确且不存在重复工具名。
6. 15 个新增只读工具可用于开发、业务排查和系统运维场景。
7. 6 个新增原始写工具只在 `legacy-full` 暴露。
8. DEV 可通过三组 preview/apply 工具受控执行新增写操作。
9. QAS/PRD 和 `diagnostic-readonly` 无法执行新增写入、生成或发布。
10. 所有写入均在用户看到预览并完成 MCP 原生确认后执行，且不支持文字确认降级。
11. DDIC 与文本元素写入具有验证和受控恢复；开发包与 RAP 不执行不可靠的自动反向操作。
12. 对不确定结果不盲目重试，并返回可供只读核验的结构化信息。
13. 自动化验证、真实 DEV 验证和未验证能力在最终汇报中明确区分。
