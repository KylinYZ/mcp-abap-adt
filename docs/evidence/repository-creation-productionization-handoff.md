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

- 106 Jest suites
- 719 tests
- controlled 31 / pending 111 / `REAL_DEV_VERIFIED=0`

命令：

```powershell
npm test -- --runInBand --coverage=false
npm run build
npm run check:repository-creation-coverage
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

目标 SAP 对 Interface 返回 HTTP 200/no Location，但创建 active 空壳。必须先完成 Eclipse SFS 成功语义与 ownership 设计；不能直接接受所有 200。

历史空壳：`ZVIF_CAMPAIGN`、`ZVIF2`、`ZVIF3`、`ZVCL_CAMPAIGN`、`ZVINCL`、`ZVTG1`、`ZVTG2`。不得复用或自动删除。

### Database Table

`ZVTAB2`、`ZVTAB3`、`ZVTAB4` 均在 source/check/activation 后 active DDL compare 失败并补偿，search 均为空。严格 tokenizer 已排除纯空白和 CLNT/MANDT 输入差异。下一步先加安全 token mismatch 诊断，再允许一次新身份验证。

### Function Group

`ZVFG1 + ZVFM0` 已补偿且为空。需要 active source mismatch 诊断；Group 未通过前 Include/Module 均依赖缺失。

### DDIC Structure

`ZVSTR1` 为 active placeholder shell，计划 source 未写。需要目标 source check 协议。

### Package

父包返回 `responsible=SAP`，目标拒绝。需要 Eclipse 当前用户 responsible 契约，不能猜用户。

### Annotation Definition

目标 SAP 明确权限拒绝；需要管理员授权，代码不能绕过。

## 当前成功对象不要删除

清理未授权。特别保留：`ZVDOM`、`ZVDE1`、`ZVTT1`、`ZVPROG`、`ZVNRO1`、`ZVASPECT`、`ZVCDSTYPE2`、`ZVMSG3`、`ZVSCHEMA4`、`RONT/ROT ZVOBJECTTYPE7`、`NONT/NOT ZVOBJECTTYPE7`、`ZZMCP_VT_DOM`。

## 不得重放

所有出现在 `PROGRESS.md` / `BLOCKED.md` 的历史 plan，包括 preview timeout、`OUTCOME_UNKNOWN`、`COMPENSATED`、`COMPENSATION_FAILED`。新验证必须使用新身份、新 preview、新原生确认。

## 新会话推荐起点

先实现 validation-only Cleanup Workflow 和 maturity evidence gate，不要立即继续 SAP 写入。完成自动化和硬重启后，从 Wave 1 使用新的可清理验证身份，逐类完成 create → active read → transport → cleanup → absence → promotion。

## 收尾状态矩阵

| 事实面 | 状态 |
| --- | --- |
| 代码 | `changed-and-verified`：本轮修复通过 106/719 门禁 |
| 运行态 | `verified-current`：31 类均有真实或明确 blocked 结果 |
| 文档 | `changed-and-verified`：设计、计划、handoff、matrix、phase gate 已对齐 |
| 规则 | `changed-and-verified`：AGENTS 指向当前 handoff 与基线 |
| 记忆 | `generated-read-only`：未修改 Codex memory |
| 工作区 | `pending`：大量用户/本轮未提交改动保留；未清场、未 commit |

