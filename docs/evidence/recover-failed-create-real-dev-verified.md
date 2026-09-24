# recover-failed-create 受控恢复链——真实 DEV 端到端验证证据

- 日期：2026-09-24
- 系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）
- 工具链：`previewRepositoryObjectCleanup`（新增 `creationPlanId` 绑定）→ `applyRepositoryObjectCleanup`
- 脚本：`npm run test:recover-real-dev`（`scripts/recover-failed-create-real-dev-smoke.mjs`）
- 结论：**SMOKE OK**——失败创建计划绑定 → 半成品受控删除 → absence 复核 → 负例门控，全链真机通过

## 验证序列（终版 smoke 输出）

```text
PASS 创建计划冻结：37f3e1cf…
PASS 残留程序已直连预造（inactive，登记 S4HK900009）：ZPRGSMK3189
PASS apply 失败（残留目标已存在）：plan status=FAILED
PASS 恢复清理 preview：绑定 FAILED
PASS 恢复清理成功 + 缺席复核通过：ZPRGSMK3189（status=COMPLETED_LOCAL_ABSENCE）
PASS 负例 A：APPLIED 计划拒绝恢复绑定（POLICY_DENIED）
PASS 普通清理（无绑定）回归验证通过
PASS 负例 B：未知计划 PLAN_NOT_FOUND
SMOKE OK
```

## 场景构造（模拟真实残局）

1. 冻结 PROGRAM 创建计划（目标尚不存在）；
2. 直连 ADT（stateless）预造同名 inactive 程序并登记传输——等价于"另一会话创建
   到一半崩溃"的真实残局；
3. 对该计划 apply：创建前置断言目标已存在 → 计划收敛 `FAILED`（无补偿资源、
   无自动删除——未知结果即停止边界保持不变）;
4. `previewRepositoryObjectCleanup` 携带 `creationPlanId` 恢复绑定 → 受控删除半成品。

## 受控语义（实现层）

1. **绑定三重门控**（`bindRecoveryPlan`）：plan 必须存在于本地记录（未知 id
   PLAN_NOT_FOUND）；状态必须 ∈ {FAILED, OUTCOME_UNKNOWN, COMPENSATION_FAILED}
   （PREVIEWED/APPLYING/APPLIED/COMPENSATED/EXPIRED 一律 POLICY_DENIED）；清理目标
   的 objectKind/objectName 必须与计划一致（parentName 仅显式提供且不符时拒绝——
   legacy 适配器把包名填进 target.parentName，与清理语义的父级不同义）。
2. **inactive 容错解析**：绑定计划才允许 active 结构读取失败时回退 inactive
   （半成品通常从未激活），并冻结 `recoveryVersion: 'inactive'`；常规清理维持
   active-only 语义不放宽。apply 阶段按冻结版本重解析（状态漂移即安全终止）。
3. **溯源**：清理计划冻结 `recoveryOf`（creationPlanId/状态/主错误码），随
   preview.plan 与 review 返回，审计可查。
4. **传输零登记证据**：半成品删除后传输内容不变（从未激活 → 无 D 条目）——
   恢复绑定计划以 `NO_TRANSPORT_ENTRY_VERIFIED` + `COMPLETED_LOCAL_ABSENCE` 收敛
   （absence 复核已独立证明删除生效）；常规清理仍要求显式 D/中性登记（零登记
   依旧 VERIFICATION_FAILED，守卫不放宽）。
5. **删除链不变**：重验证 → 锁 → 单次 DELETE → UNLOCK（失败兜底）→ absence，
   DELETE 后异常仍按 OUTCOME_UNKNOWN 终止不重试。

## 门禁

- `npm test -- --runInBand`：162 suites / 1555 tests 全绿（含恢复绑定 7 个新用例）
- `npm run build`：通过
- `npm run check:repository-creation-coverage`：REAL_DEV_VERIFIED=28，证据零缺失
- `npm run check:vsp-capability-parity`：71 行校验通过（晋级后 MCP_SUPERSET=13）
