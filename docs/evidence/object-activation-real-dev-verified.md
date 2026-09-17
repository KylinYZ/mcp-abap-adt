# 受控对象激活链真机验证——通过（devtools.activate → EQUIVALENT）

- 验证日期：2026-09-16
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：`scripts/object-activation-real-dev-smoke.mjs`（目标 ZVCL_CAMPAIGN）
- 审计日志：`D:\SAP-MCP\audit\dev\abap-change-audit.jsonl`
- 历史过程（部分验证与三次失败补跑）：`object-activation-real-dev-partial-verified.md`

## 结论

受控激活链三工具（`previewObjectActivation` / `applyObjectActivation` /
`getObjectActivationStatus`）已在真实 DEV 系统完成端到端验证，smoke 输出
`SMOKE OK`，审计出现完整 `PREVIEW_CREATED → CONFIRMED → COMPLETED` 链。
矩阵行 `devtools.activate` 据此晋级 **EQUIVALENT**（evidence 追加
`real-dev-verified`）。

## 验证链路（本次 smoke 全部 PASS）

| 环节 | 结果 | 证据 |
| --- | --- | --- |
| 三工具进入 DEV workbench 运行时 catalog | PASS | smoke listTools |
| `healthcheck` 目标身份（DEV/300） | PASS | smoke |
| 受控创建 PROGRAM ZVACTSMOKE（preview→确认→apply） | PASS | smoke + 审计 |
| 创建后激活态复查（activateOrThrow 设计，不在 inactive 列表） | PASS | smoke |
| 激活目标预检：ZVCL_CAMPAIGN 在 inactive 列表、归属当前用户（68157） | PASS | smoke |
| `previewObjectActivation` 冻结 plan：6 条目全部属 ZVCL_CAMPAIGN、payloadHash 冻结、状态 PREVIEWED | PASS | smoke + 审计 |
| `applyObjectActivation` 原生确认（decision=activate）并单次执行 | PASS | 审计 `OBJECT_ACTIVATION_CONFIRMED`（14:38:16.238Z） |
| 激活执行结果：plan 终态 SUCCEEDED | PASS | 审计 `OBJECT_ACTIVATION_COMPLETED`（14:38:26.122Z，摘要 "activated 6 object(s), 0 message(s), 0 still inactive"） |
| 重复 apply 拒绝（PLAN_ALREADY_CONSUMED/PLAN_EXPIRED） | PASS | smoke |
| 激活后目标状态复查：ZVCL_CAMPAIGN 离开未激活列表 | PASS | smoke + 独立新进程复查（still inactive: false） |
| 自建对象受控清理 + absence 复查（searchObject 0 命中） | PASS | smoke + 独立复查（residue count: 0） |

## 审计关键事件（plan `dd0f5874e438d3ad5877d1494a2672b1`）

```json
{"eventType":"OBJECT_ACTIVATION_PREVIEW_CREATED","activationObjectCount":6,"timestamp":"2026-09-16T14:38:16.229Z",...}
{"eventType":"OBJECT_ACTIVATION_CONFIRMED","activationObjectCount":6,"timestamp":"2026-09-16T14:38:16.238Z",...}
{"eventType":"OBJECT_ACTIVATION_COMPLETED","resultSummary":"activated 6 object(s), 0 message(s), 0 still inactive","timestamp":"2026-09-16T14:38:26.122Z",...}
```

## 前置修复（本轮验证得以通过的关键）

1. **apply gate 自我死锁修复**（`src/lib/serverGuardrails.ts`）：`applyObjectActivation`/
   `getObjectActivationStatus` 补入 `usesSapExecutionGate` 豁免名单——此前
   `maxConcurrentTools=1` 下确认后的 `applyConfirmed` 再次 `gate.run` 永远排队，
   客户端 60s 超时、审计无 CONFIRMED。修复带 `serverGuardrails.test.ts` 回归测试。
2. **smoke 脚本超时放宽**：激活 apply 调用 `callTool(params, undefined, {timeout: 300_000})`。
3. **激活目标约束**：工作流 `collectInactiveRecords` 只收含 `adtcore:parentUri` 的
   条目（激活载荷需精确 ADT 引用）；顶层 INTF/DTEL/DOMA 条目不适用，带 include
   的类/函数组适用。

## 系统遗留状态

- 无本轮新增残留：ZVACTSMOKE 已清理（absence 复查 0 命中）；激活目标
  ZVCL_CAMPAIGN 为既有自有验证对象，仅激活、不删除（激活属预期状态推进）。
- 历史遗留（前轮记录，未变）：ZVACTSMOKE3 可能仍存在；SM12 可能有旧 ENQ 锁。
