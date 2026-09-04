# 31 类仓库对象创建产品化交接

更新时间：2026-08-25

## 新会话第一条指令

在 `D:\MyDev\SAP\mcp-abap-abap-adt-api` 接管 31 类仓库对象创建产品化。先读：

1. `AGENTS.md`
2. `docs/superpowers/specs/2026-08-25-repository-creation-productionization-design.md`
3. `docs/superpowers/plans/2026-08-25-repository-creation-productionization-plan.md`
4. 本文件
5. `PROGRESS.md`
6. `BLOCKED.md`
7. `docs/evidence/repository-validation-campaign-matrix.md`

不要重放历史计划，不要清理现有对象，不要直接调用 raw create/delete。

## 用户最终目标

让当前 31 类对象在关闭 `SAP_MCP_REAL_DEV_VALIDATION` 后仍能在正常 DEV Profile 正式创建，即逐类达到 `REAL_DEV_VERIFIED`；不是永久依赖测试白名单。

用户批准“按对象族分批晋级、完成一类立即开放一类”。

## 工作区与运行边界

- 仓库：`D:\MyDev\SAP\mcp-abap-abap-adt-api`
- SAP：DEV client 300
- Profile：`development`
- 验证包：`Z001`
- 验证传输：`S4HK900009`
- 验证前缀：`ZV`
- 配置：`C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`
- 当前 `SAP_MCP_REAL_DEV_VALIDATION=true`
- QAS/PRD 不允许写
- 工作区很脏，不 commit、不清理、不覆盖无关修改

修改源码或构建后必须硬重启 Codex/MCP。硬重启验收：healthcheck 为新 session，旧 plan 返回 `PLAN_NOT_FOUND`。

## 自动化基线

- 109 Jest suites
- 793 tests
- controlled 31 / pending 111 / `REAL_DEV_VERIFIED=28`
- maturity `REAL_DEV_VERIFIED=28` / `AUTOMATION_VERIFIED=2` / `CONTROLLED_IMPLEMENTED=2`；完整 evidence records 为 28

命令：

```powershell
npm test -- --runInBand --coverage=false
npm run build
npm run check:repository-creation-coverage
npm run test:repository-productionization-runtime -- "C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env"
npm run test:repository-verified-domain-preview -- "C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env" ZVPV001
git diff --check
```

## 31 类最终结果

权威逐行状态：`docs/evidence/repository-validation-campaign-matrix.md`。

- 10 类 `APPLIED_ACTIVE_VERIFIED`
- 1 类 `ACTIVE_READBACK_ONLY`
- 5 类 active shell-only / unknown
- 2 类 compensated
- 2 类 target/local unavailable
- 11 类 dependency missing

这些是创建侧结果，不等于 `REAL_DEV_VERIFIED`，因为清理与清理后传输复查尚未完成。

## 已真实成功的关键类型

- `DDIC_DOMAIN ZVDOM`
- `DDIC_TABLE_TYPE ZVTT1`
- `PROGRAM ZVPROG`
- `MESSAGE_CLASS ZVMSG3`，message 001 已复读
- `LOGICAL_EXTERNAL_SCHEMA ZVSCHEMA4`
- `NUMBER_RANGE_OBJECT ZVNRO1`
- `CDS_TYPE ZVCDSTYPE2`
- `CDS_ASPECT ZVASPECT`
- `SAP_OBJECT_TYPE ZVOBJECTTYPE7`
- `SAP_OBJECT_NODE_TYPE ZVOBJECTTYPE7`（NONT/NOT root node）
- `DATA_ELEMENT ZVDE1` active readback 正确，但历史 plan 保持 unknown

## 已修复且必须保留的根因

1. Windows native confirmation + named pipe；不要恢复文字确认。
2. Repository apply execution-gate 重入自锁。
3. DDIC SAP 默认值规范化。
4. validation response ASX 与 HTTP 200 empty success。
5. response header 遍历与 canonical Location absolute URL 处理。
6. Blue v2 `adtcore:encoding` / `adtcore:type`。
7. RONT optional `objectTypeCode`。
8. Message Class stateless shell creation；不要改回 primary stateful session。
9. DESD `/source/main` 使用严格 `application/json`，readback 可省略可选字段。
10. Database Table 有专属严格 DDL tokenizer；不要改通用 source compare。

## 未解决阻塞

### Source Object / Type Group

本地已实现 bounded HTTP 200/no-Location ownership proof：只接受空 body，并要求创建前不存在、精确 URI/包 search、active metadata/描述/当前用户/主语言/主系统、CTS 对象身份和传输全部匹配后才写源码。任一证据缺失仍为 `OUTCOME_UNKNOWN`，不自动删除。尚待重启后的全新身份真实验证。

历史空壳：`ZVIF_CAMPAIGN`、`ZVIF2`、`ZVIF3`、`ZVCL_CAMPAIGN`、`ZVINCL`、`ZVTG1`、`ZVTG2`。不得复用或自动删除。

### Database Table

`ZVTAB2`、`ZVTAB3`、`ZVTAB4` 均在 source/check/activation 后 active DDL compare 失败并补偿，search 均为空。现已增加首个 mismatch token 索引、token kind、数量和双方 hash 的脱敏诊断，不输出 token 值或源码；尚待重启后一次全新身份取证。

### Function Group

`ZVFG1 + ZVFM0` 已补偿且为空。现已增加首个差异行号、行数、行字节数与行 hash 的脱敏诊断，不输出源码；尚待重启后一次全新身份取证。

### DDIC Structure

`ZVSTR1` 为历史 active placeholder shell，不能重用或删除。`DDIC_STRUCTURE ZVPSTR06` 已完成真实 create、active readback、cleanup、absence 和 CTS deletion-entry verification，当前已晋级 `REAL_DEV_VERIFIED`。

### Package

父包返回 `responsible=SAP` 时，preview 现在使用当前认证 `SafetyPolicy.sapUser`，并由 SAP package basic/full validation 和 constraints 共同校验；不从父包复制系统值，也不接受调用方用户名。尚待重启后真实 preview/apply。

### Annotation Definition

目标 SAP 明确权限拒绝；需要管理员授权，代码不能绕过。

## 当前成功对象不要删除

清理未授权。特别保留：`ZVDOM`、`ZVDE1`、`ZVTT1`、`ZVPROG`、`ZVNRO1`、`ZVASPECT`、`ZVCDSTYPE2`、`ZVMSG3`、`ZVSCHEMA4`、`RONT/ROT ZVOBJECTTYPE7`、`NONT/NOT ZVOBJECTTYPE7`、`ZZMCP_VT_DOM`。

## 不得重放

所有出现在 `PROGRESS.md` / `BLOCKED.md` 的历史 plan，包括 preview timeout、`OUTCOME_UNKNOWN`、`COMPENSATED`、`COMPENSATION_FAILED`。新验证必须使用新身份、新 preview、新原生确认。

## 新会话推荐起点

阶段 1 已实现 validation-only cleanup，阶段 2 已实现 maturity manifest 与 Registry/coverage 双重证据门禁。cleanup 现采用删除传播与同一未释放传输 neutral 条目双模式；当前已有 28 类 `REAL_DEV_VERIFIED`。

当前权威状态（2026-09-03）：上述 6 类已用真实 `APPLIED` 创建、active readback、同一未释放传输、DELETE、absence 和唯一 neutral CTS 证据晋级；`CHANGE_DOCUMENT_OBJECT ZVPCHDO05` 也已用全新 `APPLIED` 创建计划、active CHDO/Class、父对象单次 DELETE、生成类级联 absence 与唯一 neutral `CHDO/CLAS` 条目完成晋级。旧 `ZVPCHDO04` unknown 计划保持不变。完整证据见 `docs/evidence/repository-creation-wave3-cds-service-chdo-validation.md`。

历史过程：`DATABASE_TABLE ZVPTAB02` 曾使成熟度达到 16；随后阶段 5 已完成并按当前双模式证据晋级至 22。`ZVPSVB01/02` 等历史失败身份仍不得重放。

2026-09-03：`ZVPCHDO05` creation plan `bea2ab37-22a2-47e0-86cf-53dc7c0897ae` 终态 `APPLIED`；cleanup plan `f4e796e8-05a9-4410-8b7c-79d47abd2d89` 终态 `COMPLETED_LOCAL_ABSENCE`，仅 DELETE CHDO 并验证生成 Class 级联缺失，`CHDO/CLAS` 均为唯一 neutral CTS 条目。`CHANGE_DOCUMENT_OBJECT` 晋级后总数为 23；下一步仅评估剩余 8 类，不自动扩大真实写入范围。

2026-09-03 剩余 8 类复评：`ABAP_CLASS` 的历史 unknown `ZVCL_CAMPAIGN` 仍 active；`DDIC_STRUCTURE ZVSTR1` 与 `DDIC_LOCK_OBJECT EZVLOCK4` 也实际存在，后者 active object-structure 读取超时，按未知远端状态停止且不得删除/重放。`DDIC_STRUCTURE` 后续已使用全新 `ZVPSTR06` 完成真实生命周期并晋级；`CDS_ANNOTATION_DEFINITION` 仍为目标授权阻塞，`CDS_ENTITY_BUFFER` 仍缺可 buffer 的 active CDS 实体，`FUNCTION_GROUP` / `FUNCTION_MODULE` 仍需先解决 active source comparer mismatch，`FUNCTION_GROUP_INCLUDE` 仍缺可验证的既有父函数组。

同日 Function Group comparer 取证：脱敏 mismatch 诊断已编译进 `dist`，无需修改代码或重启；但 stateful SAP session 已降级为 `request-failed`。对新身份 `ZVPFG3` / `ZVPFM3` 的只读 absence 搜索一项 60 秒超时、一项 HTTP 400。未创建 preview、未触发确认、未写入或删除 SAP；必须先恢复 SAP 连接后再做全新身份验证。

SAP MCP 重启后，`ZVPFG3` / `ZVPFM3` 的 absence search 均成功。creation plan `89cd70cd-eb3d-4ab3-af26-75c103cfad99` 经原生确认后已创建、写入、检查、解锁、激活，但 active source verify 失败；模块与函数组均按顺序补偿，独立 search 再次确认缺失。计划终态为 `COMPENSATED`，不得重放。

为验证空函数分隔行假设，`ZVPFG4` / `ZVPFM4` 使用同一最小源码进行一次全新验证，creation plan `01d6db7a-b7a3-40ce-9965-0bbe5df12a9c` 仍在 active source verify 失败，并已按模块、函数组顺序成功补偿；独立 search 确认两对象均不存在。此结果否定该格式假设，相关 comparer 放宽已立即撤回，当前 comparer 保持原有严格规则。已确认的根因是诊断在 legacy-to-repository 适配器边界丢失：现在只透传经 schema 校验的 hash、行号和字节数，绝不透传源码或任意 details。需要重启后以全新身份取证；`ZVPFG3` / `ZVPFM3` / `ZVPFG4` / `ZVPFM4` 均不得重放。

2026-09-03 本地修复验证：`FUNCTION_MODULE` 源码比较器现同时支持 SAP 激活后的函数名大写归一化、签名首行带句号或省略句号的合法形式，以及签名分隔空行差异；正文、参数、注释和实现仍严格比较。安全 mismatch 诊断继续只暴露 hash、行号、字节数和行 hash。定向 46/46、全量 109 套件 774/774、`npm run build`、`check:repository-creation-coverage`（23 条完整 evidence）及 `git diff --check` 均通过。由于本次修改了源码和 `dist`，下一步需要一次硬重启后再进行只读健康检查；在重启前不创建新 SAP 身份，也不重放 `ZVPFG3/ZVPFM3/ZVPFG4/ZVPFM4`。

2026-08-29 补充：`ZVPSVB02` 的 v2 创建成功，但独立复读证明其仍为 `inactive`、`bindingCreated=false`；经明确授权删除后对象已缺失，CTS 唯一 `R3TR/SRVB/ZVPSVB02` 的 `OBJFUNC` 为空，cleanup 终态 `FAILED`，不得复用。代码现已补上标准 ADT activation，并强制验证 `active`、`bindingCreated=true`、`published=false` 和 active 配置；需重启后使用全新 `ZVPSVB03`。CTS 门禁未放宽，E071 未修改。

2026-08-29 后续：`ZVPSVB03` 已完整创建、激活并验证，但删除后 CTS 的 `SRVB` 与生成 `G4BA` 条目均为空 `OBJFUNC`，没有删除传播条目；Service Binding 停止继续制造身份，保持未晋级。阶段 5 已转入 CHDO：`ZVPCHDO01` 在 activation 前因 SAP working JSON 省略默认 `standard` category 而触发严格比较并安全补偿，无残留、无生成对象。比较器现仅规范化该默认省略，需重启后以 `ZVPCHDO02` 验证。

CHDO 最新结论：`ZVPCHDO02/03` 同样在 activation 前补偿。第三次脱敏诊断与离线哈希匹配精确证明目标把隐藏 `errorMessage` 规范化为 `CD/600`；target configuration 也声明该字段 `sap.adt.hidden=true`。公共输入已移除 `errorMessage`，适配器固定并冻结 active `CD/600`；需重启后使用全新身份验证，三个旧身份均不得复用。

`ZVPCHDO04` 已成功写入、复读和激活；独立证据确认 active CHDO 与 active 生成类 `ZCL_ZVPCHDO04_CHDO`。原计划因错误期待 FUGR 而终态 unknown，不得重放。代码现统一验证 SAP 生成 active Class，并新增只删除 CHDO、验证生成类由 SAP 级联消失的 cleanup 模式；需重启后先清理该现存对象，再用新身份形成 APPLIED 证据。

后续清理记录：`ZVPCHDO04` 的 CHDO 与生成 Class 已级联缺失，但 CTS 两条记录均为空 `OBJFUNC`，不晋级。`ZVPCDS05` BDEF 已删除且 search 为空，CTS 仅保留空 `R3TR/BDEF`，不晋级；两次均未修改 E071。

2026-08-25 已完成 `sap-dev` 硬重启，并确认 healthcheck session 重置、旧 plan 返回 `PLAN_NOT_FOUND`、三个 cleanup 工具实际可见。Wave 1 首个 `DDIC_DOMAIN ZVPD01` 已创建、激活、复读并独立确认删除；对象 search 已缺失，但 CTS task `S4HK900010` 合法保留 `R3TR/DOMA/ZVPD01`，旧 verifier 错误要求零条目，cleanup 历史计划终态保持 `FAILED` 且不得重放。

后续仍以“对象缺失 + 固定传输中唯一精确 `OBJFUNC=D` CTS 删除条目”为晋级标准；不得删除或修改 E071/E071K，不得删除或释放传输。`DDIC_LOCK_OBJECT`、Wave 3 CTS、Annotation Definition 权限、以及 Wave 2 未晋级类型均保持各自阻塞状态。所有列入 maturity manifest 的历史身份不得复用。

## 收尾状态矩阵

| 事实面 | 状态 |
| --- | --- |
| 代码 | `changed-and-verified`：阶段 1/2 与 CTS 删除条目修复通过门禁；`DDIC_DOMAIN` 已证据化晋级 |
| 运行态 | `verified-current`：31 类均有真实或明确 blocked 结果 |
| 文档 | `changed-and-verified`：设计、计划、handoff、matrix、phase gate 已对齐 |
| 规则 | `changed-and-verified`：AGENTS 指向当前 handoff 与基线 |
| 记忆 | `generated-read-only`：未修改 Codex memory |
| 工作区 | `pending`：大量用户/本轮未提交改动保留；未清场、未 commit |

