# 类 include 受控写入链真机验证——通过（source.class-include → MCP_SUPERSET）

- 验证日期：2026-09-16
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：`scripts/class-include-real-dev-smoke.mjs`
- 审计日志：`D:\SAP-MCP\audit\dev\abap-change-audit.jsonl`

## 结论

受控变更链（`previewAbapChange` / `applyAbapChange` / `getAbapChangeStatus`）的
`classInclude` 参数已在真实 DEV 系统端到端验证：对自建类 ZVCLINCSMK 的
definitions include 真实写入、激活并复查一致，smoke 输出 `SMOKE OK`（17 项断言
全 PASS）。矩阵行 `source.class-include` 由 PARTIAL 晋级 **MCP_SUPERSET**
（同一任务 + immutable plan/原生确认/漂移校验/回滚等安全超集），evidence 追加
`real-dev-verified`。

## 实现摘要（最小改动复用整条受控链）

- `src/safe/types.ts`：`ClassIncludeKind`（definitions/implementations/macros/testclasses）
  与 `ResolvedAbapObject.classInclude`。
- `src/safe/AbapObjectResolver.ts`：`resolve(type, name, classInclude?)` —— include
  可写源 URL 从类 structure 的 `class:includeType` 条目只读解析；锁/激活仍归属父类；
  缺 include 给确定性错误（testclasses 缺失时指引 createTestInclude）。
- `src/safe/AbapChangeWorkflow.ts`：`PreviewChangeInput.classInclude` 透传；
  preview/apply/rollback/漂移校验/激活全链不变（全部键于 plan 冻结的 sourceUrl）。
- `src/safe/AbapChangeConfirmation.ts`：确认消息显式标注 include 粒度
  （`ZVCLINCSMK（definitions include）`），防误批。
- `src/handlers/SafeAbapHandlers.ts`：`previewAbapChange` 增加可选枚举参数并透传。
- 自动化：resolver（四种粒度/缺失/非法值/非 CLASS）/workflow（plan 冻结与 apply
  复用）/confirmation（消息标注）/handler（透传）四层 +12 tests。

## 验证链路（最终干净运行，全部 PASS）

| 环节 | 结果 |
| --- | --- |
| 三工具进入 DEV workbench 运行时 catalog；healthcheck DEV/300 | PASS |
| 受控创建 ABAP_CLASS ZVCLINCSMK（Z001 + S4HK900009，原生确认） | PASS |
| `previewAbapChange(classInclude='definitions')` 冻结 plan：sourceUrl=`/sap/bc/adt/oo/classes/zvclincsmk/includes/definitions`、classInclude=definitions、锁=父类 | PASS |
| 写前只读复查：include 原始内容（165 字符标准模板） | PASS |
| `applyAbapChange`（确认消息同时含对象名与 "definitions include" 标注）→ plan 终态 APPLIED | PASS |
| apply 链含 SOURCE_VERIFIED（激活后源 readback 匹配） | PASS |
| 独立只读直读（绕开工具缓存）：include 内容 == 写入标记 | PASS |
| 负例：PROGRAM + classInclude → VALIDATION_FAILED | PASS |
| 受控清理 + absence 复查（系统已无 ZVCLINCSMK，零残留） | PASS |

## 审计关键事件（ZVCLINCSMK，confirmationMode=elicitation）

三轮完整 include 变更 apply（前两轮为脚本断言修正过程中的重复验证）均呈现：
`PREVIEW_CREATED → APPLY_STARTED → SOURCE_REVALIDATED → OBJECT_LOCKED →
SOURCE_WRITTEN → POST_WRITE_SYNTAX_PASSED → OBJECT_UNLOCKED → OBJECT_ACTIVATED →
SOURCE_VERIFIED → APPLY_COMPLETED`；创建/清理链为
`REPOSITORY_CREATION/CLEANUP_CONFIRMATION_PENDING → CONSUMED`。

## 过程记录（对后续 smoke 有复用价值）

1. 真实系统的 include 源 URI 形如 `/includes/definitions`（mock 假设的
   `/source/definitions` 不成立）；断言语义应为「definitions 源资源且归属该类」。
2. `getObjectSource` 带分页参数会命中工具层缓存（`sourceOrigin:"cache"`）；写后
   独立复查必须无分页参数直读 SAP。
3. 该 DEV 版本新类也暴露 testclasses include——四种粒度全可解析（原以为缺失）；
   「缺失 include」容错路径保留在自动化测试中。
4. 一次创建 apply 返回 UNKNOWN_OUTCOME（DEV 慢时段 ~81s 响应超时）；按边界用
   只读探针确认对象实际已创建并激活，未盲目重试/删除；后续轮次正常完成。
5. 残留清理脚本 `scripts/cleanup-zvactsmoke-residue.mjs` 已参数化支持
   PROGRAM/ABAP_CLASS。

## 系统遗留状态

无：ZVCLINCSMK 已清理（absence 复查 0 命中）；include 标记随整类删除。
