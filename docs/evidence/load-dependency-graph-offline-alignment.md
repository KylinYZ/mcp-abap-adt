# analysis.history：有界加载依赖图接线（离线验证）

日期：2026-09-24。承接 `dependency-graph-offline-alignment.md` 的快照分析底座。

## 本轮交付

新增 `buildLoadDependencyGraph`，复用现有 `getLoadGraph` / ADT datapreview
只读查询，将 D010INC 单跳关系串行组合为有界多跳图：

- `loaded_by`（默认）：反向展开谁加载当前对象，附带 `LOADS` 快照影响面。
- `loads`：正向展开对象加载什么；不把下游依赖误称为受影响对象。
- 返回 `graph` 可直接传入 `analyzeDependencyGraph`；同时返回统计、每次读取状态、
  采集问题、未展开节点以及实际查询次数。
- `getLoadGraph` 增加按方向的机器可读 `collection` 状态：`ok`、`failed`、`truncated`。
  builder 不通过可编辑 notes 文案判断成功/完整性；缺少结构化状态时保守返回 partial。
- 读取异常文本不再直接透传，避免泄露远端响应、URL 或凭据。合法空数组与缺失/无效数据严格区分。

本轮开发不连接 SAP。新增远端采集**代码已接线**，但验证只使用本地 fixtures/mock；
不能因复用已有真机单跳能力就声称多跳链真机通过。矩阵仍 **PARTIAL、54/71**；
仓库对象创建成熟度不变。

## 来源与对齐边界

参考本地 VSP `pkg/adt/loads.go`、`pkg/graph/builder_loads.go`，commit
`9886d2727f47506368b0a3c2f1c1766f1200f747`。沿用其编译期加载关系语义、
对象归一化和过滤原则，复用本项目已实现的单跳读取器，不添加 ADT endpoint、媒体类型或新 SQL 形态。

与 VSP 原始行图相比，本 builder 只保留对象级去重边及 `D010INC` 来源；
需要原始 include 细节时使用单跳 `getLoadGraph`。不加入 CALLS、传输、CR 或配置边，
不宣称等价完整的 VSP impact/graph_stats。

**函数组反向展开保守限制：**当前 VSP 与本项目 LoadedBy 都使用 `INCLUDE LIKE '<对象名>%'`，
不能充分涵盖函数组的 `SAPL<组>` / `L<组>...` 池形态。新 builder 对 FUGR 反向根参数直接拒绝，
中途发现的 FUGR 保留已知边但不继续反向查询，列入 `unexpanded`。
正向 FUGR 仍复用已有 `loads` 查询。该限制来自源码审计，不是新真机结论；
本轮没有擅自补写猜测的查询。后续要扩大覆盖时需另行确认命名空间与池形态样本。

## 预算和完整性

| 参数 | 默认 | 最大值 |
| --- | --- | --- |
| maxDepth | 2 | 3 |
| maxQueries | 5 | 10 |
| maxNodes（含根） | 100 | 500 |
| maxEdges | 200 | 2000 |

- 查询严格串行，不重试、不并行；查询失败计入预算。每次单向调用对应一个现有 D010INC 查询。
- 同一节点最多查询一次；环、菱形与重复边不引起重复展开；最短深度采用 BFS。
- 达到深度的边界节点不会再发请求，明确标记 `depth-limit`。查询预算、节点/边容量、
  原始 2000 行截断与读取异常分别报告；不会仅因边被过滤完就把截断误判为完整。
- 缺失端点不会进入图；同名不同类型的对象不合并；返回类型/名称非法的边使结果标记 partial。
- `collection.status=complete-within-reader-scope` 只说明在此读取器范围内没有已知遗漏。
  `systemWideComplete` 永远为 false；`rootExistenceVerified` 永远为 false。
- `impact.completeWithinSnapshot` 只针对已收集图；即使为 true，采集仍可能是 partial。
  多次顺序查询不构成 SAP 原子快照。空结果不能证明对象存在或无全系统影响。
- 全局请求/响应字节限制照常生效；没有为图查询放宽已有安全门限。

## 使用示例

```json
{
  "objectType": "CLAS",
  "objectName": "ZCL_EXAMPLE",
  "direction": "loaded_by",
  "maxDepth": 2,
  "maxQueries": 5
}
```

工具名：`buildLoadDependencyGraph`。仅本地源码版本新增，未发布。
开发入口 `focused`/`developer`、运维入口 `operations`、专家入口 `expert` 可见，
兼容 development/diagnostic-readonly；safe/business 隐藏且 direct dispatch 拒绝。
工具属于 `read-only tenant`，使用现有 SAP 执行门控；非 DEV 不获得写能力。

## 验证与下一步

| 检查 | 结果 |
| --- | --- |
| 全量 Jest（默认覆盖率与既有阈值） | `npm test -- --runInBand --silent`：165 suites / 1654 tests 全通过，退出码 0；本轮新增 39 项（builder/reader 32 + profile/role 7） |
| TypeScript 构建 | `npm run build` 通过 |
| 创建成熟度检查 | `node scripts/check-repository-creation-coverage.mjs` 通过；28 份证据，缺失 0，成熟度不变 |
| 矩阵 | 71 行校验通过，对齐保持 54/71；Markdown 与 JSON 同步 |
| 离线 MCP smoke | `npm run test:dependency-graph:offline` 通过；模拟 SQL → 单跳 reader → 多跳 builder → impact 完整经过真实 stdio MCP；新进程 healthcheck 仍 disconnected，旧合成计划 PLAN_NOT_FOUND |
| 格式 | `git diff --check` 通过 |

真机多跳验证、用户日常 MCP 重启/部署、npm 发布均未执行。
离线 stdio smoke 注入固定 SQL fixtures，并禁止网络连接；其模拟数据不能记作真机证据。

下一步推荐：对照 VSP 做传输/CR 边界查询的离线算法和 fixtures，再接确认过的只读采集。
若要新增不确定的 ADT 协议，先请求 Eclipse 抓包（方法、相对路径/参数、媒体类型、
脱敏请求/响应体和有序步骤）；不索要 Cookie、密码、Authorization 或可复用锁/会话值。
