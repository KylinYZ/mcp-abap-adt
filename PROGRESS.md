# 当前进度

更新时间：2026-09-04

## 结论

- 代码版本：`0.6.0`。
- 自动化门禁：109 个 Jest suites、793 个 tests；`npm run build` 与成熟度 coverage 检查通过。
- 仓库对象目录：31 类；`REAL_DEV_VERIFIED=28`、`CONTROLLED_IMPLEMENTED=1`、`AUTOMATION_VERIFIED=2`。
- 真实 DEV 验证固定使用专用配置、现有未释放传输和一次原生确认；QAS/PRD 不写。
- 所有历史 `OUTCOME_UNKNOWN`、`COMPENSATED`、`COMPENSATION_FAILED` 计划均不可重放；新验证必须使用新身份和新 preview。

## 已达到 `REAL_DEV_VERIFIED`

`ABAP_CLASS`、`ABAP_INTERFACE`、`BEHAVIOR_DEFINITION`、`CDS_ACCESS_CONTROL`、`CDS_ASPECT`、`CDS_DATA_DEFINITION`、`CDS_METADATA_EXTENSION`、`CDS_TYPE`、`CHANGE_DOCUMENT_OBJECT`、`DATABASE_TABLE`、`DATA_ELEMENT`、`DDIC_DOMAIN`、`DDIC_STRUCTURE`、`DDIC_TABLE_TYPE`、`DDIC_TYPE_GROUP`、`FUNCTION_GROUP`、`FUNCTION_GROUP_INCLUDE`、`FUNCTION_MODULE`、`LOGICAL_EXTERNAL_SCHEMA`、`MESSAGE_CLASS`、`NUMBER_RANGE_OBJECT`、`NONT/NOT`、`PACKAGE`、`PROGRAM`、`PROGRAM_INCLUDE`、`RONT/ROT`、`SERVICE_BINDING`、`SERVICE_DEFINITION`。

逐类 evidence、对象身份、传输和 cleanup 证据以 [`docs/evidence/repository-creation-maturity-evidence.json`](docs/evidence/repository-creation-maturity-evidence.json) 为准；创建侧顺序和依赖见 [`docs/evidence/repository-validation-campaign-matrix.md`](docs/evidence/repository-validation-campaign-matrix.md)。

## 尚未晋级

| 对象 | 当前等级 | 原因 | 下一步 |
| --- | --- | --- | --- |
| `DDIC_LOCK_OBJECT` | `CONTROLLED_IMPLEMENTED` | 依赖表的真实创建与 cleanup 证据尚未形成 | 先取得专用 DEV 协议与完整生命周期证据 |
| `CDS_ANNOTATION_DEFINITION` | `AUTOMATION_VERIFIED` | 目标 SAP 明确拒绝创建授权 | 由 SAP 管理员补齐最小授权后，用新身份复测 |
| `CDS_ENTITY_BUFFER` | `AUTOMATION_VERIFIED` | 尚无满足目标约束的 active CDS 实体 | 准备可 buffer 的 active CDS 依赖后再验证 |

## 接手入口

1. 先读 `AGENTS.md` 和 [`docs/evidence/repository-creation-productionization-handoff.md`](docs/evidence/repository-creation-productionization-handoff.md)。
2. 再读当前 validation matrix 与 maturity manifest，不以本文件推断单个计划细节。
3. 需要历史根因时查 [`BLOCKED.md`](BLOCKED.md)、`CHANGELOG.md` 和对应 evidence 文档。
4. 修改源码或构建后硬重启 MCP；用新 healthcheck session 和旧 plan `PLAN_NOT_FOUND` 验收。

## 验证状态

| 事实面 | 状态 |
| --- | --- |
| 代码 | `verified-current`：当前分支源码、profile 计数和 maturity gate 有测试覆盖 |
| 运行态 | `pending`：本轮未重新连接真实 SAP 或发布环境 |
| 文档 | `changed-and-verified`：入口、指南、状态和证据索引已对齐 |
| 规则 | `changed-and-verified`：`AGENTS.md` 已压缩并指向唯一权威文档 |
| 记忆 | `generated-read-only`：未修改 Codex/Obsidian 记忆 |
| 工作区 | `verified-current`：未发现本轮生成的临时文档；未执行删除或清场 |

## 2026-09-16 闲时轮：devtools.activate 补跑——发现并修复 apply 自我死锁

- 矩阵行 `devtools.activate` 保持 UNVERIFIED（apply 真实激活执行仍未完成，三次尝试均中断，重试预算用尽即停）。
- 关键产出：定位 `applyObjectActivation` 未列入 `usesSapExecutionGate` 豁免名单，`maxConcurrentTools=1` 下确认后内部再次 `gate.run` 自我死锁（客户端 60s 超时、审计无 CONFIRMED、SAP 无副作用）——已修复并以 `serverGuardrails.test.ts` 回归测试覆盖（129 suites / 1178 tests 全绿）。
- 另明确：激活目标条目必须含 `adtcore:parentUri`（ZVIF2 等顶层 INTF/DTEL 不适用；ZVCL_CAMPAIGN 类可用）；smoke 脚本修复 TDZ 引用并放宽激活 apply 超时至 5 分钟。
- 真机结果：三次尝试分别中断于目标过滤、死锁（已修复）、SAP 端传输校验瞬时 500；自建残留 ZVACTSMOKE2 已受控清理并 absence 复查通过，无新增系统残留。
- 遗留：下轮直接重跑 `scripts/object-activation-real-dev-smoke.mjs`（目标 ZVCL_CAMPAIGN）预期一次通过；详见 `docs/evidence/object-activation-real-dev-partial-verified.md` 补跑记录。

## 2026-09-16 闲时轮（二）：devtools.activate 补跑通过——晋级 EQUIVALENT，矩阵 UNVERIFIED 清零

- 本地门禁全绿后一次通过真机 smoke：`scripts/object-activation-real-dev-smoke.mjs` 目标 ZVCL_CAMPAIGN，全部 18 项断言 PASS，输出 SMOKE OK。
- 审计完整链（plan `dd0f5874...`）：PREVIEW_CREATED（6 条目）→ OBJECT_ACTIVATION_CONFIRMED → OBJECT_ACTIVATION_COMPLETED（"activated 6 object(s), 0 still inactive"）；重复 apply 拒绝、目标离开未激活列表、自建对象清理 absence 复查均通过，并有独立新进程只读复查佐证。
- 上轮修复的 apply gate 自我死锁（serverGuardrails 豁免名单）即本次通过的关键前置，回归测试持续生效。
- 矩阵行 `devtools.activate` 晋级 EQUIVALENT（evidence + real-dev-verified）；矩阵现状：MCP_SUPERSET=6、EQUIVALENT=25、PARTIAL=17、GAP=17、INTENTIONAL_RESTRICTION=6、**UNVERIFIED=0**，对齐 31/71。
- 证据：`docs/evidence/object-activation-real-dev-verified.md`（新建）；partial 文档保留为历史过程。
- 遗留：剩余 GAP 集中在 RFC transport（需授权）、report/AMDP/UI5 写（RESTRICTION 方向）；前轮历史遗留 ZVACTSMOKE3 与旧 ENQ 锁未处理。

## 2026-09-16 闲时轮（三）：source.class-include 晋级 MCP_SUPERSET——类 include 受控写入链

- 本轮工作（循环推进目标第 1 项，唯一开放 P0）：previewAbapChange 扩展 classInclude 参数（definitions/implementations/macros/testclasses，仅 CLASS）。最小改动复用整条受控链——resolver 解析 include 可写源 URL 并冻结进 plan，锁/激活归属父类，确认消息显式标注 include 粒度；四层 mock 测试 +12。
- 本地门禁全绿：Jest 129 suites / 1190 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 真机闭环 smoke（scripts/class-include-real-dev-smoke.mjs，最终干净运行 17 项断言全 PASS、SMOKE OK）：自建类 ZVCLINCSMK → definitions include 真实写入+激活（plan APPLIED、SOURCE_VERIFIED、独立直读复查标记一致）→ 负例 VALIDATION_FAILED → 受控清理 absence 通过，零残留。审计含 3 轮完整 SOURCE_WRITTEN→OBJECT_ACTIVATED→SOURCE_VERIFIED→APPLY_COMPLETED（全部 elicitation 确认）。
- 过程要点：真实 include URI 形如 /includes/definitions；getObjectSource 带分页参数命中工具缓存（写后复查须直读）；该 DEV 新类也暴露 testclasses（四粒度全可解析）；一次 UNKNOWN_OUTCOME（慢时段 81s 超时）按边界只读探针确认实际已创建、未盲试。
- 矩阵：source.class-include PARTIAL → MCP_SUPERSET（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=25、PARTIAL=16、GAP=17、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 32/71。证据：docs/evidence/class-include-real-dev-verified.md；清理脚本已参数化支持 PROGRAM/ABAP_CLASS。
- 遗留：无系统残留。下一轮起点（预筛清单）：diagnostics.dumps（P1，dump 增值分析客户端聚合）。

## 2026-09-16 闲时轮（四）：diagnostics.dumps 晋级 EQUIVALENT——dump 增值分析客户端聚合

- 本轮工作（轮三预筛指定项）：新增 `groupRuntimeDumps`（ST22 dump 按"异常类型+终止程序"分组聚合，频次降序/最近优先，对齐 VSP GroupDumps 语义）与 `findSimilarDumps`（同类历史检索，回答"是新问题吗"，对齐 VSP similar 语义）；纯客户端聚合零新端点，数据源复用 RuntimeDumpReader。14 个 mock 用例 + 接线（runtimeTools 面 + workbench/operations 名单）。
- 本地门禁全绿：Jest 130 suites / 1204 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 真机验证（只读，7 天窗口）：groupRuntimeDumps 聚合 50 条真实 dump 为 22 组（Top：DBSQL_SQL_ERROR@CL_BATCH_SCHEDULER ×11）；findSimilarDumps 检索 DBSQL_SQL_ERROR 28 次历史（DDIC/SAPSYS/068157）。证据：docs/evidence/dump-analysis-real-dev-verified.md。
- 矩阵：diagnostics.dumps PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状：MCP_SUPERSET=7、EQUIVALENT=26、PARTIAL=15、GAP=17、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 33/71。
- 遗留（既有缺陷，非本轮引入）：readRuntimeDumps 服务端 runtimeError 过滤在该 DEV 系统报 InternalError（findSimilarDumps 已改为纯客户端匹配绕开）；ZVACTSMOKE3 残留对象与旧 ENQ 锁仍未处理。
- 下一轮起点建议：P1 PARTIAL 中 codeintel.context（dependency-context-spike）或 git.abapgit（abapgit-export-alignment，注意只读边界）；P2 的 ui5.read（ui5-readonly-spike）也可。

## 2026-09-17 闲时轮（五）：codeintel.context 晋级 EQUIVALENT——依赖上下文四只读工具

- 本轮工作（轮四预筛指定项）：dependency-context-spike 落地为四个只读工具——`getDependencyContext`（压缩依赖上下文 prologue：正则提取依赖→读者价值排序→只读 ADT 取源→公共契约提取与调用收窄，失败依赖显式列为 unresolved）、`analyzeDependencies`（regex 层依赖发现+疑似误报标注）、`parseAbapSource`（客户端词法/分句/分类）、`analyzeSourceEffects`（本地副作用与 LUW 归类）。VSP 参考实现 pkg/ctxcomp + handlers_effects.go 逐段移植并注明行号；取源串行（VSP 5 路并发→按串行红线收敛），预算按"到手契约"计、失败不占槽位。
- 本地门禁全绿：Jest 132 suites / 1257 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check；本能力新增 53 例单测（API 36 + Handlers 17）。
- 真机验证（scripts/context-analysis-real-dev-smoke.mjs，全程只读，零写操作）：focused catalog 四工具可见；grepPackage 枚举 Z001 候选，选中 ZCL_MCP_SM21_ADT_HTTP——3 依赖（CL_SYSLOG/CL_SYSLOG_FILTER/IF_HTTP_EXTENSION）3 契约全解析、prologue 130 行、stats 恒等式通过；契约名与依赖发现清单交叉一致；parse 176 条语句识别 CLASS_DEFINITION；LUW=safe 含边界声明；source 直传零 SAP 往返。最终 SMOKE OK。
- 真机发现并修复：ADT include 的 abapsource:sourceUri 为相对 URI（source/main），直接 getObjectSource 报 Invalid Object URL——已在 createSourceFetcher 增加 absolutizeSourceUrl（口径对齐 AbapMemberSourceReader.resolveSourceUrl，拒绝 ../:// 等），补 3 个单测。其余 smoke 前期失败均为脚本自身目标选择/断言问题，非被测能力缺陷。
- 矩阵：codeintel.context PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=27、PARTIAL=14、GAP=17、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 34/71。证据：docs/evidence/context-analysis-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench 显式名单 +4）+ ToolOperationPolicy（read-only 类 +4）+ ToolCatalogIntegrity 计数（development=143、diagnostic-readonly=112、legacy-full=175、workbench=110）+ AGENTS.md 基线。
- 遗留：无系统残留（全程只读）。ZVACTSMOKE3 与旧 ENQ 锁仍为历史遗留。下一轮起点建议（预筛清单）：P2 的 ui5.read（ui5-readonly-spike）、revisions.source/compare（revision 源码读取与版本对比核实）、read.message-class-texts（message-class-read-spike）；P1 的 git.abapgit（abapgit-export-alignment，注意只读边界与 SAP 端 abapGit 前置）。

## 2026-09-17 闲时轮（六）：ui5.read 晋级 EQUIVALENT——UI5 filestore 只读三工具

- 本轮工作（预筛清单指定项）：ui5-readonly-spike 落地为三个只读工具——`ui5ListApps`（filestore 应用清单 Atom feed）、`ui5GetApp`（应用文件树）、`ui5GetFileContent`（文件原始内容）。VSP pkg/adt/ui5.go 只读方向移植（ui5.write 维持缺口）；应用名单级命名空间白名单 + 文件路径穿越拒绝（处理器参数层 InvalidParams 零网络往返 + API 层纵深防御），URL 由名称拼接整体转义。
- 行为增强：目标系统忽略 name 查询参数（专用 DEV 实测，VSP 同受影响），query 客户端 `*` 通配符过滤兜底。
- 本地门禁全绿：Jest 134 suites / 1277 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check；本能力新增 20 例单测（API 12 + Handlers 8）。
- 真机验证（scripts/ui5-readonly-real-dev-smoke.mjs，全程只读）：feed 3105 条返回 200 应用（含 /SAM4U/DASHBRD 命名空间形态）；Z* 客户端过滤正确（该 DEV 无自定义 UI5 应用）；ui5GetApp 文件树 17 条；ui5GetFileContent 真实读回 .Ui5RepositoryBinaryFiles（92 bytes）；穿越负例 InvalidParams 拒绝。最终 SMOKE OK（第一轮遇一次 ui5GetApp 瞬时失败，等待重试通过，未超预算）。
- 矩阵：ui5.read GAP → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=28、PARTIAL=14、GAP=16、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 36/71。证据：docs/evidence/ui5-readonly-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +3）+ ToolOperationPolicy（read-only +3）+ ToolCatalogIntegrity 计数（development=146、diagnostic-readonly=115、legacy-full=178、workbench=113）+ AGENTS.md 基线（134/1277）。
- 遗留：无系统残留（全程只读）。

## 2026-09-17 闲时轮（七）：diagnostics.spool-jobs 晋级 PARTIAL——spool/作业只读 SQL 子集

- 本轮工作（P1 优先级指定项）：job-spool-read-spike 落地为只读 SQL 子集二工具——`listSpoolRequests`（TSP01 清单 + TST01 头增补 storage/码页/行数/字节 + TBTCP 作业步骤反查，listident 补零 10 位）与 `listJobs`（TBTCO 清单含状态释义/起止时间/时长 + TBTCP 步骤增补）。VSP spool.go/jobs.go 自由 SQL 路径逐段移植；走 runQuery datapreview 通道（decode=true）。
- 边界（随结果 notes 返回，记 PARTIAL 而非 EQUIVALENT）：spool 内容读取（TST03/TemSe 解码）与作业日志（VSP 走 RFC/XBP，本项目暂无 RFC 传输）不在子集内；解除条件已写入矩阵行 liftCondition。
- 注入防线：名字类参数处理器层白名单（InvalidParams）、作业名放行通配、LIKE 转义+控制字符拒绝、日期校验、状态码白名单。
- 真机发现并适配端点缺陷：该 DEV datapreview 对 tbtco/tbtcp 的 WHERE+ORDER BY 组合确定性报解析错（"DES" is not allowed here——DESCENDING 段被丢弃；tsp01 正常）。已实测界定触发面，实现 `runWithOrderFallback`（VSP 原样优先 → 失败回退 WHERE-only + 客户端排序并在 notes 标注）。另把名字白名单预检上移到处理器参数层（InvalidParams 而非 InternalError）。
- 本地门禁全绿：Jest 136 suites / 1299 tests、build、coverage、parity、diff --check；本能力新增 21 例（API 13 + Handlers 8）。
- 真机验证（scripts/spool-jobs-real-dev-smoke.mjs，全程只读 SELECT）：近 7 天 50 作业（/IWXBE/EVENT_STATISTICS finished，步骤含程序）+ 50 spool（#23200 storage=D codepage=4103，作业引用 SAP_MM_PUR_PO_AND_IR_FROM_QTN）；交叉印证与注入负例通过。SMOKE OK。
- 矩阵：diagnostics.spool-jobs GAP → PARTIAL（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=28、PARTIAL=15、GAP=15、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 35/71。证据：docs/evidence/spool-jobs-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +2）+ ToolOperationPolicy（read-only +2）+ ToolCatalogIntegrity 计数（development=148、diagnostic-readonly=117、legacy-full=180、workbench=115）+ AGENTS.md 基线（136/1299）。
- 遗留：无系统残留。本轮三能力（codeintel.context、ui5.read、diagnostics.spool-jobs）完成，输出汇总。下一轮预筛：read.message-class-texts（message-class-read-spike，P2）、revisions.source/compare（P2）、analysis.boundaries（package-boundary-spike，P2，纯客户端可仿 VSP graph/boundary.go）；P1 仅剩 git.abapgit（需 SAP 端 abapGit 前置）与 AMDP 调试（需 HANA AMDP 授权），均受环境前置约束。

## 2026-09-17 闲时轮（八）：read.message-class-texts 晋级 EQUIVALENT——消息类文本只读工具

- 本轮工作（预筛指定项）：message-class-read-spike 落地为只读工具 `getMessages`——GET /sap/bc/adt/messageclass/<名>（Accept vnd.sap.adt.mc.messageclass+xml），消息号+短文本按号升序，可选 sap-language 语言覆盖（VSP OverrideLanguage 同义）。VSP client.go GetMessageClass / i18n.go GetMessageClassTexts 只读方向移植；写入方向（i18n.write）维持缺口。
- 关键实现点：XML 属性按名后缀容错匹配（兼容 mc: 前缀与无前缀形态）；对该解析关闭 fast-xml-parser 属性数值化以保留 msgno 前导零（"001"）；名字白名单（≤20 位、可选单级命名空间）预检在处理器参数层（InvalidParams 零网络往返），API 层纵深防御。
- 本地门禁全绿：Jest 138 suites / 1315 tests、build、coverage、parity、diff --check；本能力新增 16 例单测（API 8 + Handlers 8）。
- 真机验证（scripts/message-class-read-real-dev-smoke.mjs，全程只读 GET）：标准消息类 00 读回 901 条（前导零保留、升序、计数一致）；sap-language=EN/DE 均成功（901 条 DE/EN 文本差异 0，仅记录）；注入负例 InvalidParams 拒绝。SMOKE OK。
- 矩阵：read.message-class-texts GAP → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=29、PARTIAL=15、GAP=14、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 36/71。证据：docs/evidence/message-class-read-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=149、diagnostic-readonly=118、legacy-full=181、workbench=116）+ AGENTS.md 基线（138/1315）。
- 遗留：无系统残留。下一轮预筛：revisions.source（revision-source-read，核实版本源码读取）或 revisions.compare（revision-compare-spike）、analysis.boundaries（package-boundary-spike，可仿 VSP graph/boundary.go 纯客户端）、i18n.read（i18n-language-read-spike，可与既有 getTextElements/domain/数据元素标签拼接）；P1 仅剩 git.abapgit 与 AMDP（环境前置受限）。

## 2026-09-17 闲时轮（九）：revisions.source 晋级 EQUIVALENT——版本源码只读工具

- 本轮工作（预筛指定项）：revision-source-read 落地为只读工具 `getRevisionSource`——输入 objectType+objectName+版本选择器（版本标签精确匹配或清单 1-based 序号），不带选择器为发现模式返回版本清单。与 VSP 的安全差异：不接受调用方 version_uri（任意 URL），版本与源 URI 全部服务端解析（quick search 精确匹配 → revisions 清单 → 版本源码 GET，解析口径复用依赖上下文取源链）。
- 接线同步：index.ts + ToolProfiles（workbench 显式名单 +1；OPERATIONS_READONLY 显式追加 getRevisionSource，与 revisions 清单同级运维诊断，operations 计数 44→45）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=150、diagnostic-readonly=119、legacy-full=182、workbench=117、operations=45）+ AGENTS.md 基线（140/1331）。
- 本地门禁全绿：Jest 140 suites / 1331 tests、build、coverage、parity、diff --check；本能力新增 16 例单测（API 8 + Handlers 8）。中途 VspCapabilityParity 测试拦获矩阵行声明 operations-readonly 但工具未入运维名单的一致性缺口，已按"补充运维名单"修正（正是防回退门禁的设计意图）。
- 真机验证（scripts/revision-source-real-dev-smoke.mjs，全程只读）：ZVCL_CAMPAIGN 发现模式返回版本清单（标签=传输号 S4HK900009）；index=1 读回 14 行源码；小写标签回填与序号路径读到同一版本（内容一致）；未知标签/非法名字/非法 objectType 参数层拒绝。SMOKE OK。
- 矩阵：revisions.source PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=30、PARTIAL=14、GAP=14、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 37/71。证据：docs/evidence/revision-source-real-dev-verified.md。
- 遗留：无系统残留。剩余可做项：revisions.compare（版本间 diff spike）、analysis.boundaries（纯客户端边界检查）、i18n.read（语言覆盖读取拼接）、analysis.history（co-change 等）、install.diagnostics（helper 前置只读检查）等 P2；P1 的 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 闲时轮（十）：revisions.compare 晋级 EQUIVALENT——版本对比只读工具

- 本轮工作（预筛指定项）：revision-compare-spike 落地为只读工具 `compareRevisions`（挂在 RevisionSourceHandlers，revisions 域三工具齐全）——两侧选择器接受版本标签（大小写不敏感）/清单序号/`current`（version2 缺省 current，与 VSP 一致），输出 LCS unified diff（3 行上下文 hunks）+ identical 判定 + 增删行计数。VSP revisions.go CompareVersions L69-119 + workflows_source.go generateUnifiedDiff L1447-1560 移植；版本与源 URI 服务端解析，不接受 version_uri 直传。
- 本地门禁：Jest 141 suites / 1339 tests、build、coverage、parity、diff --check 全绿；本能力新增 8 例单测（unifiedDiff hunk 头/上下文窗口/远距双 hunk 等）。第一轮门禁拦获 compareRevisions 未入策略分类/名单的接线遗漏（assertToolCatalogClassified 抛错），补齐后全绿——防回退门禁按设计生效。
- 真机验证（scripts/revision-compare-real-dev-smoke.mjs，全程只读）：ZVCL_CAMPAIGN 版本 S4HK900009 vs current 检出真实差异（+1/-1，hunk @@ -10,5 +10,5 @@，对象激活后被修改）；相同版本 identical=true；标签大小写不敏感与序号双路径一致；负例参数层拒绝。SMOKE OK（首跑遇旧 dist 失败一次，重建后通过，非能力缺陷）。
- 矩阵：revisions.compare PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=31、PARTIAL=13、GAP=14、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 38/71。证据：docs/evidence/revision-compare-real-dev-verified.md。
- 接线同步：ToolProfiles（workbench +1、operations +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=151、diagnostic-readonly=120、legacy-full=183、workbench=118、operations=46）+ AGENTS.md 基线（141/1339）。
- 遗留：无系统残留。revisions 域（清单/源码/diff）全部闭环。剩余可做项：analysis.boundaries（纯客户端边界检查）、i18n.read、analysis.history、install.diagnostics、codeintel.navigation 邻域补充等 P2；P1 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 闲时轮（十一）：i18n.read 晋级 EQUIVALENT——按语言只读四工具

- 本轮工作（预筛指定项）：i18n-language-read-spike 落地为四个按语言只读工具（挂 I18nReadHandlers）——`getObjectContentInLanguage`（对象内容按语言，源 URL 由 objectType+objectName 服务端解析，复用 RevisionSourceApi.resolveObjectSourceUrl）、`getDataElementLabels`（数据元素四段标签，Accept 必须用 vnd.sap.adt.dataelements.v2+xml——通用类型 406，VSP 实测注释）、`getTextPoolInLanguage`（文本池 symbols/selections/headings 三子资源，key=value 解析、@ 指令跳过、空文本保留、单子资源 404 记 missing 不报错）、`compareObjectLanguages`（双语行级对比 line-N 键，只返回差异/缺失）。消息类文本按语言已由 getMessages 覆盖；i18n.write 维持缺口。
- 本地门禁全绿：Jest 143 suites / 1352 tests、build、coverage、parity、diff --check；本能力新增 13 例单测（API 6 + Handlers 7）。
- 真机验证（scripts/i18n-language-read-real-dev-smoke.mjs，全程只读 GET）：LANGU 元素四段标签按语言读回（EN/DE 均德语原文——主语言回退行为与 note 一致）；RFITEMAP 文本池 106 条（missing=[]）；对象内容 1412 行；双语对比 differing=0 与代码行无语言差异预期一致；负例参数层拒绝。SMOKE OK。
- 矩阵：i18n.read PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=32、PARTIAL=12、GAP=14、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 39/71。证据：docs/evidence/i18n-language-read-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +4）+ ToolOperationPolicy（read-only +4）+ ToolCatalogIntegrity 计数（development=155、diagnostic-readonly=124、legacy-full=187、workbench=122、operations=46）+ AGENTS.md 基线（143/1352）。
- 遗留：无系统残留。剩余可做项：analysis.boundaries（纯客户端边界检查）、analysis.history（co-change 等）、install.diagnostics（helper 前置只读检查）、codeintel.navigation/completion-format 邻域核实；P1 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 规划修订轮：RFC 基座定为 open-rfc（矩阵 rfc.* 行说明改写）

- 决策（用户确认）：rfc-transport-spike 阶段 1 传输基座不再自研，采用本地 open-rfc（`D:\MyDev\SAP\open-rfc`，npm `open-rfc@0.2.3`，SDK-free TS classic RFC 客户端）。依据：VSP Go 版即依赖同源 open-rfc-go（`vibing-steampunk/go.mod` `replace => ../open-rfc-go`，`pkg/saprfc` 为薄桥接）；open-rfc 零运行时依赖、无 NW RFC SDK/原生插件，与本项目技术栈一致。
- 不变：`src/rfc/` 阶段 0 保留为门控与模型层（FmAllowlist 只读白名单、FM 接口/编解码/超时/连接池），open-rfc 仅作传输执行器适配进 TransportAdapter；`rfc.helper-bridge` 维持 INTENTIONAL_RESTRICTION（非 remote-enabled FM 经 helper 与 open-rfc 无关）；真实 RFC 仅专用 DEV 授权 smoke、QAS/PRD 只读。
- 变化：连接参数由既有 ADT 系统配置推导（不引入第二套凭据）；describe 经 open-rfc RFC_METADATA_GET 映射 `src/rfc/interface` 出 JSON Schema。
- 矩阵落点（状态全部不变，仅改 restrictionReason/liftCondition）：rfc.remote-enabled.call/describe（P0 GAP，nextMilestone 仍 rfc-transport-spike）、rfc.remote-enabled.discovery 与 rfc.remote-enabled.read-table（P1 PARTIAL）解除条件指向 open-rfc 基座；diagnostics.spool-jobs 的 liftCondition 同步；校验通过后计数不变（对齐 39/71）。
- 前置条件（阶段 1 开工前必须关闭，已写入计划文档修订节）：①open-rfc 要求 Node ^22.14/^24 而本项目 engines>=18（当前开发机 v20.18.0），需先完成引擎兼容评估；②依赖形态评审（npm 依赖 vs vendored，参照 third-party/abap-adt-api 先例与许可证记录）；③classic RFC 明文传输边界（无加密/对端认证，仅可信内网 DEV）纳入系统角色门控设计。
- 同步修正过期表述：计划文档 RFC 段落 + 新增「2026-09-17 规划修订」节、SpoolJobApi.ts 头注释、spool-jobs 证据文档边界节、PROGRESS.md 历史轮次中「RFC 方向排除」的措辞（历史事实不变，改为「暂无 RFC 传输」并指向新基座）。

## 2026-09-17 闲时轮（十二）：analysis.boundaries 晋级 EQUIVALENT——包边界只读检查工具

- 本轮工作（预筛指定项）：package-boundary-spike 落地为只读工具 `checkPackageBoundaries`——TADIR 枚举包内 PROG/CLAS/INTF → 逐对象串行读源码提取依赖（复用 ContextCompressionApi.extractDependencies）→ TADIR 按 kind 分组批查目标包 → 逐边裁定 SAME_PACKAGE/ALLOWED（白名单 glob `*`/`?`）/STANDARD（非 Z/Y 包）/VIOLATION/UNKNOWN，聚合 crossedPackages 与 violatingObjects。判定口径对齐 VSP graph/boundary.go 六类裁定；架构差异（VSP 预构建内存图 vs 本实现按需即时分析）已记录。动态调用检测（DYNAMIC 裁定）未实现，dynamic 恒 0 并在 notes 标注。
- 注入防线：包名处理器层白名单（InvalidParams 零网络往返）；目标包 IN 字面量由内部拼装（数据来自 TADIR）。
- 本地门禁全绿：Jest 144 suites / 1357 tests、build、coverage、parity、diff --check；本能力新增 13 例单测（API 5 + Handlers 8，含六类裁定/白名单通配/STANDARD 不进清单/空包边界）。
- 真机验证（scripts/boundary-check-real-dev-smoke.mjs，全程只读 SELECT/GET）：Z001 包枚举 15 对象、3 条依赖全部裁定 STANDARD（干净自有验证包），六类计数自洽；白名单路径因无跨包依赖以负例覆盖（分支由单测断言）；注入负例参数层拒绝。SMOKE OK。
- 矩阵：analysis.boundaries GAP → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=33、PARTIAL=12、GAP=13、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 40/71。证据：docs/evidence/boundary-check-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=156、diagnostic-readonly=125、legacy-full=188、workbench=123、operations=46）+ AGENTS.md 基线（144/1357）。
- 遗留：无系统残留。所有者要求本轮完成后暂停迭代。剩余可做项（下批候选）：analysis.history（co-change 等只读分析）、install.diagnostics（helper 前置只读检查）、analysis.lint（需 abaplint 引擎）、codeintel.navigation/completion-format 邻域核实；P1 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 闲时轮（十三）：crud.compare-source 晋级 EQUIVALENT——对象间源码对比只读工具

- 本轮工作（P2 最小可关闭项）：compare-source 落地为只读工具 `compareSourceObjects`（挂 RevisionSourceHandlers，版本域四工具齐全）——两对象（CLAS/INTF/FUNC/PROG）各自经 quick search 精确解析当前源码 → identical 判定 → LCS unified diff（3 行上下文）→ 增删行计数 + 两侧行数。VSP workflows_source.go CompareSource L1403-1444 移植；源 URL 服务端解析，不接受任意 URL。复用 compareRevisions 的 unifiedDiff 与解析链，净增代码量小。
- 本地门禁全绿：Jest 144 suites / 1369 tests、build、coverage、parity、diff --check；本能力新增 10 例单测。过程中 compareRevisions 轮的同款教训再现一次（compareSourceObjects 漏入策略分类/名单 → assertToolCatalogClassified 拦获），补齐后全绿。
- 真机验证（scripts/compare-source-real-dev-smoke.mjs，全程只读 GET）：ZVCL_CAMPAIGN 自比 identical（14 行）；ZVCL_CAMPAIGN vs RFITEMAP（1412 行）检出真实差异 +1408/-10（unified hunk、两侧标注正确）；负例参数层拒绝。SMOKE OK。
- 矩阵：crud.compare-source GAP → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=34、PARTIAL=12、GAP=12、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 41/71。证据：docs/evidence/compare-source-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=157、diagnostic-readonly=126、legacy-full=189、workbench=124、operations=46）。
- 新增协作规则（所有者本轮指示）：每轮完成后 git commit + push；网络不通走本地代理 127.0.0.1:7890。本轮起执行首次提交推送。
- 遗留：无系统残留。剩余可做项：analysis.history（co-change 等只读分析）、install.diagnostics（helper 前置只读检查）、read.transaction（事务码元数据）、analysis.lint（需 abaplint 引擎）等 P2；P1 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 闲时轮（十四）：read.transaction 晋级 PARTIAL——事务码元数据只读工具（描述通道环境受限）

- 本轮工作（预筛指定项）：read.transaction 落地为只读工具 `getTransaction`（挂 TransactionReadHandlers）——TSTC（事务码→承载程序 PGMNA）+ TSTCT（按语言 SPRSL 取描述 TTEXT）两条自由 SQL。VSP client.go GetTransaction L1384-1412 的任务语义移植；通道差异经真机实测确认。
- 真机实测发现（探针逐层定位）：① VSP 的 ADT vit/wb TRAN 端点在该 DEV 无 TRAN 映射（"No URI-Mapping defined"，SE38/SM37 双探针）；② 替代通道 TSTCT 的 datapreview 数据读取一律 Internal server error（无 WHERE/各种 WHERE 全形态，表结构 describe 正常）——环境级数据预览限制。
- 适配：TSTCT 描述查询容错为"缺失 + note 标注"（不让它拖垮 program 主语义）；"事务码不存在"按 InvalidParams 透出。矩阵如实记 PARTIAL（描述要素在目标环境不可得），liftCondition 写明解除条件。
- 本地门禁全绿：Jest 145 suites / 1383 tests、build、coverage、parity、diff --check；本能力新增 14 例单测（API 7 + Handlers 7，含 TSTCT 失败容错降级）。
- 真机验证（scripts/transaction-read-real-dev-smoke.mjs，全程只读 SELECT）：SE38 → 程序 RSABAPPROGRAM 正确；描述缺失 + note 标注 TSTCT 受限；DE 同样受限；ZZZZ9 不存在 → InvalidParams 含 TSTC 提示；注入负例参数层拒绝。SMOKE OK。
- 矩阵：read.transaction GAP → PARTIAL（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=34、PARTIAL=13、GAP=11、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 41/71。证据：docs/evidence/transaction-read-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=158、diagnostic-readonly=127、legacy-full=190、workbench=125、operations=47）+ AGENTS.md 基线（145/1383）。
- 遗留：无系统残留。剩余可做项：analysis.history（co-change 等只读分析）、install.diagnostics（helper 前置只读检查）、analysis.lint（需 abaplint 引擎）等 P2；P1 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 闲时轮（十五）：install.diagnostics 晋级 EQUIVALENT——安装前置只读发现工具

- 本轮工作（预筛指定项）：helper 前置只读 discovery 落地为只读工具 `checkInstallPrerequisites`（挂 InstallDiagnosticsHandlers，无入参）——ZADT_VSP helper TADIR 探测（LIKE 'ZADT_VSP%'，失败重试 1 次）+ abapGit ADT 服务可达性分类（/sap/bc/adt/abapgit/repos，v2 Accept；available/not_installed/forbidden/error 四态，"does not exist" 语义归 not_installed）+ 本地 Node 运行时。notes 明确"本服务器不做任何安装动作"（安装属 INTENTIONAL_RESTRICTION 行）。VSP 的 ListDependencies 是本地嵌入 ZIP 清单（安装动作输入），对本项目不适用，矩阵 restrictionReason 已记录差异。
- 本地门禁全绿：Jest 146 suites / 1394 tests、build、coverage、parity、diff --check；本能力新增 11 例单测（API 5 + Handlers 6）。
- 真机验证（scripts/install-diagnostics-real-dev-smoke.mjs，全程只读 SELECT/GET）：ZADT_VSP helper installed=false（该系统从未安装 helper；首轮 TADIR 瞬时 500 由重试吸收）；abapGit 分类 not_installed（ADT 报资源不存在，语义识别正确）；Node v22.22.2 报告；notes 边界生效。SMOKE OK。
- 矩阵：install.diagnostics PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=35、PARTIAL=12、GAP=11、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 42/71。证据：docs/evidence/install-diagnostics-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=159、diagnostic-readonly=128、legacy-full=191、workbench=126、operations=48）+ AGENTS.md 基线（146/1394）。
- 遗留：无系统残留。剩余可做项：analysis.history（co-change 等只读分析）、analysis.lint（需 abaplint 引擎）、codeintel.navigation 邻域核实、crud.recover-failed-create/set-description/refactor.rename（写方向工作流，需谨慎设计）等 P2；P1 git.abapgit/AMDP 受环境前置约束。

## 2026-09-17 闲时轮（十六）：analysis.lint 归位 INTENTIONAL_RESTRICTION——abaplint 引擎不可得

- 调研结论：矩阵行 analysis.lint（P2 GAP，离线 ABAP 静态分析）的依赖 abaplint 引擎不可得——npm 包 abaplint 已于 2022-07 unpublish（2026-09-17 npm view 返回 404 实测）；VSP 依赖其内部 Go 转译版（pkg/abaplint，非公开包），本项目无法复用。
- 处理：按矩阵词汇归位 INTENTIONAL_RESTRICTION（GAP 移出可做桶），restrictionReason 记录 404 实测证据与替代路径（ADT 在线语法检查 syntaxCheckCode/syntaxCheckCdsUrl 已在 catalog，覆盖"发现语法错误"核心需求；abaplint 离线规则集无等价物），liftCondition 写明重新评估条件。
- 期间一次 JSON 转义事故（node -e 内嵌引号破坏 JSON），已 git checkout 恢复并以 JSON.parse 验证后重做。
- 现状：MCP_SUPERSET=7、EQUIVALENT=35、PARTIAL=12、GAP=10、INTENTIONAL_RESTRICTION=7、UNVERIFIED=0，对齐 42/71（完成率不变，GAP 桶去虚存实）。

## 2026-09-17 闲时轮（十七）：diagnostics.knowledge-queries 晋级 PARTIAL——文档/IMG 检索只读工具

- 本轮工作（预筛指定项）：knowledge-queries 子集落地为两个只读工具（挂 KnowledgeQueriesHandlers）——`getAbapDocumentation`（ABAP 文档：索引模式 DOKIL 跨类跨语言清单 / 正文模式 DOKTL 最新版本 line/dokformat/doktext 行序列，行数上限截断标注）与 `searchImgActivities`（CUS_IMGACT 活动文本 LIKE 检索 + CUS_IMGACH 补 tcode + TNODEIMGT 文件夹）。VSP handlers_docs.go/IMGSearch 移植。fm_test_data/cluster_read/img_activity 路径递归不在子集（notes 标注），矩阵记 PARTIAL。
- 关键实现点：语言键 ISO→SAP 1 位内部码转换（sapInternalLanguageKey，映射表逐项对齐 VSP spras——DOKTL.LANGU/SPRAS 列均为 1 位，2 位直查永远查空）；文本注入转义+控制字符拒绝。
- 本地门禁全绿：Jest 148 suites / 1410 tests、build、coverage、parity、diff --check；本能力新增 16 例单测（API 9 + Handlers 7）。
- 真机验证（scripts/knowledge-queries-real-dev-smoke.mjs，全程只读 SELECT）：LANGU 文档索引 5 条、正文 13 行真实读回（U1 标题、格式码）；IMG 检索 Anlage* 命中 10 节点（活动+文件夹）；不存在文档 InvalidParams 含提示；注入样本安全处理。SMOKE OK。
- 矩阵：diagnostics.knowledge-queries GAP → PARTIAL（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=35、PARTIAL=13、GAP=9、INTENTIONAL_RESTRICTION=6、UNVERIFIED=0，对齐 42/71。证据：docs/evidence/knowledge-queries-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +2）+ ToolOperationPolicy（read-only +2）+ ToolCatalogIntegrity 计数（development=161、diagnostic-readonly=130、legacy-full=193、workbench=128、operations=50）+ AGENTS.md 基线（148/1410）。
- 遗留：无系统残留。剩余可做项已基本枯竭：analysis.history 的 cr_history 经探针确认 E071/E070 datapview 受限（同 TSTCT 环境级限制）；剩余均为写方向工作流（recover-failed-create/set-description/rename/i18n.write）或环境前置（git.abapgit、AMDP、analysis.lint 引擎）。

## 2026-09-17 闲时轮（十八）：矩阵保真更新——实测证据回写 PARTIAL 行

- git.abapgit 行 restrictionReason 补真机实测：该 DEV 的 /sap/bc/adt/abapgit/repos 资源不存在（abapGit 未安装，checkInstallPrerequisites 实测），前置现状可经该工具只读发现。
- analysis.history 行 restrictionReason 补真机实测：E071/E070 datapreview 数据读取一律 Internal server error（表结构可查），cr_history 的自由 SQL 通道在该 DEV 不可用；VSP 同走 E071/E070 亦受同等限制。
- 校验与推送：matrix --check 通过；commit + 代理推送。

## 2026-09-18 闲时轮：spool-jobs 补齐内容读取——晋级 EQUIVALENT

- 状态甄别：起跑时发现矩阵已被第十九+轮推进（spool-jobs 只读子集已真机验证记 PARTIAL，剩余差距为 spool 内容读取）；本轮撤销了与既有 SpoolJobApi 重叠的重复实现（新建三文件未接线即删，零污染），改为在既有模块上追加第三个工具 `readSpoolContent`（tsp01→tst01 头→tst03 内容 hex 解码；按 dcharcod 4103/4110 UTF-16LE 与 latin-1 分支解码并清理 ABAP list 控制字节；OTF/二进制返回 raw 说明）。handler/绑定/清单映射全口径复用，新增 5 个 mock 用例（合计 27）。
- 真机缺陷修复：① quoteLiteral 已含引号导致双重包裹（datapreview "after ''" 解析错）；② 该 DEV spool 内容为 UTF-16LE（dcharcod=4103），latin-1 近似乱码——两处均已修复并以双码页 mock 覆盖。
- 真机结果：readSpoolContent 对真实请求 #23674 取回 568 字符可读 LIST 内容（真实报表标题/日期/结构线）；listSpoolRequests 复验 10 条真实请求。
- 本地门禁全绿：Jest 150 suites / 1414 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 矩阵：diagnostics.spool-jobs PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状：MCP_SUPERSET=7、EQUIVALENT=36、PARTIAL=12、GAP=9、INTENTIONAL_RESTRICTION=7、UNVERIFIED=0，对齐 43/71。profile 计数：dev=162、workbench=129、diag=131、full=194、ops=46。证据：docs/evidence/spool-content-real-dev-verified.md。
- 遗留：job_log（RFC/XBP 方向，RESTRICTION）；OTF/二进制解码与 ABAP list 精确排版还原（VSP 亦有差异）；readRuntimeDumps 服务端 runtimeError 过滤缺陷（轮四遗留）。
- 下一轮起点建议：P1 剩余中 debug.amdp-adt（amdp-discovery-spike，ADT 原路径 discovery）；P2 可做 read.transaction（TSTC/TSTCT 只读查询，与 applog/spool 同模式）。

## 2026-09-18 轮（十九）：rfc.remote-enabled.discovery 晋级 EQUIVALENT——RFC 直链探测工具（所有者放开 RFC/helper 方向）

- 所有者决策：放开 RFC/helper 方向（此前为排除项），并确认 open-rfc-go 直连已验证可用（专用 DEV rfc_sysnr=01）。
- 本轮工作：RFC 直链探测落地——npm 引入 `open-rfc@0.2.3`（所有者维护的纯 TS classic RFC 客户端，与 VSP open-rfc-go 同源同协议，无 NW RFC SDK 依赖），`src/rfc/open-rfc-transport.ts` 适配为 TransportAdapter（ABAP 异常 RFC_ABAP_EXCEPTION 与传输故障分离，池剔除只认后者），`probeRfcSystem` 工具经 allowlist 门控 + invokeFmCall 超时链调用 RFC_PING + RFC_SYSTEM_INFO。
- 通道侦察：经典 RFC 网关 3200/3300 ECONNREFUSED（容器仅暴露 8001 HTTP）；RFC 直链实测 host=10.30.254.48 sysnr=01（.vsp.json rfc_sysnr）。
- 真机验证（scripts/rfc-probe-real-dev-smoke.mjs，全程只读系统 RFM）：RFC_PING 连通；RFC_SYSTEM_INFO 全量指纹（sysid=S4H release=816 host=sapides dbsys=HDB ip=10.30.254.48 kernel=916 inst=01）。SMOKE OK。
- 矩阵：rfc.remote-enabled.discovery PARTIAL → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=37、PARTIAL=11、GAP=9、INTENTIONAL_RESTRICTION=7、UNVERIFIED=0，对齐 44/71。证据：docs/evidence/rfc-probe-real-dev-verified.md。
- 接线同步：index.ts + ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=164、diagnostic-readonly=133、legacy-full=196、workbench=131、operations=48）+ AGENTS.md 基线（149/1435）。
- 遗留：无系统残留。下轮候选：rfc.remote-enabled.call/read-table（open-rfc 底座已通，callRfm 泛化 + RFC_READ_TABLE 白名单内表读取）、RFC_SIMULATE_AUTH_CHECK 授权探测（open-rfc 支持）。

## 2026-09-18 轮（二十）：rfc.remote-enabled.read-table 晋级 EQUIVALENT——UNVERIFIED 清零，open-rfc 阻塞解除

- 背景与授权：所有者确认 open-rfc（D:\MyDev\SAP\open-rfc，kylin_dev 分支）为其自维护 fork，库的问题可直接修复维护；本轮按方案 ①（本项目侧接线）解除 read-table 阻塞。
- 修复一（决策门）：open-rfc 对含 TABLES 参数的调用要求显式递归序列化器观测（否则 live-decision-required 拒发）。OpenRfcTransport 构造缺省注入 classic-xRFC 观测策略（profile abap-7.58 + observation classic-xrfc/classic-xrfc；部署级断言：经典 RFC 直链无 basXML 协商，仅限可信内网 DEV），构造 options 可覆盖；单测 OpenRfcTransportPolicy.test.ts（3 例）锁接线契约。
- 修复二（DELIMITER）：RFC_READ_TABLE 的 DELIMITER 为 CHAR1，open-rfc 按元数据宽度校验，双字符 ~~ 被拒；改回 VSP 同款单字符 |（列值含 | 串列为 VSP 同款已知限制）。
- 修复三（WHERE 引号）：OPTIONS TEXT 由 RFM 内部作为动态 Open SQL 片段执行，此前单引号翻倍触发 ABAP DB_Error（SAIS）；改为原样透传，注入防线保留（控制字符/分号/换行拒绝 + 表名/列名白名单 + 72 字符上限）。此前注释"VSP sqlQuote 语义"系误记——VSP readtable.go 实际不转义引号，本轮核对源码澄清。
- 系统形态适配（真机发现）：该 S/4 DEV 的 RFC_READ_TABLE 被 SAP 增强（USE_ET_DATA_4_RETURN 导入参数 + ET_DATA 导出表 SDTI_RESULT_TAB），不带开关时经典 DATA 回填全空；且 open-rfc 请求侧按元数据校验参数名，旧系统发开关会 unknown parameter 拒发。适配为能力探测双路径：TransportAdapter 新增可选 getFunctionInterface（OpenRfcTransport 委托 open-rfc Client 同名方法，仅保留参数名/方向类结构视图），read-table-adapter 探测 USE_ET_DATA_4_RETURN 存在则带开关并从 ET_DATA[].LINE 解析，否则经典 DATA[].WA；探测按适配器 WeakMap 缓存，失败如实抛出且不缓存（静默降级会产生"0 行成功"假阴性）。单测 ReadRfcTableEtData.test.ts（5 例）。
- 真机验证（scripts/read-table-real-dev-smoke.mjs，全程只读）：T001 全量 10 行、WHERE 过滤（该 client 300 无 BUKRS=1000，0 行属正确行为）、列投影 [["0001","SAP SE"],["0003","SAP US (IS-HT-SW)"]]、注入负例参数层拒绝。SMOKE OK。
- 本地门禁全绿：Jest 153 suites / 1430 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check；临时探针五件已清理。
- 矩阵：rfc.remote-enabled.read-table UNVERIFIED → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=38、PARTIAL=10、GAP=9、INTENTIONAL_RESTRICTION=7、UNVERIFIED=0，对齐 45/71。证据：docs/evidence/read-table-real-dev-verified.md。
- 遗留：无系统残留。下一 RFC 轮次候选：rfc.remote-enabled.call/describe（callRfm 泛化，两个 P0 GAP）、RFC_SIMULATE_AUTH_CHECK 授权模拟。

## 2026-09-18 轮（二十一）：rfc.remote-enabled.call/describe 双 P0 GAP 关闭——对齐 47/71

- 本轮工作（优先级清单 P0 项）：callRfm 泛化落地为两个只读工具——`describeRfm`（FM 接口元数据 → 参数级结构化描述 + 仅导入/变更参数的轻量 inputSchema + allowlisted 提示；复用 TransportAdapter.getFunctionInterface，结构化视图扩展类型细节字段；describe 不执行目标 FM）与 `callRfm`（受控只读 RFM 调用：allowlist 硬门 → 载荷透传（顶层键大小写归一）→ invokeFmCall 超时/取消链；RFC 域错误带原因透出）。
- 安全设计（所有者授权 P0 后的本轮决策）：默认只读 allowlist 3 → 7（新增 RFC_GET_FUNCTION_INTERFACE/RFC_METADATA_GET/RFC_FUNCTION_SEARCH/RFC_SIMULATE_AUTH_CHECK，准入标准写入注释：SAP 标准交付、无副作用、名称稳定；业务自定义 RFM 不走默认集合，经构造注入扩展）。白名单外拒绝发生在任何网络往返之前（真机断言 invoke 零触达）。
- 真机验证（scripts/rfc-call-describe-real-dev-smoke.mjs，全程只读）：describeRfm RFC_READ_TABLE 11 参数（含 S/4 增强形态 USE_ET_DATA_4_RETURN/ET_DATA，交叉印证上轮元数据实测）；describe→call 组参闭环（RFC_FUNCTION_SEARCH 发现 FUNCNAME 后驱动 callRfm）；RFC_SYSTEM_INFO 指纹 RFCSI_EXPORT.RFCSYSID=S4H（裸 RFM 透传保真）；RFC_READ_TABLE 透传读回 ET_DATA 2 行；白名单外/非法名双负例拒绝。SMOKE OK。
- 本地门禁全绿：Jest 153 suites / 1440 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 矩阵：rfc.remote-enabled.call 与 rfc.remote-enabled.describe GAP → EQUIVALENT（evidence + real-dev-verified）。现状 MCP_SUPERSET=7、EQUIVALENT=40、PARTIAL=10、GAP=7、INTENTIONAL_RESTRICTION=7、UNVERIFIED=0，对齐 47/71。证据：docs/evidence/rfc-call-describe-real-dev-verified.md。
- 接线同步：ToolProfiles（workbench +2）+ ToolOperationPolicy（read-only +2）+ ToolCatalogIntegrity 计数（development=166、diagnostic-readonly=135、legacy-full=198、development-workbench=133）+ AGENTS.md 基线（153/1440）。
- 遗留：无系统残留。RFC_SIMULATE_AUTH_CHECK 已入白名单（结果语义化呈现为后续轮次）；剩余 GAP 7 行（debug.amdp-adt、report.run/async/variants、ui5.write、crud.clone-object、transport.merge-move）与 PARTIAL 10 行按优先级清单推进。

## 2026-09-18 轮（二十二）：img_activity 闭环 + 重大环境发现——datapreview 按会话查询预算

- 本轮工作（P2 清单项）：知识查询第三只读工具 `getImgActivity`——单个 IMG 活动完整详情：基础行（CUS_IMGACH）+ 按语言文本（CUS_IMGACT）+ 菜单路径（TNODEIMGR 引用 → TNODEIMG 向上递归带环检测 + TNODEIMGT 文本，根在前排序）+ HY 文档容错（复用文档正文通道）。VSP IMGActivity/imgPaths/imgPathOf 移植；递归不用 JOIN（实测 `AS r` 别名被该环境拒），辅助信息逐项容错降级为 notes；`maxRefs`（1..20）有界入参控制查询量。
- 真机验证（scripts/img-activity-real-dev-smoke.mjs，全程只读）：负例（ZZZZ9NOPE InvalidParams / 注入参数层拒绝）→ 回归（Anlage* DE 命中 10 节点，与第十七轮一致）→ 详情（APOC_C_FORMV 事务码 S_ER9_68000005，路径 "Statutory Reporting > Certificate of Creditable Withholding Tax Report"；带空格 docu_id 容错降级）。SMOKE OK。
- **重大环境发现：datapreview 按会话查询预算（约 19 次）**。二分探针实测：同一 ADT 会话第 ~20 次查询起持续失败直至新会话；单次 getImgActivity 详情恰耗 ~19 次。历史上多轮"瞬时失败"（第十七轮 CUS_IMGACH、read.transaction 的 TSTCT/E071/E070 受限、第九轮 81s UNKNOWN_OUTCOME）大概率即此机制而非表级限制。处置：知识查询层不做失败重试（重试白烧预算，单测锁定）；maxRefs/smoke 顺序控制预算；候选加固项（需所有者评审）——ADT 客户端会话重置机制，可一次性解决全部 datapreview 工具的长会话可用性。
- report.text-elements 差距核实（本轮完成）：读面已覆盖，剩余差距为文本池受控写入链（setTextElements 为 legacy-full 专家原子工具）——归入写方向批次，需设计评审授权。
- 本地门禁全绿：Jest 153 suites / 1446 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 矩阵：knowledge-queries 维持 PARTIAL 但边界收窄（img_activity 闭环；剩余 fm_test_data/cluster_read 需 S/2 集群解析器约 2.2k 行移植，独立工程轮候选；真机已确认 datapreview 可回传 CLUSTD hex 串，通道可行）。现状 MCP_SUPERSET=7、EQUIVALENT=40、PARTIAL=10、GAP=7、INTENTIONAL_RESTRICTION=7、UNVERIFIED=0，对齐 47/71。证据：docs/evidence/img-activity-real-dev-verified.md。
- 接线同步：ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）+ ToolCatalogIntegrity 计数（development=167、diagnostic-readonly=136、legacy-full=199、development-workbench=134）+ AGENTS.md 基线（153/1446）。
- 遗留：无系统残留。下轮候选：① S/2 集群解析器工程轮（fm_test_data/cluster_read，关知识查询最后缺口）；② datapreview 会话预算加固（ADT 客户端会话重置，需评审）；③ 写方向工作流批次（set-description 起步，需授权）。

## 2026-09-18 轮（二十三）：预算假象收获期——read.transaction 晋级 + analysis.history 核心闭环 + report.* 矩阵保真

- 预算发现的红利兑现：新会话重测第十七/十八轮判"环境受限"的表——TSTCT/E071/E070 datapreview 全部正常。进一步定位 TSTCT 的真缺陷：SPRSL 是 1 位内部语言键，2 位 ISO 字面量（'EN'）超出列宽被 datapreview 拒（实测 400）。修复：getTransaction 查询前经 sapInternalLanguageKey 转内部键（与知识查询同表）。
- read.transaction 复测晋级 EQUIVALENT：SE38 → RSABAPPROGRAM + 描述 "ABAP Editor"（EN/DE 真实返回）；负例保持参数层拒绝。SMOKE OK。
- analysis.history 核心子集落地（TransportHistoryApi + TransportHistoryHandlers，新处理器接入 index.ts）：`getCrHistory`（E071 R3TR+LIMU → E070 任务→请求层级+用户/日期；E070A CR 属性未配置记 notes）与 `getCoChange`（同请求共现频次排行，VSP 图引擎的简化口径，notes 声明"线索非结论"）。真机：ZVCL_CAMPAIGN 任务 S4HK900010→请求 S4HK900009/用户 068157；共现 5 条真实对象（含锁对象 ENQU EZVLOCK3，与代码事实吻合）。SMOKE OK。边界收窄：剩余为 impact/boundaries/graph_stats 等图引擎类。
- 矩阵保真：report.run/async/variants GAP → INTENTIONAL_RESTRICTION（所有者早期已定 RESTRICTION 方向，等价读能力由 spool-jobs/text-elements 覆盖），GAP 桶 7 → 4。
- 本地门禁全绿：Jest 154 suites / 1455 tests、build、coverage、parity、git diff --check。
- 矩阵现状：MCP_SUPERSET=7、EQUIVALENT=41、PARTIAL=9、GAP=4、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 48/71。证据：docs/evidence/transport-history-real-dev-verified.md。
- 接线同步：ToolProfiles（workbench +2）+ ToolOperationPolicy（read-only +2）+ ToolCatalogIntegrity 计数（development=169、diagnostic-readonly=138、legacy-full=201、development-workbench=136）+ AGENTS.md 基线（154/1455）。
- 遗留：无系统残留。剩余 GAP 4 行全为写方向或环境前置（clone-object、merge-move、amdp-adt、ui5.write）；PARTIAL 9 行中可推进项为知识查询集群解析器工程轮（fm_test_data/cluster_read）与写方向受控工作流批次（均需授权/大轮）。

## 2026-09-18 闲时轮：debug.amdp-adt discovery spike——GAP → PARTIAL（真机确认 ADT 原生 AMDP 调试资源存在）

- 本轮工作（P1 GAP 的 amdp-discovery-spike）：新增 `checkAmdpDebugger`（无状态只读 GET /sap/bc/adt/amdp/debugger/main，语义对齐 VSP probeAMDP：400/200/405 可用、404 缺失、其余 unknown），单工具处理器接入 runtimeTools 面（workbench 名单 +1）。12 个 mock 用例含真机业务错误形态。
- 真机结果（只读，326ms）：目标 DEV 具备 ADT 原生 AMDP 调试资源（400 "Parameter mainId could not be found"——资源在要求参数，即存在性证据；服务端零安装，非 helper 路径）。
- 真机缺陷修复：本项目 ADT 客户端把非 2xx 转成业务 Error（无 response.status），最初状态码分支全落空归 unknown——改按消息内容分类并用 includes 子串判定（顺带消除多轮工具写入把正则转义损坏为控制字符的风险，已删 tsbuildinfo 强制重建）。
- 关键事实记录：AMDP 调试句柄在 ABAP 会话内存（class-data），未来调试会话必须复用同一有状态会话（本项目 ADTClient 默认 stateful 满足）。
- 本地门禁全绿：Jest 155 suites / 1478 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 矩阵：debug.amdp-adt GAP → PARTIAL（discovery 真机可用；调试会话本体待受控工作流立项，nextMilestone=amdp-debugger-controlled-workflow）。顺带修复轮二十遗留：analysis.history 行声明的 operations-readonly 口径与实际名单不符（getCrHistory/getCoChange 未入 operations 名单），已补齐（operations 46→48）。现状：MCP_SUPERSET=7、EQUIVALENT=41、PARTIAL=10、GAP=3、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 48/71。证据：docs/evidence/amdp-discovery-real-dev-verified.md。
- 剩余 GAP 3 行：clone-object、merge-move（传输写方向）、ui5.write（写方向）——均需受控工作流立项或属 RESTRICTION。下一轮起点建议：P2 PARTIAL 的受控写批次（set-description/clone-object/report.text-elements/i18n.write——需大轮设计受控链）或 diagnostics.knowledge-queries 的集群解析器工程轮。

## 2026-09-18 闲时轮：crud.clone-object GAP → PARTIAL——组合任务路径真机闭环

- 选型甄别：P1 三项（execute-abap 任意执行面/recover-failed-create 语义边界/git.abapgit 环境受限）均不满足完整可行链，落到 P2 的 crud.clone-object（GAP）。中途放弃一站式受控克隆工作流的大轮设计（半成品风险），改为组合任务路径的真机闭环推进——全部走既有受控工具，零新代码。
- 真机闭环（scripts/clone-object-real-dev-smoke.mjs，已注册 test:clone-real-dev）：受控创建源对象 → getObjectSource 读源 → REPORT 声明行改名（对齐 VSP CloneObject 正则语义）→ 受控创建目标（携带改名源码，immutable plan+原生确认）→ readback 比对一致 → 双对象受控清理 absence 零残留。工程要点：ENQ 锁释放延迟用时间戳后缀新名绕开；getObjectSource 源码在 result.source 字段。
- 矩阵：crud.clone-object GAP → PARTIAL（evidence + real-dev-verified，nextMilestone=clone-controlled-workflow——一站式受控克隆工作流立项后晋级）。矩阵守卫修正：组合 taskPath 的 profiles 不含 legacy-full（受控创建链不在专家面，Wave 1 口径）。现状：MCP_SUPERSET=7、EQUIVALENT=41、PARTIAL=11、GAP=2、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 48/71。证据：docs/evidence/clone-object-real-dev-verified.md。
- 本地门禁全绿：Jest 156 suites / 1476 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。无系统残留。
- 剩余 GAP 2 行：transport.merge-move（传输写方向 RESTRICTION）、ui5.write（写方向 RESTRICTION）。下一轮起点建议：受控写工作流大轮（clone-controlled-workflow 或 set-description/i18n.write）或 diagnostics.knowledge-queries 集群解析器工程轮——均需整轮预算。

## 2026-09-20 闲时轮：保真维护——轮四遗留缺陷清账（readRuntimeDumps 服务端过滤）

- 本轮形态（无大轮授权，按保真维护推进）：清账轮四遗留缺陷——readRuntimeDumps 带 runtimeError/exception/objectName/user 服务端过滤在该 DEV InternalError。
- 根因：本项目把四项过滤拼成 feed search 谓词（`and ( contains ( runtimeError , ... ) )`），而该 ADT dumps feed 协议只支持 between datetime 谓词（对照 VSP Dumps：服务端仅 from/to，其余全为客户端 matches）。
- 修复：buildRuntimeDumpQuery 只保留时间窗；user/objectName/runtimeError/exception 改为客户端过滤（对齐 VSP matches 的大小写不敏感语义 + 本项目既有 contains 契约），注入形态的过滤值降级为无害文本（客户端匹配不到即空结果，无 SQL 面）。测试按新契约重写并补客户端过滤与注入无害化用例（6 个）。
- 真机复验（只读，7 天窗口）：带 runtimeError=DBSQL_SQL_ERROR 返回 30 条且 100% 为目标异常（修复前同参数 InternalError）；无过滤对照 50 条；耗时 59s（系统慢但在预算内）。
- 矩阵保真：diagnostics.dumps restrictionReason 补缺陷清账事实（无状态变化）。findSimilarDumps 的客户端匹配路径与本次修复同语义，无需改动。
- 本地门禁全绿：Jest 156 suites / 1478 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。AGENTS.md 基线同步（156/1478，2026-09-20）。
- 矩阵现状：MCP_SUPERSET=7、EQUIVALENT=41、PARTIAL=11、GAP=2、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 48/71（无变化——本轮为缺陷清账）。
- 下一轮起点建议：全部剩余项为大轮（受控写工作流批次/集群解析器工程轮/AMDP 调试会话工作流），无大轮授权时继续保真维护形态（守卫巡检/遗留清账/依赖健康检查）。

## 2026-09-22 闲时轮：crud.set-description 受控写链落地——PARTIAL → MCP_SUPERSET（大轮）

- 本轮启动受控写批次第一个工作流（description-controlled-write）：受控描述修改链（PROG/CLAS/INTF/INCL 四类）。
- 构件：src/adt/DescriptionApi.ts（metadata GET/descriptionAttr 替换/PUT(corrNr)/URL 映射/长度限制，语义对齐 VSP SetDescription）+ src/safe/DescriptionChangeWorkflow.ts（immutable plan + 上下文绑定 + 同值短路 + UNKNOWN_OUTCOME 终止 + readback 核验）+ DescriptionChangeHandlers（preview/apply/status 三工具，apply 仅 DEV+development/workbench，原生 elicitation 确认）。
- 真机闭环（scripts/description-real-dev-smoke.mjs + description-verify-smoke.mjs）：自建 PROGRAM → 预检冻结 → 确认 apply → readback 一致 → 同值短路 → 清理零残留，全部 PASS。真机动态 limit=70 按 descriptionTextLimit 校验。
- 真机修复三缺陷：① stateful 会话要求（锁句柄会话绑定，stateless PUT 报错）；② lock 原始行大写列名（LOCK_HANDLE）提取归一化 + 提取失败时 raw 键兜底解锁（防 ENQ 泄漏）；③ JSDoc 内 */* 注释截断。
- 本地门禁全绿：Jest 157 suites / 1490 tests、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 矩阵：crud.set-description PARTIAL → MCP_SUPERSET（evidence + real-dev-verified）。现状：MCP_SUPERSET=8、EQUIVALENT=41、PARTIAL=9、GAP=2、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 49/71。证据：docs/evidence/description-controlled-real-dev-verified.md。
- 接线同步：ToolProfiles（workbench +3）+ ToolOperationPolicy（READ_ONLY +1/LOCAL +1/ADVANCED +1/CONTROLLED_DESCRIPTION 集合与 role/profile 门控）+ ToolCatalogIntegrity 计数（development=173、development-workbench=140）+ AGENTS.md 基线（157/1490，2026-09-22）。
- 下一轮起点建议：受控写批次继续（clone-controlled-workflow 一站式工作流：本轮 DescriptionApi/锁链经验直接复用）或 report.text-elements/i18n.write。

## 2026-09-22 闲时轮：crud.clone-object 一站式受控克隆——PARTIAL → MCP_SUPERSET（大轮）

- 本轮完成受控写批次第二个工作流（clone-controlled-workflow，上轮建议起点）：CloneObjectApi（源 URL 服务端解析 + 声明改名协议函数，对齐 VSP CloneObject 的 REPORT/CLASS/INTERFACE 正则语义并加固——类源码要求 DEFINITION/IMPLEMENTATION 两处同步替换，声明行数量不符即拒绝，VSP 只替换首个匹配会漏改）+ CloneObjectWorkflow（preview 只读读源快照+本地改名冻结 immutable plan（sourceHash/payloadHash/declarationChanges），applyConfirmed 委托既有受控创建链单次执行——壳创建/锁/写/语法检查/激活/源码 hash 比对/失败补偿全部复用，创建链确认层自持 executionGate）+ CloneObjectHandlers（preview/apply/status 三工具，apply 仅 DEV+development/workbench，原生 elicitation 确认，决策门豁免外层 gate 防自我死锁）。
- 真机闭环（scripts/clone-controlled-real-dev-smoke.mjs，注册 test:clone-controlled-real-dev，6 项断言全 PASS、SMOKE OK）：自建源 ZVCLSMKSRC6721 → preview 冻结（源 hash/改名 1 处/目标 2 行）→ 确认 apply（创建链 APPLIED）→ readback 独立直读逐字一致（REPORT ZVCLSMKTGT6721）→ 本地状态 SUCCEEDED → 双清理 absence 零残留。审计链 CLONE_PREVIEW_CREATED→CLONE_COMPLETED（新字段 clonePlanId）。
- 本地门禁全绿：Jest 158 suites / 1509 tests（+17 例：协议 6 + 工作流 7 + 处理器 4）、build、check:repository-creation-coverage、check:vsp-capability-parity、git diff --check。
- 矩阵：crud.clone-object PARTIAL → MCP_SUPERSET（evidence + real-dev-verified）。现状：MCP_SUPERSET=9、EQUIVALENT=41、PARTIAL=9、GAP=2、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 50/71。证据：docs/evidence/clone-controlled-real-dev-verified.md（组合路径历史证据 clone-object-real-dev-verified.md 保留为过程记录）。
- 接线同步：ToolProfiles（workbench +3）+ ToolOperationPolicy（read-only +1/local +1/advanced-mutation +1/CONTROLLED_CLONE_TOOL_NAMES 专属 profile 门控 + 角色可见性）+ ToolCatalogIntegrity 计数（development=176、development-workbench=143）+ serverGuardrails（applyCloneObject/getCloneObjectStatus 豁免外层 gate）+ AGENTS.md 基线（158/1509，2026-09-22）。
- 遗留：无系统残留。本轮前完成三轮未提交工作清场（AMDP discovery/clone 组合路径/set-description 已分批提交推送，四个临时探针文件清理）。剩余 PARTIAL 9 行中可推进项：refactor.rename（rename-controlled-write，与本轮同型）、report.text-elements/i18n.write（文本池受控写入）、recover-failed-create（语义边界）；GAP 2 行（transport.merge-move/ui5.write）均属写方向 RESTRICTION；大轮候选：AMDP 调试会话工作流、S/2 集群解析器、abapgit Stage 2 执行器。

## 2026-09-22 闲时轮（二）：refactor.rename 受控重命名——PARTIAL → MCP_SUPERSET（大轮）

- 本轮完成受控写批次第三个工作流（rename-controlled-write）：RenameControlledWorkflow 一站式受控重命名——preview 只读读源快照+声明改名冻结 immutable rename plan（按对象类型精确锚定 REPORT/CLASS/INTERFACE 词边界，类两处同步，拒绝 VSP RenameObject 全文 ReplaceAll 的误伤面）；apply 单确认两步：①复用克隆工作流落地新对象（受控创建链保证）②受控清理链删除旧对象。防御语义：创建失败绝不触碰旧对象（唯一存活副本）；删除侧失败时缺席复核收敛。
- 环境切换（所有者指示）：真机 smoke 从 sap-dev.env 切到 **sap-demo.env**，传输号仍 S4HK900009（sap-dev 上该传输已对 Z001 不可用，探针确认 E070 无此请求；sap-demo 上 TRSTATUS=D 可用）。AGENTS.md 基线已注明。
- 真机发现并修复（缺席复核收敛机制）：首轮真机删除动作实际已生效（REPOSRC 无 A 版、structure 不存在）但清理链传输证据校验失败——该系统把删除登记挂在请求的子任务下（E070.STRKORR 层级），transportDetails 请求级对象清单聚合不到，key 组零匹配报 VERIFICATION_FAILED，首轮按设计收敛 PARTIAL（防御语义正确）。修复：删除侧失败时追加只读缺席复核（与 preview 读源同通道），关键适配本项目 ADT 客户端把非 2xx 转 AdtErrorException（状态码在 err 字段、消息本地化中文"没有找到角色"）——按状态码（err/status 双兼容）判定，409/403 与网络异常保守不判。缺席成立收敛 SUCCEEDED 并显式注明 deleteVerifiedBy=absence-recheck 与替代证据；否则维持 PARTIAL_RENAME。
- 真机闭环（scripts/rename-controlled-real-dev-smoke.mjs，注册 test:rename-controlled-real-dev，7 断言全 PASS、SMOKE OK、零 PARTIAL）：ZVRENOLD6375 → preview 冻结 → 单确认两步 apply → 新对象 readback 逐字一致 → 旧对象 absence → 新对象清理零残留 → plan SUCCEEDED。
- 本地门禁全绿：Jest 159 suites / 1526 tests（重命名 16 例 + 克隆 ReadCloneSource status 透传）、build、coverage、parity、diff --check。
- 矩阵：refactor.rename PARTIAL → MCP_SUPERSET（evidence + real-dev-verified）。现状：MCP_SUPERSET=10、EQUIVALENT=41、PARTIAL=8、GAP=2、INTENTIONAL_RESTRICTION=10、UNVERIFIED=0，对齐 51/71。证据：docs/evidence/rename-controlled-real-dev-verified.md。
- 接线同步：ToolProfiles（workbench +3）+ ToolOperationPolicy（read-only +1/local +1/advanced-mutation +1/CONTROLLED_RENAME_TOOL_NAMES 专属门控 + 角色可见性）+ ToolCatalogIntegrity 计数（development=179、development-workbench=146）+ serverGuardrails（applyControlledRename/getControlledRenameStatus 确认型豁免）+ AGENTS.md 基线（159/1526，2026-09-22）。
- 遗留：无系统残留（两对象均 absence）。剩余 PARTIAL 8 行中可推进项：report.text-elements/i18n.write（文本池受控写入，复用 DescriptionApi 锁链）、recover-failed-create（语义边界）、diagnostics.knowledge-queries（S/2 集群解析器，工程轮）；GAP 2 行均写方向 RESTRICTION。受控写批次三连发完成（set-description → clone → rename），同一安全模型（immutable plan + 原生确认 + 单次执行 + readback/absence）已形成可复制模式。
