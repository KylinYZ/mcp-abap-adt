# Repository Creation Validation Campaign Matrix

固定范围：SAP DEV client 300；包 `Z001`；传输 `S4HK900009`；前缀 `ZV`。每行最多一次 apply；历史计划不得复用。清理未授权。

2026-08-24 只读冲突检查：除已完成的 `ZVDOM`、`ZVDE1` 外，表内其余目标在对应 ADT 类型下均返回 0 个结果。

| 顺序 | objectKind | 测试身份 | 依赖 | 当前状态 |
| ---: | --- | --- | --- | --- |
| 1 | `DDIC_DOMAIN` | `ZVDOM` | 无 | `APPLIED_ACTIVE_VERIFIED` |
| 2 | `DATA_ELEMENT` | `ZVDE1` | `ZVDOM` | `ACTIVE_READBACK_ONLY`；`VERIFIER_MISMATCH-001` |
| 3 | `DDIC_TABLE_TYPE` | `ZVTT1` | `CHAR(10)` | `APPLIED_ACTIVE_VERIFIED`；plan `66ec0518-0eb4-4d38-9a5c-092084420928` |
| 4 | `PACKAGE` | `ZVPKG` | 父包 `Z001` | `OUTCOME_UNKNOWN`；负责人参数拒绝；`LOCAL_VALIDATION-017` |
| 5 | `PROGRAM` | `ZVPROG` | 完整 REPORT 源码 | `APPLIED_ACTIVE_VERIFIED`；plan `1b1622b1-f3ea-4d75-9430-20d9e8aaa787` |
| 6 | `FUNCTION_GROUP` | `ZVFG1` + 首模块 `ZVFM0` | 完整 FUNCTION 源码 | `COMPENSATED`；`VERIFIER_MISMATCH-008` |
| 7 | `FUNCTION_GROUP_INCLUDE` | 父组 `ZVFG1`，suffix `Z01` | `ZVFG1` active；完整名仅取 preview/status | `DEPENDENCY_MISSING`：父组已补偿 |
| 8 | `FUNCTION_MODULE` | `ZVFM1` | `ZVFG1` active；完整 FUNCTION 源码 | `DEPENDENCY_MISSING`：父组已补偿 |
| 9 | `DDIC_STRUCTURE` | `ZVSTR1` | 字段使用 `ZVDE1` | shell-only readback；`REMOTE_UNKNOWN-009` |
| 10 | `DATABASE_TABLE` | `ZVTAB2` | `MANDT` + `ZVDE1` 键字段 | `COMPENSATED`；checks/write/activation succeeded, DDL formatting verifier mismatch；search absent；`VERIFIER_MISMATCH-031` |
| 11 | `DDIC_LOCK_OBJECT` | `ZVLOCK1` | active 主表 | `DEPENDENCY_MISSING`：Database Table 未保留 active 对象 |
| 12 | `DDIC_TYPE_GROUP` | `ZVTG1`、复测 `ZVTG2` | TYPE-POOL 源码 | 两次均 active shell-only；Location 未确认，计划源码未写；`REMOTE_UNKNOWN-010/027` |
| 13 | `MESSAGE_CLASS` | `ZVMSG3` | 消息 `001` | `APPLIED_ACTIVE_VERIFIED`；plan `c9f665b5-7f1a-42b1-b914-92fe6baf0262`；stateless shell/lock/source/activation verified |
| 14 | `LOGICAL_EXTERNAL_SCHEMA` | `ZVSCHEMA4` | 远端 schema `MCP_REMOTE_SCHEMA_4` | `APPLIED_ACTIVE_VERIFIED`；plan `69f4988d-444b-408b-a003-349f8d70a596`；active JSON verified |
| 15 | `NUMBER_RANGE_OBJECT` | `ZVNRO1` | 长度 Domain `ZVDOM` | `APPLIED_ACTIVE_VERIFIED`；plan `f31d89c8-5d61-4512-96e6-ea5e3c7aa531` |
| 16 | `ABAP_INTERFACE` | `ZVIF_CAMPAIGN`、`ZVIF2`、`ZVIF3` | public interface 源码 | 三次 active shell-only；ZVIF3 明确 HTTP 200/no Location；计划源码未写；`REMOTE_UNKNOWN-012/027/030` |
| 17 | `ABAP_CLASS` | `ZVCL_CAMPAIGN` | public final class 源码 | `OUTCOME_UNKNOWN`；active shell exists；`REMOTE_UNKNOWN-013` |
| 18 | `PROGRAM_INCLUDE` | `ZVINCL` | 完整 Include 源码 | `OUTCOME_UNKNOWN`；active shell/header only；`REMOTE_UNKNOWN-015` |
| 19 | `CDS_TYPE` | `ZVCDSTYPE2` | 独立 CDS type 源码 | `APPLIED_ACTIVE_VERIFIED`；plan `09f0ee65-00d0-4122-ba21-a42b9ab34032`；EXACT source |
| 20 | `CDS_ASPECT` | `ZVASPECT` | 独立 CDS aspect 源码 | `APPLIED_ACTIVE_VERIFIED`；plan `f0ab98fe-1b3f-4247-972d-dea0f17466e0` |
| 21 | `CDS_ANNOTATION_DEFINITION` | `ZVANNO1` | 独立 annotation definition 源码 | `TARGET_UNAVAILABLE-016`；SAP 授权拒绝 |
| 22 | `CDS_DATA_DEFINITION` | `ZVCDSROOT` | active Database Table | `DEPENDENCY_MISSING`：Database Table 未保留 active 对象 |
| 23 | `CDS_ACCESS_CONTROL` | `ZVDCL1` | `ZVCDSROOT` active | `DEPENDENCY_MISSING`：CDS root 未创建 |
| 24 | `CDS_METADATA_EXTENSION` | `ZVMDE1` | `ZVCDSROOT` active | `DEPENDENCY_MISSING`：CDS root 未创建 |
| 25 | `SERVICE_DEFINITION` | `ZVSRVDEF` | `ZVCDSROOT` active | `DEPENDENCY_MISSING`：CDS root 未创建 |
| 26 | `BEHAVIOR_DEFINITION` | `ZVCDSROOT` | 同名 root entity active | `DEPENDENCY_MISSING`：CDS root 未创建 |
| 27 | `CDS_ENTITY_BUFFER` | `ZVBUFFER` | `ZVCDSROOT` active | `DEPENDENCY_MISSING`：CDS root 未创建 |
| 28 | `SERVICE_BINDING` | `ZVSRVBIND` | `ZVSRVDEF` active | `DEPENDENCY_MISSING`：Service Definition 未创建 |
| 29 | `SAP_OBJECT_TYPE` | semantic `ZvObjectType7` / repo `ZVOBJECTTYPE7` | 无 | `APPLIED_ACTIVE_VERIFIED`；plan `be766b83-ed0a-46ed-943b-8ba18623d6f5`；active JSON verified；历史失败身份均不重放 |
| 30 | `SAP_OBJECT_NODE_TYPE` | root semantic/repo `ZvObjectType7` / `ZVOBJECTTYPE7`（ADT type `NONT/NOT`） | `RONT/ROT ZVOBJECTTYPE7` active | `APPLIED_ACTIVE_VERIFIED`；plan `3d7f2827-1bab-4e7b-97c9-c5365770852d`；root node 必须与父 RONT 同语义名 |
| 31 | `CHANGE_DOCUMENT_OBJECT` | `ZVCHDO` | active table、Message Class/001 | `DEPENDENCY_MISSING`：`ZVMSG3/001` 已满足，Database Table 缺失 |

## 停止与跳过

- `LOCAL_VALIDATION`、`VERIFIER_MISMATCH`、`DEPENDENCY_MISSING`、明确的 `TARGET_UNAVAILABLE`：记录后可转下一独立类型。
- `REMOTE_UNKNOWN`：只有独立只读证据确认对象状态明确，且没有锁、session 或传输风险时才可继续。
- 任何旧计划、超时计划、`OUTCOME_UNKNOWN` 计划均不得重放。
