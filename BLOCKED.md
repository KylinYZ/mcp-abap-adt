# 当前阻塞与历史索引

更新时间：2026-09-04

本文件只保留仍影响下一步行动的阻塞；已解决问题的过程证据保留在 `docs/evidence/` 与 `CHANGELOG.md`。历史计划和身份均不可重放。

## 当前阻塞

### `DDIC_LOCK_OBJECT` — 依赖证据不足

代码和自动化 adapter 已完成，当前成熟度为 `CONTROLLED_IMPLEMENTED`。真实 DEV 晋级需要一张可验证的 active 主表、完整 create/readback/cleanup/absence 和传输证据。未满足前不开放写入，也不执行数据库或 E071/E071K 修改。

### `CDS_ANNOTATION_DEFINITION` — 目标授权拒绝

真实 DEV 已返回明确的“无权创建 Annotation Definition”。这是 SAP 目标权限问题，代码不能绕过。管理员补齐最小授权后，必须使用全新对象身份和新 preview 复测。

### `CDS_ENTITY_BUFFER` — 缺少可用依赖

当前没有满足目标约束的 active CDS 实体可供 buffer。准备好专用 active CDS 依赖后，才可进行新的只读 preview 和真实验证。

## 操作红线

- QAS、PRD、缺失和未知系统角色只读。
- 远端结果不明确、锁状态不明确或传输证据不完整时停止，不重试、不自动删除。
- 不删除现有 SAP 对象，不释放传输，不修改 E071/E071K，不执行数据库写操作。
- 真实验证必须经过 server preview、一次原生确认和一次 apply；cleanup 使用独立确认。

## 历史 issue 索引

以下 issue 已解决、已补偿或已被当前实现吸收，仅供追溯：

`VERIFIER_MISMATCH-001`、`TARGET_UNAVAILABLE-002`、`LOCAL_VALIDATION-003`–`006`、`GOAL_BLOCKED-007`、`VERIFIER_MISMATCH-008`、`REMOTE_UNKNOWN-009`–`015`、`TARGET_UNAVAILABLE-016`、`LOCAL_VALIDATION-017`、`TARGET_UNAVAILABLE-018`、`LOCAL_VALIDATION-019`–`022`、`TARGET_UNAVAILABLE-023`、`VERIFIER_MISMATCH-024`–`026`、`REMOTE_UNKNOWN-027`–`030`、`VERIFIER_MISMATCH-031`–`033`。

每个 issue 的原始计划号、对象身份和证据仍可从 Git 历史及对应的 `docs/evidence/` 文档追溯；不要把历史状态当作当前目录状态。
