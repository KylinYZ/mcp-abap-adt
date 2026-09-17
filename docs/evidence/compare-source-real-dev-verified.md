# 对象间源码对比只读工具真机验证（crud.compare-source → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/compare-source-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 searchObject/objectStructure/
  源码 GET，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 GAP → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/RevisionSourceApi.ts` 扩展 `compareSourceObjects`：VSP
  `pkg/adt/workflows_source.go` CompareSource（L1403-1444）的只读移植——
  两对象各自经 quick search 精确解析当前源码（服务端解析，不接受任意 URL），
  identical 逐字节判定 → LCS unified diff（3 行上下文）→ 增删行计数 +
  两侧行数统计。名字白名单（normalizeRepositoryName）前置校验。
- `src/handlers/RevisionSourceHandlers.ts` 增加 compareSourceObjects 工具
  （objectType1/objectName1/objectType2/objectName2 四字段必填 + 枚举/
  白名单校验，字段名携带序号便于调用方定位）。

## 真机 smoke 输出

1. catalog 可见性：compareSourceObjects 在 focused 运行时 catalog。
2. 同对象自比：ZVCL_CAMPAIGN（14 行）identical=true、无 diff 体。
3. 真实差异对比：ZVCL_CAMPAIGN vs RFITEMAP（1412 行）检出 +1408/-10，
   unified hunk 头与两侧标注（CLAS:ZVCL_CAMPAIGN / PROG:RFITEMAP）正确。
4. 负例：非法 objectType1（TABL）、缺 objectName2、非法名字（`Z';--`）
   均参数层 InvalidParams（-32602）拒绝。

## 门禁记录

- Jest：144 suites / 1369 tests 全绿（本能力净增 10 例：API 3 + Handlers 3
  + 目录/计数调整相关用例）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 GET）。
