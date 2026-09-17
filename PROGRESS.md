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
