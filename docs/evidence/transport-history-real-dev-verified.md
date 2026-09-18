# 事务描述修复 + 传输历史真机验证（read.transaction → EQUIVALENT；analysis.history 边界收窄）

- 日期：2026-09-18
- 环境：专用 DEV（10.30.254.48，env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/transaction-read-real-dev-smoke.mjs`（复测）+
  `node ./scripts/transport-history-real-dev-smoke.mjs`（新能力），全程只读
  SELECT，零写操作
- 结果：两个 smoke 均 **SMOKE OK**。矩阵 read.transaction PARTIAL →
  **EQUIVALENT**；analysis.history 维持 PARTIAL 但核心子集（cr_history +
  co_change）闭环。

## 一、read.transaction 晋级：两层假象的定位与修复

第十七轮记录的"TSTCT datapreview 受限（各种 WHERE 形态一律 Internal
server error）"经本轮复测定位为两层独立假象的叠加：

1. **2 位语言键字面量溢列宽（本轮修复的真缺陷）**：TSTCT.SPRSL 是 1 位
   SAP 内部语言键，`WHERE sprsl = 'EN'` 的 2 位字面量超出列宽，datapreview
   直接拒绝（真机实测 400；`sprsl = 'E'` 即正常）。修复：查询前经
   sapInternalLanguageKey 转内部键（EN→E、DE→D、ZH→1），与知识查询同表。
2. **datapreview 按会话查询预算耗尽**（详见 img-activity 证据）：当时的
   会话已消耗预算，任何查询都会失败——"换日恢复"与本机制吻合。

复测结果：SE38 → 程序 RSABAPPROGRAM + 描述 "ABAP Editor"（EN/DE 双语言
真实返回），不存在/非法/注入负例保持参数层拒绝。

## 二、analysis.history 核心子集：getCrHistory + getCoChange

数据源为传输控制表（E071/E070）自由 SQL——第十八轮记录的"E071/E070
datapreview 受限"同为预算假象，本轮复测即正常。

- `getCrHistory`（VSP handleCRHistory 子集移植）：E071 R3TR 精确 + LIMU
  前缀（容错）→ E070 任务→请求层级（STRKORR）+ 用户/日期。真机：
  ZVCL_CAMPAIGN → 任务 S4HK900010 挂请求 S4HK900009，用户 068157；
  E070A CR 属性未配置按 notes 声明（VSP 的 CR 分组依赖服务端配置
  TransportAttribute，本项目无该配置）。
- `getCoChange`（VSP handleCoChange 的同请求共现简化口径）：目标所在传输 →
  父请求 + 兄弟任务 → 请求范围内全部对象按共现传输数频次排序。真机：
  ZVCL_CAMPAIGN 返回 5 条真实共现（含锁对象 ENQU EZVLOCK3——该类确实
  使用了锁对象，频次线索与代码事实吻合）。与 VSP 的差异：无多跳图遍历
  （pkg/graph 引擎），notes 如实声明"频次是审查线索不是结论"。

## 三、门禁记录

- Jest：154 suites / 1455 tests 全绿（本能力新增 9 例 + read.transaction
  断言更新为内部键语义）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。
- 接线：ToolProfiles（workbench +2）+ ToolOperationPolicy（read-only +2）
  + ToolCatalogIntegrity 计数（development=169、diagnostic-readonly=138、
  legacy-full=201、development-workbench=136）。

## 四、矩阵保真（同轮）

report.run / report.async / report.variants 由 GAP → INTENTIONAL_RESTRICTION：
所有者早期已定"report 写为 RESTRICTION 方向"（2026-09-16 轮记录），且等价
读能力已由 spool-jobs 与 report.text-elements 覆盖；liftCondition 写明重新
放开条件。GAP 桶去虚存实（7 → 4）。

## 遗留

- 无系统残留（全程只读 SELECT）。
- analysis.history 剩余：impact/boundaries/graph_stats 等图引擎类（独立
  工程轮候选）。
- 矩阵剩余 GAP 4 行全部为写方向或环境前置（clone-object、merge-move、
  amdp-adt、ui5.write）。
