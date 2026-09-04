# 同一未释放传输清理证据双模式设计

日期：2026-08-31

## 背景

仓库对象产品化当前把“对象缺失 + 唯一 `OBJFUNC=D` CTS 条目”作为统一清理门禁。真实 DEV 证据表明，该规则适用于已经存在于下游系统、需要传播删除的对象，但不适用于在同一未释放传输中完成“创建 → 验证 → 删除”的临时验证对象。

Wave 3 对象均已由 SAP 成功删除并独立 search 缺失，CHDO 生成 Class 也已由 SAP 级联删除；task `S4HK900010` 保留精确对象条目，但 `OBJFUNC` 为空。对象从未通过该未释放传输进入下游系统，因此不存在需要传播的下游删除。

## 目标

把清理证据分成两个互斥模式：

1. `DELETION_PROPAGATED`：对象此前可能存在于下游，必须验证唯一 `OBJFUNC=D`。
2. `SAME_OPEN_TRANSPORT_REMOVED`：对象创建前不存在，在同一未释放传输中创建并删除，允许精确 CTS 对象条目的 `OBJFUNC` 为空。

双模式只改变清理证据解释，不修改历史计划终态，不放宽创建、激活、active readback、依赖复核、原生确认、对象缺失或 QAS/PRD 写保护。

## 非目标

- 不把“search 为空”单独视为完整产品化证据。
- 不允许调用方声明或选择清理模式。
- 不修改 E071/E071K，不删除或释放传输。
- 不把 `OUTCOME_UNKNOWN` 创建计划改写成 `APPLIED`。
- 不允许异常重复 CTS 对象键、跨传输创建/删除或已释放传输进入同传输模式。

## 事实与术语

### 删除传播模式

适用于既有对象、已经释放或可能进入下游的对象。清理后必须保留唯一精确的 `OBJFUNC=D` 对象键，证明下游导入时会执行删除。

### 同传输移除模式

仅在以下条件全部满足时成立：

- 创建计划在写入前记录 `REVALIDATE_ABSENCE=true`。
- 创建计划终态为 `APPLIED`。
- 创建与清理绑定相同 SAP host、client、用户、包、对象类型、对象名和传输请求。
- 传输在创建和清理时均为未释放状态。
- active/final readback 与对象类型要求全部通过。
- cleanup 已记录远端 DELETE 成功。
- cleanup 后对象和所有冻结生成物/依赖生成资源均独立缺失。
- 每个预期 CTS 对象键恰好出现一次，`OBJFUNC` 为空；不存在异常重复或未知 companion key。

同传输模式证明的是“验证对象已从 DEV 移除，且从未形成需要下游删除的已发布生命周期”，不声称存在删除传播。

## 运行时状态设计

### Cleanup 终态

保留现有 `COMPLETED` 表示 `DELETION_PROPAGATED`。新增非错误终态：

- `COMPLETED_LOCAL_ABSENCE`：DELETE、对象缺失、生成物缺失和精确 neutral CTS 条目已验证，但是否可用于成熟度晋级仍需与创建证据交叉校验。

cleanup workflow 不自行推断创建前是否存在，也不接受调用方传入创建计划 ID。它只记录可独立观察的清理事实：

- `OBJECT_DELETED`
- `ABSENCE_VERIFIED`
- 可选 `CASCADE_ABSENCE_VERIFIED`
- `transportDisposition=DELETION_ENTRY_VERIFIED` 或 `NEUTRAL_ENTRIES_VERIFIED`
- 冻结的 CTS 对象键集合及重复检查结果

### CTS 判断

对每个冻结资源键：

- 恰好一条 `OBJFUNC=D`：`DELETION_ENTRY_VERIFIED`。
- 无 `D`，但恰好一条 `OBJFUNC` 为空：`NEUTRAL_ENTRIES_VERIFIED`。
- 缺失、重复、非空且非 `D`、对象名/类型漂移：失败关闭。

类型化 companion 资源必须显式冻结：

- Service Binding：`SRVB` 与 SAP 生成的 `G4BA`。
- Change Document Object：`CHDO` 与冻结生成 `CLAS`。
- 其他类型只验证各自直接资源；历史无关同名类型条目不计入该资源键。

## 成熟度证据设计

升级 maturity manifest 到 schema version 2，固定新增清理传输模式和创建前缺失证明：

```json
{
  "create": {
    "planId": "...",
    "status": "APPLIED",
    "preCreationAbsent": true
  },
  "transport": {
    "request": "S4HK900009",
    "packageName": "Z001",
    "cleanupMode": "SAME_OPEN_TRANSPORT_REMOVED",
    "transportOpenAtCreate": true,
    "transportOpenAtCleanup": true,
    "neutralEntriesVerified": true
  },
  "cleanup": {
    "planId": "...",
    "status": "COMPLETED_LOCAL_ABSENCE",
    "objectDeleted": true
  },
  "absence": {
    "searchAbsent": true,
    "generatedResourcesAbsent": true
  }
}
```

旧的 `DELETION_PROPAGATED` 记录继续要求 `deletionEntryVerified=true`。cleanup evidence status 固定允许 `COMPLETED`、`COMPLETED_LOCAL_ABSENCE` 和仅供历史迁移的 `FAILED_AFTER_ABSENCE`。两种模式共享相同 target fingerprint、独立 create/cleanup plan、active readback 和 evidenceRef 校验。

### 历史计划

历史 `FAILED`、`OUTCOME_UNKNOWN`、`COMPENSATED` 状态永不修改。对旧 cleanup 在 `cleanup-transport` 失败、但已记录 DELETE 与 absence 的情况，manifest 可使用证据状态 `FAILED_AFTER_ABSENCE`，前提是：

- 失败阶段严格等于 `cleanup-transport`。
- stages 已包含成功的 DELETE 与 absence。
- 当前独立 search 仍为空。
- neutral CTS 对象键可由只读证据精确复核。
- 创建计划仍必须为真实 `APPLIED`；缺少真实计划 ID 时不得编造或晋级。

## 历史结果重新评估

### 可重新评估

- `CDS_DATA_DEFINITION`：选择一条完整且可恢复真实创建 plan ID 的 `ZVPCDS02/03/05` 证据。
- `CDS_ACCESS_CONTROL ZVPDCL02`
- `CDS_METADATA_EXTENSION ZVPMDE03`
- `SERVICE_DEFINITION ZVPSRV01`
- `BEHAVIOR_DEFINITION ZVPCDS05`
- `SERVICE_BINDING ZVPSVB03`

这些类型的创建、active readback、DELETE 和 absence 已完整；实现阶段必须先从现有审计/证据恢复准确创建 plan ID，不能用占位符。

### 不因本规则直接晋级

- `DDIC_DOMAIN ZVPD01`：同类旧门禁误判，但该类型已由 `ZVPD02` 正式晋级。
- `DATABASE_TABLE ZVPTAB01`：存在重复 `R3TR/TABL` 对象键；不满足 neutral 精确唯一条件，且该类型已由 `ZVPTAB02` 晋级。
- `SERVICE_BINDING ZVPSVB02`：创建后仍 inactive，创建证据不完整。
- `CHANGE_DOCUMENT_OBJECT ZVPCHDO04`：清理证据满足 neutral 模式，但创建计划终态为 `OUTCOME_UNKNOWN`；本设计不允许其晋级，必须用新身份完成正式 `APPLIED`。
- Lock Object、Structure、ABAP Class、Function Group/Module、Entity Buffer、Annotation Definition 等其他阻塞与 CTS neutral 模式无关。

## 错误处理

- cleanup DELETE 结果未知：仍为 `OUTCOME_UNKNOWN`，不读取 CTS 来覆盖未知写结果。
- 对象或生成物仍存在：失败，不能进入任一完成模式。
- neutral 条目重复或缺失：失败，不能自动降级为本地完成。
- 创建与清理传输不同、传输已释放、缺少 pre-absence 或 create 非 `APPLIED`：maturity gate 拒绝晋级。
- 历史 evidenceRef 或 plan ID 缺失：保持未晋级，先恢复真实证据或使用新身份验证。

## 测试设计

### Cleanup workflow

- 保留唯一 `D` 的既有成功用例。
- 唯一空条目返回 `COMPLETED_LOCAL_ABSENCE`。
- 空条目重复、缺失、异常值均失败。
- CHDO/SRVB companion 键必须全部唯一且一致。
- 生成物残留时，即使 CTS neutral 也失败。

### Maturity gate

- `DELETION_PROPAGATED` 继续接受现有 16 条证据。
- `SAME_OPEN_TRANSPORT_REMOVED` 仅在完整交叉证据下通过。
- 缺少 pre-absence、create 非 `APPLIED`、跨传输、已释放、重复条目、旧 unknown plan 均拒绝。
- schema migration 后现有 16 条 `REAL_DEV_VERIFIED` 不降级。

### Runtime smoke

- validation 开启时 cleanup 工具仍只在 DEV development profiles 可见。
- validation 关闭时 cleanup 工具隐藏。
- QAS/PRD 永不获得写能力。

## 推进顺序

1. 升级 cleanup 状态与 CTS disposition。
2. 升级 maturity manifest schema 和校验器。
3. 迁移现有 16 条正式证据，不改变成熟度。
4. 只读恢复 Wave 3 精确创建 plan ID 与 neutral CTS 对象键。
5. 重新评估并晋级证据完整的 6 类。
6. 用全新 CHDO 身份完成 `APPLIED` 和同传输清理闭环。
7. 更新 Registry、coverage、README、使用指南、PROGRESS、BLOCKED 和 handoff。
8. 源码/build 更新后仅进行一次必要 MCP 重启，再验证关闭 validation 后的正常 DEV writable 状态。

## 验收标准

- 同传输临时验证对象不再因缺少 `OBJFUNC=D` 被误判失败。
- 既有或已下传对象仍必须提供唯一删除传播条目。
- 历史计划状态保持不可变且不可重放。
- 现有 16 类正式证据不回退。
- 所有新晋级类型拥有真实 plan ID、active readback、同传输证明、DELETE、absence、精确 CTS neutral 条目与目标 fingerprint。
