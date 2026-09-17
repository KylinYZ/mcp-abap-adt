# 版本源码只读工具真机验证（revisions.source → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/revision-source-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 searchObject/revisions/源码 GET，
  零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 PARTIAL → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/RevisionSourceApi.ts`：补齐 VSP `SAP(action=revisions,
  params={op:source})` / focused GetRevisionSource（handlers_revisions.go
  L41-56）的任务路径。与 VSP 的安全差异：不接受调用方传入 version_uri（任意
  URL），输入为 objectType+objectName+版本选择器，版本与源 URI 全部服务端解析：
  1. quick search 精确匹配对象（复用依赖上下文取源链已真机验证的解析口径）；
  2. revisions 版本清单（复用既有 api/revisions，条目自带版本源 URI）；
  3. 按选择器命中条目 → 源码 GET。
- 版本选择器二选一：`version`（对 version/versionTitle 标签大小写不敏感精确
  匹配）或 `index`（清单 1-based 序号，最新在前）；都不给为发现模式，返回
  版本清单与选择提示。
- `src/handlers/RevisionSourceHandlers.ts` + `src/index.ts` 接线；
  ToolProfiles（workbench 显式名单 + OPERATIONS_READONLY 显式追加，与
  revisions 清单同级运维诊断）与 ToolOperationPolicy（read-only 类）同步。

## 真机 smoke 输出

1. catalog 可见性：getRevisionSource 在 focused 运行时 catalog。
2. 发现模式：ZVCL_CAMPAIGN 返回 1 个版本，标签为传输号 `S4HK900009`（该系统
   以写入传输命名版本），带 Discovery mode 选择提示。
3. index 选择：index=1 读回 14 行源码（`CLASS zvcl_campaign DEFINITION ...`），
   行数统计一致。
4. version 选择：以小写标签 `s4hk900009` 回填读取成功，且与序号路径读到
   同一版本源码（内容一致）。
5. 负例：未知标签（not found → InvalidParams）、非法名字（`A';--`）、非法
   objectType（XSLT）均在参数层拒绝（零网络往返）。

## 门禁记录

- Jest：140 suites / 1331 tests 全绿（本能力新增 16 例：API 8 + Handlers 8）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读）。
- revisions.compare（版本间 diff）维持 PARTIAL，作为后续独立 spike。
