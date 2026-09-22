# 对象克隆组合任务路径真机验证（crud.clone-object）

- 验证日期：2026-09-18
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：`scripts/clone-object-real-dev-smoke.mjs`（已注册 `npm run test:clone-real-dev`）
- 语义来源：VSP `pkg/adt/workflows_source.go` CloneObject（第 1586-1650 行，
  PROG/CLAS/INTF：GetSource → 正则改名 → WriteSource create）

## 结论

组合任务路径在真实 DEV 系统端到端验证通过：**读源 → 声明行改名 → 受控创建
（immutable plan + 原生确认）→ readback 比对 → 受控双清理**，全部走既有受控
MCP 工具。矩阵行 `crud.clone-object` 由 GAP 推进为 **PARTIAL**（一站式受控
克隆工作流待立项后可晋级 EQUIVALENT/MCP_SUPERSET）。

## 真机闭环结果（时间戳后缀对象 ZVCLONESRC9816 / ZVCLONETGT9816）

| 步骤 | 结果 |
| --- | --- |
| 源对象受控创建（plan + 确认 + apply） | PASS |
| 源码读取（ADT 直读，含 REPORT 声明行） | PASS |
| 声明行改名（REPORT <src> → REPORT <tgt>，对齐 VSP 正则语义） | PASS |
| 目标对象受控创建（携带改名后源码，plan + 确认 + apply） | PASS |
| readback 比对（目标源码 = 改名后源码，行尾规范化） | PASS |
| 双对象受控清理 + absence 复查 | PASS（系统零残留） |

## 与 VSP 的差异（受控增强）

VSP CloneObject 是一次性直接写入（GetSource → 改名 → WriteSource create，无
确认、无 readback）。组合路径的每一步写入都有 immutable plan、原生表单确认与
absence 复查——关键输入/输出等价，安全保证更强。

## 过程要点（工程纪要）

- SAP 端 ENQ 锁释放有延迟：清理后立即重建同名对象会撞"当前编辑"冲突，
  脚本采用时间戳后缀的全新对象名从根上绕开。
- `getObjectSource` 的返回形态为 `{status, source, totalLines, ...}`（源码在
  `source` 字段）。

## 验证层级声明

- 真实 DEV 已验证：PROGRAM 类克隆组合路径全链路（含 readback 比对与清理闭环）。
- 待立项：一站式受控克隆工作流（单 plan 冻结源快照 + 自动改名 + 比对，
  nextMilestone=clone-controlled-workflow）；ABAP_CLASS/ABAP_INTERFACE 类的
  克隆（同构，工作流落地时一并支持）。
