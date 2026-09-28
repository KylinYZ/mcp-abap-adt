# `analysis.history` 缺口审计

审计日期：2026-09-28。范围：当前仓库的 `getTransportScope`、加载图/传输边界采集与分析能力，对照 VSP capability parity 矩阵及仓库内已记录证据。本文为代码与证据审计；本次未连接 SAP、未重新运行真机 smoke，也未更改功能矩阵状态。

## 结论摘要

`analysis.history` 仍应保持 **PARTIAL**，矩阵总对齐维持 **54/71**。现有实现覆盖共同变更/传输历史、D010INC 单跳 LOADS、多跳有界 LOADS 图、显式传输成员采集、LOADS 与 WBCROSSGT/CROSS 出边组合的 TR 边界分类，以及显式快照上的 impact/stats/boundaries 算法子集。它并不等于 VSP 完整图引擎：自动 CR 成员分组、动态调用解析、包元数据来源、图健康度/完整图统计等仍未闭环；一些图分析函数只针对调用方提供的快照，不负责采集全系统图。

证据层级必须区分：`transport-crossref-real-dev-verified.md` 记录了 2026-09-25 专用 DEV 的只读真机验证；`load-dependency-graph-offline-alignment.md` 与 `transport-boundaries-offline-alignment.md` 记录离线/mock 算法验证，不能升级为真机验证。功能存在、离线测试通过、真机已验证、发布/部署完成是不同状态。

## 子能力审计表

| 子能力 / 缺口 | 当前实现及矩阵状态 | 现有证据与边界 | 可实施来源 / 阻碍 | 风险 | 增量验收标准 | 优先级 |
|---|---|---|---|---|---|---|
| CR 分组与 CR 边界（`cr_boundaries`） | `analyzeDependencyGraph(boundaries)` 接受显式 `objectIds` 集合；`getTransportScope` 从 E070/E071 采集 TR 成员。尚未从 CR 自动分组多个 TR 并生成集合。 | `transport-boundaries-offline-alignment.md`：显式集合边界仅离线验证。`transport-crossref-real-dev-verified.md`：TR 的成员→结构边→分类核心链真机闭环，但 CR 分组依赖的 E070A 在 sap-demo 未配置。 | 查明并验证目标 SAP 版本上 CR/任务/请求分组的权威只读来源；若 E070A 未配置，应先记录系统限制，不从父子任务关系猜 CR。必要时以脱敏真实 DEV 样本建立只读 SQL contract。 | 把 TR 错并为 CR 会产生假“范围内”依赖；空分组/权限受限容易伪装成无成员。 | 至少两个具有可核实 CR 归属的请求样本；覆盖含/不含成员、重复请求、缺字段、权限拒绝、截断；与 SAP 显示/权威只读数据逐项核对；错误或不确定时保留 partial，不得宣称可释放。 | P1，外部来源确认后实施 |
| 动态调用 / `DYNAMIC_CALL` 采集 | boundaries 算法能分类图中已有 `DYNAMIC_CALL` 边；传输采集器当前 WBCROSSGT/CROSS 结构边路径产出 REFERENCES/CALLS，未见动态调用解析/动态边采集。 | `transport-boundaries-offline-alignment.md` 是输入快照上的离线分类证据；`transport-crossref-real-dev-verified.md` 真机验证的是静态出边，不是动态解析。 | 先找现有 VSP `pkg/graph/builder_parser.go` 与 SAP 端可用静态分析/交叉引用来源。动态目标若只能从源码解析，需明确支持的 ABAP 语法范围、常量折叠能力和不可解析情形；无证据不得臆造 ADT endpoint。 | 动态调用可能漏报或错误解析；把未知目标当静态确定边会给出虚假的边界结论。 | 针对字面量、常量、变量、拼接、宏/条件编译等建立 fixture；解析边与 unresolved 动态调用分开计数；限定语法支持范围，未知保持显式 partial；若使用 SAP 来源需单独真机对照。 | P1，先做可行性 spike |
| 包归属 / 跨包分类 | boundaries 可对图快照中已有 package 属性分类；缺失包信息计入 `inScopeUnknownPackage`，不会冒充同包。成员采集和 WBCROSSGT/CROSS 组合链未证明提供完整 package 元数据。 | `transport-boundaries-offline-alignment.md`：包缺失语义与算法离线验证。crossref 真机证据证明边采集，不证明传输所有成员包元数据完整。 | 审计当前 ADT 对象目录/包元数据 reader 是否可安全复用；明确软件组件、包继承和对象未分配包的语义。不能通过对象名推断 package。 | 将未知包误标同包或跨包会漏报依赖；多请求读取非原子，元数据可能与传输快照时点不一致。 | 对至少两类对象及包继承/无包/读取失败 fixture 验证；输出来源与状态；任何缺失或截断均保留 unknown/partial；真实系统只读核对后才声称真机数据源验证。 | P1，低风险只读来源确认后 |
| 多跳 LOADS 与 FUGR 方向覆盖 | `getLoadGraph` 读取 D010INC 单跳；`buildLoadDependencyGraph` 有界 BFS 串行组合。加载语义是编译加载依赖，不等同 CALLS。FUGR 反向查询被保守拒绝/停止展开。 | `load-dependency-graph-offline-alignment.md`：新增多跳链仅 fixtures/mock 离线验证。`transport-scope-real-dev-verified.md` 记录 `ZCL_MCP_SM21_ADT_HTTP` 单跳 26 条真机边；crossref real-dev 文档亦有组合链结果。 | 在专用 DEV 上对多跳和 FUGR 池命名形态做小预算只读验证；只有拿到命名形态证据才考虑补查询。 | 多次查询不是原子快照；截断、预算、对象不存在与合法空结果不可混为一谈；FUGR 误扩展造成漏边/错误归属。 | 验证多跳深度/方向、查询预算、失败/截断传播；FUGR 正反向各有真实样本或明确限制；证明无重复查询、无写调用；报告保持 systemWideComplete=false。 | P1，限量真机验证 |
| Impact / 图统计 | `analyzeDependencyGraph` 对输入快照提供 impact/stats 算法，不负责采集系统级全图；结果完整性只对已收集快照有意义。 | `dependency-graph-offline-alignment.md`：离线算法对齐，明确不新增真机证据；`load-dependency-graph-offline-alignment.md`：impact 只针对已收图，systemWideComplete 恒 false。 | 分开定义图采集和图查询合同；若将来要系统级 impact，需明确范围/授权/预算以及可支持的来源，不可把 snapshot 查询包装成系统全局影响分析。 | UI/agent 可能把“snapshot complete”误解为系统完整；混合异步读数产生时点不一致。 | API/说明分别陈述 snapshot completeness 与 source acquisition status；构造 partial/truncated/empty cases；不提升系统完整性标志；新增远端范围前须有读源证据和预算测试。 | P1，继续保留边界 |
| `health` / 全图 `graph_stats` 与 VSP 图引擎等价 | 矩阵仍将整个 `analysis.history` 标记 PARTIAL；尚无证据表明已有等价的图健康检查、全图统计采集及其完整范围。 | `transport-crossref-real-dev-verified.md` 明确列为图引擎轮剩余范围；矩阵 JSON `analysis.history.restrictionReason` 也将 health/graph_stats 等列为剩余缺口。 | 对照 VSP `pkg/graph` 的定义逐操作拆合同，确认 health 的输入/输出、图构建来源、错误语义；区别现有快照 `stats` 与系统级 graph_stats。 | 只实现同名空壳会造成矩阵虚假晋级；全量采集可能越过预算和只读执行门控。 | 每项能力独立矩阵映射、源数据契约、快照范围声明、离线契约测试及必要真机证据；未满足前保持 PARTIAL。 | P2，先做范围定义 |
| `where_used_config` / `usage_examples` 及其它列举操作 | 矩阵把这些操作列在 `analysis.history` VSP 参数面中；现有 evidence 尚未证明当前 getTransportScope/load graph/boundaries 链等价覆盖它们。 | `vsp-capability-parity-matrix.json` 的 `analysis.history` restrictionReason 列出这些操作；本次检索到的 transport/load graph evidence 未提供其等价验证。 | 逐操作审阅 VSP handler 和实现，确认是否被本项目其他 tool 覆盖、是否有意限制，避免仅按总能力行判断。 | 以相邻工具或名字相似功能冒充语义等价。 | 对每个 VSP 子操作记录覆盖工具、参数/结果/角色差异、证据链接与状态；缺证据保持 PARTIAL/GAP。 | P2，矩阵映射审查 |

## 证据冲突与文档时效

审计发现的证据冲突已于 2026-09-28 更正：`transport-scope-real-dev-verified.md` 新增后续证据说明，明确其旧“剩余缺口”措辞已过时；VSP capability matrix JSON/Markdown 也已同步移除“WBCROSSGT/CROSS 未实现”的当前态误述。专门 crossref DEV 证据仍是此能力真实验证范围的依据；更正不扩大其样本覆盖，也不改变 `analysis.history` 的 PARTIAL 状态。

本次 CodeGraph 审阅确认 `getLoadGraph` 使用 D010INC 并带机器可读采集状态，`collectTransportLoadBoundaries` 可组合 crossref / load source；仓库证据对 VSP 引擎定义及真机边界的描述作为语义依据。CodeGraph 结果不是验证结论，真机范围只以明确列出的 real-dev evidence 为准。

## 建议执行顺序

1. **P1：刷新证据索引与状态一致性。** 以 crossref 专项证据纠正 `transport-scope-real-dev-verified.md` 旧缺口表述；清点矩阵每个 `analysis.history` 子操作到工具/evidence 的映射。此为文档治理，不改变能力状态。
2. **P1：确认 CR 权威来源。** 先在目标专用 DEV 核实 E070A/CR 分组可用性和数据合同；若不可用则记为环境阻塞，不猜测、不做 SAP 写操作。
3. **P1：动态调用 spike 与多跳 LOADS 真机小样本。** 先限定解析支持面和采集预算，只读、串行、明确允许后执行；失败/不确定都维持 partial。
4. **P1：package 元数据来源审计。** 能复用已验证只读 ADT 读取时再实现；先用离线 fixture 确保 unknown 状态传播。
5. **P2：图健康度/系统级 graph_stats 合同定义。** 与现有输入快照 stats 分开，不以“名称相同”晋级。

任何真实 SAP 验证应由用户明确授权并使用专用 DEV 配置，默认串行、只读；本次不执行。即使后续核心路径补齐，只有参数、结果、系统角色、采集范围及证据都达到合同要求，才可重新评估矩阵状态。部署、硬重启验收与 npm 发布仍是独立事项。
