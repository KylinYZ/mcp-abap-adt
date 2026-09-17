# 包边界只读检查工具真机验证（analysis.boundaries → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/boundary-check-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 TADIR SELECT 与源码 GET，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 GAP → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/BoundaryCheckApi.ts`：VSP `pkg/graph/boundary.go` CheckBoundaries
  （L67-190）六类裁定的只读移植。与 VSP 的架构差异：VSP 基于预构建内存图
  （TADIR+源码批量入图），本实现按需即时分析——
  1. TADIR 枚举包内 PROG/CLAS/INTF（自由 SQL，`object IN (...)`）；
  2. 逐对象串行读源码（searchObject → objectStructure → 源 URI 绝对化），
     ContextCompressionApi.extractDependencies 提取依赖（复用已有正则层）；
  3. 依赖按 kind 分组 TADIR 批查目标包（`obj_name IN (...)`）；
  4. 逐边裁定：SAME_PACKAGE / ALLOWED（白名单 glob，`*`/`?` 通配）/
     STANDARD（非 Z/Y 包）/ VIOLATION / UNKNOWN，聚合 crossedPackages 与
     violatingObjects。
- `src/handlers/BoundaryCheckHandlers.ts` + `src/index.ts` 接线；ToolProfiles
  （workbench 显式名单）与 ToolOperationPolicy（read-only 类）同步。
- 注入防线：包名处理器层白名单（InvalidParams 零网络往返）；目标包 IN 字面量
  由内部拼装（数据来自 TADIR 而非调用方）。
- 已知边界（notes 随结果返回）：动态调用检测（VSP DYNAMIC 裁定）未实现，
  dynamic 恒 0；依赖提取为源码正则层，仅解析 CLAS/INTF/FUNC 引用。

## 真机 smoke 输出

1. catalog 可见性：checkPackageBoundaries 在 focused 运行时 catalog。
2. Z001 包分析：枚举 15 个源码对象（objectLimit=15），串行读源提取 3 条依赖，
   TADIR 反查后全部裁定 **STANDARD**（该包为干净的自有验证包，无跨包 Z 依赖）。
3. 结构与自洽断言：六类计数之和 === 依赖总数；crossedPackages={}、
   violatingObjects=[]；notes 标注动态调用边界。
4. 白名单路径：该包无跨包依赖，按 smoke 分支以负例覆盖（白名单/VIOLATION/
   ALLOWED 分支由单测断言：Z_COMMON 白名单 ALLOWED、Z999 跨包 VIOLATION、
   violatingObjects/crossedPackages 聚合）。
5. 负例：非法包名（`Z';--`）与非法 objectKinds（TABL）均参数层
   InvalidParams（-32602）拒绝。

## 门禁记录

- Jest：144 suites / 1357 tests 全绿（本能力新增 13 例：API 5 + Handlers 8，
  含六类裁定、白名单通配、STANDARD 不进清单、空包边界、参数校验）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 SELECT/GET）。
- 动态调用检测（DYNAMIC 裁定）为后续可选增强；VSP 同源差异已记录在矩阵行。
