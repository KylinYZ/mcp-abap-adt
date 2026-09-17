# VSP 能力对齐矩阵实施计划

## 目标

以 `D:\MyDev\SAP\vibing-steampunk` 的当前 MCP 对外能力为下限，使本项目能够让用户完成等价的 SAP 工作任务；本项目可以采用不同的工具名、ADT 协议或更严格的服务端安全工作流。

“对齐”不表示照搬 VSP 的 Go 实现，也不表示在所有 profile、所有 SAP 系统角色中都开放同样的写入能力。一个能力只有在目标 profile 和系统角色中可被安全地完成时，才算对齐。

## 本次基线

审计源必须同时记录 commit 和工作树状态，避免把未提交的实现误报为已发布能力：

| 项目 | 当前 commit | 审计入口 | 备注 |
| --- | --- | --- | --- |
| VSP | `9886d2727f47506368b0a3c2f1c1766f1200f747` | `internal/mcp/tools_register.go`、`internal/mcp/tools_focused.go`、`internal/mcp/handlers_universal.go` | 工作树含 RFC、兼容层等未提交变化；矩阵要记录其来源状态。 |
| 本项目 | `a8cdeda38dc4bbb8a98896e4f42e5925eed3d8ef` | `src/index.ts`、`src/config/ToolProfiles.ts`、`src/config/ToolOperationPolicy.ts` | 工作树含 `focused` 和 cleanup 调整；不得以旧文档的工具计数代替实时 catalog。 |

VSP 的 universal `SAP` 路由覆盖 source、read、search、grep、开发工具、ATC、CRUD、debug、AMDP、transport、Git、report、RFC、dump、trace、lint、analysis、service binding 和 revisions。VSP 的 focused 集合还公开了相应的主要任务工具。本项目已有独立 handler catalog、角色 profile、执行门控和受控仓库创建/清理工作流。

## 对齐判定

逐行矩阵使用以下状态，禁止只按工具名称或工具数量判断：

| 状态 | 含义 | 允许进入完成率 |
| --- | --- | --- |
| `MCP_SUPERSET` | 本项目完成同一任务，且多了可验证的安全或复读保证 | 是 |
| `EQUIVALENT` | 两边可完成同一任务，关键输入、输出和副作用相当 | 是 |
| `PARTIAL` | 只覆盖对象、参数、结果、系统角色或生命周期的一部分 | 否 |
| `GAP` | VSP 已对外提供、本项目没有等价任务路径 | 否 |
| `INTENTIONAL_RESTRICTION` | 因 QAS/PRD、无 SAP helper、无授权或不可安全验证而限制；必须写明替代路径和解除条件 | 否 |
| `UNVERIFIED` | 代码存在但未完成当前版本的自动化或专用 DEV 验证 | 否 |

一个 VSP 工具可映射到多个本项目工具；一个本项目任务也可比 VSP 多出 preview、原生确认、apply、status、readback、cleanup 等步骤。矩阵必须写出完整任务链，而不是把 `preview` 单独当成已支持写入。

## 矩阵工件

第一实施 PR 新增下列工件，而不是手工维护一篇随时间失真的对照文章：

1. `docs/evidence/vsp-capability-parity-matrix.json`：唯一机器可读真源，一行一个 VSP action 或独立工具。
2. `docs/evidence/vsp-capability-parity-matrix.md`：由 JSON 生成的评审视图，按能力域、优先级和状态汇总。
3. `scripts/check-vsp-capability-parity.mjs`：校验 schema、唯一性、映射目标工具仍存在、profile/role 限制完整、P0 不允许无理由 `GAP`。
4. `src/__tests__/VspCapabilityParity.test.ts`：从运行时 `createToolCatalog()` 和 profile 选择结果验证矩阵所引用的本项目工具，不把静态字符串当作证据。

JSON 每行最小字段：

```jsonc
{
  "id": "rfc.remote-enabled.call",
  "domain": "rfc",
  "vsp": {
    "surface": "SAP(action=rfc, op=call)",
    "source": "internal/mcp/handlers_rfc.go",
    "requires": ["direct RFC gateway connectivity", "remote-enabled FM"]
  },
  "mcp": {
    "status": "GAP",
    "taskPath": [],
    "profiles": [],
    "systemRoles": [],
    "restrictionReason": ""
  },
  "priority": "P0",
  "evidence": ["source-audit"],
  "nextMilestone": "rfc-transport-spike"
}
```

上例是 JSONC 展示；实际 `.json` 不允许注释。每次更新 VSP 能力时必须更新 `vspRevision`、`vspWorktreeState` 和发现日期；CI 不要求存在 VSP sibling checkout，也不在本项目 CI 中编译或运行 VSP。

## 初始工作流矩阵

以下是当前源码审计得到的启动清单。`NEEDS_AUDIT` 不是缺口结论，而是要求在首个矩阵 PR 中按逐工具输入输出确认。

| 域 | VSP 当前任务面 | 本项目初判 | 优先级 | 下一步 |
| --- | --- | --- | --- | --- |
| 源码、对象读取、搜索、grep、依赖/调用图 | `SAP` read/search/grep/analyze 与 focused 读取工具 | `EQUIVALENT` 或 `MCP_SUPERSET`，逐工具核验 | P0 | 对照 source/member read、search、code analysis handlers |
| 源码改动、锁、激活、删除、重命名、格式化 | VSP CRUD/edit/pretty-print/workflow | `MCP_SUPERSET` 候选；写入必须核验 preview/confirm/readback 链 | P0 | 映射受控变更及 expert 原子工具 |
| DDIC：域、数据元素、表、结构、类型 | VSP generic create、table 与 DDIC text 工具 | `MCP_SUPERSET` 候选；`DDIC_DOMAIN`/`DATA_ELEMENT` 已有独立受控创建证据 | P0 | 比对创建字段、标签、多语言与维护路径 |
| 传输、对象归属和清理 | VSP transport/CRUD | `MCP_SUPERSET` 候选 | P0 | 映射 transport read、受控 creation/cleanup、未知结果边界 |
| ABAP Unit、语法、ATC、质量 | VSP unit/coverage/check/lint/ATC | `PARTIAL` | P0 | 先核验 unit、ATC、syntax；覆盖率与本地 lint 单列缺口 |
| RFC：远程启用 FM | VSP direct `openrfc` 的 describe/call/search/read-table | `GAP` | P0 | 独立 RFC transport spike；不复用 ADT cookie 假装 RFC。2026-09-17 修订：传输基座定为本地 open-rfc（TS），见「2026-09-17 规划修订」节 |
| RFC：非 remote-enabled FM | VSP `ZADT_VSP` WebSocket bridge | `INTENTIONAL_RESTRICTION` | P1 | 仅在 SAP helper 已安装、DEV 和明确授权时评估 |
| 报表、后台作业、spool | VSP report actions 及 RFC job/spool 路径 | `GAP` | P1 | 先拆为 run、status、log/spool；分别评估 ADT/RFC/helper 前提 |
| AMDP 调试 | VSP ADT 与 `ZADT_VSP` 两套 AMDP 路由 | `GAP` | P1 | 先做目标系统 discovery 和 helper/ADT 前置检查 |
| 调试、breakpoint、listener、变量 | VSP debugger actions | `EQUIVALENT` 或 `PARTIAL` | P1 | 对照本项目 safe debug 生命周期，优先保持更严格确认边界 |
| dump、trace、SQL trace、运行诊断 | VSP dump/trace/sqltrace | `PARTIAL` | P1 | 先对照 ST22、SM21、trace 类型与查询范围 |
| abapGit、gCTS、文件导入导出 | VSP Git/gCTS/file actions | `PARTIAL` | P1 | 分离 SAP-side git、gCTS 和本地文件副作用，禁止一次性开放 |
| UI5 | VSP UI5 app/file actions | `GAP` | P2 | 先做只读 app discovery/read；写入另立受控计划 |
| 多语言与文本池 | VSP i18n、text pool、DDIC/message texts | `PARTIAL` | P2 | 先复用本项目 DDIC 文本能力，再补 text pool/message class 映射 |
| revision、比较、版本历史 | VSP revisions/compare actions | `EQUIVALENT` 或 `PARTIAL` | P2 | 对照 revision handlers 的对象范围与 diff 输出 |
| 安装、自检、feature discovery | VSP install/helper/features | `INTENTIONAL_RESTRICTION` | P2 | 本项目只提供诊断与前置检查，不自动安装 SAP helper |

## 波次实施

### Wave 1：矩阵与防回退

1. 从 VSP 注册表和 universal route 提取稳定的 capability ID；工具名只是 source attribute。
2. 从本项目 runtime catalog、`focused`/`business`/`operations`/`expert` profile 和 operation policy 提取映射目标。
3. 为每条 P0 任务补输入、结果、前置条件、副作用级别、SAP helper 依赖、系统角色和证据等级。
4. 提交 JSON、Markdown 生成器、完整性检查和定向 Jest 测试。

验收：P0 逐行都有状态和理由；所有 `EQUIVALENT`/`MCP_SUPERSET` 目标工具在 runtime catalog 中存在；所有 `INTENTIONAL_RESTRICTION` 都有解除条件；脚本对重复 ID、失效工具名、无 profile、无证据失败。

### Wave 2：P0 核心开发者链路

先关闭由 Wave 1 证明的源码、DDIC、传输、质量链路缺口。每项只扩展一个明确任务，保留本项目 immutable plan、原生确认、单次 apply、结果未知停止和复读/清理证据，不为追求 VSP 表面 parity 放开任意 ADT URL、XML、lock handle 或调用方确认布尔值。

RFC 另立子项目：先完成协议可行性、认证边界、基础类型/内表编解码、超时/取消、连接池和只读 FM allowlist；再考虑有副作用的函数。不得把 VSP 的 `ZADT_VSP` bridge 误标为“纯 RFC 无依赖”。

> 2026-09-17 规划修订：阶段 0（`src/rfc/`，2026-09-16 完成）保留为门控与模型层；阶段 1 传输基座不再自研，定为本地 open-rfc（`D:\MyDev\SAP\open-rfc`，npm `open-rfc@0.2.3`，SDK-free TypeScript classic RFC 客户端，与 VSP 侧 `open-rfc-go` 同源同协议）。详见文末「2026-09-17 规划修订：RFC 基座定为 open-rfc」一节。

验收：每个新任务有 mock/protocol 测试；真实 SAP 仅在专用 DEV 配置且明确授权下做无副作用 smoke；QAS/PRD 仍拒绝写入。

### Wave 3：P1 扩展工作流

依次处理报表/作业/spool、调试对齐、运行诊断、gCTS/abapGit 和 AMDP。每个 domain 都先完成 read/discovery，再决定是否引入专用 SAP helper；helper 缺失时应返回可执行的前置条件，而不是退化成不受控的通用调用。

### Wave 4：P2 生态能力

补齐 UI5、翻译/文本池、revision compare、安装诊断等。只读能力优先；有副作用的导入、部署或翻译写入需独立风险评审和 profile 边界。

## 持续规则

1. VSP 每次新增 MCP capability 时，先新增或更新矩阵行，再实现本项目映射；P0/P1 新 `GAP` 必须在同一规划变更中有 milestone。
2. 本项目新增能力也必须进入矩阵，标记为 `MCP_ONLY` 或映射到已有 VSP 任务，防止矩阵只成为追赶清单。
3. 自动化、真实 DEV、已发布 npm 和用户生产可用性分开记录；矩阵的 `source-audit` 不能升级为真实 SAP 验证。
4. 绝不在矩阵检查、测试或脚本中连接 SAP、执行 RFC、创建传输或修改数据库；真实 DEV 验证另行取得授权。

## 2026-09-17 规划修订：RFC 基座定为 open-rfc

### 决策

rfc-transport-spike 阶段 1 的传输基座不再自研，直接采用本地 open-rfc（`D:\MyDev\SAP\open-rfc`，npm `open-rfc@0.2.3`，Apache-2.0，SDK-free TypeScript classic RFC 客户端）。依据：

1. VSP Go 版正是这样做的：`vibing-steampunk/go.mod` 依赖 `github.com/oisee/open-rfc-go`（`replace => ../open-rfc-go`），`pkg/saprfc` 是其上的薄桥接层。open-rfc TS 版与 open-rfc-go 同源同协议，走同一条已被 VSP 验证过的路线。
2. open-rfc 零运行时依赖、无 NW RFC SDK、无原生插件，纯 TS 实现与本项目技术栈一致，避免维护自研 classic RFC 序列化器。
3. 自研传输的协议可行性风险（classic RFC 线上格式、认证、错误形态）由 open-rfc 承担；本项目只做适配与门控。

### 不变的部分

- `src/rfc/` 阶段 0 保留为门控与模型层：`FmAllowlist` 只读白名单（默认 RFC_SYSTEM_INFO/RFC_PING/RFC_READ_TABLE）、FM 接口模型与 JSON Schema 生成、基础类型/编解码规格、超时与 AbortSignal 取消、连接池状态机——这些在本项目侧的职责（审计边界、参数校验、门控）open-rfc 不提供。
- 阶段推进顺序不变：先只读白名单 FM，再评估有副作用的函数；`rfc.helper-bridge`（非 remote-enabled FM 经 ZADT_VSP）维持 INTENTIONAL_RESTRICTION，open-rfc 与其无关。
- 安全边界不变：真实 RFC 调用仅在专用 DEV 配置且明确授权下 smoke；QAS/PRD 只读；`RF_CALL_NOT_ALLOWED` 白名单外拒绝；矩阵/测试/脚本仍不连接 SAP。

### 变化的部分

- 传输执行器由「自研 TransportAdapter 真实实现」改为「open-rfc `Client` 适配到 `src/rfc/transport.ts` 的 TransportAdapter 接口」，阶段 0 的 LoopbackTransport 保留为测试替身。
- 连接参数来源定为「由既有 ADT 系统配置推导」：SAP_URL/主机、client、user、passwd、语言映射到 open-rfc 连接参数（ashost/sysnr/client/user/passwd/lang），不引入第二套独立凭据配置。
- describe 输出经 open-rfc 的 RFC_METADATA_GET 读取 FM 元数据，映射到 `src/rfc/interface` 模型生成 JSON Schema。

### 前置条件（阶段 1 开工前必须关闭）

1. **Node 引擎兼容**：open-rfc 要求 `^22.14 || ^24`，本项目 `engines: >=18`（当前开发机 v20.18.0）。需评估升级 Node、确认该约束对 npm 发布与用户环境的影响，或在计划文档记录豁免理由后再引入依赖。
2. **依赖形态评审**：npm 依赖 vs vendored（参照 `third-party/abap-adt-api/` 先例）与许可证/来源记录（NOTICE、THIRD_PARTY_NOTICES）对齐项目既有第三方约定。
3. **边界确认**：classic RFC 明文传输无加密与对端认证（open-rfc README 明示），仅限可信内网/专用 DEV；系统角色门控需把 RFC 工具纳入与 ADT 写入同级的最小暴露面。

### 矩阵落点

- `rfc.remote-enabled.call` / `rfc.remote-enabled.describe`（P0 GAP）：restrictionReason 与 liftCondition 已改写为 open-rfc 基座方案，状态保持 GAP 直到阶段 1 落地并真机验证。
- `rfc.remote-enabled.discovery`（P1 PARTIAL）、`rfc.remote-enabled.read-table`（P1 PARTIAL）、`diagnostics.spool-jobs`（P1 PARTIAL）：解除条件同步指向 open-rfc 基座。
- `rfc.helper-bridge`（P1 INTENTIONAL_RESTRICTION）：维持原边界，仅补充说明 remote-enabled 方向由 open-rfc 承接。
