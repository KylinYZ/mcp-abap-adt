# 同一未释放传输清理证据实施计划

依据：`docs/superpowers/specs/2026-08-31-same-open-transport-cleanup-evidence-design.md`

## 阶段 1：状态与 CTS 分类

1. 扩展 cleanup plan 状态，新增 `COMPLETED_LOCAL_ABSENCE`。
2. 把 CTS 验证从“只接受唯一 D”改为返回 disposition：`DELETION_ENTRY_VERIFIED` 或 `NEUTRAL_ENTRIES_VERIFIED`。
3. 每个冻结资源键只接受唯一精确条目；重复、缺失、异常 `OBJFUNC` 失败关闭。
4. 保持 DELETE unknown、对象残留、生成物残留的现有失败语义。
5. 更新 cleanup plan view、审计 stages 和单元测试。

验收：既有唯一 D 用例不变；唯一空条目进入本地缺失完成态；重复和缺失继续失败。

## 阶段 2：成熟度 manifest v2

1. 扩展 evidence 类型，记录 `preCreationAbsent`、cleanup mode、传输开放状态和 neutral entry 证明。
2. 兼容迁移现有 16 条 `DELETION_PROPAGATED` 正式证据。
3. 支持历史 `FAILED_AFTER_ABSENCE`，但只接受 `cleanup-transport` 失败且 DELETE/absence stages 完整的证据。
4. 强制 create 为 `APPLIED`、create/cleanup 独立 plan、相同 target/package/transport。
5. 增加跨传输、已释放、重复、缺失 pre-absence、unknown create 等负向测试。

验收：现有 16 类不降级；neutral 证据只有完整交叉条件下通过。

## 阶段 3：历史证据恢复

1. 从持久审计和现有文档只读恢复 Wave 3 的真实 creation plan ID、stages、目标 fingerprint 与传输状态。
2. 不修改历史计划终态，不编造缺失 ID。
3. 为证据完整的 CDS root、DCL、MDE、SRVD、BDEF、Service Binding 写入 manifest v2。
4. CHDO 保持未晋级，后续使用新身份完成正式 `APPLIED`。

验收：每条新增 maturity 记录均能追溯到真实 plan、active readback、cleanup 和 CTS neutral 证据。

## 阶段 4：Registry 与文档同步

1. 仅将证据完整的类型提升为 `REAL_DEV_VERIFIED`。
2. 更新 coverage、README、README.zh-CN、使用指南、PROGRESS、BLOCKED、matrix 与 handoff。
3. 冻结被替代和失败身份，防止重放。

验收：Registry、manifest、coverage 和文档成熟度计数完全一致。

## 阶段 5：验证与运行态加载

1. 运行定向 cleanup/evidence/registry 测试。
2. 运行全量 Jest、TypeScript build、coverage、runtime smoke 和 `git diff --check`。
3. 源码与 build 更新完成后仅请求一次 MCP 硬重启。
4. 重启后验证新 session、旧计划缺失和关闭 validation 后的新晋级类型 writable。
5. 再用全新 CHDO 身份完成正式创建与同传输清理闭环。

验收：自动化全绿；真实 DEV 与文档结论分层准确；无 E071/E071K 或传输写操作。
