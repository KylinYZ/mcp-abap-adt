# Dump 增值分析真机验证（diagnostics.dumps 增值半边）

- 验证日期：2026-09-16
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：探针式验证（groupRuntimeDumps / findSimilarDumps，全部只读，7 天窗口）
- 语义来源：VSP `pkg/adt/dumps.go` GroupDumps 与 `handlers_dumps.go` similar 语义
  （均为纯客户端聚合，零额外端点）

## 结论

两个增值分析工具在真实 DEV 系统上验证通过，矩阵行 `diagnostics.dumps`
由 UNVERIFIED 晋级 **EQUIVALENT**。

## 真机结果

| 工具 | 结果 | 真实数据 |
| --- | --- | --- |
| `groupRuntimeDumps` | PASS（60s，系统慢但成功） | 7 天窗口 50 条 dump → 22 个分组；Top 组 `DBSQL_SQL_ERROR @ CL_BATCH_SCHEDULER`（11 次，DDIC/SAPSYS）、`DBSQL_SQL_ERROR @ SAPMSSY2`（10 次）、`DBIF_REPO_SQL_ERROR @ CL_RUNTIME_ERROR`（7 次）——频次降序、并列按最近排序全部符合 VSP 语义 |
| `findSimilarDumps` | PASS（1.2s） | `DBSQL_SQL_ERROR` 7 天 28 次，用户集 [DDIC, SAPSYS, 068157]，first 11:29 / last 17:56，occurrences 带真实 ST22 条目 id 与终止程序——"惯犯问题"判定数据完整 |

## 过程中发现并处理的缺陷

1. **既有工具的服务端 `runtimeError` 过滤在该 DEV 系统失败**（`readRuntimeDumps`
   带该参数即 InternalError——既有缺陷，非本轮引入；已记入 PROGRESS 遗留）。
   `findSimilarDumps` 最初透传该参数触发同样失败。修复：匹配改为纯客户端
   （对齐 VSP similar 的"拉全量后客户端匹配"语义），handler 不再把
   runtimeError/exception 传给服务端 feed 过滤，mock 断言固化该契约。

## 安全边界确认

- 两工具全部只读（read-only tenant），数据源复用既有 RuntimeDumpReader 的
  时间窗/过滤校验（窗口 ≤7 天、值白名单），聚合为确定性纯函数。

## 验证层级声明

- 真实 DEV 已验证：分组聚合（真实 22 组数据）、同类检索（28 次真实历史）。
- 未验证/遗留：`readRuntimeDumps` 服务端 runtimeError 过滤缺陷（既有，待单独立项）；
  explain_dump 的 AI 级解释属 VSP 增值差异，不在对齐范围。
