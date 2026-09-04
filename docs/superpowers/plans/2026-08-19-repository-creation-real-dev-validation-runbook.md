# 仓库对象创建平台真实 DEV 验证手册

## 1. 目的与边界

本手册用于把某个对象类型从 `AUTOMATION_VERIFIED` 提升到 `REAL_DEV_VERIFIED`。每种对象必须独立完成创建、检查、激活、active 读取、传输核验和清理，不能用 Eclipse 抓包或自动化测试替代新平台自身的真实执行证据。

验证只允许在隔离 DEV、`development` 或 `development-workbench` Profile 中进行。QAS、PRD、未知角色、`safe` 和只读 Profile 均不得参与。

## 2. 当前启动条件

当前已注册的 31 类对象（包括 `DDIC_STRUCTURE`、`DDIC_TYPE_GROUP`、`DDIC_LOCK_OBJECT`、`LOGICAL_EXTERNAL_SCHEMA`、`DDIC_DOMAIN`、`DATA_ELEMENT`、`MESSAGE_CLASS` 与 `TTYP/DA`）仍均为非 `REAL_DEV_VERIFIED`。公共 `applyRepositoryObjectCreation` 仅在能力已正式可写，或默认关闭且按对象类型、前缀、包和传输精确限定的 REAL_DEV 验证模式生效时，才会在可信原生确认后进入写入；不得通过提前修改成熟度绕过该门。

验证模式必须继续满足：

- 仅 DEV 的两个开发 Profile 可用。
- 仅允许配置中显式列出的对象类型和隔离命名前缀。
- 仍只接受服务端 `creationPlanId`，并打开一次 MCP 原生 form。
- capability 继续返回 `writable=false`，直到完整验证和清理完成。
- 未知写结果立即停止，不重试、不自动删除。
- 验证模式默认关闭，不得进入发布默认配置。

当前首批验证配置（仅用于独立 PowerShell 进程，不写入仓库 `.env`）：

```text
SAP_MCP_REAL_DEV_VALIDATION=true
SAP_MCP_REAL_DEV_VALIDATION_OBJECTS=DDIC_DOMAIN,DATA_ELEMENT,DDIC_TABLE_TYPE,DATABASE_TABLE
SAP_MCP_REAL_DEV_VALIDATION_PREFIX=ZZMCP_VT_
SAP_MCP_REAL_DEV_VALIDATION_PACKAGE=Z001
SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT=S4HK900009
```

## 3. 验证准备

1. 使用未释放、属于当前 SAP 用户的开发传输。
2. 选择隔离父包和命名前缀，例如 `ZZMCPV_`；不得复用业务对象。
3. 记录 SAP host、client、用户、系统角色、Profile、构建版本和 Git commit/diff 标识。
4. 先确认可信原生 provider 可用：Windows 默认使用 Explorer broker + 一次性 named pipe，其他平台使用已协商成功的 MCP form；不允许文字确认降级。
5. 通过只读搜索确认目标对象不存在，并保存传输当前对象清单基线。
6. 为创建和清理分别预留独立确认；创建确认不能授权后续删除。

## 4. 通用执行步骤

1. 调用 `listRepositoryObjectCreationCapabilities`，确认目标类型成熟度、availability 和验证模式状态符合预期。
2. 调用 `describeRepositoryObjectCreation`，保存输入 Schema、固定默认值、阶段图和补偿限制。
3. 调用 `previewRepositoryObjectCreation`，复核完整 review、传输号、payload hash 和零 mutation 证据。
4. 调用 `applyRepositoryObjectCreation`，在原生确认窗口中核对对象、传输和 hash 后确认一次。
5. 调用 `getRepositoryObjectCreationStatus`，确认每个远端阶段均有结果，且没有锁句柄、凭据或完整源码泄漏。
6. 使用独立只读接口读取 active 对象、源码、属性和传输内容，并与计划 review 做语义比较。
7. 在 Eclipse ADT 中只读打开对象，确认对象状态、包归属、语法和激活状态。
8. 通过独立确认执行清理，随后再次核验对象缺失、无残留锁、传输内容符合预期。

任何阶段出现超时、连接中断或未知响应时，状态必须为 `OUTCOME_UNKNOWN`。先只读调查真实状态，禁止重新 apply 或直接删除。

2026-08-24 的 `DDIC_DOMAIN` 首次真实创建已证明该规则必要：远端创建至激活均完成，但旧验证器因 SAP 空默认值规范化问题保留 `OUTCOME_UNKNOWN`。独立 active 复读确认对象和核心属性正确，代码已修复；历史计划不改写、不重放，清理仍需新的独立授权。完整证据见 `docs/evidence/real-dev-validation-phase-0-gate.md`。

当前 31 类验证活动不再按类型反复修改配置：`SAP_MCP_REAL_DEV_VALIDATION_OBJECTS` 一次显式列出当前全部 31 类，前缀统一为 `ZV`，包和传输仍为 `Z001` / `S4HK900009`。不允许 `*`，未来新增类型不会自动开放。父对象型计划冻结独立 `packageName`；函数组 Include 使用 `ZVFG1` + `Z01` → `LZVFG1Z01` 规则。完整清单见 `docs/superpowers/specs/2026-08-24-repository-validation-campaign-design.md`。

## 5. 对象专项验收

### 5.1 `PROGRAM` / `FUNCTION_GROUP` / `FUNCTION_MODULE`

- 验证完整源码 hash；只允许已知换行规范化和函数模块格式差异。
- 函数组先创建组、再创建首个函数模块；清理顺序必须相反。
- 函数组生成 Include 由 SAP 管理，不得作为调用方源码写入。

### 5.2 `PACKAGE`

- 验证父包、软件组件、传输层、`development`、封装和 record-changes 属性。
- 只有能证明由当前计划创建且为空的包才可清理。

### 5.3 `DATABASE_TABLE`

- 分别验证表主体和 `TABL/DTT` technical settings 的 inactive/active 状态。
- 至少执行普通字段、合法 `CURR`/币种引用、合法 `QUAN`/单位引用三组用例。
- 验证 `tableStatusCheck`、`abapCheckRun`、技术设置、active source 和传输内容。

### 5.4 `ABAP_CLASS` / `ABAP_INTERFACE` / `PROGRAM_INCLUDE`

- Class 壳默认必须与 Eclipse ADT 3.60.2 一致：`public`、`final=true`；Interface 和 Include 不接受未证实的额外壳属性。
- 分别验证固定 collection/validation URL、版本化 media type、canonical Location、响应身份、服务端 source link、源码语法检查、解锁、激活和 active source 复读。
- Class 必须验证 definition/implementation 完整源码；Interface 必须验证完整 interface block；Include 必须明确 standalone 或 parent-program 语义后再执行真实验证。

### 5.5 `CDS_DATA_DEFINITION` / `CDS_ACCESS_CONTROL` / `CDS_METADATA_EXTENSION`

- 分别核对 DDLS `ddlSource.v2`、DCL `dclSource`、DDLX Blue/`ddic.ddlx.v1` 的 collection、validation、canonical Location 和响应身份。
- DCL 必须以现有 active STOB 实体为 `referencedObjectName`；DDLX 必须以现有 active、非 extension 的 `DDLS/DF` 为引用，并验证 preview/apply 两次引用复核都命中同一 URI。
- 验证 CDS checkrun、服务端 source link、锁定、源码写入、解锁、激活和 active source 复读；任何引用漂移或未知结果都必须停止，不能重试或盲删。

### 5.6 `CDS_ANNOTATION_DEFINITION` / `SERVICE_DEFINITION` / `BEHAVIOR_DEFINITION`

- 分别核对 DDLA `ddic.ddla.v1`、SRVD `ddic.srvd.v1` 和 BDEF Blue v1 的 validation、collection、canonical Location、服务端 source link 与响应身份。
- Service Definition 必须使用定义变体并绑定现有 active STOB；Behavior Definition 必须绑定同名 active 根 CDS 实体。不得用本轮验证尝试 Service Extension 或 Behavior Extension。
- 验证源码写入、检查、解锁、激活和 active source 复读；引用漂移或任何未知写结果都必须停止，不能重试或盲删。

### 5.7 `SERVICE_BINDING`

- 先准备一个已激活的 `SRVD/SRV`，分别覆盖 OData V2/V4 和 UI/Web API 类别；确认 preview 只读取、不创建。
- apply 后必须执行标准 ADT activation，再核对 `SRVB/SVB` 的 canonical Location、active 读取、包归属、Service Definition、协议版本、类别、`0001` 服务版本、`bindingCreated=true` 和 `published=false`。
- 验证创建后配置复读和精确清理；创建或删除结果不明确时停止，不重试、不盲删。

### 5.8 `DDIC_STRUCTURE`

- 先确认 `/sap/bc/adt/ddic/structures` 在 ADT discovery 中返回带 `type` 的创建 template；preview 必须冻结该 accepted content type，apply 必须重新读取并拒绝媒体类型漂移。
- 验证 `TABL/DS` canonical Location、包归属、服务端 source link、结构源写入、语法检查、解锁、激活和 active source 复读。
- 当前切片只覆盖普通组件和数据元素类型，不接受 key、未绑定 CURR/QUAN 引用；未知创建、写源、解锁或激活结果均不得重试或盲删。

## 6. 证据记录

每种对象保存一份不含业务数据和秘密的验证摘要：

| 字段 | 要求 |
| --- | --- |
| 对象类型 / ADT 类型 | 稳定 `objectKind` 与精确 ADT 类型 |
| 系统上下文 | host 脱敏标识、client、角色、Profile |
| 计划证据 | plan id、payload hash 前缀、阶段结果 |
| SAP 证据 | 创建、检查、激活、active 读取、传输核验结果 |
| 清理证据 | 对象缺失、无锁、传输复查 |
| 异常 | 已知失败、未知结果、人工处理 |

只有创建与清理都通过，且没有未解释差异或未知结果，才可在代码评审中把该对象成熟度提升为 `REAL_DEV_VERIFIED`。
