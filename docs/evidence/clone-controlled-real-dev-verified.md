# 受控对象克隆一站式工作流——真实 DEV 验证证据

日期：2026-09-22
矩阵行：`crud.clone-object`
状态变更：PARTIAL → **MCP_SUPERSET**（evidence + real-dev-verified）
脚本：`scripts/clone-controlled-real-dev-smoke.mjs`（npm run test:clone-controlled-real-dev）

## 能力构成

一站式受控克隆工作流（clone-controlled-workflow），三个工具：

| 工具 | 语义 | 门控 |
| --- | --- | --- |
| `previewCloneObject` | 只读预检：服务端解析源 URL 读源快照 → 本地声明改名 → 冻结 immutable plan（源 hash + 改名后源码 + payloadHash） | read-only，DEV 受控 profiles |
| `applyCloneObject` | 原生表单确认后单次执行：把改名后的冻结源码委托既有受控创建链（壳创建/锁/写/语法检查/激活/源码 hash 比对/失败补偿） | advanced-mutation，仅 DEV + development/development-workbench |
| `getCloneObjectStatus` | 本地 plan 状态查询 | local-only |

## 与 VSP CloneObject 的关系（MCP_SUPERSET 依据）

VSP `pkg/adt/workflows_source.go` CloneObject（L1586-1653）：GetSource → 声明行
正则改名 → WriteSource 直写创建，无确认、无身份证明、无失败补偿。

本项目在其之上叠加整条受控链：immutable plan、上下文绑定（跨 host/client/
user/role/profile 重放拒绝）、一次原生确认、创建链内部的 absence 复查/传输
校验/锁链/激活后源码 hash 比对/UNKNOWN_OUTCOME 终结/失败补偿。语义差异：

- 仅支持受控创建链已覆盖的 PROGRAM/ABAP_CLASS/ABAP_INTERFACE 三类（VSP 同为三类）；
- 类源码改名要求 DEFINITION 与 IMPLEMENTATION 两处同步替换（VSP 只替换
  第一个匹配，多声明场景漏改；本项目声明行数量不符即拒绝，不允许"猜"）；
- 源 URL 全部服务端解析（不接受任意 URL）；源码快照与改名结果冻结进 plan，
  apply 不再触碰源对象。

## 真机验证记录（2026-09-22，专用 DEV）

对象：`ZVCLSMKSRC6721` → `ZVCLSMKTGT6721`（Z001 包，传输 S4HK900009）
全部断言 PASS，输出 SMOKE OK：

1. 源对象受控创建（immutable plan + 原生确认 + APPLIED）。
2. `previewCloneObject` 冻结：sourceName/targetName/packageName 一致，
   `sourceHash`（sha256）、`payloadHash` 均为 64 位十六进制，
   `declarationChanges=1`（PROGRAM 语义），目标 2 行，plan 只读阶段零写路径。
3. `applyCloneObject` 原生确认（消息含目标对象名才 accept）后单次执行，
   受控创建链 plan APPLIED（内部含 absence 复查/传输校验/激活后源码 hash 比对）。
4. readback 独立直读目标对象源码，与改名后期望逐字一致
   （声明行 `REPORT ZVCLSMKTGT6721`）。
5. `getCloneObjectStatus` 本地复查 SUCCEEDED。
6. 双对象受控清理 + absence 复查：系统零残留。

审计链含 `CLONE_PREVIEW_CREATED`、`CLONE_COMPLETED`（审计事件字段
`clonePlanId`），确认走 MCP form elicitation。

## 自动化与接线

- 17 个 mock 用例（协议 6 + 工作流 7 + 处理器 4）：改名三类型语义、声明数
  负例、HTTP 非 2xx、plan 冻结断言、委托参数、二次 apply 拒绝、UNKNOWN_OUTCOME
  终结、确定性失败 FAILED、非法入参族、上下文重放拒绝、三工具注解与确认门。
- 接线：index.ts（controlledAdvancedTools 面 + dispatch）、ToolProfiles
  （workbench 显式名单 +3）、ToolOperationPolicy（read-only +1 / local +1 /
  advanced-mutation +1 / CONTROLLED_CLONE_TOOL_NAMES 专属门控 + 角色可见性）、
  serverGuardrails（applyCloneObject/getCloneObjectStatus 豁免外层 gate——
  apply 在原生确认后委托创建链，其确认层内部自持 executionGate，外层不豁免
  会在 maxConcurrentTools=1 下自我死锁，与受控激活同型）。
- 门禁：Jest 158 suites / 1509 tests、build、check:repository-creation-coverage、
  check:vsp-capability-parity、git diff --check 全绿。

## 历史边界

- 2026-09-18 组合任务路径（零新代码）真机闭环记录见
  `clone-object-real-dev-verified.md`（保留为过程证据）；本轮一站式工作流
  将"读源/改名/创建"收敛为单 plan 单确认，消除组合路径的中间人工环节。
