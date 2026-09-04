# 31 类仓库对象创建产品化实施计划

关联设计：`docs/superpowers/specs/2026-08-25-repository-creation-productionization-design.md`

## 阶段 0：接管与冻结现场

1. 阅读 `AGENTS.md`、生产化设计、本计划和交接文档。
2. 阅读 `PROGRESS.md`、`BLOCKED.md` 和 campaign matrix。
3. 运行基线：106 suites / tests ≥719、build、coverage 31/111/0、diff check。
4. 读取 `sap-dev.env`，确认 DEV/client 300、31 类、`ZV`、`Z001`、`S4HK900009`；不要输出凭据。
5. 只读核验 handoff 中列出的 active/absent 对象。
6. 不重放任何历史计划，不清理现有对象，不修改 QAS/PRD。

验收：工作区现状和真实 SAP 状态与交接文档一致；没有 SAP mutation。

## 阶段 1：验证专用 Cleanup Workflow

### 1.1 类型和计划存储

- 新增 cleanup request/plan/status 类型。
- 计划绑定 host、client、SAP user、role、profile、objectKind、object identity、package、transport、依赖摘要和 TTL。
- 终态清除私有 payload；任何 plan 只消费一次。

### 1.2 Preview

- 只允许 DEV + approved profile + validation switch。
- 校验 validation prefix/package/transport。
- Server 搜索并读取 exact object identity、active/final state和依赖。
- 冻结逆序清理图，不接受调用方 URL/锁/删除顺序。

### 1.3 Apply

- 使用独立原生确认。
- 完整 cleanup workflow 只进入 execution gate 一次。
- 每个对象在删除前重新验证 identity/transport/dependencies。
- 删除结果未知立即停止；不重试、不继续父对象。
- 删除后 search 缺失，并复核固定传输/task 中恰好保留匹配的 CTS 删除条目；不得修改 E071 或删除整个传输。

### 1.4 工具与测试

- 增加 preview/apply/status 三个 validation-only 工具。
- 增加 accept/cancel/timeout/malformed/disconnect、一次执行、逆序、未知结果、锁释放、非验证对象拒绝测试。
- 更新 request limits、catalog budgets、surface fixtures 和文档。

验收：自动化门禁通过；未调用真实 SAP。

## 阶段 2：Maturity Evidence Gate

1. 新增 repository creation maturity evidence manifest。
2. 记录 create/readback/transport/cleanup/absence 五类证据；transport 必须同时证明创建时归属与删除后唯一精确 CTS 删除条目。
3. Registry 测试要求 `REAL_DEV_VERIFIED` 必须有完整 evidence。
4. Coverage 脚本输出每种 maturity 数量和缺失证据。
5. capability 仍逐类显式声明，不支持通配晋级。

验收：故意移除任一证据时测试失败；现有 31 类暂不自动晋级。

## 阶段 3：Wave 1 正式开放

对象：Domain、Data Element、Table Type、Program、Message Class、Logical Schema、Number Range、CDS Type、CDS Aspect、RONT、NONT。

每类执行：

1. 选择新的 validation identity，确认不存在。
2. preview → 原生确认 → apply。
3. 独立 active/final readback 和 transport evidence。
4. 单独 cleanup preview → 原生删除确认 → apply。
5. search 缺失和 transport 复查；CTS 必须保留唯一精确删除条目，以便下游系统同步删除。
6. 写 evidence manifest。
7. 把该 capability 晋级 `REAL_DEV_VERIFIED`。
8. 关闭 validation switch 后验证该类型仍可生成正常 preview；不要再次真实创建。

依赖清理顺序：NONT → RONT；Number Range → Domain；Data Element → Domain。其余独立。

验收：每类单独可回滚；完成一类即可正式使用一类。

## 阶段 4：Wave 2 协议修复

### 4.1 Source Object / Type Group

- 完成 Eclipse SFS session 与 HTTP 200/no-Location 返回语义取证。
- 仅在同步成功响应 + exact identity body/readback + absence-before + package/transport/current-user 共同证明 ownership 时接受。
- Interface、Class、Program Include、Type Group 分别用全新身份验证；历史空壳不复用。

### 4.2 Database Table

- 在 verifier mismatch 中记录脱敏 token mismatch 摘要。
- 用一次新 identity 获取真实差异；达到新证据前不再放宽 tokenizer。
- 修复后完成 source、table activation、technical settings、cleanup 全链路。

### 4.3 Package

- 反编译 Eclipse package creation responsible 逻辑。
- 使用当前认证用户并通过 SAP validation/system user 契约确认。
- 禁止从父包复制系统用户 `SAP`，禁止猜测用户名。

### 4.4 Function Group Family

- 捕获 group/module active source 的安全差异摘要。
- 修正 group + first module verifier。
- 成功后按 Group → Include → Module 创建，按 Module → Include → Group 清理。

### 4.5 DDIC Structure

- 捕获 Eclipse source check endpoint。
- 在 PUT 前运行 check；错误时不创建 shell或安全补偿。
- 完成 source、activation、active readback 和 cleanup。

验收：Wave 2 每类按阶段 3 相同标准晋级。

## 阶段 5：Wave 3 依赖链

1. `DATABASE_TABLE`
2. `DDIC_LOCK_OBJECT`
3. `CDS_DATA_DEFINITION`
4. `CDS_ACCESS_CONTROL`
5. `CDS_METADATA_EXTENSION`
6. `SERVICE_DEFINITION`
7. `BEHAVIOR_DEFINITION`
8. `CDS_ENTITY_BUFFER`
9. `SERVICE_BINDING`
10. `CHANGE_DOCUMENT_OBJECT`

所有父引用在 preview 和 apply 都必须复核 active identity。CHDO 生成对象、Service Binding 发布状态等任何未知结果停止且不自动删除。

验收：按依赖逆序清理后逐类晋级。

## 阶段 6：外部权限与最终关闭

1. 由 SAP 管理员补齐 Annotation Definition 创建权限。
2. 使用新身份完成其完整生命周期并晋级。
3. 确认 31 类全部 `REAL_DEV_VERIFIED`。
4. 设置 `SAP_MCP_REAL_DEV_VALIDATION=false`，硬重启。
5. 验证正常 DEV Profile 下 31 类 `writable=true`，cleanup validation tools 隐藏。
6. 验证 QAS/PRD 仍全部不可写。
7. 更新 README、使用指南、AGENTS、CHANGELOG、phase gate 和 coverage roadmap。

最终验收：31 类关闭验证开关后可正常 preview/apply；真实 mutation仍逐次原生确认；测试、构建、coverage和文档全部一致。

## 停止规则

- 旧 plan、超时 plan、`OUTCOME_UNKNOWN` plan 不重放。
- 同类连续三次失败停止该类。
- shared lock、session、transport 或生成对象结果不明时停止整个真实活动。
- 不为了通过测试降低 verifier、删测试、使用 caller confirmation 或 raw mutation。

