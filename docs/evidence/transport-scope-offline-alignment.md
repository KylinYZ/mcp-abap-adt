# 显式传输成员只读采集：离线对齐

日期：2026-09-24。源码未发布，未连接 SAP，未部署到用户日常 MCP 客户端。

## 交付

新增 `getTransportScope({ transports: ["DEVK900001"] })`，仅接受 1–10 个显式请求/任务编号。
沿用既有 datapreview `runQuery(sql, limit, true)` 只读通道，不接受外部 SQL、URL 或报文。
最多四次串行 SELECT：请求/任务 E070 头、必要时父请求头、兄弟任务、E071 对象成员。
选择任务意味着纳入整个父请求及其兄弟任务；多编号为显式并集，不声称已自动发现 CR。

返回 graph、boundaryScope、requests、transports，以及 collection 的 reads/issues/status。
R3TR 对象以精确 TYPE:NAME 建节点，IN_TRANSPORT 指向父请求；重复成员边去重。
LIMU 及其他非 R3TR 行不映射、不凭相似名称猜身份，报告计数及 partial。
空成员范围不符合 boundaries 的非空输入要求，调用方必须先处理空范围。

## 对齐依据与约束

参考本地 `vibing-steampunk` commit `9886d2727f47506368b0a3c2f1c1766f1200f747` 的
`pkg/graph/builder_transport.go`：R3TR 成员、任务归并请求。MIT 归属已补充。
本项目比参考实现更保守：不静默跳过缺失头、冲突头、异常数据或 LIMU；这些均标记 partial。
SQL 形态复用本项目 TransportHistoryApi 已有 E070/E071 查询，不新增 ADT 协议。

- 输入最多 10 个编号；头/兄弟任务查询上限 500 行，成员上限 2000 行；刚好达到行限也按可能截断处理。
- 最多读取 100 个请求/任务的成员，最多返回 450 个对象；预算溢出显式报告。
- 异常/缺失 values 不冒充空成功，远端错误正文不透出；不自动重试。
- 不跨多层猜测父子关系；拒绝自引用、冲突头及不属于查询范围的记录。
- 输出不超过既有图分析的 500 节点/2000 边约束；对象名超过图契约 80 字符时报告 unsupported。
- 连续查询不是原子快照；期间传输内容可能变化。complete-within-r3tr-reader-scope 仅表示本次有限读取无已知缺口。
- IN_TRANSPORT 不是结构依赖。直接对仅含成员边的图运行 boundaries 得到空依赖，不能证明安全或完整。
- 不读取 E070A 配置、不修改 E071/E071K、不创建/释放传输，不提供可发布结论。

## 验证

- 全量 Jest：167 suites / 1736 tests，默认覆盖率门禁通过（新增 37 项采集/处理器测试和 7 项目录策略测试）。
- 覆盖任务/父请求/兄弟任务、串行与定额、SQL 注入拒绝、缺失/冲突/截断、LIMU、脱敏及图输入兼容。
- 5 类系统角色 × 5 个兼容 profile 可分派只读工具；safe/business 隐藏且 dispatch 拒绝。
- 离线 MCP smoke：禁止网络，真实 stdio 分派成员采集 → 加载图 → boundaries；两次新进程 healthcheck disconnected，合成旧计划 PLAN_NOT_FOUND。
- 上述都不是 SAP 真机证据或用户客户端重启验收。矩阵 analysis.history 保持 PARTIAL、54/71。

下一步：有界结构依赖采集与传输范围统一组合，传播成员/依赖两边的不完整性；仍不自动推断 LIMU 或 CR 属性。
