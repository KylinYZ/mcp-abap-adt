# 传输/CR 对象集合边界：离线算法对齐

日期：2026-09-24。仅本地源码新增，未发布、未部署到日常客户端、未连接 SAP。

## 交付与输入

现有 `analyzeDependencyGraph` 新增 `operation: "boundaries"`，不新增工具、不改变 profile 计数。
输入为已有图快照与显式 `boundaryScope: { label, objectIds }`：

- label 只是显示文本，可写 TR 编号或 CR 名称；不查编号、不读取 E071、不自动推断传输成员。
- objectIds 为 1–500 个唯一、已在图中存在的仓库对象 ID，可表示单个 TR 或多个 TR 的 CR 并集。
  TR、DYNAMIC、TVARVC 节点不能作为成员；成员关系要求完整 TYPE:NAME 精确匹配。
- 仅分析集合内对象发出的结构依赖，忽略 IN_TRANSPORT、CO_TRANSPORTED、READS_CONFIG 及静态自身引用。
- 增加 VSP 同名边类型 `DYNAMIC_CALL`（不是 `DYNAMIC`）；动态占位节点可表示为 `DYNAMIC:LV_FM`。
  所有输入仍沿用本项目大写 canonical ID 契约，不引入小写/模糊身份。

## 参考与有意差异

本地 VSP commit：`9886d2727f47506368b0a3c2f1c1766f1200f747`。
参考 `pkg/graph/queries_transport_boundaries.go` 及其测试，动态边字面量来自
`pkg/graph/builder_parser.go` 的 `EdgeDynamic = "DYNAMIC_CALL"`。
MIT 归属和许可保留在 `third-party/vibing-steampunk/`。

| 行为 | 本项目处理 |
| --- | --- |
| VSP name-only 模糊范围匹配 | 不采用；CLAS:ZITEM 与 TYPE:ZITEM 是不同身份，避免误报“已包含” |
| 自定义对象在集合外 | `missingCustom`，仅 Z/Y 命名启发式；不是“SAP 中不存在”，也不代表必须补进传输 |
| 非 Z/Y 名称 | `standardCandidates`，仅名称候选，不声称 SAP 标准归属已确认 |
| `/.../` 命名空间 | `unknownNamespace`，不默认视为标准对象 |
| 动态引用 | `dynamic`；即使目标碰巧在集合中也不当作已解析；静态边不能吞掉动态证据 |
| 集合内包信息缺失 | `inScopeUnknownPackage` 计数，不冒充同包 |
| 同一源/目标静态多边 | 合并，保留排序去重的 edgeKinds/sources；动态观测独立于静态观测 |
| SelfConsistent / 可释放结论 | 不提供；明确 `deploymentReadinessVerified=false` |

返回 `entries` 分为 missingCustom、unknownNamespace、dynamic、crossPackage、standardCandidates。
`summary` 统计整个快照；maxEntries 默认 200、范围 1–500，是所有明细类别共享的预算。
超限时 `truncated=true`，并提供 totalEntries / returnedEntries；优先保留自定义缺项、
命名空间不明、动态引用，再保留跨包和标准候选。每类稳定排序，不因输入边顺序而变化。

恒等关系：totalDependencies = inScope + missingCustom + unknownNamespace + dynamic + standardCandidates；
inScope = inScopeSamePackage + inScopeCrossPackage + inScopeUnknownPackage。
动态与静态证据属于两种不同观测，可能对同一源/目标分别计数。

## 验证范围与缺口

| 验证 | 结果 |
| --- | --- |
| 全量测试及默认覆盖率门禁 | `npm test -- --runInBand --silent`：166 suites / 1692 tests 全通过，退出码 0；新增 1 个套件、38 项测试 |
| 构建 | `npm run build` 通过 |
| 离线 MCP smoke | `npm run test:dependency-graph:offline` 通过，新增 boundaries 真实 stdio 分派断言 |
| profile/role | 既有 5 类角色 × 5 个兼容入口测试追加 boundaries 分派与零 SAP 调用断言；safe/business 隐藏/拒绝策略未改变 |
| 创建成熟度检查 | 通过；31 类、28 份真机历史证据，缺失 0，成熟度未变 |
| 功能矩阵/格式 | JSON/Markdown 同步检查及 `git diff --check` 通过 |

没有真实 SAP 采集、部署、传输修改或发布。
本能力的 `transportMembershipVerified` / `systemWideComplete` 始终为 false；
空报告或无自定义缺项不能证明传输完整、目标系统满足前提或允许释放。

离线 MCP smoke 使用已有固定 SQL fixtures 构图，再调用 boundaries；禁止网络，
验证真实 stdio 分派、进程重启和合成旧计划 PLAN_NOT_FOUND，但不是日常 MCP 客户端重启验收。

功能矩阵 analysis.history 仍 **PARTIAL，54/71**。仅推进 tr_boundaries/cr_boundaries 的
显式集合离线子集，尚未自动构建 TR/CR 成员范围，也不是 VSP 远端全链等价。

下一步：接已确认的只读传输成员采集，并传播缺失、LIMU→仓库对象映射的不确定性及截断信息。
不得以相似名字猜成员。新增 ADT 报文若证据不足，先请求脱敏 Eclipse 抓包；
本轮没有新协议，所以无需抓包。
