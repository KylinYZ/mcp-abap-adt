# 版本对比只读工具真机验证（revisions.compare → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/revision-compare-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 searchObject/revisions/
  objectStructure/源码 GET，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 PARTIAL → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/RevisionSourceApi.ts` 扩展 `compareRevisions`：VSP
  `pkg/adt/revisions.go` CompareVersions（L69-119）与 `workflows_source.go`
  generateUnifiedDiff（L1447-1560）的只读移植：
  - 两侧选择器接受版本标签（大小写不敏感，对 version/versionTitle 匹配）、
    清单 1-based 序号（纯数字字符串）、`current`（当前激活源码；
    version2 缺省 current，与 VSP 一致）；
  - LCS 行级 diff + unified hunks（3 行上下文、@@ -a,b +c,d @@ 头）；
  - identical 逐字节判定 + added/removed 行计数；
  - 当前源码读取：objectStructure → main include 源 URI（相对 URI 绝对化，
    口径同 ContextCompressionApi/AbapMemberSourceReader）。
- `src/handlers/RevisionSourceHandlers.ts` 增加 compareRevisions 工具定义与
  分派（version1 必填、version2 可选、长度上限校验）。
- 安全差异（有意为之）：不接受调用方 version_uri；版本与源 URI 全部服务端
  从 revisions 清单解析。

## 真机 smoke 输出

1. catalog 可见性：compareRevisions 在 focused 运行时 catalog。
2. 相同版本对比（1 vs 1）：identical=true、diff="Sources are identical"。
3. 版本 vs current：检出**真实差异**——ZVCL_CAMPAIGN 激活后源码又被修改，
   `@@ -10,5 +10,5 @@` hunk、+1/-1 行计数，identical 与计数自洽。
4. 标签选择器：小写标签 `s4hk900009` 与大写 `S4HK900009` 两侧对比 identical。
5. 负例：未知版本与缺 version1 均参数层 InvalidParams（-32602）拒绝。

## 过程记录

- 本地第一轮门禁拦获两处接线遗漏（compareRevisions 未入 ToolOperationPolicy
  分类与 workbench/operations 名单 → assertToolCatalogClassified 抛错），已补齐
  后全绿；真机首跑使用旧 dist 失败一次，重建后 SMOKE OK（失败原因已定位，
  非被测能力缺陷，不构成系统性阻塞）。

## 门禁记录

- Jest：141 suites / 1339 tests 全绿（本能力新增 8 例：API 6 + Handlers 2，
  含 unifiedDiff hunk 头/上下文窗口/远距双 hunk 断言）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读）。
- revisions 域三条任务路径（清单/源码/diff）至此全部闭环。
