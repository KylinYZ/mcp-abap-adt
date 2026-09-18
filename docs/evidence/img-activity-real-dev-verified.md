# IMG 活动详情真机验证（diagnostics.knowledge-queries 的 img_activity 子集闭环）

- 日期：2026-09-18
- 环境：专用 DEV（10.30.254.48，env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/img-activity-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；自由 SQL 只读 SELECT，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 knowledge-queries 维持
  PARTIAL 但边界收窄：img_activity 子能力闭环，剩余 fm_test_data/
  cluster_read（需 S/2 集群解析器，独立工程轮）。

## 实现范围

- `getImgActivity`（第三个知识查询只读工具）：单个 IMG 活动完整详情——
  基础行（CUS_IMGACH：activity/tcode/docu_id）+ 按语言文本（CUS_IMGACT）
  + 菜单路径（TNODEIMGR 引用 → TNODEIMG 向上递归 ≤12 层带环检测 +
  TNODEIMGT 按语言文本，路径串根在前 " > " 连接并排序）+ HY 文档（复用
  文档正文通道，docu_id 经 token 校验容错）。VSP pkg/adt/docs.go
  IMGActivity/imgPaths/imgPathOf 语义移植。
- 与 VSP 的差异：递归不用 JOIN（datapreview 兼容口径，逐级两次单表查询，
  且实测该环境 `AS r` 别名形态会被拒）；辅助信息（文本/路径/文档）逐项
  容错降级为 notes，不拖垮主语义；`maxRefs`（1..20，默认 20=VSP 上限）
  有界入参控制路径递归的查询量。
- 接线：ToolProfiles（workbench +1）+ ToolOperationPolicy（read-only +1）
  + ToolCatalogIntegrity 计数（development=167、diagnostic-readonly=136、
  legacy-full=199、development-workbench=134）。

## 真机 smoke 输出

1. 负例先行：ZZZZ9NOPE → InvalidParams（"does not exist"）；`Z';--` →
   参数层拒绝（零查询）。
2. 回归：searchImgActivities 'Anlage*'（DE）命中 10 节点（与第十七轮一致）。
3. getImgActivity APOC_C_FORMV（maxRefs=2）：事务码 S_ER9_68000005；
   菜单路径 "Statutory Reporting > Certificate of Creditable Withholding
   Tax Report"（父节点 EN 文本真实读回；叶节点无文本被正确跳过）。
4. HY 文档容错：该活动 docu_id 含空格（"SIMGASSIGN FORM TEMPLATES"），
   token 校验拒绝后按 notes 降级，不影响主语义。

## 重要环境发现：datapreview 按会话查询预算（约 19 次）

排障过程中定位（二分探针实测）：**同一 ADT 会话内 datapreview 自第 ~20
次查询起持续失败（400/5xx），直至新会话**。25 次连续简单查询的探针显示
1-19 次成功、20 次起全挂；单个 getImgActivity 详情约消耗 19 次查询，正好
触及预算。由此推断：历史上多轮记录的"瞬时失败"（第十七轮 CUS_IMGACH
Internal server error、read.transaction 的 TSTCT/E071/E070 datapreview
受限、第九轮 81s UNKNOWN_OUTCOME 等）大概率是预算耗尽机制，而非表级
限制或随机抖动——当时的新会话重试成功/换日恢复与本机制吻合。

工程处置：
- 知识查询层**不做失败重试**（预算耗尽时重试白烧配额），并留单测锁定；
- `maxRefs` 提供查询量控制；smoke 顺序改为负例/回归先行、查询密集的详情
  最后（总查询量保持在预算内）；
- 候选加固项（后续轮，需所有者评审）：ADT HTTP 客户端的会话重置/重建
  机制（预算耗尽时自动换会话），可一次性解决全部 datapreview 工具的长
  会话可用性。

## 门禁记录

- Jest：153 suites / 1446 tests 全绿（本能力新增 10 例：API 5 + 处理器
  分派/校验 5；含 maxRefs 上限、环检测、容错降级、不重试锁定）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 SELECT）。
- fm_test_data/cluster_read：需要 S/2 集群二进制解析器（VSP pkg/datacluster
  约 2.2k 行 + pkg/sapcompress），独立工程轮候选（真机已确认 datapreview
  可回传 CLUSTD LRAW 的 hex 串，通道可行）。
- report.text-elements 差距核实结论（本轮完成）：读面已覆盖，剩余差距为
  文本池受控写入链（setTextElements 为 legacy-full 专家原子工具，无
  preview/确认/apply 受控流）——归入写方向工作流批次，需设计评审授权。
