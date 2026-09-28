# analysis.history 与 FM 测试数据后续规划

更新时间：2026-09-28。本文是规划与验收清单，不代表新增实现、发布或部署已经完成。

## 当前事实

- VSP capability parity 矩阵仍为 54/71，`analysis.history` 为 `PARTIAL`；不要因核心路径有真机证据而改报完整对齐。
- `getTransportScope` 的 LOADS + WBCROSSGT/CROSS 组合链有专用 DEV 只读验证，包含决定性结构边正例、边界分类和部分状态传播。证据：[传输 cross-reference 真机验证](transport-crossref-real-dev-verified.md)。
- 缺口审计已完成：[analysis.history 缺口审计](analysis-history-gap-audit.md)。各项仍须按子能力分别证明，不以整个 tool catalog 的存在推断等价。
- FM 测试数据工具只读 EUFUNC 目录/元数据；`CLUSTD` EXPORT 集群 payload 不解析。证据：[FM 测试数据目录层真机验证](fm-test-data-real-dev-verified.md)。
- Payload 源码审计有新进展：用户提供的 VSP checkout 精确匹配矩阵固定 SHA，MIT 许可和 decoder/compressor 内部依赖已核实；本地 EUFUNC V5 fixtures 可供审计，但脱敏/再分发资格未核实，不复制使用。隔离离线原型已完成，并以合成数据测试覆盖受限格式子集；全仓 Jest/build 通过。主项目 MCP/API 接入仍 NO-GO，直到 datapreview `CLUSTD` wire 表示及完整性得到独立验证。详见 [payload 可行性审计](fm-test-data-payload-spike.md) 与 [FM API 集成计划](fm-test-data-api-integration-plan.md)。
- 包版本为 0.8.4。是否发布包含这些代码的新版、npm 状态及用户 MCP 客户端部署/重启验收，均需独立核实；离线或 DEV smoke 不等于已发布、已部署。

## 规划 A：analysis.history 缺口与验收

| 缺口 | 当前结论 | 下一步 / 完成条件 |
| --- | --- | --- |
| 传输请求 CR 分组 | 目标 DEV 未配置 E070A CR 分组；当前读传输成员并集不能推断 CR 边界 | 暂不实现猜测性分组。若未来目标系统可读且有权限，先只读取证字段/关系并构造已知父子/冲突/缺失样本，再确定接口与保守 partial 规则 |
| 动态调用边 | 当前静态交叉引用不能完整解析动态 ABAP 调用 | 先定义可支持语法/解析来源与 UNKNOWN 表达；以实际 DEV 源码样本验证正负例和误报边界，覆盖不了的调用明确列为 partial |
| 包归属元数据 | 当前组合边界不等价 VSP 完整包归属分类 | 确认可用只读 ADT/API 来源及权限；通过对象归属和缺失/歧义样本验证后再接入，禁止依据名称推断包 |
| 完整图引擎语义 | 已验证调用方快照 impact/stats/boundaries 与有界 LOADS/TR 采集路径的核心行为；非 VSP 全量图引擎 | 对照 VSP 每种边与查询的任务语义，逐项指定证据等级；在任何扩展后保持 `systemWideComplete=false`，让读取失败、截断、未知类型与不一致持续传播为 partial |

建议优先级：先补充验证缺口的 fixture/契约和矩阵 evidence，再只在外部系统确有安全只读来源时实现 CR/包归属；动态图边应独立立项。每个子项完成前维持矩阵 `PARTIAL`。

## 规划 B：FM 测试数据 payload 解码可行性

当前目录层能力已经可用，不需要为其扩大 scope。固定上游源码/许可来源已核实，可以做不接 SAP、不接 MCP 的离线 decoder 原型；在确认 payload 可安全传输、fixture 可使用并完成 contract 验收之前，不接入线上 API/tool。最低前置条件：

1. **格式与依赖审计**：审阅 VSP `pkg/datacluster` 与 `sapcompress` 的来源、许可证、传递依赖、版本/格式支持；确认 S/2 EXPORT 集群格式适用性，避免只凭源代码行数估时。
2. **脱敏样本**：准备合法、空 payload、多 SRTF2 续块、压缩/未压缩、目录行及损坏/截断数据样本；样本不得含个人或业务敏感字段，核对可否纳入仓库 fixtures。
3. **边界契约**：定义只解码允许的数据结构；限制输入字节数、解压后大小、深度、字段数、CPU 时间及输出大小；循环/恶意长度/未知类型/损坏集群应失败关闭并给出脱敏错误。不得执行解码出来的 ABAP 或将内容用于写入。
4. **独立验证**：先用离线 golden fixtures 对照已知结果，再用明确授权的专用 DEV 只读样本验证；区分目录存在与 payload 成功解析。缺字段、部分块和通道失败不能返回貌似完整的 inputs/outputs。
5. **决策门**：若无可安全共享的样本、维护成本过高或只能覆盖不清楚的子集，则保留目录层功能并明确不支持内容解码；只有格式、依赖、样本和安全门槛均通过才进入实现。

## 发布与部署验收门

- 先核对本次改动纳入的代码、包版本/CHANGELOG 与矩阵 `released` 证据；未发布代码不得描述为 npm 已交付。
- 发布后验证目标包版本与安装产物；用户环境部署另行确认。
- MCP 客户端变更按项目规则硬重启，确认新 healthcheck session 与旧 plan `PLAN_NOT_FOUND`。未取得证据前，部署状态记为 pending。

## 本轮边界

本规划更新未连接 SAP、执行远端操作、发布 npm 包或修改客户端配置；本轮自动化验证结果见 [`PROGRESS.md`](../../PROGRESS.md)，所有真机结论只引用已有 evidence 文档。
