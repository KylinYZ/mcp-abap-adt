# 事务码元数据只读工具真机验证（read.transaction → PARTIAL）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/transaction-read-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅两条 SELECT，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 GAP → **PARTIAL**
  （evidence + real-dev-verified；描述通道受环境限制，非 EQUIVALENT，见下）。

## 实现范围

- `src/adt/TransactionReadApi.ts`：VSP `pkg/adt/client.go` GetTransaction
  （L1384-1412）的任务语义（transaction/description/program）移植，通道改为
  经典表自由 SQL（与 spool-jobs/callees 同通道）：
  - TSTC：事务码 → 承载程序（PGMNA）；
  - TSTCT：按语言（SPRSL）取描述（TTEXT）。
- `src/handlers/TransactionReadHandlers.ts` + `src/index.ts` 接线；ToolProfiles
  （workbench 显式名单）与 ToolOperationPolicy（read-only 类）同步。

## 环境级限制（记 PARTIAL 的原因）

1. VSP 通道不可用：ADT `vit/wb` TRAN 端点在该 DEV（7.58）返回
   "No URI-Mapping defined for URI ..."（SE38/SM37 双探针实测）——VSP 同源受限。
2. 替代通道 TSTCT 的 datapreview 数据读取一律 Internal server error（无 WHERE/
   各种 WHERE 形态全试），表结构 describeClassicTable 正常——环境级数据预览
   限制。因此描述容错为缺失 + note 标注（不让它拖垮 program 主语义）。

## 真机 smoke 输出

1. catalog 可见性：getTransaction 在 focused 运行时 catalog。
2. SE38 → 程序 **RSABAPPROGRAM** 正确返回；描述缺失且 note 如实标注
   "reading TSTCT failed on this system (datapreview restriction)"。
3. 语言覆盖 DE：同样受限缺失（note 一致）。
4. 不存在事务码 ZZZZ9 → InvalidParams（含 "does not exist in TSTC" 提示）。
5. 负例：非法事务码（`Z';--`）与非法语言键（CHN）参数层拒绝。

## 门禁记录

- Jest：145 suites / 1383 tests 全绿（本能力新增 14 例：API 7 + Handlers 7，
  含 TSTCT 失败容错降级用例）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 SELECT）。
- liftCondition 已写入矩阵行：TSTCT datapreview 限制解除或找到替代描述通道后
  评估 EQUIVALENT。
