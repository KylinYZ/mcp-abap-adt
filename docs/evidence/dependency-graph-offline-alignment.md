# analysis.history：依赖图离线对齐（2026-09-24）

## 范围与结论

本机不能真机实测，本轮仅实现 `analyzeDependencyGraph` 本地工具：

- `impact`：从给定根沿入边反向 BFS，输出直接/间接受影响对象、最短深度、前驱、边类型和来源标签。
- `stats`：按对象类型、包、边类型、来源统计；重复边保留为独立证据计数，影响节点不重复。
- 不自动读取 SAP，不调用 ADT/RFC，不锁对象，不创建/释放传输，不执行数据库写入。
- 输入为调用方提供的有界快照；来源标签不视为真机证据。空结果不能证明 SAP 中没有影响。
- `analysis.history` 仍为 **PARTIAL**，对齐总数仍为 **54/71**。本轮不新增任何 `real-dev-verified` 或对象创建成熟度声明。

## 参考与有意差异

参考本地 `D:\Dev\sapMcp\vibing-steampunk`，commit
`9886d2727f47506368b0a3c2f1c1766f1200f747`：

| 参考源码 | 本项目对应 |
| --- | --- |
| `pkg/graph/queries_impact.go` | `src/lib/DependencyGraph.ts` 反向 BFS、最短路径、环保护、类型过滤 |
| `pkg/graph/graph.go` | 边方向/类型与图统计 |
| `pkg/graph/queries_impact_test.go` | 单跳、多跳、深度上限、环、混合传输图、扇出等行为测试 |

MIT 许可证及来源说明随包保留于 `third-party/vibing-steampunk/`。
不同于 VSP 的可变图和远端 builder，本工具只接受已提供的快照，并拒绝
不存在的根、重复节点、悬空边和未声明字段，避免用空结果掩盖输入错误。

边方向固定为「依赖者 → 被依赖者」。`LOADS` 不等于 `CALLS`，
`CO_TRANSPORTED` 仅为共同传输相关性。未指定 `edgeKinds` 或给空数组时遍历所有类型。
同长度路径以输入边顺序决定展示前驱；只展示一条最短解释链，不是全部路径。

节点最多 500，边最多 2000；深度默认 3、范围 1–10；结果默认 200、范围 1–500。
实际越界分别标记 `depthLimitReached` / `entryLimitReached`。
`completeWithinSnapshot` 仅指当前快照与已选择边类型，不承诺系统完整性。
全局请求/响应字节限制仍生效，不提高既有运行时上限。

## 下一步推荐

1. 在此底座上接入已有只读数据源，先做窄范围图构建，再扩展传输/CR 边界分析。
   必须传播采集失败、行数截断和来源完整性；不能将局部图冒充系统完整图。
2. `diagnostics.knowledge-queries` 的 `fm_test_data` 不走「直接读 TE_DATADIR/FDESC_COPY」捷径：
   VSP `pkg/adt/fmtest.go` 先读取 EUFUNC 集群，再经 `pkg/datacluster` 解码这两个**集群内对象**。
   需要单独对齐集群重组/解码器与脱敏 fixtures，不猜测 datapreview 能直接返回结构。
3. `execute-abap`、AMDP 受控会话链仍需独立设计与协议证据；本轮不触碰。

## 抓包协作约定

本轮纯本地算法无需 Eclipse 抓包。后续若发现协议缺口，暂停该能力并明确请求：
操作步骤、SAP/ADT 版本、HTTP 方法与相对路径、查询参数、请求 Content-Type/Accept、
脱敏请求体、状态码、响应 Content-Type 与脱敏响应体；有状态动作需要按顺序提供全链。
不要提供密码、Authorization、Cookie、CSRF token 或可复用 session/lock 值。
抓包只能确认协议形态，不能替代真实 apply/readback/cleanup 等生命周期验证。

## 验证状态

| 验证项 | 实际结果 |
| --- | --- |
| 锁文件依赖安装 | `npm ci --ignore-scripts`，不运行原生 RFC 安装脚本；未修改 lockfile |
| 全量功能测试 | `npm test -- --runInBand --coverage=false --silent`：164 suites / 1615 tests 全通过 |
| 默认覆盖率门禁 | `npm test -- --runInBand --silent`：164 suites / 1615 tests 全通过，默认 coverage reporters 与既有 thresholds 均通过，退出码 0 |
| 构建 | `npm run build` 通过 |
| 创建成熟度 | `node scripts/check-repository-creation-coverage.mjs` 通过；28 份证据、缺失 0，成熟度未改变 |
| 功能矩阵 | `node scripts/check-vsp-capability-parity.mjs --check` 通过，71 行、54 项对齐 |
| 离线 MCP smoke | `node scripts/dependency-graph-offline-smoke.mjs` 通过；真实 stdio 客户端 + 两个不同 PID，healthcheck 均为 disconnected / generation 0；旧的合成内存计划重启后 PLAN_NOT_FOUND |
| 格式检查 | `git diff --check` 通过 |
| 参考源码 | 本轮参考的 graph/impact/tests/fmtest 文件均无本地改动，匹配记录的 VSP commit |

本轮增加 49 项测试（新图套件 42 + catalog/role 7），总套件数增加 1。
初次使用非锁定依赖安装的定向测试虽 86 项断言通过，但 Windows coverage 文件路径报错；
恢复锁文件安装后，默认全量覆盖率运行成功。未关闭默认配置，也未降低任何覆盖率阈值。

**SAP 真机、用户日常 MCP 客户端部署与发布均未验证。**
离线 smoke 只证明新构建的本地 MCP 进程行为：内存计划为测试夹具，未调用 preview/apply；
网络被禁止，未建立 SAP session。因此不能把该测试写成真实 SAP 会话重启验证。
