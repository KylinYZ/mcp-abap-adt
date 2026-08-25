# 阶段 0 真实 DEV 验证门记录

日期：2026-08-20  
状态：`REAL_DEV_VALIDATION_GATE_READY`（尚未达到 `REAL_DEV_VERIFIED`）

## 目标

在隔离 DEV 中验证首批已实现的四类 DDIC 对象，并在每类完成创建、状态复读、传输核验和清理后，才单独提升该类的成熟度。能力目录在此之前保持 `writable=false`。

## 已完成的只读前置（2026-08-20 快照）

| 项目 | 结果 |
| --- | --- |
| 系统角色/Profile | DEV / `development-workbench`（以运行时身份为准） |
| 测试包 | `Z001` 存在 |
| 传输 | `S4HK900009`（由用户确认，未由本记录创建或释放） |
| 隔离前缀 | `ZZMCP_VT_` |
| 目标对象 | `ZZMCP_VT_DOM`、`ZZMCP_VT_DE`、`ZZMCP_VT_TT`、`ZZMCP_VT_TAB` 均不存在 |
| 远端 mutation | 未执行创建、锁定、PUT、激活、解锁或删除 |

## Preview 复核结果（2026-08-20）

修复 MCP preview schema 和 TTYP validation 媒体类型后，四类计划均在真实 DEV 目标完成只读 preview；没有执行 apply、锁定、PUT、激活、解锁或删除。计划只存在于独立 MCP 子进程内存中，进程关闭后不可继续 apply。

| 对象类型 | 对象名 | Preview | 计划哈希前缀 |
| --- | --- | --- | --- |
| `DDIC_DOMAIN` | `ZZMCP_VT_DOM` | `status=preview` | `49aff1d0009a4578` |
| `DATA_ELEMENT` | `ZZMCP_VT_DE` | `status=preview` | `201dcc94bc55386d` |
| `DDIC_TABLE_TYPE` | `ZZMCP_VT_TT` | `status=preview` | `76adf0b022575024` |
| `DATABASE_TABLE` | `ZZMCP_VT_TAB` | `status=preview` | `e13dc6054d37cf43` |

四项均无未知结果；真实写入仍需在支持 `elicitation.form` 的客户端中逐项确认后才能开始。

## 原生确认通道复核（2026-08-20）

本地 stdio 测试客户端初始化能力为 `{}`，未声明 `elicitation.form`。对 `DDIC_DOMAIN` 的一次 apply 尝试在确认门返回 `CONFIRMATION_UNSUPPORTED`，未进入创建 workflow，也未执行 SAP 创建、锁定、PUT、激活、解锁或删除。不得用自动确认或文字降级替代原生表单。

重启后的 MCP 宿主虽然已暴露五个仓库创建工具，但一次 `DDIC_DOMAIN` apply 在原生确认后没有回传。按安全规则停止等待并使用独立只读 ADTClient 核验：`searchObject` 为空，直接 GET `/sap/bc/adt/ddic/domains/zzmcp_vt_dom?version=active` 返回 `404 Not Found`，传输 `S4HK900009` 及其 task 中均无该对象。因此已确认本次创建未发生，不属于 `OUTCOME_UNKNOWN`；原计划不得复用，后续必须重新 preview。

重新启动会话后的第二个全新计划（`6f27c4ba-04b1-4a1e-9d5d-0d0b843b58ce`）也在用户选择 `apply` 后没有回传。独立只读核验再次确认 `ZZMCP_VT_DOM` 不存在，传输仍可修改且对象清单没有该域；未执行重试、激活、锁定、写入、删除或清理。当时的阻塞点被判断为宿主 elicitation 响应未传回 MCP server；2026-08-24 后续排查又发现仓库 apply 的 execution-gate 重入自锁，见下节。

## Windows 确认与 gate 自锁修复（2026-08-24）

仓库对象创建改用 Server 固定的 `windows-native` provider：Explorer broker 在交互桌面启动中文 WinForms 窗口，结果经一次性 Windows named pipe 返回；helper 不持有 SAP 凭据，也不开放 TCP 端口。无 SAP 隔离测试分别得到严格的 `cancel` 与 `apply` 响应。

真实 Codex Desktop 取消路径使用全新计划 `f9158ff3-b7cb-4a3c-a362-f46883932ce1`，用户点击取消后，原始 `tools/call` 在 18.6 秒内返回 `confirmation_declined`；同一 session 随后的状态查询立即成功，对象搜索为空。确认路径此前仍会挂起，最终定位为同一个 `ToolExecutionGate` 的重入自锁：外层 `applyRepositoryObjectCreation` 占用默认唯一 SAP 槽，确认后 `applyConfirmed` 又等待该 gate 执行 workflow，形成外层等待内层、内层等待外层。修复后 repository apply 和本地 status 不占外层 gate，只有确认后的完整 SAP workflow 进入 gate 一次，并增加了专门回归测试。

## DDIC Domain 真实创建证据（2026-08-24）

在精确验证范围 `DDIC_DOMAIN` / `ZZMCP_VT_` / `Z001` / `S4HK900009` 下生成全新计划 `c1967732-b1c1-4d49-9802-5a030699c952`，用户在 Windows 原生窗口确认创建。计划记录以下远端阶段成功：

- `REVALIDATE_ABSENCE`
- `VALIDATE_TRANSPORT`
- `CREATE_SHELL`
- `RESOLVE_CREATED_OBJECT`
- `LOCK_RESOURCE`
- `WRITE_PROPERTIES`
- `UNLOCK_RESOURCE`
- `ACTIVATE_OBJECT`

Server 随后把计划标记为 `OUTCOME_UNKNOWN`，错误为 active DDIC 属性与计划不匹配；按安全规则没有重试、删除或补偿。独立只读 `searchObject` 已确认 `ZZMCP_VT_DOM` 存在于包 `Z001`，active `getDomainProperties` 返回描述 `MCP confirmation apply-path verification`，类型 `CHAR`、长度 10、小数位 0，输出长度 10，`signExists=false`、`lowercase=false`、`ampmFormat=false`。这些核心属性与确认计划一致；差异仅是 SAP 把调用方省略的可选 `valueInformation` 物化为 `{ valueTableRef: "", appendExists: false }`。

验证器已修复为只把“省略该块”和上述空默认值视为等价；非空值表、固定值或 append 标志仍严格比较。历史计划保持原始 `OUTCOME_UNKNOWN`，不回写为成功。

当前结论是“真实创建和 active 属性复读已确认，清理未完成”。`ZZMCP_VT_DOM` 仍存在于 DEV，尚未核验独立清理和清理后的传输状态，因此 `DDIC_DOMAIN` 仍为 `CONTROLLED_IMPLEMENTED`、目录仍为 `writable=false`、`REAL_DEV_VERIFIED` 仍为 0。31 类活动最终分布和产品化入口见本文件后续章节及 `repository-creation-productionization-handoff.md`。最新自动化基线为 106 个 Jest suites / 719 tests。

## 31 类活动首批结果（2026-08-24）

活动重启后，错误前缀 `ZBADDOM` 的 preview 在本地以 `POLICY_DENIED/validation` 拒绝。第一类 `DDIC_DOMAIN ZVDOM` 的计划 `3d07dd81-6c64-4a72-82cc-c0f915d4d8be` 完整返回 `APPLIED`；创建、锁定、属性写入、解锁、激活、active 对象复读和属性复读均成功，独立 `searchObject` 与 `getDomainProperties(active)` 确认包 `Z001`、`CHAR(10)` 和输出标志与计划一致。

第二类 `DATA_ELEMENT ZVDE1` 引用 `ZVDOM`。计划 `8cdd9118-9f44-4511-b3eb-6072d363db65` 完成创建、锁定、属性写入、解锁和激活后进入 `OUTCOME_UNKNOWN`；没有重试或删除。独立只读结果确认 `ZVDE1` 已 active，包、Domain、`CHAR(10)` 和标签文本与计划一致。差异是 SAP 自动补充标签长度 `10/20/40/55` 及四个默认 `false`。验证器已只规范化省略值与这些 SAP 默认值，非默认标志仍严格拒绝；历史计划保持 `OUTCOME_UNKNOWN`，不重放。

## 执行顺序

创建顺序：`DDIC_DOMAIN` → `DATA_ELEMENT` → `DDIC_TABLE_TYPE` → `DATABASE_TABLE`  
清理顺序：`DATABASE_TABLE` → `DDIC_TABLE_TYPE` → `DATA_ELEMENT` → `DDIC_DOMAIN`

每类必须单独生成计划并通过一次可信原生确认；Windows 使用 `windows-native` provider，其他受支持客户端可使用 MCP form。创建确认不授权后续清理。任何超时、断连或响应不足以判定成功/失败时，记录 `OUTCOME_UNKNOWN`，只读调查后停止，不重试、不盲删。

## SAP Object Type 创建侧真实证据（2026-08-25）

在多轮仅使用全新身份的协议修复后，计划 `be766b83-ed0a-46ed-943b-8ba18623d6f5` 对 `ZvObjectType7` / `ZVOBJECTTYPE7` 完成 `APPLIED`。真实阶段覆盖 Blue v2 shell、inactive metadata/JSON、activation、active metadata/JSON；独立 search 与 active 复读确认对象位于 `Z001`，类别为 `technicalObject`，语义名、描述和原始语言与确认计划一致。目标 SAP 合法省略 optional `objectTypeCode`。

此前发现并修复三类协议差异：Blue additional content 属性必须使用 `adtcore:encoding`/`adtcore:type`；HTTP 201 + canonical Location 可伴随空响应体；`objectTypeCode` 在 inactive/active 均为 optional，但存在时必须受限且不能从 inactive 漂移。历史失败/补偿计划全部保留且从未重放。

本证据只证明创建侧、激活和复读成功。`ZVOBJECTTYPE7` 尚未清理，传输未释放，因此能力仍保持 `CONTROLLED_IMPLEMENTED`、`writable=false`、`REAL_DEV_VERIFIED=0`。

## SAP Object Node Type 创建侧真实证据（2026-08-25）

父 `RONT/ROT ZVOBJECTTYPE7` active 后，SAP validation 证明 root node 必须与父对象使用相同语义名。计划 `3d7f2827-1bab-4e7b-97c9-c5365770852d` 随后以 `ZvObjectType7` 创建独立的 `NONT/NOT ZVOBJECTTYPE7`，完成父引用重验、Blue v2 shell、inactive JSON、激活及 active JSON 复读并返回 `APPLIED`。

独立 search、active structure 和 source JSON 确认对象位于 `Z001`，`name=ZvObjectType7`、`sapObjectType=ZvObjectType7`、`rootNode=true`。未执行 NONT 或 RONT 清理，传输未释放，因此只记为创建侧成功，不提升 `REAL_DEV_VERIFIED`。

## 尚待完成

## 31 类活动最终创建侧分布（2026-08-25）

- `APPLIED_ACTIVE_VERIFIED`：10 类。
- `ACTIVE_READBACK_ONLY`：1 类。
- active shell-only / unknown：5 类，所有历史计划均不重放。
- `COMPENSATED`：2 类，独立 search 确认无目标残留。
- target/local unavailable：2 类。
- `DEPENDENCY_MISSING`：11 类；主要由 Database Table 和 Function Group 未保留 active 父对象引起。
- 自动化门禁：106 suites / 719 tests；创建覆盖清单为 controlled 31、pending 111、`REAL_DEV_VERIFIED=0`。

`LOGICAL_EXTERNAL_SCHEMA ZVSCHEMA4`、`CDS_TYPE ZVCDSTYPE2`、`MESSAGE_CLASS ZVMSG3`、`SAP_OBJECT_TYPE ZVOBJECTTYPE7` 和 `SAP_OBJECT_NODE_TYPE ZVOBJECTTYPE7` 均已在本轮完成创建、激活和独立 active 复读。Database Table 连续三次在 active DDL 复核失败并全部补偿，按活动规则停止；其下游统一记录依赖缺失。

## 尚待完成

- 当前 `sap-dev.env` 的 `SAP_MCP_REAL_DEV_VALIDATION=true`，31 类、`ZV`、`Z001`、`S4HK900009` 白名单仍在运行。关闭后，尚未晋级 `REAL_DEV_VERIFIED` 的仓库对象将不能继续通过该验证通道创建。
- 是否关闭临时验证开关需由用户决定；在决定前保持当前运行状态，不修改 QAS/PRD。
- 所有现存对象清理仍未授权；创建确认不构成删除授权。若未来清理，需单独确认并按依赖逆序执行。
- Source Object/Type Group 的 HTTP 200/no-Location ownership、Database Table active DDL 差异、Function Group source mismatch、Package responsible discovery 和 Annotation Definition 授权仍需独立后续工作。
