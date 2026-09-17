# 知识查询只读工具真机验证（diagnostics.knowledge-queries → PARTIAL）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/knowledge-queries-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅自由 SQL SELECT，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 GAP → **PARTIAL**
  （evidence + real-dev-verified；documentation + img_search 子集，非
  EQUIVALENT，边界见下）。

## 实现范围

- `src/adt/KnowledgeQueriesApi.ts`：VSP `handlers_docs.go` documentation 与
  IMGSearch 的只读移植（数据源为自由 SQL 表查询）：
  - `getAbapDocumentation`：ABAP 文档（SE61 语义）。索引模式：DOKIL 按
    object 列全部 id/langu/version/txtlines；正文模式：DOKTL 查最新
    dokversion 的 line/dokformat/doktext 行序列（SAP 文档一行一条记录），
    行数上限截断标注；
  - `searchImgActivities`：CUS_IMGACT 活动文本 LIKE 检索 + CUS_IMGACH 补
    tcode（二次单表查询规避 JOIN 风险）+ TNODEIMGT 文件夹文本。
- **语言键转换**：DOKTL.LANGU/SPRAS 列为 1 位 SAP 内部码——2 位 ISO 输入经
  `sapInternalLanguageKey` 转换（映射表逐项对齐 VSP spras，applog_messages.go
  L200-216），否则永远查空。
- `src/handlers/KnowledgeQueriesHandlers.ts` + `src/index.ts` 接线；注入防线：
  docClass/docObject/text 白名单或转义 + 控制字符拒绝。
- 边界（notes 标注，记 PARTIAL 的原因）：fm_test_data、cluster_read、
  img_activity 完整路径递归不在子集。

## 真机 smoke 输出

1. 索引模式：LANGU 文档索引 5 条（DE/D、DE/E、TX/1 跨类跨语言）。
2. 正文模式：DE 类最新版本（version=1）13 行真实读回，首行 U1 格式
   `&DEFINITION&`，行结构（line/format/text）完整。
3. IMG 检索：`Anlage*`（DE）命中 10 个节点（活动+文件夹），节点类型合法，
   活动带技术名。
4. 负例：不存在文档（ZZZZ9NONE）InvalidParams 含"no DE documentation"提示；
   控制字符/注入样本被转义或拒绝。

## 过程中发现的环境限制（已适配）

- CUS_IMGACH 数据读取 Internal server error（datapreview 限制）：tcode 补齐
  容错为缺失 + notes 标注，活动检索主语义不受影响。
- 语言键 2 位 ISO 直查 DOKTL/IMG 表永远查空：sapInternalLanguageKey 转换
  （对齐 VSP spras 映射表）。

## 门禁记录

- Jest：148 suites / 1410 tests 全绿（本能力新增 16 例：API 9 + Handlers 7）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 SELECT）。
- fm_test_data、cluster_read、img_activity 完整详情维持未覆盖；
  liftCondition 已写入矩阵行。
