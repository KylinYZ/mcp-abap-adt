# 31 类仓库对象创建产品化设计

日期：2026-08-25  
目标仓库：`D:\MyDev\SAP\mcp-abap-abap-adt-api`

## 1. 决策

31 类对象采用“按对象族分批晋级”策略，不等待全部完成后统一开放，也不把 `SAP_MCP_REAL_DEV_VALIDATION` 当成永久使用入口。

一个对象类型只有在完成创建、适用的写入/锁/激活、active 或最终结果复读、传输归属、独立清理和清理后缺失复查后，才能晋级 `REAL_DEV_VERIFIED`。晋级后，该类型在正常 DEV `development` / `development-workbench` Profile 下可写，不再依赖验证开关；preview、原生确认、不可重放、QAS/PRD 禁写等现有安全边界保持不变。

## 2. 当前事实

31 类创建侧活动已经全部得到明确结果，权威状态见：

- `docs/evidence/repository-validation-campaign-matrix.md`
- `docs/evidence/real-dev-validation-phase-0-gate.md`
- `PROGRESS.md`
- `BLOCKED.md`

当前分布：

- 10 类 `APPLIED_ACTIVE_VERIFIED`
- 1 类 `ACTIVE_READBACK_ONLY`
- 5 类 active shell-only / unknown
- 2 类 `COMPENSATED`
- 2 类 target/local unavailable
- 11 类 `DEPENDENCY_MISSING`

自动化基线为 109 个 Jest suites、742 tests；覆盖清单为 controlled 31、pending 111、`REAL_DEV_VERIFIED=11`。Wave 1 的 11 类已全部证据化晋级，其余 20 类仍未晋级。

## 3. 正式可用的定义

正式可用不是“验证开关为 true”，而是同时满足：

1. capability `maturity='REAL_DEV_VERIFIED'`。
2. 当前系统是 DEV，Profile 为 `development` 或 `development-workbench`。
3. 名称、包、传输仍通过 `SafetyPolicy`。
4. `previewRepositoryObjectCreation` 冻结不可变计划。
5. `applyRepositoryObjectCreation` 继续要求 Server 管理的原生确认。
6. 一个计划只执行一次；超时、断连、未知远端结果绝不重放。
7. QAS、PRD、未知 role 仍只能读取。
8. 原始 `legacy-full` 写接口不作为正式受控创建实现。

`SAP_MCP_REAL_DEV_VALIDATION` 只保留两个用途：未晋级类型的受控验证，以及验证专用清理工具。全部 31 类完成后关闭。

## 4. 验证清理能力

当前创建 workflow 的 compensation 只处理 apply 失败，无法在创建成功并重启后执行独立清理。产品化需要增加一个仅限 DEV 验证活动的清理闭环：

- `previewRepositoryObjectCleanup`
- `applyRepositoryObjectCleanup`
- `getRepositoryObjectCleanupStatus`

清理工具要求：

- 仅在 `SAP_MCP_REAL_DEV_VALIDATION=true` 时可见和可调用。
- 只接受 `objectKind`、对象名和必要父对象标识，不接受 URL、XML、lock handle 或 `confirmed=true`。
- Server 重新搜索对象、读取 active 状态、包和传输归属，冻结 cleanup plan。
- apply 使用独立原生确认；创建确认不能授权删除。
- 仅删除当前验证前缀、包和传输范围内的对象。
- 依赖对象按逆序清理；未知删除结果停止，不自动重试。
- 清理后必须 search 缺失，并复核固定传输/task 中恰好保留一条匹配 `PGMID + OBJECT + OBJ_NAME` 的 CTS 删除条目；该条目用于把删除同步到 QAS/PRD，禁止为了“零残留”删除 E071 或整个传输。
- 正常生产使用不暴露这三个工具。

## 5. 成熟度证据

新增检查入库的 maturity evidence manifest。每个 `REAL_DEV_VERIFIED` 类型必须记录：

- objectKind / ADT type
- 创建计划证据 ID
- active/final readback 证据
- 创建时 transport evidence，以及清理后精确 CTS 删除条目仍保留的独立 evidence
- cleanup plan/evidence ID
- cleanup 后 search 缺失证据；不把合法 CTS 删除条目误判为仓库对象残留
- DEV target fingerprint 与日期
- 已解释的 SAP 默认值或规范化规则

测试必须保证：没有 evidence 的 capability 不能写成 `REAL_DEV_VERIFIED`；有 unresolved `OUTCOME_UNKNOWN` 的同一验证身份不能用于晋级；历史计划状态不得改写。

## 6. 分批对象族

### Wave 1：已有创建成功证据

`DDIC_DOMAIN`、`DATA_ELEMENT`、`DDIC_TABLE_TYPE`、`PROGRAM`、`MESSAGE_CLASS`、`LOGICAL_EXTERNAL_SCHEMA`、`NUMBER_RANGE_OBJECT`、`CDS_TYPE`、`CDS_ASPECT`、`SAP_OBJECT_TYPE`、`SAP_OBJECT_NODE_TYPE`

为每类使用新的可清理验证身份完成完整生命周期，按依赖逆序清理。通过一类就晋级一类，不等待整批完成。

### Wave 2：核心协议阻塞

`PACKAGE`、`FUNCTION_GROUP`、`FUNCTION_GROUP_INCLUDE`、`FUNCTION_MODULE`、`DDIC_STRUCTURE`、`DATABASE_TABLE`、`DDIC_TYPE_GROUP`、`ABAP_INTERFACE`、`ABAP_CLASS`、`PROGRAM_INCLUDE`

这一批先修协议或 verifier，再做真实完整生命周期。

### Wave 3：依赖链

`DDIC_LOCK_OBJECT`、`CDS_DATA_DEFINITION`、`CDS_ACCESS_CONTROL`、`CDS_METADATA_EXTENSION`、`SERVICE_DEFINITION`、`BEHAVIOR_DEFINITION`、`CDS_ENTITY_BUFFER`、`SERVICE_BINDING`、`CHANGE_DOCUMENT_OBJECT`

依赖顺序固定为 Database Table → Lock Object / CDS root → DCL、MDE、SRVD、BDEF、Buffer → Service Binding / Change Document。

### 外部阻塞

`CDS_ANNOTATION_DEFINITION` 需要目标 SAP 授权。代码不得伪装授权成功；权限未补齐前保持 `TARGET_UNAVAILABLE`。

## 7. 未解决根因的设计方向

### Source shell HTTP 200/no Location

不能把所有 HTTP 200 当成功。只有同步响应无传输异常，并通过 exact response identity、预先 absence、预期 URL inactive readback、包/描述/类型/current user 和传输归属共同证明 ownership 后，才能进入源码写入。任一证据缺失仍为 `OUTCOME_UNKNOWN`。

### Database Table active DDL

现有严格 tokenizer 已排除纯格式差异，但真实 active DDL 仍不一致。下一次尝试前先增加不泄露源码的 token mismatch 诊断（首个差异 token class、索引和两侧 hash），再依据现场证据实现最小规范化。不得继续无证据放宽。

### Package responsible

不能复制父包的 `responsible=SAP`。应按 Eclipse 创建逻辑使用当前认证用户，并通过目标用户/validation 契约确认其有效性；没有权威证据时 preview 失败关闭。

### Function Group 与 Structure

Function Group 先捕获 active source 的安全差异摘要，再修 module/group verifier。Structure 必须在 PUT 前运行目标支持的 source check，返回脱敏诊断；不能继续创建 placeholder shell 后才发现源码不可保存。

## 8. 发布门槛

每次 maturity 晋级必须通过：

- 相关定向测试
- `npm test -- --runInBand --coverage=false`
- `npm run build`
- `npm run check:repository-creation-coverage`
- `git diff --check`
- 新 MCP 进程验收：旧 plan `PLAN_NOT_FOUND`、healthcheck session 重置
- 真实 DEV 创建、active/final 复读、传输复核、独立清理、缺失复查

没有完成清理的类型可以记录创建侧成功，但不能晋级 `REAL_DEV_VERIFIED`。

## 9. 非目标

- 不扩大到剩余 111 个 Eclipse wizard 类型。
- 不改变 QAS/PRD 只读边界。
- 不开放文字确认、调用方布尔确认或 raw create/delete。
- 不删除本轮已有对象，除非获得单独清理确认。
- 不把历史 `OUTCOME_UNKNOWN` 改写成成功。

