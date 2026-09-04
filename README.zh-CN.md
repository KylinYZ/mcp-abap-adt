[English](README.md) | [简体中文](README.zh-CN.md)

免责声明：本服务仍处于实验阶段。默认 `safe` 模式提供受控的源码变更与对象创建流程，但 SAP 权限设计、传输治理、备份和人工复核仍由使用方负责。

# ABAP-ADT-API MCP 服务

## 项目说明

`@kylinyz/mcp-abap-abap-adt-api` 是一个连接 MCP 客户端与 SAP ABAP Development Tools（ADT）接口的 MCP 服务，是 [`mario-andreschak/mcp-abap-abap-adt-api`](https://github.com/mario-andreschak/mcp-abap-abap-adt-api) 的修改版分支，使用独立的 npm 作用域名发布。完整 ADT 客户端已经内置在 `src/adt/`，安装和运行不再依赖外部 `abap-adt-api` npm 包。内置源码基于上游 `abap-adt-api` 8.4.2 和 MIT License，精确提交、许可证与后续同步方法见 [`third-party/abap-adt-api/BASELINE.md`](third-party/abap-adt-api/BASELINE.md)。

> **分发状态（2026-08-18）：** `0.5.0` 已以 `@kylinyz/mcp-abap-abap-adt-api` 发布到 npm。推荐在 MCP 配置中使用带作用域且固定版本的包名。原作者不带作用域的 `mcp-abap-abap-adt-api`（0.1.1）是独立的旧版本。

完整安装、客户端接入和操作步骤见 [使用指南](docs/使用指南.md)。从本地 `.tgz` 或源码入口切换到 npm 线上包时，使用 [npm 线上版本迁移指南](docs/npm线上版本迁移指南.md)。

> **相关项目：** 如果需要更高层、以只读为主的 ABAP 工具（例如 `GetProgram`、`GetClass`、`GetTable`），请使用独立的 [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) 项目。本项目提供的是较底层的 ADT 能力，并在其上增加了默认启用的安全源码变更门面。

## 功能

当前代码按 profile 注册七套工具面：

| Profile | 工具数 | 功能范围 | 建议用途 |
| --- | ---: | --- | --- |
| `safe`（默认） | 7 | 受控读取/修改 `PROGRAM`、`INCLUDE`、`CLASS`、`FUNCTION_MODULE`，以及受控创建 `PROGRAM`、`FUNCTION_GROUP`、`FUNCTION_MODULE` | 日常 AI 辅助 ABAP 开发 |
| `development` | 124 | 向后兼容的宽开发与诊断工具面，并提供受控仓库对象创建平台五工具 | 现有开发客户端 |
| `diagnostic-readonly` | 99 | 向后兼容的宽只读诊断工具面 | 现有诊断客户端 |
| `legacy-full` | 161 | 7 个安全工具 + 6 个高层运行工具 + 148 个原始低层 ADT 工具 | 仅 DEV 的兼容与专家直接控制 |
| `development-workbench` | 87 | 聚焦开发、安全调试、受控高级操作、质量检查和仓库对象创建能力目录 | ABAP 开发 Skill |
| `business-readonly` | 17 | 先取 schema、再做有界业务数据读取 | 业务数据 Skill |
| `operations-readonly` | 40 | 运行、版本、trace 和已有调试现场证据 | 运维 Skill |

以上为关闭验证开关的常规数量；显式启用 `SAP_MCP_REAL_DEV_VALIDATION=true` 后，仅 DEV `development` / `development-workbench` 额外开放 3 个验证专用 cleanup 工具，目录总数分别为 127 / 90，其他 Profile 与 QAS/PRD 均不可见。

`0.4.0` 新增 `readRuntimeDumps`、`describeClassicTable`、`inspectSapSystem`、`getAbapMemberSource` 四个高层只读工具，以及仅 DEV `development-workbench` 可见的 `previewQualityCheck`、`runQualityCheck`、`getQualityCheckStatus`。按 SAP 返回的精确 ADT URL 读取源码的 `getObjectSource` 在 `development`、`diagnostic-readonly`、`legacy-full` 和 `development-workbench` 中开放，但不进入 `safe`、业务和运维 Profile。成员级或 URL 级源码只用于聚焦阅读；任何源码写入仍必须先用 `inspectAbapObject` 读取完整对象作为基线。大型源码可使用可选 `startLine`/`maxLines` 分页，每页都返回完整源码哈希和行覆盖信息，调用方必须拒绝缺页或哈希漂移。

`development` 与 `development-workbench` 在 DEV 额外提供 `list/describe/preview/apply/status` 五个受控仓库对象创建工具。当前切片已完成能力目录、计划状态机、原生确认、未知结果停止和 Profile 双重门控；首批五类对象都已接入自动化适配器：程序/函数对象复用现有受控创建工作流，包/数据库表使用类型化 Eclipse ADT 契约。即使 `writable=false`，preview 也会返回完整源码、对象图或属性供审阅；apply 仍必须等对应适配器经过独立确认的真实 DEV 全链路验证后才开放。

验证期间可额外使用 `previewRepositoryObjectCleanup`、`applyRepositoryObjectCleanup`、`getRepositoryObjectCleanupStatus`：服务端冻结精确对象、开发包、传输、父依赖和逆序删除图；删除必须单独原生确认，未知结果绝不重放。对象删除后必须保留唯一匹配的 CTS 删除条目，以便 QAS/PRD 同步删除。[成熟度证据清单](docs/evidence/repository-creation-maturity-evidence.json) 对 create、active/final readback、创建与删除传输证据、cleanup、absence 逐项 fail-closed 校验，历史失败身份不能用于晋级。

仓库对象创建的确认 provider 由 `SAP_MCP_CONFIRMATION_PROVIDER` 固定选择，默认 `auto`。`auto` 会在实际确认时优先使用客户端支持的 MCP form；Windows 客户端不支持 form 时，才通过 Explorer broker 在当前交互桌面显示系统原生 Apply/Cancel 弹窗，并用一次性 named pipe 回传结果。确认框的有效期按北京时间（UTC+08:00）显示，等待时间最长 15 分钟且不会超过计划剩余有效期。该流程不开放 TCP 端口，也不向 helper 提供 SAP 凭据。可显式选择 `windows-native` 或 `mcp-form`。`mcp-app` 在 App-only 隔离未验证前会安全拒绝，不会回退为文字确认或调用方布尔值。

2026-08-24 已在 Codex Desktop 完成 Windows 路径端到端复核：取消能返回原始 `tools/call`，同一 session 随后仍可查询状态；确认创建也不会再发生自锁。原自锁由 `applyRepositoryObjectCreation` 先占用唯一外层 SAP gate、确认后又等待同一 gate 执行 workflow 引起。当前仓库 apply/status 不占外层 gate，只有确认后的完整 SAP workflow 在 gate 内串行执行一次。

同日经单独授权的精确 DEV 验证在包 `Z001`、传输 `S4HK900009` 中创建并激活了 `DDIC_DOMAIN` `ZZMCP_VT_DOM`，独立 active 复读确认 `CHAR(10)` 和输出标志与计划一致。历史计划仍保留 `OUTCOME_UNKNOWN`：旧验证器把 SAP 自动补出的空 `valueInformation` 与调用方省略该可选块误判为不同；当前比较只规范化这个空默认值，非空值表、固定值和 append 标志仍严格比较。31 类创建侧活动现已全部形成明确结果；由于清理和传输收尾尚未完成，能力仍保持 `writable=false`。后续按产品化计划逐类晋级，每次真实操作仍需独立确认。

Phase 2 纳入的十三类源码/服务对象中，接口、Include、CDS Data Definition、DCL、Metadata Extension、Service Definition、Behavior Definition、CDS Type、CDS Aspect、Service Binding 十类现已完成真实 DEV 生命周期并达到 `REAL_DEV_VERIFIED`。Class、Annotation Definition、CDS Entity Buffer 仍未晋级。DCL、MDE、SRVD、BDEF 与 Entity Buffer 会冻结 active CDS 引用；Service Binding 会冻结 active Service Definition，执行独立 activation，并复核 OData 配置与未发布状态。

完整覆盖口径以 Eclipse ADT 3.60.2 的已安装 New Wizard 为准。当前能力目录覆盖 31 个，尚有 111 个待提取协议；当前 `REAL_DEV_VERIFIED=26`，其余 5 类仍不可写。证据见 `docs/evidence/`，静态映射见 [ADT 创建向导清单](docs/evidence/eclipse-adt-3.60.2-creation-wizard-manifest.json)。

内置能力新增 21 个显式原始工具，覆盖对象结构元素、类型层次、增强、DDIC 属性与文本、ATC 文档、开发包迁移及 RAP 生成/发布。`development` 使用其中 15 个只读/校验/预览工具，并额外提供 DDIC、包迁移、RAP 三组共 6 个受控 `preview`/`apply` 工具。完整名称、分组和风险边界见[使用指南的功能清单](docs/使用指南.md#4-mcp-功能与工具清单)。

`LOGICAL_EXTERNAL_SCHEMA`（`DESD/TYP`）已完成 server-driven 受控切片，当前为 `CONTROLLED_IMPLEMENTED`、`available=true`、`writable=false`。流程会冻结目标 `$schema`，创建 Blue v1 壳，通过对象 source link 写入受控 objectTypes.v1 JSON，激活并复读；SAP 管理的 `usesRouting=true` 会被拒绝。本切片未执行真实 SAP 写入。

`NUMBER_RANGE_OBJECT`（`NROB/NRO`）也已完成同等级的 server-driven 受控生命周期，当前为 `CONTROLLED_IMPLEMENTED`、`available=true`、`writable=false`。preview 会冻结目标 objectTypes.v1 `$schema`、Blue v1 壳媒体类型、包/传输身份，以及 active Domain、Data Element、Transaction 依赖；apply 只能写入评审后的 `application/json` 区间与缓冲字段，并复读 workingArea 和 active 内容。调用方不能提供 URL、JSON、媒体类型或 lock handle。`ZVNRO1` 已完成真实 DEV 创建、激活和 active JSON 复读；清理与传输收尾仍待完成。

`SAP_OBJECT_TYPE`（`RONT/ROT`）是当前能力目录注册的第 24 类对象，已达到 `CONTROLLED_IMPLEMENTED`、`available=true`、`writable=false`。preview 会冻结目标 Blue v2 discovery 和三份 `newObjectTypes.v1` `$new` 契约，把六类受控类别映射为 Eclipse 使用的 `bo`/`to`/`ao`/`co`/`do`/`ho`，并在内部派生大写仓库名、metadata、base64 JSON、XML、URL 和媒体类型。apply 只执行一次壳 POST，复核 inactive JSON，激活一次，再复读 active metadata、内容及 SAP 生成的 `objectTypeCode`；调用方不能提交这些协议字段或生成码。Eclipse ADT 3.60.2 JAR 行为与目标 DEV discovery、schema、configuration、content、validation 已完成只读核验，但没有执行真实 RONT 创建、激活、删除或清理，因此仍不开放写入。

`SAP_OBJECT_NODE_TYPE`（`NONT/NOT`）是能力目录注册的第 26 类对象，同样为 `CONTROLLED_IMPLEMENTED`、`available=true`、`writable=false`。公开输入只允许 PascalCase 节点名、描述、包、传输、大写的现有 RONT 仓库名和显式 `rootNode` 选择。preview 会冻结 active RONT 的 URI、CamelCase 语义名、Blue v2 discovery 及三份 `newObjectTypes.v1` 契约；apply 重新核验引用与契约后只执行一次壳 POST 和一次激活，并复读 inactive/active JSON。active `sapObjectType` 必须等于冻结的 RONT 语义名，一个 RONT 只能有一个 root node 的约束仍由 SAP 判定。Eclipse ADT 3.60.2 JAR 行为与目标 DEV discovery、契约、validation 和 active 示例已完成只读核验，但没有执行真实 NONT 创建、激活、删除或清理。

`MESSAGE_CLASS`（`MSAG/N`）是能力目录注册的第 29 类对象，已完成 `CONTROLLED_IMPLEMENTED`、`available=true`、`writable=false` 的受控源码切片。公开输入仅包含消息类名称、描述、包/传输，以及可选的 `001`–`999` 三位消息号和最多 72 个可打印字符的消息文本；长文本和消息文档暂不开放。preview 冻结 ADT 源码契约，apply 只创建一次壳、锁定、写入受控 `mc:messages` 源码、解锁、激活一次，并复核 inactive/active 源码及对象身份；激活或后续复核不明确即进入不可重试的 `OUTCOME_UNKNOWN`，绝不自动删除。当前未执行真实 MSAG 创建、激活、删除或清理。

`DDIC_TABLE_TYPE`（`TTYP/DA`）已接入结构化 XML 受控生命周期，公开输入只允许行类型、目标系统公布的预定义类型、长度/小数位范围、表访问类型及已确认的主键/二级键默认值。`CURR`、`QUAN` 不再被静态拒绝，其边界来自目标系统 `abapType` 能力响应。adapter 会保留服务器返回的 value-help 模板，只替换受控属性，随后执行工作区复读、解锁、激活和 active 复读；任意 XML、URL、媒体类型、链接和 lock handle 均不开放。高级 key-components 请求体仍需独立 Eclipse 抓包后再接入。

`CHANGE_DOCUMENT_OBJECT`（`CHDO/CHD`）现为 `REAL_DEV_VERIFIED`、`available=true`，在可写 DEV profile 中为 `writable=true`。公开输入不接受 SAP 隐藏的 `CD/600` 默认值。全新身份 `ZVPCHDO05` 已完成正式 `APPLIED` 创建、working/active 复读、SAP 生成 active Class、仅删除 CHDO 后的 Class 级联缺失，以及同一未释放传输中唯一 neutral `CHDO/CLAS` CTS 证据；历史 `ZVPCHDO04` unknown 计划保持原样且未复用。

31 类创建侧验证已于 2026-08-25 完成并全部形成明确结果；当前目标已转为逐类产品化，完成清理与传输证据后晋级 `REAL_DEV_VERIFIED`，使其在关闭临时验证开关后正式可用。当前状态与新会话接手说明见 [产品化交接](docs/evidence/repository-creation-productionization-handoff.md)，实施顺序见 [产品化计划](docs/superpowers/plans/2026-08-25-repository-creation-productionization-plan.md)。

### 默认 `safe` 模式

- **支持四类源码对象**：`PROGRAM`、`INCLUDE`、`CLASS`、`FUNCTION_MODULE`。
- **支持受控对象创建**：可创建 `PROGRAM`、已有函数组中的 `FUNCTION_MODULE`，以及一次预览“新函数组 + 首个函数模块”；单独空 `FUNCTION_GROUP` 暂停开放，等待目标系统 Eclipse 激活协议证据。
- **先审阅、后修改**：读取精确对象的完整当前源码，验证完整目标源码，执行语法检查并返回完整 diff；预览阶段不会锁定、写入或激活 SAP 对象。
- **跨客户端确认**：客户端支持 MCP `elicitation.form` 时使用原生弹框；不支持时，可按配置启用绑定计划的一次性文字确认。
- **策略边界**：只允许 DEV 角色、白名单主机、客户端和命名空间；拒绝 `$TMP`，并要求 SAP 为目标对象返回一个已有且未释放的传输请求。
- **应用阶段保护**：再次校验传输和源码哈希，获取有状态 `MODIFY` 锁，只写入已确认计划中的源码，再次检查语法，然后解锁、激活并复读源码哈希。
- **失败自动恢复**：写入后发生错误时恢复原源码；必要时重新获取恢复锁，随后解锁、重新激活原版本并校验原始哈希。
- **脱敏审计**：以 JSONL 记录执行阶段，不记录密码、授权头、Cookie、锁句柄、完整源码、diff、确认短语或验证码。

### 兼容 `legacy-full` 模式

系统角色优先于 Profile：只有 DEV 能按开发 Profile 使用写入和调试控制；QAS、PRD、缺失角色或非法角色无论配置哪个 Profile，都只允许本地与只读操作，隐藏工具直调也会在进入 ADT 客户端前拒绝。只有明确需要原始低层 ADT 能力时才设置 `SAP_MCP_TOOL_PROFILE=legacy-full`。DEV 下该模式共注册 161 个工具，其中新增的 6 个原始 DDIC/包迁移/RAP 写工具不会经过受控预览、确认、漂移检查和复查流程。

### DEV 受控高级操作

`development` 提供 `previewDdicPropertyChange`/`applyDdicPropertyChange`、`previewPackageChange`/`applyPackageChange` 和 `previewRapOperation`/`applyRapOperation`。preview 不执行远端写入，只返回服务器管理的 `operationPlanId`；apply 只接受该计划 ID，并由 MCP 打开唯一一次原生 form 确认，不再叠加聊天文字确认。确认后重新检查策略和漂移，写入、迁移、生成或发布最多调用一次，再进行只读复查。超时或断线可能返回 `UNKNOWN_OUTCOME`，此时必须先只读核验 SAP 当前状态，不能直接重放。

低层写入和删除工具不会经过安全源码变更流程，因此只应作为兼容能力使用。

### DEV 安全调试

`development` 增加 `previewDebugOperation`、`applyDebugOperation`、`getDebugOperationStatus`、`authorizeDebugSession`、`executeDebugCommand`、`previewDebugVariableChange`、`applyDebugVariableChange` 和 `revokeDebugSession`。监听器、断点、Attach、调试设置、跳转行、终止进程和变量修改按风险粒度使用服务器原生 form 弹框；安全调试不提供文字确认降级。

会话授权默认 15 分钟并绑定 SAP 用户、client 和当前 Attach 上下文。Step、Continue、运行到行和栈导航每次只接受一个明确命令。跳转行、终止进程和变量修改每次单独确认；变量应用前复读栈帧和原值，发生漂移即拒绝。连接或超时导致远端结果不确定时只读复查状态，绝不自动重放控制动作。`SAP_MCP_ALLOWED_DEBUG_USERS` 支持逗号分隔多个用户，未配置时仅允许当前 `SAP_USER`。QAS/PRD 不注册任何调试控制工具，只保留已有现场读取。

### DEV 受控质量检查

`previewQualityCheck`、`runQualityCheck`、`getQualityCheckStatus` 只在 DEV `development-workbench` 中开放。预览冻结明确的 ABAP Unit 或 ATC 范围；ATC variant 必须由用户明确指定，服务不自动猜测。运行只接受服务端计划编号并打开一次 MCP 原生确认。超时或断线记为 `UNKNOWN_OUTCOME`，此后只读检查状态和 SAP 证据，禁止盲目重跑。

### 可选 SM21 运行日志分析

设置 `SAP_MCP_TOOL_PROFILE=development`、`diagnostic-readonly`、`legacy-full` 或 `operations-readonly` 后，会开放只读的 `sm21Read` 与 `analyzeRuntimeErrors`。它们复用现有 ADT HTTP 登录会话，依赖 SAP 端部署 [`ZCL_MCP_SM21_ADT_HTTP`](sap/adt-http/ZCL_MCP_SM21_ADT_HTTP.abap) 及其[部署说明](sap/adt-http/ZCL_MCP_SM21_ADT_HTTP-deployment.md)。ST22 摘要使用独立的 `readRuntimeDumps`，必须提供带时区偏移的时间窗和有界 `limit`，不得退回原始 `dumps` 查询。

不需要在 MCP 主机安装 `node-rfc`、SAP NW RFC SDK、JCo、NCo，也不需要 RFC destination 或额外客户端凭据。现有 ADT 用户只需 `S_ADMI_FCD=SM21`；MCP 工具参数不接受凭据。

### 性能与资源护栏

全部七个 Profile 的工具统一经过中央参数和响应保护。FIFO 执行门控只保护使用共享有状态 ADT 客户端的操作；原生确认等待、本地状态查询和 `healthcheck` 不占 SAP 执行槽。确认成功后，完整源码变更、对象创建、调试控制、高级操作或质量检查流程在同一个 gate 内执行。默认并发数为 `1`，因为 ADT 操作共享 Cookie、CSRF、会话类型和锁生命周期。只有在受控 SAP DEV 环境验证后才应提高并发数。

| 环境变量 | 默认值 | 有效范围 | 用途 |
| --- | ---: | --- | --- |
| `SAP_MCP_ENV_FILE` | 程序旁 `.env` | 已存在的文件路径 | 由进程显式选择独立 dotenv 文件；相对路径按进程工作目录解析，不能写在被选择的文件内部。 |
| `SAP_MCP_ADT_TIMEOUT_MS` | `60000` | 5000–600000 | 传给 ADT 客户端的真实 HTTP 超时。 |
| `SAP_MCP_MAX_CONCURRENT_TOOLS` | `1` | 1–8 | 同时执行的工具数；生产建议保持 `1`。 |
| `SAP_MCP_MAX_QUEUED_TOOLS` | `50` | 0–1000 | FIFO 等待容量，超出后返回繁忙错误。 |
| `SAP_MCP_QUERY_DEFAULT_ROWS` | `200` | 1–查询上限 | `tableContents` 与 `runQuery` 默认行数。 |
| `SAP_MCP_QUERY_MAX_ROWS` | `5000` | 1–100000 | 查询行数硬上限。 |
| `SAP_MCP_SEARCH_DEFAULT_RESULTS` | `50` | 1–搜索上限 | `searchObject` 默认数量。 |
| `SAP_MCP_SEARCH_MAX_RESULTS` | `500` | 1–10000 | 搜索结果硬上限。 |
| `SAP_MCP_MAX_ARGUMENT_BYTES` | `5242880` | 64 KiB–50 MiB | 单次工具参数的 UTF-8 JSON 字节上限，包含完整源码。 |
| `SAP_MCP_MAX_RESPONSE_BYTES` | `10485760` | 1–100 MiB | 单次工具响应允许的 UTF-8 文本总字节数。 |
| `SAP_MCP_SOURCE_CACHE_MAX_ENTRIES` | `20` | 0–1000 | 会话源码缓存条目数；`0` 表示关闭。 |
| `SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES` | `2097152` | 64 KiB–20 MiB | 允许缓存的单份源码上限。 |
| `SAP_MCP_SOURCE_CACHE_TTL_SECONDS` | `900` | 60–3600 | 源码缓存有效期。 |
| `SAP_MCP_CHANGE_PLAN_MAX_ENTRIES` | `100` | 1–1000 | 内存中变更计划记录上限。 |
| `SAP_MCP_ALLOWED_DEBUG_USERS` | 当前 `SAP_USER` | 逗号分隔用户 | DEV 调试控制用户白名单。 |
| `SAP_MCP_DEBUG_AUTH_TTL_SECONDS` | `900` | 60–3600 | 绑定 Attach 上下文的会话授权有效期。 |
| `SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS` | `86400` | 3600–604800 | 回滚失败后恢复源码保留时间。 |
| `SAP_MCP_LOG_LEVEL` | `warn` | `error`、`warn`、`info`、`debug` | 普通 stderr 日志最低级别。 |
| `SAP_MCP_SESSION_RECOVERY` | `true` | `true`/`false` | stateful 会话失效时恢复并最多重放一次只读调用；写操作绝不重放。 |
| `SAP_MCP_STATELESS_READS` | `false` | `true`/`false` | 将高层只读和 SM21 读请求切到独立 stateless 客户端；先在 DEV 验证。 |
| `SAP_MCP_CREDENTIAL_COMMAND` | 未设置 | 绝对路径 | 外部凭据命令；接收 `SAP_MCP_CREDENTIAL_TARGET` 一个参数并输出一行密码。 |
| `SAP_MCP_CREDENTIAL_TARGET` | 未设置 | 非空 | 传给外部凭据命令的目标名。 |
| `SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL` | `false` | `true`/`false` | 开启后拒绝旧的 `SAP_PASSWORD` 回退。 |
| `SAP_MCP_SM21_TIMEZONE` | `UTC` | IANA 时区名称 | 将工具 ISO 时间转换为 SAP 时间戳。 |
| `SAP_MCP_SM21_MAX_WINDOW_HOURS` | `24` | 1–24 | SM21 时间窗硬上限。 |
| `SAP_MCP_SM21_DEFAULT_PAGE_SIZE` | `100` | 1–500 | SM21 默认返回行数。 |
| `SAP_MCP_SM21_MAX_PAGE_SIZE` | `500` | 1–500 | SM21 单页行数硬上限。 |

配置越界时服务启动失败。显式查询或搜索数量超过上限会在访问 SAP 前拒绝，不静默截断，也不改写 SQL。`getObjectSource` 分页是在首次完整读取 SAP 后使用受限的进程内会话缓存切分，不是 SAP 服务端分页。写请求超时代表远端结果未知，必须先检查对象或变更计划状态，再决定是否重试，禁止盲目重复写入。

stateful ADT HTTP 会话与 SAP GUI 登录彼此独立。只读调用收到明确的会话失效响应时，服务会清理本地 Cookie/CSRF，互斥重登并最多重放该只读调用一次；写入、锁、调试、质量、传输和激活操作只返回“远端结果未知”，不会自动重放。生产建议使用外部凭据命令并移除 `SAP_PASSWORD`；兼容回退只输出一次脱敏警告。

在开放该工具的 Profile 中，`healthcheck` 只证明本地 MCP 进程可响应，并返回非敏感的已配置 host、client、profile 和 role；它不访问 SAP，且明确返回 `sapConnectionVerified: false`。使用 `inspectSapSystem` 分别报告 configured identity 和独立探测的 SAP ADT capability；允许 partial success，不从配置身份推断产品版本或具体权限。七工具 `safe` profile 不开放这两个通用诊断工具。

审计 JSONL 仍逐条等待并串行落盘。服务不自动轮转或删除审计日志；部署环境必须负责保留、归档、磁盘容量告警和访问控制。

## 安全 ABAP 源码变更与对象创建

默认 `SAP_MCP_TOOL_PROFILE=safe`，只暴露七个高层工具：

- `inspectAbapObject`：读取一个精确且在白名单内的 `PROGRAM`、`INCLUDE`、`CLASS` 或 `FUNCTION_MODULE` 对象，默认返回完整源码、对象元数据和源码哈希；可用 `startLine`/`maxLines` 分页并保留原始源码字节。
- `previewAbapChange`：校验目标对象、传输请求、完整目标源码和语法，返回完整 diff 和短时变更计划；不修改 SAP。
- `applyAbapChange`：在用户明确确认后执行先前生成的计划，包含源码漂移检查、锁定、写入、语法检查、解锁、激活、复读校验和失败恢复。
- `getAbapChangeStatus`：读取本地计划状态和阶段结果，不返回完整源码、凭据、Cookie 或锁句柄。
- `previewAbapObjectCreation`：只读校验并冻结 `PROGRAM`、`FUNCTION_GROUP`、`FUNCTION_MODULE` 创建计划；不创建、锁定、写入或激活 SAP 对象。
- `applyAbapObjectCreation`：用户明确确认后，按依赖顺序创建、写入、检查、激活和复读；失败时只对当前计划能证明归属的对象尝试反向删除补偿。
- `getAbapObjectCreationStatus`：读取创建计划、已创建对象和补偿状态，不返回完整源码、确认短语或锁句柄。

### 标准操作流程

1. 调用 `inspectAbapObject`，读取精确对象的完整当前源码，并以它作为编辑基线。大型源码必须分页检查相同 `sourceHash`、连续行范围、累计 `totalLines` 和末页 `hasMore=false`。
2. 调用 `previewAbapChange`，传入完整替换源码和一个已有且未释放的传输请求。
3. 向用户展示工具内容中服务器直接返回的完整 Markdown diff。预览不会锁定、写入或激活对象。
4. 直接使用返回的 `changePlanId` 调用 `applyAbapChange`，不要再要求一次聊天文字确认。唯一确认由服务器通过 MCP 客户端获取，不能由模型自行声明。
5. 需要查看执行阶段、错误、解锁或回滚结果时，调用 `getAbapChangeStatus`。

创建对象时改用 `previewAbapObjectCreation`、`applyAbapObjectCreation` 和 `getAbapObjectCreationStatus`。支持单个 `PROGRAM`、已有函数组中的单个 `FUNCTION_MODULE`，以及“新函数组 + 首个函数模块”。单独空 `FUNCTION_GROUP` 会在预览阶段拒绝。完整中文 JSONC 参数和恢复说明见[使用指南](docs/使用指南.md#10-安全创建对象)。

函数模块接口参数属于完整 `source/main` 源码中 `FUNCTION ... .` 的签名部分，可与实现代码一起预览、写入和复读验证。当前尚未提供“结构化参数数组自动生成 ABAP 签名”的高级工具，调用方必须提交完整可审阅源码；函数组源码仍由 SAP 生成。创建失败后的删除是尽力补偿，不是数据库事务，结果不确定时必须人工检查而不能盲目重试。

变更计划只保存在当前 MCP 进程内，具有有效期且只能消费一次。MCP 重启后计划会丢失。默认有效期为 900 秒，允许配置为 60–3600 秒。计划不存在、已过期、已消费或出现源码漂移时均不能写入 SAP，必须重新预览。

### 确认交互

- 支持 MCP form elicitation 的客户端会在 diff 展示后显示唯一的精简弹框，包含 `应用变更` 和 `取消` 两个选项；不需要先在聊天中回复确认。只有客户端返回接受且选择 `应用变更` 时才会开始修改。
- 选择 `取消`、点击跳过、关闭弹框或未返回选择，都视为取消，不消费计划，也不锁定或写入 SAP。
- 原生弹框最多等待 15 分钟，同时不会超过计划剩余有效期。超时按取消处理，计划保持 `PREVIEWED`；只要计划仍有效，用户可以再次调用应用工具重新弹框。
- 客户端不支持 form elicitation 时，只有设置 `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true` 才能应用。第一次调用会返回绑定计划的一次性短语，第二次调用必须提交完全一致的 `textConfirmation`。
- 支持原生弹框的客户端始终使用更强的弹框确认，并忽略文字确认参数。两种确认机制都不可用时，服务返回 `CONFIRMATION_UNSUPPORTED` 并拒绝写入。

### 计划与恢复状态

| 状态 | 含义 |
| --- | --- |
| `PREVIEWED` | 计划有效，等待确认；尚未开始修改 SAP。 |
| `APPLYING` | 已确认，受控应用流程正在执行。 |
| `APPLIED` | 激活和目标源码哈希复核成功。 |
| `FAILED` | 在写入源码前失败，无需回滚。 |
| `ROLLED_BACK` | 写入后发生错误，原源码已恢复、重新激活并通过哈希复核。 |
| `ROLLBACK_FAILED` | 自动恢复未完成，必须人工检查对象、锁、非活动版本和传输。 |
| `EXPIRED` | 计划在应用前过期，必须重新预览。 |

### 当前验证状态

截至 2026-08-20，当前自动化基线已经覆盖内置 ADT 客户端、全部注册工具、Profile/角色策略和受控工作流：

- **自动化验证**：109 个 Jest 测试套件、771 项测试覆盖内置 ADTClient、仓库创建、双模式 cleanup、maturity evidence、脱敏诊断、原生确认、Profile/角色策略、有界状态、日志和审计串行写入。
- **动态目录验证**：2026-08-17 使用真实 `dist/index.js` 完成 35 个 profile/role runtime session 和 14 个隐藏工具直调拒绝检查，未调用 SAP。
- **真实 SAP 只读验证**：四个新高层读取已在配置的 DEV/QAS/PRD 系统通过；证据未保存业务行、dump 文本或源码。
- **仍未验证**：`ZZMCP_VT_DOM` 的独立清理与 `DDIC_DOMAIN` 成熟度晋级、其余仓库对象真实创建、真实 ATC/ABAP Unit 执行、受控 DDIC 属性/包迁移/RAP 写入，以及安全调试控制。
- **真实 SAP DEV 成功流程**：`PROGRAM`、`INCLUDE`、`CLASS`、`FUNCTION_MODULE` 均完成真实读取、预览、锁定、写入、语法检查、解锁、激活、复读哈希和审计验证。
- **真实保护流程**：已验证预览语法错误、用户持锁、源码漂移、MCP 重启后计划失效、计划自然过期、成功计划不可重复消费、原生弹框应用/取消/关闭和确认超时。
- **真实回滚流程**：在源码写入后可控地模拟第一次激活失败，工作流成功重新获取恢复锁、写回原源码、解锁、真实激活原版本、复核原始哈希，并进入 `ROLLED_BACK`；最终无残留锁或目标非活动版本。
- **真实 SAP DEV 运行护栏**：已验证查询/搜索超限在访问 SAP 前拒绝、搜索默认数量、查询数量参数透传、1 MiB 响应替换为 `413`、源码分页缓存命中、LRU 淘汰、60 秒 TTL 过期，以及同一 MCP 进程内单并发 FIFO 和队列满 `429`。当前 SAP ADT 表预览会稳定返回请求数量外加一条 lookahead 行，例如请求 `5` 行返回 `6` 条。
- **换行规范化**：`ZCODEX_MCP_TEST` 已真实得到 `LINE_ENDING_NORMALIZED`，计划进入 `APPLIED`，且激活、解锁和复读哈希均成功。
- **对象创建与抓包实测**：`PROGRAM ZMCP_CREATE_TEST` 已完成真实创建并保留。Eclipse ADT 3.60.2 对 `ZMCP_ADT_TRACE + Z_MCP_ADT_TRACE` 的会话证明：组合创建不单独激活函数组，参数直接写入 `source/main`，函数模块使用仅含 `uri + name` 且 `preauditRequested=true` 的激活请求。MCP 使用该协议创建 `ZMCP_IF_TEST + Z_MCP_IF_TEST` 时，创建、写入、语法检查、解锁和激活均成功；SAP 随后把换行改为 CRLF，并将签名后分隔区补为三个空行，旧复核规则误判后安全补偿成功，两个对象只读搜索确认无残留。现已增加函数模块专用受限格式比较，仍需重启后做最终真实 DEV 成功复测。
- **激活未知结果保护**：激活请求抛出超时或连接异常时，先只读核对 active/inactive 版本；无法确定远端结果时撤销自动删除资格并进入人工检查状态，禁止盲目重试。
- **HTTP 超时**：已使用本机停滞 HTTP 端点端到端确认底层 ADT 客户端在配置 `5000 ms` 时约 5 秒取消请求；没有通过故意运行慢查询压测 SAP。
- **待专项验证**：四个高层只读工具在当前真实 SAP 系统的端点兼容性，真实 ATC/ABAP Unit 执行，全部新增 DDIC/包迁移/RAP 写入，安全调试的真实 SAP DEV 控制动作，调试/ATC/trace 长任务行为，提高 `SAP_MCP_MAX_CONCURRENT_TOOLS` 后的共享会话行为，以及不同 SAP 版本、权限模型和生产部署。fake client 自动化测试不能建立真实 SAP 端点、质量执行或写入成功结论。

以上结论不代表已经穷举所有 SAP 版本、权限模型、网络故障或恢复过程再次失败的场景。出现 `ROLLBACK_FAILED` 或 `UNLOCK_FAILED` 时应停止自动重试并人工检查 ADT/SAP，避免反复写入扩大风险。

## 前置条件

- 可通过 ADT 访问的 SAP ABAP 系统，包括系统 URL、用户名、密码和客户端号。
- SAP 事务 `SICF` 中已启用 `/sap/bc/adt` 服务。
- 用户具有所需 ADT 权限以及目标对象和传输请求的修改权限。
- Node.js 18 或更高版本以及 npm。可用 `node -v` 和 `npm -v` 检查。

## 从 npm 安装（推荐）

将 SAP 凭据保存在版本库之外的私有环境文件中，并让每个 MCP 进程通过绝对路径 `SAP_MCP_ENV_FILE` 选择对应配置。一个进程的 Profile 在启动时固定，多 Profile 或多 SAP 环境必须分别配置进程别名。

```cmd
npx -y @kylinyz/mcp-abap-abap-adt-api@0.5.0
```

MCP 配置示例：

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "command": "npx",
      "args": ["-y", "@kylinyz/mcp-abap-abap-adt-api@0.5.0"],
      "env": {
        "SAP_MCP_ENV_FILE": "D:\\sap-mcp-config\\sap-dev.env"
      }
    }
  }
}
```

修改环境文件或 MCP 配置后，需要重启 MCP 客户端。

## 从源码安装（本地开发）

开发、验证本地改动或测试尚未发布的构建时使用源码安装：

```cmd
cd 包含当前修改的源码目录\mcp-abap-abap-adt-api
npm install
copy .env.example .env
npm run build
npm run start
```

必须使用本分支且确实包含目标修改的源码副本；不能假定重新克隆上游仓库即可得到本文描述的版本。

编辑 `.env`：

```env
SAP_URL=https://your-sap-server.com:44300
SAP_USER=YOUR_SAP_USERNAME
SAP_PASSWORD=YOUR_SAP_PASSWORD
SAP_CLIENT=100
SAP_LANGUAGE=ZH

SAP_MCP_TOOL_PROFILE=safe
SAP_MCP_SYSTEM_ROLE=DEV
SAP_MCP_ALLOWED_HOSTS=your-sap-server.com
SAP_MCP_ALLOWED_CLIENTS=100
SAP_MCP_ALLOWED_NAMESPACES=Z,Y
SAP_MCP_CHANGE_PLAN_TTL_SECONDS=900
SAP_MCP_ALLOWED_DEBUG_USERS=
SAP_MCP_DEBUG_AUTH_TTL_SECONDS=900
SAP_MCP_AUDIT_PATH=C:\sap-mcp-audit
SAP_MCP_ALLOW_TEXT_CONFIRMATION=false
SAP_MCP_CONFIRMATION_PROVIDER=auto
SAP_MCP_ADT_TIMEOUT_MS=60000
SAP_MCP_MAX_CONCURRENT_TOOLS=1
SAP_MCP_MAX_QUEUED_TOOLS=50
SAP_MCP_QUERY_DEFAULT_ROWS=200
SAP_MCP_QUERY_MAX_ROWS=5000
SAP_MCP_SEARCH_DEFAULT_RESULTS=50
SAP_MCP_SEARCH_MAX_RESULTS=500
SAP_MCP_MAX_ARGUMENT_BYTES=5242880
SAP_MCP_MAX_RESPONSE_BYTES=10485760
SAP_MCP_SOURCE_CACHE_MAX_ENTRIES=20
SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES=2097152
SAP_MCP_SOURCE_CACHE_TTL_SECONDS=900
SAP_MCP_CHANGE_PLAN_MAX_ENTRIES=100
SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS=86400
SAP_MCP_LOG_LEVEL=warn

# 仅 legacy-full 的可选 SM21/ST22 运行日志分析
SAP_MCP_SM21_TIMEZONE=Asia/Shanghai
SAP_MCP_SM21_MAX_WINDOW_HOURS=24
SAP_MCP_SM21_DEFAULT_PAGE_SIZE=100
SAP_MCP_SM21_MAX_PAGE_SIZE=500
```

不要将 `.env` 提交到版本库。`SAP_MCP_AUDIT_PATH` 必须允许 MCP 进程写入。安全源码修改要求角色、主机、客户端、命名空间白名单和审计目录全部满足策略。

源码构建完成后，让 MCP 客户端直接运行绝对路径下的 `dist/index.js`：

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "command": "node",
      "args": ["D:\\path\\to\\mcp-abap-abap-adt-api\\dist\\index.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

修改 `.env`、重新构建 `dist` 或调整 MCP 配置后，需要重启 MCP 客户端。连接变量、安全白名单、性能护栏和 SM21 配置的完整说明，以及 Codex/Claude 配置示例、验证步骤、安全源码修改、对象创建和错误处理见 [使用指南](docs/使用指南.md)。

## 推荐给模型的自定义指令

```text
默认 safe 模式支持受控修改 PROGRAM、INCLUDE、CLASS、FUNCTION_MODULE，以及受控创建 PROGRAM、FUNCTION_GROUP、FUNCTION_MODULE。

1. 先调用 inspectAbapObject 读取精确对象的完整当前源码和元数据。
2. 使用完整目标源码、精确对象和已有未释放传输调用 previewAbapChange。
3. 向用户展示工具内容中服务器直接返回的完整 Markdown diff。
4. 直接使用返回的 changePlanId 调用 applyAbapChange，不要先要求聊天文字确认。客户端支持 form elicitation 时，必须显示服务器发起的唯一原生确认弹框并提交用户选择。
5. 客户端不支持 form 且服务器启用了文字降级时，先展示服务器返回的一次性短语，再用同一个 changePlanId 和完全一致的 textConfirmation 调用一次。
6. 使用 getAbapChangeStatus 检查阶段、解锁和恢复结果，不暴露完整源码。

创建对象时，先调用 previewAbapObjectCreation 展示完整对象图、源码、传输和补偿警告；用户明确同意后只使用 creationPlanId 调用 applyAbapObjectCreation，再用 getAbapObjectCreationStatus 检查创建与补偿状态。不要给 FUNCTION_GROUP 传 source；FUNCTION_MODULE 的参数签名必须包含在完整 source 中，不能只提交实现代码或结构化参数数组。

不要传入或信任模型生成的 confirmedByUser。只有应用结果明确表示语法检查、激活、源码哈希复核和解锁均成功时，才能声明修改成功。出现源码漂移时重新读取和预览。回滚或解锁失败时，要求用户在 ADT/SAP 中人工检查非活动对象、锁和传输。

legacy-full 会额外开放原有低层 ADT 工具。原始写入和删除操作绕过安全流程，只能作为兼容能力使用。

DDIC、包迁移或 RAP 写入必须使用 development 的受控 preview/apply 工具。展示 preview 后，只把 operationPlanId 传给 apply，由服务器打开唯一原生确认；不要回退到 legacy-full 原始 setter、execute、generate 或 publish。QAS/PRD 无论 Profile 都只读。出现 UNKNOWN_OUTCOME 后停止写入，先核对 SAP 当前状态。
```

## 数据库访问建议（`development`、`diagnostic-readonly` 和 `legacy-full`）

默认七工具 `safe` 模式不开放数据库查询工具。只读 Profile 和 `legacy-full` 中的查询工具统一经过服务端只读语句门控：

- 始终使用明确的 `WHERE` 条件，避免无边界读取。
- 只查询实际需要的字段。
- 确定提供完整主键时使用 `SELECT SINGLE`。
- 不能保证完整主键但只需要一条记录时，使用 `UP TO 1 ROWS`。
- `tableContents` 用于读取表数据，不用于查看字段定义；临时查询可使用 `runQuery`。
- `runQuery` 只接受单条 `SELECT` 或 `WITH` 查询；DML、DDL、动态执行和多语句会在访问 SAP 前拒绝。
- `tableContents.sqlQuery` 为空时使用表预览默认行为；提供查询时同样必须是只读语句。

## DDIC 定义检查（诊断 Profile）

- 先用 `searchObject` 将对象名解析为 URI，再调用 `objectStructure` 查看对象或 DDIC 结构。
- `ddicElement` 用于读取数据元素或域等 DDIC 元素。
- `ddicRepositoryAccess` 用于读取指定路径的 DDIC 仓库信息。
- `GetTable`、`GetStructure` 和 `GetTypeInfo` 不属于本服务，它们来自独立的 `mcp-abap-adt` 项目。

## 常见问题

- **npm 包解析失败**：使用带作用域且固定版本的 `npx -y @kylinyz/mcp-abap-abap-adt-api@0.5.0`。不带作用域的包是上游独立旧版本；无法访问 npm 时，可从本分支源码构建，并使用 `node` 加 `dist/index.js` 绝对路径启动。
- **SAP 连接失败**：检查 URL、用户、密码、客户端、ADT 权限、网络连通性以及 `SICF` 中的 `/sap/bc/adt` 服务。
- **自签名证书错误**：仅在开发环境设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- **`CONFIRMATION_UNSUPPORTED`**：改用支持 MCP form elicitation 的客户端，或明确启用安全性较低的文字确认降级。
- **`PLAN_NOT_FOUND`**：计划只存在于内存中，MCP 重启后必须重新预览。
- **`PLAN_EXPIRED` / `PLAN_ALREADY_CONSUMED`**：重新预览；计划不能延期或重复应用。
- **`SOURCE_DRIFT`**：重新读取 SAP 当前源码后再预览；服务不会覆盖预览后发生的人工修改。
- **`LOCK_FAILED`**：在 ADT/SAP 中检查锁持有者；释放锁后，如果源码已变化，应重新预览。
- **`ROLLBACK_FAILED` / `UNLOCK_FAILED`**：停止自动重试，人工检查非活动对象、锁、源码版本和传输请求。
- **`AUDIT_FAILED`**：恢复 `SAP_MCP_AUDIT_PATH` 的写权限后再尝试源码修改。

## 开发验证

```cmd
npm test -- --runInBand
npm run build
git diff --check
```

自动化测试不能替代真实 SAP DEV 验证。对生产环境或新的 SAP 版本、权限模型进行部署前，应使用专用测试对象和已有测试传输重新验证完整流程。

## 参与贡献

1. Fork 仓库并创建功能分支。
2. 保持默认 `safe` 模式的安全边界，不要让低层写入工具绕过配置暴露。
3. 为修改添加对应测试并运行测试、构建和格式检查。
4. 提交分支并创建 Pull Request。

## 许可证

本项目使用 [MIT License](LICENSE)。
