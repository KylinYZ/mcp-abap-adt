# Repository Validation Campaign Progress
- Target: SAP DEV client 300, package Z001, transport S4HK900009, prefix ZV.
- Scope: 31 explicit repository kinds; one preview and at most one apply per object.
- Confirmations: user authorized computer-use to inspect and click each native “确认创建” button.
- Completed: DDIC_DOMAIN ZVDOM = APPLIED and active verified.
- Completed with bounded issue: DATA_ELEMENT ZVDE1 = active verified; historical plan OUTCOME_UNKNOWN, no replay.
- Completed: DDIC_TABLE_TYPE ZVTT1 = APPLIED; independent active read matches CHAR(10), standard/nonUnique/notSpecified defaults.
- Completed: PROGRAM ZVPROG = APPLIED; independent SAP source read matches the confirmed REPORT.
- DDIC_TYPE_GROUP ZVTG1 = OUTCOME_UNKNOWN; object exists and is readable active/inactive, but SAP source only contains TYPE-POOL declaration, not planned TYPES; no replay/delete.
- NUMBER_RANGE_OBJECT ZVNRO1 = APPLIED; independent search and JSON source read match ZVDOM, warning 10, no prefix/rolling, no buffering.
- SAP_OBJECT_TYPE ZVOBJECTTYPE = OUTCOME_UNKNOWN before shell stage; independent search absent, structure import failed; no replay/delete, issue `REMOTE_UNKNOWN-011`.
- ABAP_INTERFACE ZVIF_CAMPAIGN = OUTCOME_UNKNOWN at shell response; independent search/active structure prove object exists; no replay/delete, issue `REMOTE_UNKNOWN-012`.
- ABAP_CLASS ZVCL_CAMPAIGN = OUTCOME_UNKNOWN at shell response; independent search proves active shell exists, structure import fails; no replay/delete, issue `REMOTE_UNKNOWN-013`.
- MESSAGE_CLASS ZVMSG = COMPENSATION_FAILED because SAP reports user 068157 is editing the object; active shell/source exists. Activity paused for shared-lock risk, issue `REMOTE_UNKNOWN-014`.
- CDS_ASPECT ZVASPECT = APPLIED; independent search/source read match the confirmed aspect.
- CDS_ANNOTATION_DEFINITION ZVANNO1 = TARGET_UNAVAILABLE/authorization rejection before shell; search absent, no mutation, issue `TARGET_UNAVAILABLE-016`.
- PACKAGE ZVPKG = OUTCOME_UNKNOWN before shell; SAP rejected responsible user input, search absent, no replay/delete, issue `LOCAL_VALIDATION-017`.
- CDS_TYPE ZVCDSTYPE = confirmation approval timeout; plan remains PREVIEWED, search absent, no mutation, plan not reused.
- PROGRAM_INCLUDE ZVINCL = OUTCOME_UNKNOWN at shell response; active shell exists with SAP-generated header source only; no replay/delete, issue `REMOTE_UNKNOWN-015`.
- FUNCTION_GROUP ZVFG1 + ZVFM0 = COMPENSATED after active source mismatch; independent searches confirm both absent.
- DDIC_STRUCTURE ZVSTR1 = shell-only readback after source write rejection; unlocked, no replay/delete, issue `REMOTE_UNKNOWN-009`.
- DATABASE_TABLE ZVTAB1 = confirmation declined; independent search confirms absent, no mutation, plan not reused.
- Computer-use automation is blocked by desktop-session isolation; even an independent EXE probe was not enumerable. No probe residue remains.
- Next: continue read-only schema/preview checks; real apply requires human click or another targetable trusted host channel.
- Preflight: all 29 planned remaining repository identities are absent; completed `ZVDOM`/`ZVDE1` are present in `Z001` as expected.
- Preview-ready without apply: `ZVTT1`, `ZVPROG`, `ZVFG1` + `ZVFM0`, `ZVSTR1`, `ZVTAB1`, `ZVTG1`, `ZVNRO1`, `ZVOBJECTTYPE`, `ZVIF_CAMPAIGN`, `ZVCL_CAMPAIGN`.
- Root causes proven with temporary candidate patches: message whitelist/empty validation, logical schema ASX, source-object ASX, package discovery constraints.
- Expanded scope granted; message, package, logical schema, and source validation fixes are implemented and independently preview-verified.
- Preflight summary: 10 remaining kinds preview-ready, 7 kinds have bounded local/target issues, 12 kinds wait on campaign parent dependencies.
- User will manually click each native confirmation; one MCP restart is now required to load the batch fixes.
- Goal resumed; after restart continue new plans only, starting with `DDIC_TABLE_TYPE ZVTT1`.
- Activity is paused: do not continue apply until the ZVMSG editing/lock state is independently cleared and reviewed.
- Stop only for unbounded remote outcome, retained lock, shared session, or transport risk.
- Baseline: 106 suites / 687 tests; controlled 31, pending 111, REAL_DEV_VERIFIED 0.

## 2026-08-24 集中修复轮次

- 失败归类已由三个子智能体并行完成：MESSAGE_CLASS 补偿锁泄漏、shell `201 + Location + empty body` 响应契约、PACKAGE 负责人参数与 SAP_OBJECT_TYPE Blue 响应解析。
- `MESSAGE_CLASS`：补偿 DELETE 失败时兜底释放本次取得的锁；DELETE 成功不再对已删除 URL 发 UNLOCK；保留原始补偿错误，不把未知结果改成成功。
- `SAP_OBJECT_TYPE`、源码对象、DDIC type group、DDIC structure：先严格验证 HTTP 201 与 canonical Location；只有空 body 才使用计划身份，非空 body 继续做身份校验。
- `AxiosHttpClient`：修正 plain-object response headers 遍历，保留 `Location` 等 ADT 创建响应头，并增加回归覆盖。
- `PACKAGE`：父包负责人为系统值 `SAP` 时在 preview 阶段拒绝，不猜测可接受用户；仍需 SAP 权威负责人发现契约后才能创建 PACKAGE。
- 本轮本地验证：106 suites / 696 tests、`npm run build`、`npm run check:repository-creation-coverage`、`git diff --check` 全部通过；未调用真实 SAP，未重放历史计划，未删除对象。
- 下一步：重启 MCP 使 `dist` 与宿主加载修复；使用全新、从未尝试的身份做一次独立 preview/apply。`ZVMSG`、`ZVOBJECTTYPE`、`ZVINCL`、`ZVTG1`、`ZVSTR1` 等历史计划和身份均不得重放。

## 2026-08-24 SAP_OBJECT_TYPE 修复后首轮真实复测

- 重启后 healthcheck 确认 DEV/client 300/development；`RONT/ROT ZVOBJECTTYPE2` 预检为空。
- 全新计划 `fa176dd5-9fd7-4e7c-82d3-12af0190f68c` 经原生弹窗确认后进入 apply，证明确认回传链路正常。
- Apply 在 Blue shell POST 阶段返回 `OUTCOME_UNKNOWN`：SAP 报 base64 前缀 `eyJuYW1lIj...` XML value parse error；计划未重放、未补偿。
- 独立 search 为空，active structure 读取失败，未证明任何 SAP 对象或可见 mutation；历史计划继续保留终态。
- 本机 ADT 3.60.2 EMF 权威序列化证明 `<adtcore:content>` 必须使用 `adtcore:encoding` 与 `adtcore:type`；旧 builder 错用了无命名空间属性，导致 SAP 未解码 base64。
- RONT/NONT builder 与反例测试已修复；本地门禁为 106 suites / 697 tests、build、coverage manifest 31/111/0、diff check 全通过。
- 需要再次重启后，以第三个全新身份和全新 plan 复测；`fa176dd5-...` 与 `ZVOBJECTTYPE2` 均不得重放。

## 2026-08-24 SAP_OBJECT_TYPE 第三身份复测未加载新进程

- 用户报告重启后，healthcheck 仍显示 stateful session 已连续存活约 1207 秒，证明 `sap-dev` MCP 子进程/连接没有重建。
- `dist/adt/api/sapObjectTypeCreation.js` 已包含 `adtcore:encoding` 与 `adtcore:type`，`config.toml` 也指向当前仓库 `dist/index.js`；磁盘构建与配置路径正确。
- 旧进程生成的新计划 `c235448a-ebc9-46cb-bb36-2f99364a246e` 仍发出旧 XML，并得到相同 base64 parse error；`ZVOBJECTTYPE3` 独立 search 为空，无可见 mutation。
- 该计划和身份均终止且不得重放。下一次尝试前必须确认 healthcheck 的 session age/generation 已重置或旧计划已不在新进程内存中。

## 2026-08-24 SAP_OBJECT_TYPE 第四身份真实复测

- 硬重启验收通过：healthcheck 为 disconnected/generation 0，旧计划返回 `PLAN_NOT_FOUND`。
- 全新计划 `c500e56d-9c13-4cdc-86f4-7110f5a225a5` 经原生弹窗确认后成功完成 `CREATE_OBJECT`，canonical Location 为 `/sap/bc/adt/businessobjects/rontrot/zvobjecttype4`。
- 这证明 Blue additional-content `adtcore:encoding`/`adtcore:type` 修复在真实 DEV 生效。
- Inactive JSON 复读被本地 parser 拒绝；workflow 随后锁定并成功删除 owned shell，计划终态 `COMPENSATED`。
- 独立 `RONT/ROT ZVOBJECTTYPE4` search 为空，确认无残留对象。该身份和计划不得重放。
- 当前根因进一步缩小为 verifier 时序：SAP 生成字段 `objectTypeCode` 在 inactive 阶段可缺失，本地 parser/adapter 却在激活前强制要求存在；正在按 inactive 可缺失、active 必须存在的规则修复。
- Verifier 已修复：inactive 缺失 code 合法，inactive 已有 code 必须合法且 active 保持一致，active 必须最终生成 1-5 字符 code；其他字段仍严格比较。
- 本轮本地门禁：106 suites / 699 tests、build、coverage manifest 31/111/0、diff check 全通过。需再次硬重启加载 parser 后使用第五个全新身份复测。

## 2026-08-25 SAP_OBJECT_TYPE 第五身份真实复测

- 硬重启验收通过；全新计划 `63167202-a21b-40f6-84de-26b63692970e` 创建 `ZVOBJECTTYPE5`。
- 真实阶段已通过：`CREATE_OBJECT`、`VERIFY_INACTIVE_OBJECT`、`VERIFY_INACTIVE_CONTENT`、`ACTIVATE_OBJECT`。
- Active content compare 因仍强制 `objectTypeCode` 存在而失败；owned object 随后成功补偿，计划终态 `COMPENSATED`，独立 search 为空。
- DEV 只读样本证明 active RONT 的 `objectTypeCode` 也可合法缺失，例如 `AccessControlList`、`AccountingActivityAllocation`、`AccountingClerk`；存在时仍是 1-5 字符。
- 最终 verifier 契约：inactive/active 均允许缺失；任一阶段存在时严格校验；inactive 已有值时 active 必须保留；其他字段不放宽。
- 本轮门禁：106 suites / 700 tests、build、coverage manifest 31/111/0、diff check 全通过。需硬重启后以第六个全新身份完成最终 RONT 验收。

## 2026-08-25 SAP_OBJECT_TYPE 最终真实验收

- 第六计划 `2596338a-e1d9-48fd-8393-b558afbe1f5d` 因原生确认超时保持 `PREVIEWED`，`ZVOBJECTTYPE6` search 为空；计划与身份均不复用。
- 第七个全新计划 `be766b83-ed0a-46ed-943b-8ba18623d6f5` 创建 `ZvObjectType7` / `ZVOBJECTTYPE7`，终态 `APPLIED`。
- 全部阶段成功：absence、contract、transport、Blue shell、inactive structure/content、activation、active structure/content。
- 独立 search 命中包 `Z001`；active structure 为 `RONT/ROT`、`active`、描述 `MCP SAP Object Type 7`；active JSON 为 `technicalObject`、`ZvObjectType7`、原始语言 `zh`，合法省略 optional `objectTypeCode`。
- RONT 创建侧真实验证完成；未执行清理，成熟度和 `REAL_DEV_VERIFIED=0` 不变。`ZVOBJECTTYPE7` 不得用于重复创建，但可作为后续 NONT 依赖的 active 父对象。

## 2026-08-25 SAP_OBJECT_NODE_TYPE 真实验收

- 初始 `ZvNodeType7` root-node preview 被 SAP validation 明确拒绝：root node 语义名必须与父 RONT 一致；无计划、无 mutation。
- 使用父语义名 `ZvObjectType7` 生成全新计划 `3d7f2827-1bab-4e7b-97c9-c5365770852d`，目标为独立 ADT 类型 `NONT/NOT`、仓库名 `ZVOBJECTTYPE7`。
- 计划终态 `APPLIED`；absence、父引用、contract、transport、Blue shell、inactive/active JSON、activation 全部成功。
- 独立 search 命中 `NONT/NOT ZVOBJECTTYPE7`；active structure 位于 `Z001`，active JSON 的 `name`/`sapObjectType` 均为 `ZvObjectType7`，`rootNode=true`，描述和原始语言与计划一致。
- NONT 创建侧真实验证完成；未执行清理，成熟度、`writable=false` 与 `REAL_DEV_VERIFIED=0` 保持不变。

## 2026-08-25 独立类型首批复测

- `LOGICAL_EXTERNAL_SCHEMA ZVSCHEMA2`：plan `ac26786c-5208-49b5-b70d-41ffdb273b54` 完成 shell 创建后，source link 媒体类型被本地 verifier 拒绝；补偿成功，独立 search 为空。
- `CDS_TYPE ZVCDSTYPE2`：plan `09f0ee65-00d0-4122-ba21-a42b9ab34032` 终态 `APPLIED`；shell、source write、checks、unlock、activation、active structure 和 EXACT source compare 全部成功，独立复读一致。
- `ABAP_INTERFACE ZVIF2`：plan `330631b0-ee6e-47fc-ae41-e4d181aebebc` 在 shell Location 判断进入 `OUTCOME_UNKNOWN`；独立 search/active structure 证明 active 空壳存在，源码未包含计划中的 `METHODS ping`。不重放、不删除。
- `DDIC_TYPE_GROUP ZVTG2`：plan `c5666a0a-a2b5-4c3c-b5c7-5fe185f32805` 同样在 shell Location 判断进入 `OUTCOME_UNKNOWN`；active source 仅 `TYPE-POOL zvtg2.`，计划 `TYPES` 未写入。不重放、不删除。
- `MESSAGE_CLASS ZVMSG2`：plan `d847ced9-1612-4b23-994e-0a966df7fc73` 在 shell resolve 后、显式 lock stage 前即出现“使用者 068157 当前编辑”，补偿再次 lock 失败；active shell 存在但无 message 001。活动因共享锁风险暂停。
- 已停止真实 apply；集中排查 DESD source媒体类型、source/type-group Location规范化、Message Class shell隐式锁三条链路。
- 集中修复完成：
  - Source/Type Group/Structure 共用严格 Location helper，支持 HTTP(S) 绝对、协议相对和相对 URL，最终 pathname 必须等于 canonical ADT path；拒绝 Content-Location、多值和非 HTTP scheme。
  - DESD source link 严格使用 `application/json`（仅允许可选 UTF-8 charset）；不再误用 `$schema` 的 vendor media type。
  - Message Class shell 创建改用专用 stateless clone，匹配 Eclipse ADT 3.60.2；主 stateful/enqueue session 不切换、不 drop、不重试。
- 全量门禁：106 suites / 711 tests、build、coverage manifest 31/111/0、diff check 全通过。等待一次硬重启后，用全新 DESD、Interface/Type Group 和 Message Class 身份集中复测。

## 2026-08-25 集中修复后复测

- 硬重启验收通过；历史 Message Class/Type Group 计划均 `PLAN_NOT_FOUND`。
- `LOGICAL_EXTERNAL_SCHEMA ZVSCHEMA3`：新媒体类型契约生效，shell 与 source resolve 成功；随后 JSON 内容 verifier 失败，补偿成功、search 为空。
- `ABAP_INTERFACE ZVIF3`：安全诊断确认 SAP 返回 `HTTP 200` 且无 `Location`；独立读取证明 active 空壳存在，计划源码未写。没有重试或删除。
- `MESSAGE_CLASS ZVMSG3`：stateless shell 修复真实生效，完整 `APPLIED`；message 001、lock/unlock、activation、active source 与独立 search 全部成功。
- 当前停止真实 apply；下一轮只处理 DESD JSON 形状和 source shell 200/no-Location 契约。

## 2026-08-25 第二轮复测结论

- `LOGICAL_EXTERNAL_SCHEMA ZVSCHEMA3` plan `da4de4d3-6a8f-4823-b927-1bd4acfbf991`：媒体类型与 source resolve 修复已生效；SAP 合法省略 `abapLanguageVersion` 和整个 `generalInformation`，旧 verifier 误判。补偿成功、search 为空；parser/adapter 已按真实样本修复，存在字段仍严格比较。
- `ABAP_INTERFACE ZVIF3` plan `195379f5-cb0e-4d2d-9dc3-17f33bb39877`：新 helper 安全报告 `status 200; Location path [missing]`；独立读取证明 active 空壳存在，计划源码未写。不重放、不删除。
- `MESSAGE_CLASS ZVMSG3` plan `c9f665b5-7f1a-42b1-b914-92fe6baf0262`：stateless 创建真实成功，完整 `APPLIED`；message 001、lock/unlock、activation、active source 和 search 全部通过。
- 当前停止真实 apply；下一步只安排 DESD 新身份回归，Source shell 继续保留为未解决协议问题，避免制造更多空壳。

## 2026-08-25 LOGICAL_EXTERNAL_SCHEMA 最终验收

- 硬重启通过；全新 plan `69f4988d-444b-408b-a003-349f8d70a596` 创建 `ZVSCHEMA4`，终态 `APPLIED`。
- schema、transport、shell、source resolve、lock、JSON write/readback、unlock、activation、active structure/content 全阶段成功。
- 独立 search 命中 `DESD/TYP ZVSCHEMA4`；active JSON 的 `defaultRemoteSchemaName=MCP_REMOTE_SCHEMA_4`，描述、原始语言和 package 均与计划一致。
- DESD 创建侧真实验证完成；未清理、不释放传输、不提升 `REAL_DEV_VERIFIED`。

## 2026-08-25 DATABASE_TABLE 依赖链尝试

- `ZVTAB2` 以 `MANDT : abap.clnt` 和 `ID : ZVDE1` 生成最小透明表；plan `237c63bd-9efa-44ed-810c-6f4de084314a`。
- shell、两轮 table checks、source write、unlock 和 table activation 全部成功；active source 字节比较失败后，owned table 补偿成功，独立 search 为空。
- 标准表 active DDL 证明 SAP 会对齐字段空白；当前 table adapter 错用字节级 source compare。正在增加仅忽略字符串/注释外无语义空白的保守 DDL token 比较，类型、key、annotation、literal 和顺序仍必须完全一致。
- Database Table 未通过前，Lock Object 和 CDS/RAP 依赖链继续 blocked；旧计划不重放。
- Table adapter 已增加专属严格 DDL tokenizer：exact/CRLF 优先，fallback 仅忽略字符串/注释外空白；类型、key、annotation、literal、identifier boundary 和 token 顺序变化均拒绝。
- 全量门禁：106 suites / 719 tests、build、coverage manifest 31/111/0、diff check 全通过。等待硬重启后以 `ZVTAB3` 新身份复测。

## 2026-08-25 Database Table 最终停止结论

- 硬重启后 `ZVTAB3` 使用 `abap.clnt`、`ZVTAB4` 改用字典类型 `MANDT`；两者均通过 shell、checks、source write、unlock 和 activation，随后在严格 DDL token compare 失败并成功补偿。
- 独立 searches 均为空，无表残留。差异已证明不只是字段空白，也不只是 `CLNT`/`MANDT` 选择；缺少补偿前 active source 证据，不能继续放宽 verifier。
- Database Table 已达到连续三次同类失败阈值，停止该类型。Lock Object、CDS root、DCL、Metadata Extension、Service Definition、Behavior Definition、Entity Buffer、Service Binding 和 Change Document Object 均记 `DEPENDENCY_MISSING`。
- 31 类现在均有明确创建侧结果：10 类 `APPLIED_ACTIVE_VERIFIED`、1 类 `ACTIVE_READBACK_ONLY`、5 类 active shell-only/unknown、2 类 compensated、2 类 target/local unavailable、11 类 dependency missing。
- 活动保持零盲目重放；现有成功对象未清理，传输未释放，成熟度和 `REAL_DEV_VERIFIED=0` 不变。
