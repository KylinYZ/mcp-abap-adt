# Wave 3 分析四工具真机验证（grep / callees / application-log / coverage）

- 验证日期：2026-09-16
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：`scripts/wave3-analytics-real-dev-smoke.mjs`（前三项只读；coverage 为执行行为，
  目标限定本用户历史 campaign 验证类，零对象修改）

## 结论

四个工具在真实 DEV 系统上全部验证通过，矩阵四行由 UNVERIFIED 晋级 **EQUIVALENT**：

| 矩阵行 | 工具 | 真机结果 |
| --- | --- | --- |
| `search.content-grep` | `grepPackage` / `grepObjects` | PASS：Z001 包枚举 7 个 PROG 对象 + 客户端逐行正则匹配，有界结构完整（truncated=false） |
| `analysis.callgraph`（down 方向） | `getCallees` | PASS：`INCLUDE LIKE 'ZVPCL01%'` 谓词查 WBCROSSGT+CROSS 双表，failedSources=0（该类无下游引用，空结果合法） |
| `diagnostics.application-log` | `readApplicationLog` | PASS：BALHDR 查询返回 50 条**真实日志**（`/WF/JOBS` SYSTEM_SCHEDULER 后台作业条目，用户 DDIC/程序 RSWWE...），truncated=true 证明分页边界生效 |
| `read.coverage` | `runUnitCoverage` | PASS：POST abapunit/testruns（coverage 采集标志）真实执行，返回结构化结果（目标 ZVPCL01 无测试类，覆盖率 0%——执行与解析链路真实生效） |

## 环境事实（已记录）

- DEV 系统当期响应显著偏慢（单对象源码拉取 ~15s），smoke 的单调用超时放宽至
  5 分钟，grepPackage 用 objectTypes 过滤缩小枚举面。
- `getCallees` 的空结果与 ZVPCL01 在交叉表中无记录一致（非查询失败：
  sourcesSearched 含双表、failedSources=[]）。

## 安全边界确认

- grep/callees/applog 三个能力全部只读；URI 与 SQL 谓词均服务端推导，
  对象名经白名单校验后才进入 SQL（注入样本在 mock 层验证为零调用）。
- runUnitCoverage 是执行行为（other-mutation，与 unitTestRun 同级），QAS/PRD
  角色由策略拒绝；本次执行目标为本用户自有验证类，对象零修改。

## 验证层级声明

- 真实 DEV 已验证：四工具的端点连通性、请求契约、响应解析（applog 含真实
  业务日志数据）、coverage 执行链路。
- 未验证：v2 元素清单（沿用 CDS 行结论）、BAL 消息文本回读（BALDAT/T100，
  本批刻意未实现）、callgraph 静态-动态对比（ADT 端点缺失，VSP 同源限制）。
