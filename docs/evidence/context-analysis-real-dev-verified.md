# 依赖上下文四工具真机验证（codeintel.context → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/context-analysis-real-dev-smoke.mjs <sap-dev.env>`
  （通过 MCP stdio 启动 `dist/index.js`，全流程只读，零写操作、零传输、零锁）
- 结果：**SMOKE OK**，全部断言 PASS。

## 验证对象与证据

自动化先行的实现与接线（详见 PROGRESS 本轮条目）：

- `src/adt/ContextCompressionApi.ts`：VSP `pkg/ctxcomp`（compressor/deps/candidates/
  contract/methodlevel）与 `handlers_effects.go`、`pkg/graph/effects.go` 的 TS 移植；
  串行取源（VSP 为 5 路并发，本项目按串行红线收敛为逐个取数）。
- `src/handlers/ContextAnalysisHandlers.ts` + `src/index.ts` 接线；
  `ToolProfiles.ts`（workbench 显式名单）与 `ToolOperationPolicy.ts`（read-only 类）同步。

真机 smoke 步骤与输出：

1. **catalog 可见性**：focused（workbench 别名）运行时 catalog 含四工具
   `getDependencyContext`、`analyzeDependencies`、`parseAbapSource`、`analyzeSourceEffects`。
2. **目标挑选**：`grepPackage(Z001, objectTypes=[PROG,CLAS])` 枚举 11 个候选；
   `analyzeDependencies` 预扫（ZVPCL01/02/03 为平凡验证类、0 依赖），
   选中 `ZCL_MCP_SM21_ADT_HTTP`（3 依赖：`CL_SYSLOG`、`CL_SYSLOG_FILTER`、
   `IF_HTTP_EXTENSION`）。
3. **getDependencyContext**：found=3、resolved=3、failed=0；prologue 130 行，
   含标题行与三个契约段（接口/类标注方法数）；stats 恒等式
   `resolved + failed = found` 通过；unresolved=[]。
4. **交叉印证**：prologue 中三个契约名与 `analyzeDependencies` 依赖发现清单一致
   （两条独立代码路径：压缩链 vs 纯分析层）。
5. **parseAbapSource**：目标解析为 176 条语句 / 206 行，识别出 CLASS_DEFINITION 段。
6. **analyzeSourceEffects**：LUW=safe、pure=true、effects=[]，含调用方后果说明与
   "local analysis" 边界声明。
7. **source 直传路径**：显式源码（零 SAP 往返）发现 2 个依赖并按 CLAS/FUNC 分类。

## 过程中发现并修复的问题

- **相对源 URI**（真机发现）：ADT include 的 `abapsource:sourceUri` 是相对对象
  资源的逻辑路径（如 `source/main`），直接传 `getObjectSource` 报
  `Invalid Object URL`。已在 `createSourceFetcher` 增加 `absolutizeSourceUrl`
  （口径对齐 `read/AbapMemberSourceReader.ts` 的 `resolveSourceUrl`：绝对路径原样、
  相对段拼到 objectUrl、拒绝 `..`/`://`/查询串），补 3 个单测（含恶意相对段拒绝）。
- 两次 smoke 前期失败均为脚本自身目标选择/断言问题（平凡对象零依赖、
  grep objectType 前缀比对），与被验证能力无关；期间被测系统行为始终正常，
  不构成重试预算消耗。

## 门禁记录

- Jest：132 suites / 1257 tests 全绿（含本能力 53 例：API 36 + Handlers 17；
  数字以 PROGRESS 最终记录为准）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`（JSON 校验 + MD 重生成）、`git diff --check` 全绿。

## 矩阵影响

`codeintel.context`：PARTIAL → **EQUIVALENT**（evidence + real-dev-verified）。
与 VSP 的已知剩余差异（不阻塞 EQUIVALENT，属增值差异）：

- VSP `analyze_deps` 另带 Go 端 abaplint parser 层与 SAP 端 SCAN/CROSS 层的多层
  置信度模型；本项目为单 regex 层（置信度 0.8，疑似误报降 0.3）。
- `analyzeSourceEffects` 为单源码单元的本地分析（VSP 同口径，边界声明随答案返回）。
- VSP `context` 的深度展开依赖完整源码取回，本项目串行取源在慢系统上耗时更长
  （默认 depth=1 时不放大）。

## 遗留

- 无系统残留（全程只读）。
- `ZVACTSMOKE3` 残留对象与旧 ENQ 锁为历史遗留（PROGRESS 前轮记录），非本轮产物。
