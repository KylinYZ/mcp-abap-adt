# Repository Validation Campaign Progress

## 日常开发优先级速览
> 说明：按日常 ABAP 开发出现频率排序；状态按当前文档中记录的最新验证结果归类。
>
> - 已实现：已完成真实 DEV 生命周期验证，可在 DEV 写入
> - 已实现，待真实 DEV 验证：创建链路及自动化验证已完成，但尚未具备完整的真实 DEV 证据，因此保持不可写
> - 已实现，受目标阻塞：创建链路及自动化验证已完成，但目标 SAP 权限或能力未满足，保持不可写
>
> 2026-09-04 已按 maturity evidence 校正：PACKAGE/ABAP_CLASS/ABAP_INTERFACE/DDIC_STRUCTURE/FUNCTION_GROUP_INCLUDE/DDIC_TYPE_GROUP/PROGRAM_INCLUDE/DATABASE_TABLE 已是 REAL_DEV_VERIFIED。历史身份 ZVPKG、ZVCL_CAMPAIGN、ZVPCL01 不得重放。当前下一个日常 P3 处理对象是 CDS_ANNOTATION_DEFINITION。

| 优先级 | 对象 | 状态 |
| --- | --- | --- |
| P1 | PACKAGE | 已实现 |
| P1 | PROGRAM | 已实现 |
| P1 | DDIC_DOMAIN / DATA_ELEMENT / DDIC_TABLE_TYPE | 已实现 |
| P1 | ABAP_CLASS | 已实现 |
| P1 | ABAP_INTERFACE | 已实现 |
| P1 | DDIC_STRUCTURE | 已实现 |
| P2 | FUNCTION_GROUP | 已实现 |
| P2 | FUNCTION_MODULE | 已实现 |
| P2 | FUNCTION_GROUP_INCLUDE | 已实现 |
| P2 | MESSAGE_CLASS | 已实现 |
| P2 | CDS_TYPE / CDS_ASPECT / LOGICAL_EXTERNAL_SCHEMA | 已实现 |
| P2 | NUMBER_RANGE_OBJECT | 已实现 |
| P3 | SAP_OBJECT_TYPE | 已实现 |
| P3 | DDIC_TYPE_GROUP | 已实现 |
| P3 | PROGRAM_INCLUDE | 已实现 |
| P3 | CDS_ANNOTATION_DEFINITION | 已实现，受目标权限阻塞 |
| P3 | DATABASE_TABLE | 已实现 |

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

## 2026-08-25 产品化阶段 0-2

- 阶段 0 冻结现场：DEV/client 300、development、31 类、`ZV`、`Z001`、`S4HK900009` 全部复核；历史成功对象存在，已补偿表/函数组缺失。`DDIC_STRUCTURE ZVSTR1` 的真实结构版本为 `new`，不是 active。
- 阶段 1 增加仅 `SAP_MCP_REAL_DEV_VALIDATION=true` 可见的 cleanup preview/apply/status；对象 URL、包、传输、子对象和删除顺序均由服务端冻结，创建与删除使用各自独立原生确认，未知删除结果停止且不重试。
- 修复 `FUNCTION_GROUP_INCLUDE` cleanup 未冻结父组的问题：`parentName` 同时参与 preview、计划绑定、apply 再校验和真实包/传输限制。
- 阶段 2 增加 `docs/evidence/repository-creation-maturity-evidence.json`，冻结现有历史 `OUTCOME_UNKNOWN` / `COMPENSATION_FAILED` 身份；Registry 和覆盖脚本同时要求 create、readback、transport、cleanup、absence 五类完整证据。
- 本轮本地门禁：109 suites / 742 tests、build、coverage 31/111/0、`git diff --check`；`npm pack --dry-run` 确认 maturity manifest 随 npm 包分发。
- 尚未硬重启当前 `sap-dev` MCP，尚未执行真实 SAP 创建、删除或 cleanup；现有对象与历史计划均未触碰，`REAL_DEV_VERIFIED=0` 保持不变。
- 独立新进程 runtime smoke 已通过：三个 cleanup 工具可见，目标为 DEV/client 300，session 从 disconnected/generation 0 启动，历史 creation/cleanup plan 均返回 `PLAN_NOT_FOUND`。桌面宿主仍需由用户手动硬重启后复核。

## 2026-08-25 Wave 1 DDIC Domain 首轮产品化闭环

- 用户手动硬重启后，healthcheck 为 DEV/client 300/development、disconnected/generation 0；旧 creation/cleanup plan 均返回 `PLAN_NOT_FOUND`，三个 validation-only cleanup 工具已实际加载。
- 全新 `DDIC_DOMAIN ZVPD01` 创建 plan `78f7ccbe-7bfb-4dab-8c2d-41e640ce082b` 经独立原生确认后终态 `APPLIED`；active 复读为 `CHAR(10)`，包 `Z001`，CTS 请求 `S4HK900009`。
- 独立 cleanup plan `c60f0f60-2107-4f59-99e4-cb551da2fe7e` 经单独“确认删除”后成功删除对象，`OBJECT_DELETED` 与 `ABSENCE_VERIFIED` 均成功；search 已确认 `DOMA/DD ZVPD01` 缺失。
- 只读 `E071` 证明确切 CTS task `S4HK900010` 保留 `R3TR/DOMA/ZVPD01`。该条目是把删除传递到下游系统所需的正常记录；旧 cleanup verifier 误要求零条目，因此历史 cleanup plan 终态为 `FAILED`，不可重放，身份 `ZVPD01` 不得复用。
- 用户已批准修正为：对象 search 缺失且固定传输中恰好保留唯一匹配 CTS 删除条目；禁止删除 E071、删除/释放传输或使用原始 transport mutation。

## 2026-08-25 DDIC_DOMAIN 首类正式晋级

- 修复并再次硬重启后，全新 `DDIC_DOMAIN ZVPD02` 创建 plan `8d7a45af-d3c5-49f6-aa54-b95fb49c5bbe` 经原生确认终态 `APPLIED`。
- 独立 active 复读确认包 `Z001`、`CHAR(10)`、输出长度 10 和四项布尔默认值；创建时 `transportInfo` 与 E071 精确归属 `S4HK900009` / `S4HK900010`、`R3TR/DOMA/ZVPD02`。
- 独立 cleanup plan `58b2874c-bc07-4ada-bbeb-4874fb5920ef` 经单独原生删除确认终态 `COMPLETED`；`OBJECT_DELETED`、`ABSENCE_VERIFIED`、`TRANSPORT_DELETION_ENTRY_VERIFIED` 全部成功。
- cleanup 后独立 search 返回 0 行，E071 恰好保留唯一 `R3TR/DOMA/ZVPD02` 删除传输条目；没有修改 E071、删除/释放传输或触碰历史对象。
- 完整证据写入 `docs/evidence/repository-creation-ddic-domain-real-dev-verified.md` 与 maturity manifest；仅 `DDIC_DOMAIN` 晋级 `REAL_DEV_VERIFIED`，其余 30 类保持原成熟度。
- 关闭 validation 的独立新进程验收通过：cleanup 工具隐藏、唯一 writable kind 为 `DDIC_DOMAIN`、全新缺失身份可生成正常 PREVIEWED plan，且未调用 apply 或 SAP mutation。
- 本轮全量门禁：109 suites / 742 tests、build、coverage controlled 31 / pending 111 / `REAL_DEV_VERIFIED=1`、runtime smoke、npm dry-run 和 `git diff --check` 全部通过。

## 2026-08-26 DATA_ELEMENT 正式晋级

- 硬重启加载 `DDIC_DOMAIN REAL_DEV_VERIFIED` 后，确认 session 为 disconnected/generation 0、旧计划均 `PLAN_NOT_FOUND`，唯一 writable kind 为 `DDIC_DOMAIN`。
- 全新 `DATA_ELEMENT ZVPDE01` 创建 plan `dd512e12-1155-47b8-8180-1ae1e1aa816b` 经原生确认终态 `APPLIED`；依赖 `ZVDOM` active `CHAR(10)`。
- active 复读确认 Domain、四级标签、SAP 默认标签长度 `10/20/40/55` 以及四个默认 `false`；创建传输为 `S4HK900009` / task `S4HK900010`，E071 唯一 `R3TR/DTEL/ZVPDE01`。
- cleanup plan `86dd48c9-e559-4ec4-b999-d9e8f77e8562` 经独立原生确认终态 `COMPLETED`；对象缺失且唯一 CTS 删除条目保留，依赖 Domain 未被修改或删除。
- 完整证据写入 `docs/evidence/repository-creation-data-element-real-dev-verified.md` 与 maturity manifest；`DATA_ELEMENT` 晋级，coverage 变为 controlled 31 / pending 111 / `REAL_DEV_VERIFIED=2`。

## 2026-08-26 DDIC_TABLE_TYPE 正式晋级

- 硬重启加载前两类成熟度后，确认唯一 writable kinds 为 `DATA_ELEMENT`、`DDIC_DOMAIN`，旧 Data Element 计划均 `PLAN_NOT_FOUND`。
- 全新 `DDIC_TABLE_TYPE ZVPTT01` 创建 plan `2073e8d7-b6fc-4ffe-bd79-52aad87987bd` 经原生确认终态 `APPLIED`；结构化属性为 `CHAR(10)`、standard access、standard/nonUnique primary key、secondary keys `notSpecified`。
- 独立 active structure 返回 `TTYP/DA`、`active`、包 `Z001`；创建 CTS 为 `S4HK900009` / task `S4HK900010`，E071 唯一 `R3TR/TTYP/ZVPTT01`。
- cleanup plan `f0ae2008-44c5-4dce-a32d-cd506cb403e0` 经独立原生确认终态 `COMPLETED`；对象缺失且唯一 CTS 删除条目保留。
- 完整证据写入 `docs/evidence/repository-creation-table-type-real-dev-verified.md` 与 maturity manifest；coverage 变为 controlled 31 / pending 111 / `REAL_DEV_VERIFIED=3`。

## 2026-08-26 Wave 1 剩余类型批量晋级

- 按“减少重启”策略，在同一已加载 validation runtime 中连续验证，期间未修改源码、配置、manifest 或构建输出。
- `PROGRAM ZVPPG01`、`MESSAGE_CLASS ZVPMSG01/001`、`LOGICAL_EXTERNAL_SCHEMA ZVPSCH01`、`NUMBER_RANGE_OBJECT ZVPNR01`、`CDS_TYPE ZVPCTYPE01`、`CDS_ASPECT ZVPCASP01` 均完成创建 `APPLIED`、active 独立复读、CTS/E071 归属、独立 cleanup `COMPLETED`、search 缺失和唯一 CTS 删除条目复查。
- `SAP_OBJECT_TYPE ZvProdType01/ZVPRODTYPE01` 与同语义名 root `SAP_OBJECT_NODE_TYPE` 均创建 `APPLIED`；组合 cleanup plan `cce682a8-e245-4da6-94e4-86410add0a9c` 严格按 NONT → RONT 清理，两类 search 均缺失且两条 CTS 删除记录保留。
- 完整运行证据汇总至 `docs/evidence/repository-creation-wave1-batch-real-dev-verified.md`；本批 8 类与此前 3 类共同使 Wave 1 达到 `REAL_DEV_VERIFIED=11`。

## 2026-08-26 Wave 2 第一批协议修复

- Source Object / Type Group：HTTP 201 仍必须 canonical Location；仅 HTTP 200 + no Location + empty body 可进入 ownership proof。服务端要求 pre-absence、唯一精确 search URI/包、active identity/description/current user/master language/system、CTS object identity 和目标 transport 全部匹配后才记录 ownership 和写源码；失败保持 `OUTCOME_UNKNOWN` 且不补偿。
- Database Table：严格 tokenizer 判失败时记录双方 source hash、token 数量、首个 mismatch 索引和两侧 token kind，不记录 token 值或源码。
- Function Group/Module：源码不匹配时记录双方 hash、行数、首个差异行号、行字节数和行 hash，不记录源码行。
- Package：父包 `responsible=SAP` 时改用当前认证 `SafetyPolicy.sapUser`，并继续通过 SAP basic/full validation 与 constraints 失败关闭；调用方不能指定 responsible。
- DDIC Structure：在取得 shell source URL 后、加锁/PUT 前先运行 candidate syntax check；失败时不写计划源码，现有 post-write check 保留。
- 本轮仅修改代码并完成 109 suites / 749 tests、build、coverage 31/111/11、关闭 validation 的 11 类可写 preview、runtime smoke 和 `git diff --check`；尚未加载到桌面 MCP，也未执行 Wave 2 真实 SAP mutation。

## 2026-08-26 Wave 2 首批真实晋级

- `PACKAGE ZVPKG2`、`ABAP_INTERFACE ZVPIF04`、`DDIC_TYPE_GROUP ZVTG5` 均完成 create → active readback → cleanup → absence → 唯一 CTS deletion-entry verification，成熟度晋级为 `REAL_DEV_VERIFIED`。
- `DATABASE_TABLE ZVPTAB01` 创建、active source、技术设置和空表检查成功；获授权删除后对象缺失，但 CTS 同任务保留两条重复 `R3TR/TABL` 与一条 `LIMU/TABT`，故不晋级且不修改 E071。
- `DDIC_STRUCTURE ZVPSTR02` 激活后 source mismatch 并已补偿；`ABAP_CLASS ZVPCL01`、`PROGRAM_INCLUDE ZVPINC01` 的新身份结果未知，均不得重放。
- 源码所有权修复：父包 `SAP` 主系统允许 SAP 规范化为实际系统 ID；Include 描述可由精确 search 证据补足；Type Group 声明要求对象名前缀；Structure DDL 补齐 `AbapCatalog.enhancement.category`。
- 完整证据写入 `docs/evidence/repository-creation-wave2-package-interface-typegroup-real-dev-verified.md`；定向 34 tests、build、coverage controlled 31 / pending 111 / `REAL_DEV_VERIFIED=14` 和 `git diff --check` 通过。
- `PROGRAM_INCLUDE ZVPINC02` 已完成 create → active readback → cleanup → absence → 唯一 CTS deletion-entry verification，成熟度提升至 `REAL_DEV_VERIFIED=15`；active metadata 缺失 description 时由精确 search 证据补足。
- 当前 Wave 2 未晋级项：`DATABASE_TABLE ZVPTAB01` CTS 重复、`DDIC_STRUCTURE ZVPSTR02` source mismatch 后补偿、`ABAP_CLASS ZVPCL01` source range 不可读；不得重放历史计划。
- `FUNCTION_GROUP ZVPFG2 + ZVPFM2` 新身份真实尝试仍因 active function-module source mismatch 补偿，独立 search 确认两者均缺失；本轮不重试，成熟度保持 `AUTOMATION_VERIFIED`。
- `DATABASE_TABLE ZVPTAB02` 创建、active DDL、技术设置、CTS 和空表验证成功；cleanup plan `949a40bd-a5af-4d6b-b724-da5c7fa9e3be` 终态 `COMPLETED`，对象缺失且唯一 `tm:obj_func=D` 删除传播条目保留。
- 数据库表 CTS 根因已修复：创建条目和 `LIMU/TABT` 技术属性条目不再计入 deletion-entry 数量；`DATABASE_TABLE` 晋级后总成熟度为 `REAL_DEV_VERIFIED=16`。
- 阶段 5 已开始：数据库表之后进入 `DDIC_LOCK_OBJECT`。目标锁对象验证端点实际要求 `Accept: application/vnd.sap.as+xml`，已修复并完成全量 109 suites / 753 tests、build、coverage；原 `lockobjects.v1+xml` 会被 SAP 拒绝。
- `ZVPTAB03` 仅完成预检，因 `DATABASE_TABLE` 已晋级而被 REAL_DEV validation plan 门禁拒绝，未创建。下一次重启后使用现有 active SAP 标准表 `T000` 作为只读主表依赖，预检全新 `DDIC_LOCK_OBJECT ZVLOCK2`。

## 2026-08-28 DDIC_LOCK_OBJECT 协议修复

- `ZVLOCK2` 计划 `581beb32-1cc6-46aa-9c4c-6cf94ab24b4c` 通过 absence、`T000` 引用和传输复核，但创建返回 `SAP 对象 ENQU ZVLOCK2 无法被分配到包 Z001`，终态 `OUTCOME_UNKNOWN`；独立 search/structure 确认对象不存在，计划和身份不得重放。
- 只读 `transportInfo` 对比直接证明：`ZVLOCK2` 无法分配，`EZVLOCK2` 在相同包/操作下返回 `RESULT=S` 和目标传输；ENQU 技术名称必须以 `E` 开头。
- 已修复 Lock Object 适配器、validation create/apply 门禁和 cleanup 门禁：普通客户命名采用 `E + 配置前缀`，安全 namespace 校验剥离技术 `E` 后仍必须命中客户 namespace；其他对象不放宽。
- 定向 21 tests、全量 109 suites / 756 tests、build、coverage 和 `git diff --check` 通过。需重启后使用全新 `EZVLOCK3`、主表 `T000` 完成真实生命周期。
- 重启后 `EZVLOCK3` 计划 `cfabe94f-e500-4982-92f0-136f6021804c` 通过 absence、`T000` 引用和传输复核，创建请求在 60 秒后超时并进入 `OUTCOME_UNKNOWN`。原 MCP stateful session 随后所有读取均超时；独立新 ADT 只读会话确认 `EZVLOCK3` search 为空，因此无对象可清理，但计划和身份仍不得重放。
- 进一步修复：Lock Object 适配器在普通客户 namespace 中先校验技术 `E`，再剥离 `E` 交给 SafetyPolicy 校验客户 `Z/Y` namespace；validation create/apply 与 cleanup 同步接受 `E + realDevValidationPrefix`。全量 109 suites / 756 tests 通过。
- 下一次重启使用第三个全新合法身份 `EZVLOCK4`、主表 `T000`；若仍在创建 POST 超时，则停止该类型并转为目标端长耗时/内容契约诊断，不继续制造身份。
- `EZVLOCK4` 计划 `73ad3c03-fbac-4474-99db-1130d2893f21` 再次在创建 POST 60 秒超时，终态 `OUTCOME_UNKNOWN`；独立新 ADT 只读会话确认 search 为空。按停止阈值，`DDIC_LOCK_OBJECT` 当前记目标长耗时/内容契约阻塞，不再创建第五个身份。
- 阶段 5 继续到不依赖 Lock Object 的 `CDS_DATA_DEFINITION` root；Lock Object 保持 `CONTROLLED_IMPLEMENTED`、`writable=false`。

## 2026-08-28 CDS_DATA_DEFINITION 媒体类型修复

- `ZVPCDS01` 计划 `d5720091-e070-457a-a98b-64407bae068e` 通过 absence 和 transport 后，shell POST 返回 `Unsupported Media Type`，终态 `OUTCOME_UNKNOWN`；独立 search 为空，传输分配正常，计划和身份不得重放。
- 目标 discovery 对 `/sap/bc/adt/ddic/ddl/sources` 不发布 accepted content types，OPTIONS/HEAD 也不提供媒体类型；当前固定 `application/vnd.sap.adt.ddlSource.v2+xml` 被真实目标拒绝。
- 仓库内置兼容创建器对同一 DDLS collection 使用 `application/*`。类型化 `CDS_DATA_DEFINITION` shell 已最小回退为 `Content-Type/Accept: application/*`，其他 CDS 类型不变。
- 需 build/restart 后用全新 `ZVPCDS02` 验证 root 生命周期。
- 重启后 `CDS_DATA_DEFINITION ZVPCDS02` 计划 `24f61425-c167-4d70-afec-9a4defc754f0` 终态 `APPLIED`；shell、source、checks、activation 和 active readback 全部成功。独立复读确认 active `DDLS/DF`、生成 `STOB/DO`、包 `Z001`、source 和 CTS。该 root 暂时保留给 DCL/MDE/SRVD/BDEF/Buffer 依赖，禁止提前 cleanup。
- 首个 `CDS_ACCESS_CONTROL ZVPDCL01` 仅在 preview 的 active 引用读取阶段失败，未生成计划、未写 SAP。目标 STOB search URI 为 `.../source/main#name=...`，不能直接传给 `objectStructure`。
- 已修复 STOB active 复核：冻结原始 fragment URI用于 apply 漂移校验，但读取结构时归一化为所属 DDLS 对象 URL；其他引用类型不变。全量 109 suites / 757 tests、build、coverage 和 `git diff --check` 通过。
- `CDS_ACCESS_CONTROL ZVPDCL01` 首次 apply 因 `pfcg_auth` 语法不符合目标 grammar 而补偿；现有 active DCL 样本确认最小合法语法为 `grant select on <entity>;`，未重放原身份。
- `CDS_METADATA_EXTENSION ZVPMDE01` 计划 `23b66141-cd46-4ebd-8a57-7a5fbe7be5c5` 在 shell POST 返回目标要求的根元素 `{http://www.sap.com/adt/ddic/ddlxsources}ddlxSource`，当前错误使用 Blue 根元素；计划终态 `OUTCOME_UNKNOWN`，未确认 ownership，不重试。
- 已修复 MDE shell/parser 使用 `ddlx:ddlxSource` 与 `http://www.sap.com/adt/ddic/ddlxsources`；需重启后用全新 `ZVPMDE02` 验证。
- 重启后 `CDS_DATA_DEFINITION ZVPCDS02` 已成功并保留；DCL `ZVPDCL01` 因 `pfcg_auth` 语法错误补偿，未重放。全新 `ZVPDCL02` 计划 `c40e0849-729e-4796-90f3-9160d5b93d09` 使用现有 active root `ZVPCDS02`，创建、检查、激活、active readback 和 CTS 全部成功，暂时保留等待依赖链逆序 cleanup。
- `CDS_METADATA_EXTENSION ZVPMDE01` 计划 `23b66141-cd46-4ebd-8a57-7a5fbe7be5c5` 在 shell POST 因 Blue 根元素错误进入 `OUTCOME_UNKNOWN`，未确认 ownership、未写源码、未清理；已加入不可复用清单。

## 2026-08-28 SERVICE_BINDING 协议修复

- 阶段 5 已推进至 `SERVICE_BINDING`；前置 active `SERVICE_DEFINITION ZVPSRV01` 已保留用于依赖链验证，尚未创建新的 Service Binding。
- 只读协议核对确认 `/sap/bc/adt/businessservices/bindings/validation` 的响应媒体类型应使用通用 `Accept: application/vnd.sap.as+xml`；创建端仍保持 `application/vnd.sap.adt.businessservices.servicebinding.v1+xml`。
- 已将验证请求切换为 `application/vnd.sap.as+xml`，并同步更新 ADT 契约测试；Service Binding 创建、配置复读、发布状态与 cleanup 逻辑未放宽。
- 本次修改后定向 11 tests、全量 109 suites / 757 tests、build、coverage（`REAL_DEV_VERIFIED=16`）、runtime smoke 和 `git diff --check` 均通过。
- 代码变更已完成，须硬重启 MCP 后使用全新身份（建议 `ZVPSVB01`）执行 preview → apply → active readback → CTS → cleanup；不得复用历史 Service Binding 身份或计划。

## 2026-08-28 SERVICE_BINDING 创建媒体类型取证

- 重启后 `ZVPSVB01` 预检成功，计划 `643bf06d-afff-43ad-ba5e-8761957680e1` 在原生确认后进入 `OUTCOME_UNKNOWN`；创建 POST 返回 `Unsupported Media Type`，未尝试重试或删除。
- 独立只读 search 确认 `SRVB/SVB ZVPSVB01` 不存在。目标 discovery 明确声明 `/sap/bc/adt/businessservices/bindings` 仅接受 `application/vnd.sap.adt.businessservices.servicebinding.v2+xml`（另有 JSON/text/html/text/plain），此前创建器错误使用 v1。
- 已将创建请求的 Content-Type/Accept 切换为 v2；验证端点继续使用 `application/vnd.sap.as+xml`。现有未知身份和计划均冻结，不得重放。
- 需再次硬重启后使用全新 Service Binding 身份继续验证，建议 `ZVPSVB02`；这是本次代码修改后的唯一必要重启。

## 2026-08-29 SERVICE_BINDING active 生命周期修复

- 重启后全新 `ZVPSVB02` 计划 `86bc12f7-bc39-430d-a069-473257c698bf` 使用 v2 创建成功，创建器原有配置复读通过。
- 独立 `objectStructure(active)` 证明对象实际仍为 `adtcore:version=inactive`、`srvb:bindingCreated=false`、`srvb:published=false`；对比现有成熟 Service Binding 证明应为 `active`、`bindingCreated=true`。原适配器遗漏标准 ADT activation，且错误将 inactive 配置复读视为完成。
- 经用户明确删除授权，cleanup 计划 `19d35a9f-a9cd-4c44-af45-ff580ad93034` 已完成 `OBJECT_DELETED` 与 `ABSENCE_VERIFIED`，独立 search 为空；CTS 仅保留唯一 `R3TR/SRVB/ZVPSVB02`，但 `OBJFUNC` 为空，未达到删除传播门禁，因此计划终态 `FAILED`，对象和计划不得复用。
- 只读 E071 对比确认系统内 SRVB 可存在 `OBJFUNC=D` 删除条目；未放宽 CTS 门禁，也未修改 E071。当前推断是未激活的新对象在同一传输中删除未形成删除传播证据。
- 已在 Service Binding 创建生命周期增加标准 ADT activation，并强制 active readback 同时满足 `version=active`、`bindingCreated=true`、`published=false`，再以 active 版本复核包、Service Definition、版本、类别和服务版本；能力声明改为 `separateActivation=true`。
- 定向 17 tests、build、coverage（`REAL_DEV_VERIFIED=16`）和 `git diff --check` 通过。需硬重启后使用全新 `ZVPSVB03` 重新完成 create → activate → active readback → cleanup → absence → CTS deletion-entry 生命周期。

## 2026-08-29 SERVICE_BINDING 停止与 CHANGE_DOCUMENT_OBJECT 首轮

- `ZVPSVB03` 计划 `fa4f950f-f7c7-40f0-9dfe-b74e99821cba` 已完成 v2 create、标准 activation、active readback 和配置复核；独立结构确认 `active`、`bindingCreated=true`、`published=false`、OData V4 Web API 和 `ZVPSRV01` 引用。
- 经明确删除授权，cleanup 计划 `eb9254f5-4d5c-4709-a4c9-ed19e143309f` 已完成对象删除和 absence；SAP CTS 保留 `R3TR/SRVB/ZVPSVB03` 与 activation 生成的 `R3TR/G4BA/ZVPSVB03`，两条 `OBJFUNC` 均为空，未形成删除传播条目。
- Service Binding 已连续证明创建/激活正常但 cleanup transport 证据不满足门禁；不修改 E071、不放宽门禁、不创建第四个身份，当前保持 `AUTOMATION_VERIFIED / writable=false`。
- 阶段 5 转入 `CHANGE_DOCUMENT_OBJECT`。全新 `ZVPCHDO01` 使用 active `T000` 与 `ZVMSG3/001`，shell 与 JSON write 成功，但 working-content 比较失败后在 activation 前安全补偿；独立 search 无残留，原身份和计划不得复用。
- CHDO JSON parser 允许默认 `standard` category 被省略，active comparator 也已有同类规范化，唯独 working comparator 错误要求字段显式存在。已最小修复为：仅当期望 `standard` 时接受 SAP 省略；显式类别漂移和 behavior-definition 类别缺失仍失败关闭。
- 需测试、build 和硬重启后以全新 `ZVPCHDO02` 验证；本次 CHDO 未尝试 activation，未生成 Function Group/Class。
- 重启后 `ZVPCHDO02` 仍在 working-content 比较点失败并于 activation 前完整补偿，说明真实差异不止默认 `standard` category；独立 search 无残留，也未生成派生对象。
- 达到第三次前停止猜测字段，新增脱敏差异诊断：仅记录首个 JSON 路径、两侧值类型、完整规范化 JSON 的 SHA-256 与字节数，不输出任何字段值或 JSON 内容。需重启后用第三个且最后一个身份 `ZVPCHDO03` 取证；若仍失败则停止 CHDO。
- `ZVPCHDO03` 脱敏诊断定位首差异为 `$.errorMessage.id`，整体 expected/actual 字节数为 449/445。离线穷举该结构的合法两字符消息类与三位消息号后，唯一完整 SHA-256 匹配为 `CD/600`；没有读取或输出实际 working JSON。
- 只读 target configuration 同时明确 `errorMessage.sap.adt.hidden=true` 且 ID 类型为 `MSAG`。因此该字段属于服务器固定默认，不应由调用方控制；适配器现固定 `CD/600`、冻结并复核 active `CD` 消息类，公共 schema 移除 `errorMessage`，contract 门禁要求目标继续声明 hidden。
- 需测试、build 和重启后使用全新身份继续 CHDO；`ZVPCHDO01/02/03` 均已补偿且不得复用。
- 重启后 `ZVPCHDO04` 已通过 working-content 复读与 activation，active CHDO 验证成功；计划仅因错误假定 standard 类别生成 `FUGR/FF` 而进入 `OUTCOME_UNKNOWN`。
- 独立只读证据确认 active JSON 的 category 省略、`errorMessage=CD/600`、generatedObject=`ZCL_ZVPCHDO04_CHDO`；生成对象实际为 active `CLAS/OC`，包 `Z001`。CTS 同时登记 `R3TR/CHDO/ZVPCHDO04` 与 `R3TR/CLAS/ZCL_ZVPCHDO04_CHDO`。
- 创建验证已修正为两类 CHDO 均要求 SAP 分配 active `CLAS/OC`。cleanup 新增 CHDO 专属级联证明：冻结生成类为 `CASCADE_VERIFY`，真实 DELETE 只针对 CHDO 一次，随后要求 SAP 级联移除生成类并分别验证 CTS 删除传播条目；永不直接删除生成类。
- 需全量门禁与硬重启后，先对现有 `ZVPCHDO04` 生成 cleanup preview 并取得独立删除授权；若级联和 CTS 完整，再用新身份完成 APPLIED 创建证据。
- `ZVPCHDO04` cleanup 计划 `6437088c-11a0-4ba5-a2dc-47594e1c7082` 已验证 CHDO 删除与生成类级联缺失成功；CTS 保留 `R3TR/CHDO/ZVPCHDO04` 与 `R3TR/CLAS/ZCL_ZVPCHDO04_CHDO`，两条 `OBJFUNC` 均为空，计划终态 `FAILED`，CHDO 与生成类均已缺失。
- `BEHAVIOR_DEFINITION ZVPCDS05` cleanup 计划 `e3da302d-5213-4dd0-965f-84e68973f6bd` 已完成删除和 absence；CTS 仅保留空 `R3TR/BDEF/ZVPCDS05`，未形成删除传播条目，计划终态 `FAILED`，不修改 E071。

## 2026-08-31 Wave 3 逆序清理收口

- 已按依赖逆序清理 `ZVPSVB03`、`ZVPCHDO04` 与生成 Class、`ZVPCDS05` BDEF、`ZVPMDE03`、`ZVPDCL02`、`ZVPSRV01`、`ZVPCDS05`、`ZVPCDS03`、`ZVPCDS02`；最终独立 search 全部为空。
- 所有 cleanup 的对象删除与 absence 均成功；CHDO 仅 DELETE 父对象一次，生成 Class 由 SAP 级联删除并独立验证缺失。
- task `S4HK900010` 中上述 `DDLS/DCLS/DDLX/SRVD/BDEF/SRVB/G4BA/CHDO/CLAS` 条目均保留但 `OBJFUNC` 为空，没有唯一 `OBJFUNC=D` 删除传播证据。
- 按证据门禁，本轮没有任何 Wave 3 类型晋级；总成熟度保持 `REAL_DEV_VERIFIED=16`、`AUTOMATION_VERIFIED=11`、`CONTROLLED_IMPLEMENTED=4`。
- 完整证据写入 `docs/evidence/repository-creation-wave3-cds-service-chdo-validation.md`，相关历史身份已加入 maturity manifest 的不可复用列表；未修改 E071/E071K，未删除或释放传输。

## 2026-08-31 同一未释放传输证据晋级

- 经用户结合实际确认，`OBJFUNC=D` 只适用于既有或已下传对象的删除；创建前不存在、在同一未释放传输中创建并删除的验证对象不需要传播下游删除。
- cleanup 新增 `COMPLETED_LOCAL_ABSENCE` 与 `NEUTRAL_ENTRIES_VERIFIED`；neutral 模式要求唯一精确空 CTS 键，重复、缺失、异常值或 companion disposition 混合均失败关闭。Service Binding 同时冻结 `SRVB/G4BA`。
- maturity manifest 升级为 schema v2；neutral 晋级强制 `APPLIED`、pre-absence、相同目标/包/传输、创建与清理时传输开放、DELETE、对象/生成物缺失和精确 neutral CTS 证据。历史计划状态保持不变。
- 从持久审计恢复了真实 creation plan ID，未使用占位符：`ZVPCDS02`、`ZVPDCL02`、`ZVPMDE03`、`ZVPSRV01`、`ZVPCDS05` BDEF、`ZVPSVB03`。
- 上述 6 类正式晋级，总成熟度变为 `REAL_DEV_VERIFIED=22`、`AUTOMATION_VERIFIED=5`、`CONTROLLED_IMPLEMENTED=4`。CHDO 创建计划仍为 `OUTCOME_UNKNOWN`，保持未晋级并需全新身份验证。

## 2026-09-03 CHANGE_DOCUMENT_OBJECT 正式晋级

- 重启后 healthcheck 确认新 session generation 0，旧计划返回 `PLAN_NOT_FOUND`；独立 search 确认 `ZVPCHDO05` 与 `ZCL_ZVPCHDO05_CHDO` 创建前均不存在。
- creation plan `bea2ab37-22a2-47e0-86cf-53dc7c0897ae` 经原生确认后终态 `APPLIED`：JSON write、working readback、activation、active CHDO/content 与 SAP 生成 active `CLAS/OC ZCL_ZVPCHDO05_CHDO` 均成功。
- cleanup plan `f4e796e8-05a9-4410-8b7c-79d47abd2d89` 仅 DELETE CHDO 一次，验证生成 Class 由 SAP 级联缺失，终态 `COMPLETED_LOCAL_ABSENCE`，`CHDO/CLAS` 两条唯一 CTS 均为 neutral；独立 search 再次确认两对象为空。
- maturity manifest 使用全新 `ZVPCHDO05` 证据晋级 `CHANGE_DOCUMENT_OBJECT`；旧 `ZVPCHDO04` unresolved 记录保持原样。总成熟度变为 `REAL_DEV_VERIFIED=23`、`AUTOMATION_VERIFIED=5`、`CONTROLLED_IMPLEMENTED=3`。

## 2026-09-03 剩余八类只读复评

- 重启验收确认 new session generation 0、23 个 `REAL_DEV_VERIFIED` 类型全部 `writable=true`，且 `CHANGE_DOCUMENT_OBJECT` 已正常可写；CHDO05 的旧 creation/cleanup plan 均返回 `PLAN_NOT_FOUND`。
- `ZVCL_CAMPAIGN` 仍为 package `Z001` 中 active `CLAS/OC`，历史 unknown 身份不可重放或删除。`ZVSTR1` 与 `EZVLOCK4` 也实际存在；对后两者的 active object-structure 读取均在 60 秒超时，和历史“search 空”记录冲突，当前按未知远端状态停止，不创建第五个 Lock Object 身份。
- `ZVANNO1`、`ZVPBUF01`、`ZVFG1`、`ZVPFG2`、`ZVFM0`、`ZVPFM2` 与 `LZVFG1Z01` search 均为空。Annotation Definition 仍需 SAP 管理员授予目标权限；Entity Buffer 需要可 buffer 的 active CDS 实体；Function Group/Module 的本地 comparer 已支持 SAP 首行大小写及合法签名句号差异，但仍需重启后的全新身份真实验证；Include 则依赖一个可验证的既有父函数组。
- 本轮只读复评未创建、删除、重放或晋级任何剩余类型。下一步必须先选择并限定一个阻塞工作流，不能把历史 unknown 对象当作可清理验证对象。
- 随后限定 `FUNCTION_GROUP` comparer 取证：重启后的本地 MCP generation 为 `0`，但 stateful SAP session 已为 `degraded`（`lastErrorType=request-failed`）。新身份 `ZVPFG3` / `ZVPFM3` 的只读 absence 搜索分别在 60 秒超时和返回 HTTP 400；未创建 preview、未触发确认、未写入或删除 SAP。在 SAP 连接恢复前不得创建新计划。
- SAP MCP 重启后连接恢复，`ZVPFG3` / `ZVPFM3` 创建前 search 均为空。creation plan `89cd70cd-eb3d-4ab3-af26-75c103cfad99` 经原生确认完成创建、写入、syntax check、解锁和激活，但 active source verify 仍失败；模块后、函数组前的补偿均成功，独立 search 再次证明两对象缺失。该计划终态 `COMPENSATED`，不得重放。
- `ZVPFG4` / `ZVPFM4` 在加载候选空函数分隔行规则后仍于 active source verify 失败，creation plan `01d6db7a-b7a3-40ce-9965-0bbe5df12a9c` 终态 `COMPENSATED`；两对象独立 search 均为空，不得重放。该结果否定空白分隔行假设，相关 comparer 放宽已立即撤回。
- 现已修复真实观测缺口：只把底层 `SOURCE_VERIFY_FAILED` 中经 schema 校验的 hash、行号、字节数和行 hash 透传到外层 compensated plan，源代码与任意 details 均不透传；同时修复带参数函数模块首行省略句号的比较器回归。全量 109 suites / 774 tests、build、coverage gate 和 diff check 均通过；因源码已修改，需重启后仅做一次全新身份诊断，不得复用 `ZVPFG3` / `ZVPFM3` / `ZVPFG4` / `ZVPFM4`。

## 2026-09-03 FUNCTION_GROUP / FUNCTION_MODULE 修复后验证

- 本地门禁通过：定向 32 tests、`npm run build`、`npm run check:repository-creation-coverage`、`git diff --check`；只读 DEV smoke 与 productionization runtime smoke 均通过。
- 硬重启后的全新身份 `ZVPFG6 + ZVPFM6` 预检和原生确认成功；函数组、函数模块创建、完整 `source/main` 写入、语法检查、解锁和激活均执行成功。
- active source verify 仍失败：`FUNCTION_MODULE` 计划源码 5 行、激活源码 7 行，返回脱敏 `expected/actual hash`、首差异行和行字节证据；计划 `9e96d4a1-5142-4f0c-aae3-f0b60d3b01a2` 终态 `COMPENSATED`。
- 补偿已成功删除 `ZVPFM6` 与 `ZVPFG6`；独立 search 均为空，无 SAP DEV 残留。不得重放该计划或身份，`REAL_DEV_VERIFIED=23` 保持不变。
- 当前结论：创建/激活协议已通过，但函数模块 active source comparer 仍未定位 SAP 的两行差异；下一步只能基于脱敏行级证据继续离线/只读分析，未取得新规则前不再创建第五个身份。

## 2026-09-03 Eclipse Function Module 抓包对照修复

- 用户提供 Eclipse ADT 3.60.2 抓包：函数模块 `source/main` 使用 `Content-Type/Accept: text/plain`；参数为空时 SAP 模板为“`FUNCTION name` + 固定 parameter-template 注释 + 独立 `.`”，激活只提交函数模块 object reference，并以 `workingArea`/`inactive` 复读。
- 对照 `ZVPFG6/ZVPFM6` 的 5→7 行差异，确认此前比较器遗漏了 SAP 固定模板注释和独立签名终止符，而非业务源码变化。
- `compareFunctionModuleSources` 现仅规范化该固定 Eclipse scaffold：移除固定 parameter-template 注释、合并独立签名 `.`，并保留既有大小写/签名分隔行规则；其它参数、实现、用户注释和空白差异仍判定为 `DIFFERENT`。
- 新增抓包回归测试；定向 26 tests、`npm run build` 通过。需硬重启 MCP 后以全新 `FUNCTION_GROUP + FUNCTION_MODULE` 身份进行最终 DEV 生命周期验证；`ZVPFG6/ZVPFM6` 及其计划不得重放。

## 2026-09-03 FUNCTION_GROUP / FUNCTION_MODULE 最终创建验证

- 硬重启后 healthcheck 确认新 session `disconnected/generation=0`。
- 全新 `ZVPFG7 + ZVPFM7` 计划 `94ea7bf8-3acd-401a-bfdd-d1b7d4fe4330` 完成 preview、原生确认、函数组/模块创建、`source/main` 写入、语法检查、解锁、仅提交函数模块 object reference 的激活，以及 active source/父组复读；终态 `APPLIED`，来源匹配通过。
- 只读传输复核显示两对象实际被 SAP 记录到任务 `S4HK900010`，而计划/配置验证传输为 `S4HK900009`；`previewRepositoryObjectCleanup(ZVPFG7)` 因对象不属于 configured validation transport 返回 `TRANSPORT_INVALID`，未执行删除。
- 当前对象仍存在于 DEV，未绕过传输门禁、未修改传输数据、未执行 cleanup。Function Group/Module 创建与激活问题已解决；完整 `REAL_DEV_VERIFIED` 晋级仍待传输归属处理和 cleanup 证据。

## 2026-09-03 传输子任务与函数池技术名校正

- 用户确认 `S4HK900010` 是主请求 `S4HK900009` 的子任务；只读 transportInfo 证实对象锁链同时包含主请求 `S4HK900009` 与任务 `S4HK900010`，不属于跨请求漂移。
- cleanup 误报的实际原因是函数组技术对象名：SAP 返回 `SAPLZVPFG7`，而业务对象名为 `ZVPFG7`。已最小修复 cleanup ownership 校验，Function Group 仅额外接受标准生成名 `SAPL<业务名>`，传输号、包和对象类型校验保持严格。
- cleanup/creation workflow 定向 23 tests、build、diff check 通过；需再次硬重启 MCP 后，对现有 `ZVPFG7` 生成 cleanup preview/apply，完成对象删除、absence 和 neutral CTS 证据。未重启前不调用 cleanup apply。

## 2026-09-03 FUNCTION_GROUP cleanup 执行结果

- 硬重启后 cleanup preview 成功：计划 `aaa278f5-8b84-40a2-a0d9-161a98bfba01` 冻结 `ZVPFG7`、技术名 `SAPLZVPFG7`、包 `Z001` 和主请求 `S4HK900009`。
- 原生确认后的 DELETE 成功，`ZVPFG7` absence 复查成功；独立 search 同时确认 SAP 级联移除 `ZVPFM7`，两对象均不存在。
- 计划在 CTS 复核阶段终态 `FAILED`：未取得“唯一 deletion entry 或唯一 neutral entry”证据；没有再次删除、没有修改 E071/E071K、没有数据库操作。
- 用户已确认 `S4HK900010` 是 `S4HK900009` 的子任务；当前待补的是 Function Group/Module 在主请求+子任务 CTS 明细中的实际对象条目映射，不能重放该已消费 cleanup 计划。

## 2026-09-03 FUNCTION_GROUP / FUNCTION_MODULE fresh retry and CTS mapping

- Fresh-session gate passed again: DEV/client `300`, session `disconnected/generation=0`; historical creation and cleanup plans returned `PLAN_NOT_FOUND`; validation runtime smoke passed with 23 `REAL_DEV_VERIFIED` kinds writable when validation is disabled.
- New identities `ZVPFG8 + ZVPFM8` used creation plan `eeb6c118e157774c7bd7dea2874dc8f4`; preview, native confirmation, group/module creation, full `source/main` write, syntax check, unlock, activation, parent/module readback and `FUNCTION_MODULE_FORMAT_NORMALIZED` source match all succeeded. Plan ended `APPLIED`.
- Read-only post-create CTS evidence reported group `LIMU/REPS/SAPLZVPFG8` and module `LIMU/FUNC/ZVPFM8`; the group was removed using cleanup plan `3c5e0679-e399-4956-9cbb-2681ef9ba96a`, and independent searches confirmed both `ZVPFG8` and cascaded `ZVPFM8` absent.
- Cleanup ended `FAILED` only at CTS evidence: no unique deletion or neutral entry was accepted. The failure plan and identity are consumed and must not be replayed; no E071/E071K or database operation occurred.
- Minimal local fix adds the standard `R3TR/FUGR/<business-name>` alias alongside the SAPL/LIMU form for future Function Group CTS matching; regression test, build, coverage gate, and `git diff --check` pass. A fresh hard restart is required before any further real apply.

## 2026-09-03 FUNCTION_GROUP 晋级，FUNCTION_MODULE CTS 边界

- 用户硬重启后，healthcheck 为 DEV/client `300`、`disconnected/generation=0`；`ZVPFG8` creation/cleanup plan 均 `PLAN_NOT_FOUND`，`ZVPFG8/ZVPFM8` search 均为空。
- 全新 `ZVPFG9 + ZVPFM9` creation plan `409df9213ed61d484f776b6f6cda0857` 终态 `APPLIED`：创建、完整模块源码写入、syntax check、unlock、activation、父组/模块 active readback 与 `FUNCTION_MODULE_FORMAT_NORMALIZED` 均成功。
- cleanup plan `c7ffdbfe-8399-46f1-80d9-060c6ea691dd` 终态 `COMPLETED_LOCAL_ABSENCE`：删除函数组、函数组 absence 与唯一 neutral `R3TR/FUGR/ZVPFG9` CTS entry 全部通过；独立 search 同时确认 SAP 级联删除 `ZVPFM9`。未修改 E071/E071K，未执行数据库操作。
- `FUNCTION_GROUP` 现有完整 same-open-transport evidence，晋级为 `REAL_DEV_VERIFIED`（总数 24）。`FUNCTION_MODULE` 保持 `AUTOMATION_VERIFIED`：本轮未冻结/验证模块自身最终 CTS key，不能把父组的 CTS 结论扩展到模块；后续需以受控独立模块 cleanup 证据完成晋级。

## 2026-09-03 FUNCTION_MODULE 父函数组 CTS 作用域晋级

- 临时 active 父组 `ZVPFG11` 与 bootstrap `ZVPFM11A` 建立后，独立模块 `ZVPFM11C` creation plan `a0b3bc5c-debe-4357-b525-b862fbcab6f0` 终态 `APPLIED`：父组复核、创建、完整源码写入、syntax check、unlock、activation 与 active source readback 全部成功。
- SAP `transportInfo` 证明模块业务键为 `LIMU/FUNC/ZVPFM11C`，但实际函数池锁/CTS 键为共享父组技术对象 `LIMU/REPS/LZVPFG11UXX`。模块 cleanup plan `2286f9b8-e40f-4a04-9c61-779dcc9026dd` 已独立删除模块并验证 absence，只在要求模块拥有唯一 CTS 单键的旧规则下终态 `FAILED`。
- 父组 cleanup plan `5e27bb27-7ce8-46aa-add5-8643db643eb7` 在同一开放传输中删除 `ZVPFG11`，取得唯一 neutral CTS entry，终态 `COMPLETED_LOCAL_ABSENCE`；最终 search 确认父组、bootstrap、`ZVPFM11B` 和 `ZVPFM11C` 均为空。
- maturity evidence 现显式记录 `FUNCTION_MODULE` 的冻结父组、直接模块删除计划和父组 CTS cleanup 计划；模块创建/激活/删除/absence 仍须独立通过，只有 CTS 使用 SAP 的父函数池共享作用域。`FUNCTION_MODULE` 晋级后总数为 `REAL_DEV_VERIFIED=25`、`AUTOMATION_VERIFIED=3`、`CONTROLLED_IMPLEMENTED=3`。

## 2026-09-04 FUNCTION_GROUP_INCLUDE Eclipse 抓包校正

- 用户提供 Eclipse ADT 3.60.2 创建 `LZMCP_ADT_TEST001` 的真实通信日志：`FUGR/I` 创建校验和创建 XML 均使用完整 include 名，父函数组为 `ZMCP_ADT_TEST`；`LZMCP_ADT_TESTUXX` 是既有 SAP 生成 include，不属于本次创建对象、验证对象或 cleanup 对象。
- `FUGR/I` 源码验证改为只读 created include 自身的 `source/main?version=workingArea`；元数据可使用 `?version=inactive/workingArea`。不再要求、读取或激活 `UXX`，也不把 `UXX -> U01` 当作创建证据链。
- Include source 的最小可检查形态为顶层声明，例如 `DATA gv_zmcp_adt_test001 TYPE i VALUE 1.`；`WRITE 1.` 是可执行语句，放在 include 顶层会导致语法检查失败。
- 本地修复完成：`FUNCTION_GROUP_INCLUDE` apply 的安全命名空间边界改为父函数组，create options 发送完整 `L...` include 名，允许数字三字符 suffix，post-activation source verify 使用 `workingArea`。定向 28 tests、`npm run build` 和 `git diff --check` 通过；尚未执行 MCP 真实 DEV 创建/清理，能力仍未晋级。
- 重启后尝试建立临时父组 `ZVPFGI12 + ZVPFGI12A`：创建、源码写入、syntax check、unlock、activation 均成功，但空 bootstrap function module 的 active source compare 未规范化 Eclipse scaffold + standalone `.` + 空实现，计划 `6388caa3d8159d7dbbfe3a84b1b6b774` 终态 `COMPENSATED`；后续 search 确认 `ZVPFGI12` 与 `ZVPFGI12A` 均不存在，不得重放该身份。
- 已修复 `compareFunctionModuleSources` 对空函数模块实现的 SAP scaffold 归一化；新增定向回归。`sourceTools` 与创建工作流 28 tests、`npm run build`、`git diff --check` 通过；因源码和 dist 已更新，需要再次硬重启 MCP 后才能继续全新父组/include 验证。
- 再次重启后，全新临时父组 `ZVPFGI13 + ZVPFGI13A` 创建计划 `39c8ad0f07ff0364cdef9e1fceb1db92` 终态 `APPLIED`；空 bootstrap module 以 `FUNCTION_MODULE_FORMAT_NORMALIZED` 通过 active source 验证。
- `FUNCTION_GROUP_INCLUDE LZVPFGI13001` creation plan `90546ae9-c48f-4be7-a430-484e77f5a13a` 终态 `APPLIED`：preview 冻结父组 `ZVPFGI13`、包 `Z001`、传输 `S4HK900009` 和完整 `L...` 名；创建、源码写入、syntax check、unlock、activation、created include `workingArea` source readback 全部成功。独立 search 命中唯一 `FUGR/I`，源码为 `DATA gv_zvpfgi13001 TYPE i VALUE 1.`，transportInfo 为 `LIMU/REPS/LZVPFGI13001`、主请求 `S4HK900009`、task `S4HK900010`。
- include cleanup preview 暴露新的真实差异：SAP search 不带 type filter 可命中 `FUGR/I`，但带 `objType=FUGR/I` 返回空；旧 cleanup resolver 因此误报对象不存在。已修复 cleanup `findExact` 对 `FUGR/I` 与 `FUGR/FF` 一样不传 search type，再由返回的 `adtcore:type` 精确过滤；定向 cleanup 17 tests、`npm run build`、`git diff --check` 通过。当前 SAP 上仍有 `LZVPFGI13001`、`ZVPFGI13`、`ZVPFGI13A`，需再次硬重启后优先清理，未修改 E071/E071K，未执行数据库操作。
- 重启后 include cleanup plan `438c4ce4-fc81-41e9-8de5-c410af87f217` 单独锁定并删除 `LZVPFGI13001`，include absence 成功；该计划仅在 `cleanup-transport` 失败。父组 cleanup plan `365e0bdc-2ef0-43e1-b3de-5be5e0649b14` 随后删除 `ZVPFGI13` 并取得 `TRANSPORT_NEUTRAL_ENTRY_VERIFIED`，终态 `COMPLETED_LOCAL_ABSENCE`。
- 最终重启后只读复查：healthcheck 为 DEV/client `300`、generation `0`；旧 include creation plan 返回 `PLAN_NOT_FOUND`；`LZVPFGI13001`、`ZVPFGI13`、`ZVPFGI13A` 和 `FUGR/F ZVPFGI13` search 均为空。未修改 E071/E071K，未执行数据库操作。
- maturity evidence 现显式记录 `FUNCTION_GROUP_INCLUDE` 的 created include、直接 include cleanup 和父组 cleanup transport scope；`UXX` 保持 SAP 生成对象排除在证据链之外。`FUNCTION_GROUP_INCLUDE` 晋级后总数为 `REAL_DEV_VERIFIED=26`、`AUTOMATION_VERIFIED=3`、`CONTROLLED_IMPLEMENTED=2`。

## 2026-09-04 P1/P3 剩余对象真实验证

- `ABAP_CLASS ZVPCL02` 的 creation plan `2fc38902-3912-4ae8-8a1c-9785eaf4e5e0` 经原生确认后完成 absence、transport 和 shell creation，但 post-create ownership proof 对 inactive structure/source 均收到 SAP `wrong input data for processing`。独立 search 证实 `CLAS/OC ZVPCL02` 存在于 `Z001`；计划终态 `OUTCOME_UNKNOWN`，不得重放、删除或复用该身份，未写源码、未激活、未晋级。
- 用户提供 Eclipse ADT 3.60.2 的 Class v4 POST，证实外层属性和 media type 均已对齐；缺失的是 packageRef 后的 `class:include(CLAS/OC,testclasses)` 与空 `class:superClassRef`。目标会接受缺失子节点的 POST，却生成无法读取的 class shell，和 `ZVCL_CAMPAIGN`、`ZVPCL01`、`ZVPCL02` 完全一致。builder 与回归测试已最小修复，需硬重启 MCP 后以全新身份真实验证；历史 class 身份均不得重放或删除。
- XML 修复后的 `ZVPCL03` 仍在 ownership proof 阶段变为 `OUTCOME_UNKNOWN`，独立 search 证实壳存在且不得清理。Eclipse 记录同时明确该 POST 为 stateless，而旧 source-object shell 使用主 stateful ADT session；现已仅将 `ABAP_CLASS` shell 改为 stateless clone，后续 lock/write/activate/readback 保持 stateful。定向 3 suites / 60 tests、build、coverage 与 diff check 通过；需再次硬重启后以全新身份复测。
- Eclipse 完整生命周期抓包标记：只有 Class 的 LOCK/UNLOCK 为 stateful enqueue；shell、object structure、source PUT、checkrun、activation 与 workingArea source readback 显示为 stateless。内置 client 在本地拒绝 stateless clone 的 `setObjectSource`，因此 Class adapter 采用 stateless shell/readback、主 stateful lock/write/check/activate/unlock 的最小边界，并新增双 client 回归；定向 2 suites / 28 tests、build、coverage 与 diff check 通过。需硬重启后使用全新身份验证。
- `ZVPCL04` 验证确认 XML 与 stateless shell/readback 修复已生效：shell、ownership proof、`source/main` resolution 和主 stateful lock 均成功；但旧边界把 PUT 发给 stateless clone，被本地 `ValidateStateful` 拒绝，unlock 成功且未写入源码。独立 inactive structure 已返回完整五类 include。现已修正为 stateless shell/readback + 主 stateful lock/write/check/activate/unlock；定向 3 suites / 61 tests、build、coverage 与 diff check 通过。`ZVPCL03/04` 计划均终态未知且对象存在，不得重放或删除；需硬重启后使用 `ZVPCL05` 复测。
- `ZVPCL06` 经过最终硬重启后的真实生命周期验证：creation plan `e72e3a9b-1de0-48df-ac96-d87f44d85a32` 完成 shell、ownership proof、`source/main`、stateful lock、源码 PUT、syntax check、unlock、activation 和 active source verify，终态 `APPLIED`；仅行尾规范化。独立 cleanup plan `19c3db56-17d7-4022-bd1d-d47d95a86fbc` 完成删除、absence 与唯一 neutral CTS entry，终态 `COMPLETED_LOCAL_ABSENCE`。`ABAP_CLASS` 正式晋级 `REAL_DEV_VERIFIED`，总数变为 27；`ZVPCL02/03/04` 历史未知身份保持不可重放/删除。
- `DDIC_STRUCTURE ZVPSTR03` 的 creation plan `fae5b16e-3782-4c1d-b13b-4ba8363c7e17` 经原生确认后已完成 shell、source write、syntax check、unlock 和 activation；仅 active source compare 不匹配。受控补偿已删除对象，独立 `TABL/DS` search 为空；不得重放该计划或身份，未取得 cleanup/CTS evidence，未晋级。
- 全新 `DDIC_STRUCTURE ZVPSTR04` plan `689febfc-90d2-41ed-84e3-91c5fe4231fc` 再次完成 shell、source write、syntax check、unlock 和 activation，仍仅在 active source compare 失败；受控补偿成功且独立 search 为空。适配器现以 `SOURCE_VERIFY_FAILED` 输出脱敏 hash、行数、首差异行与行 hash，不输出源码；需硬重启后以新身份获得真实诊断，再基于 Eclipse active DDL 抓包修复，`ZVPSTR04` 不得重放。
- `DDIC_STRUCTURE ZVPSTR05` plan `f9fd30ed-2118-40cf-8335-f6506e7ebce6` 使用新诊断确认 SAP 只在最终 `}` 前增加一行空白：expected 7 行、active 8 行，首差异第 7 行。已新增仅针对此精确形态的 `DDIC_STRUCTURE_FORMAT_NORMALIZED`，字段/注解/类型与其它空白变化仍失败关闭；计划已补偿且 search 为空，需硬重启后使用全新 `ZVPSTR06` 复测。
- `CDS_ANNOTATION_DEFINITION ZVPANNO02` 的 creation plan `e3e52ce9-ef32-4ec5-a628-02ae1288cd5c` preview 成功，但原生确认后的 shell create 被 SAP 拒绝：`You are not authorized to create Annotation Definitions`。独立 `DDLA/ADF` search 为空；计划终态 `OUTCOME_UNKNOWN`，不得重放或复用，仍需目标权限后使用全新身份验证。
- 为获取精确授权对象，用户对 `068157` 开启 `STAUTHTRACE` 后使用全新 `ZVPANNO03` 重现；plan `5924a0ed-1136-46c9-b7b9-7a7a380b9021` 同样仅在 shell create 被拒绝，absence/transport 均成功且独立 `DDLA/ADF` search 为空。该 plan 与身份均已消费，等待 trace 的失败授权对象和字段值后再配置最小角色。
- 本轮未修改 E071/E071K、未执行数据库操作；完整证据见 `docs/evidence/repository-creation-wave4-abap-class-structure-annotation-validation.md`。`ABAP_CLASS` 与 `DDIC_STRUCTURE` 已分别晋级 `REAL_DEV_VERIFIED`，总数变为 28；`CDS_ANNOTATION_DEFINITION` 仍为 `AUTOMATION_VERIFIED` 并受目标应用级限制。
