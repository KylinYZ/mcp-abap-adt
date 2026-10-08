# analysis.lint 收编 + rfc.helper-bridge 收编真机验证（2026-10-10）

- 系统：sap-dev（10.30.255.42:8000，client 200，用户 HP068157）——所有者授权轮
- smoke：
  - `npm run test:cluster-impact-real-dev`（回归，含 impact 对照）
  - `npm run test:helper-rfc-real-dev`（新增）——**SMOKE OK**（5 PASS）
- 结论：**analysis.lint 与 rfc.helper-bridge 双双晋级 EQUIVALENT**——VSP 对齐 **64/71**（EQUIVALENT=51、MCP_SUPERSET=13、PARTIAL=1、RESTRICTION=6）

## analysis.lint：analyzeLint（本地 abaplint 引擎）

**解除条件已满足**：先前"npm 包 abaplint 已 unpublish"的定性修正——unpublish 的是无 scoped 的 CLI 包装包（`abaplint`），引擎本体 **`@abaplint/core` scoped 包持续发布**（当前 2.120.70）。

- 集成方式借鉴 abap-mcp-server（KylinYZ/abap-mcp-server，Apache-2.0）：默认 Cloud/Standard 配置 + 文件类型自动探测（CLAS/INTF/FUGR/PROG/DDLS/BDEF/DCLS 从代码内容识别）+ Registry/MemoryFile/parseAsync/findIssues + 超时保护。
- 防线：50KB 输入上限 + 10s 超时 + maxFindings 截断（default 200 / max 500）；40+ 规则（语法+质量+命名开启，噪声规则关闭）。
- 纯客户端执行：无 SAP 交互，全角色/全环境可见（含 QAS/PRD）。
- 真机：含真实问题的 ABAP 源（exit/MOVE/keyword_case）抓出 4 findings；干净源 0 findings；截断/空码/超长拒绝全过。
- 局限（如实）：分析的是提交的源码字符串（非 SAP 端活跃版本全量依赖图）；规则集为 snippet 分析配置（abapdoc 等关闭）。

## rfc.helper-bridge：helperCallRfm（桥 rfc 域受控 FM 调用）

**所有者明确授权**后实施。桥 rfc 域（部署的 ZCL_VSP_RFC_SERVICE，call/getMetadata/search 三动作）端到端通。

- 机制：经 ZADT_VSP 桥（RFC6455 WebSocket）的 rfc 域 `call` 动作——CALL FUNCTION 在 SAP 应用服务进程内执行，**非 remote-enabled FM 也可达**（callRfm/open-rfc 直链受网关限制仅 remote-enabled）。
- **受控收紧（与 VSP 的差异如实声明）**：VSP 桥面无 allowlist（任意 FM）；本项目在客户端侧加 **allowlist 硬门**（默认=callRfm 只读标准 FM 白名单 7 FM，经构造注入扩展——部署者显式追加），白名单外零网络往返拒绝。风险评审遗留：helper 面绕过 ADT 审计与网关限制的本质风险不变，allowlist 只收窄爆炸半径；扩展 FM 前须逐个评估。
- 真机：RFC_PING subrc=0、RFC_SYSTEM_INFO exports 指纹（与 callRfm 直链对照 sysid 一致=S4D）、allowlist 外 FM 拒绝。

## 自动化基线

191 suites / 2166 tests 全绿（AnalyzeLint 7 例 + AnalyzeLintHandlers 6 例 + helperCallRfm 分派测试 + 守卫更新）；build、coverage（28）、parity（71 行 **64/71**）、git diff --check 全绿。profile 计数不变（analyzeLint 已在只读面计数内；helperCallRfm 在既有 DEV 执行面计数内）。

## 遗留

- 后台作业 spool 的码页解码噪声（既有 nuance）。
- helper 面扩展 FM 须逐个评估（allowlist 注入即部署者显式决策）。
