# 安装前置只读发现工具真机验证（install.diagnostics → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/install-diagnostics-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 TADIR SELECT 与 git repos GET，
  零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 PARTIAL → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/InstallDiagnosticsApi.ts`：安装前置只读 discovery（对齐 VSP
  system FEATURES + ListDependencies 的"前置现状发现"语义，不含安装动作）：
  - ZADT_VSP helper：TADIR `obj_name LIKE 'ZADT_VSP%'` 探测（失败重试 1 次，
    该 DEV datapreview 有瞬时 500）；
  - abapGit：GET `/sap/bc/adt/abapgit/repos`（Accept
    `application/abapgit.adt.repos.v2+xml`，与本项目 gitRepos 同通道），
    按状态分类 available（200）/ not_installed（404 或 ADT "does not exist"
    语义）/ forbidden（403）/ error；
  - 本地运行时：Node 版本。
- `src/handlers/InstallDiagnosticsHandlers.ts` + `src/index.ts` 接线；
  ToolProfiles（workbench 显式名单）与 ToolOperationPolicy（read-only 类）
  同步。
- notes 明确边界：本服务器不做任何安装动作（安装属矩阵
  INTENTIONAL_RESTRICTION 行）。

## 真机 smoke 输出

1. catalog 可见性：checkInstallPrerequisites 在 focused 运行时 catalog。
2. ZADT_VSP helper：installed=false、objects=[]（该系统从未安装 helper；
   首轮 TADIR 瞬时 500 由重试吸收）。
3. abapGit：分类 **not_installed**（ADT 报 "Resource .../abapgit/repos does
   not exist"，语义识别正确），detail 带判定依据。
4. 本地运行时：Node v22.22.2。
5. notes：明确"never installs"边界。

## 门禁记录

- Jest：146 suites / 1394 tests 全绿（本能力新增 11 例：API 5 + Handlers 6）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 SELECT/GET）。
