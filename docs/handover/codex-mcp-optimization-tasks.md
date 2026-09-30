# Codex 交接任务清单 — SAP MCP 工具优化（源自 ZTABDATA 双系统部署实战）

> 交接日期：2026-09-30
> 来源：ZTABDATA 表数据工具部署会话（sap-demo/BASIS 816 受控链通道）+ sess_d09a3d1f 与 sess_7d40bb2c（ED1/7.51 sap-adt+ZADT_VSP 通道）
> 证据：两条会话 rollout、本仓库 git 提交 9d9625f→HEAD、`sap/tabdata/` 源码、记忆库 `tabdata-tool-deploy-state` / `zcode-mcp-30s-kill-and-timeoutms`
> 优先级定义：P0=阻断交付/丢数据风险；P1=显著效率损耗；P2=体验改善

---

## A. 服务端问题（本仓库 mcp-abap-abap-adt-api 代码层）

### A1 [P0] 三个确认链 auto 模式短路顺序 bug（已修复待合入验证）

- **现象**：ZCode 客户端（无 MCP elicitation 能力）调用 previewTransportCreation 后 apply 报 `CONFIRMATION_UNSUPPORTED`，部署级 `SAP_MCP_CONFIRMATION_MODE=auto` 完全失效。
- **根因**：`TransportCreationConfirmation.ts` / `ObjectActivationConfirmation.ts` / `TransportCleanupConfirmation.ts` 三个类中 `supportsFormElicitation()` 检查位于 `autoApprove` 短路**之前**；而 `AbapCreationConfirmation.ts` / `AbapChangeConfirmation.ts` 顺序正确（plan 校验 → autoApprove → elicitation）。
- **修复状态**：本次已改为同构顺序（plan 状态校验 → autoApprove → elicitation 检查），见 git 提交 `a9c7ba1`。
- **交接任务**：
  1. 为全部 7 个确认类补一致性单测：`autoApprove()=true` 时**不得**触碰 `supportsFormElicitation`/`elicitInput`，且 plan 校验必须先于短路执行；
  2. 审计 `DebugConfirmation.ts` / `AdvancedOperationConfirmation.ts` / `MessageTextHandlers.ts` / `DescriptionChangeHandlers.ts` / `CloneObjectHandlers.ts` / `RenameControlledHandlers.ts` 是否存在同类顺序问题（本次未逐一验证）；
  3. `apply*` 成功响应里的 `confirmationMode` 字段应如实返回 `auto-config`（当前 transport 链返回 `elicitation`，与审计日志不一致——审计正确、响应字段错误）。
- **验收**：`SAP_MCP_CONFIRMATION_MODE=auto` 且无 elicitation 能力的客户端可完成全链 apply；审计日志 `confirmationMode=auto-config`；native 模式行为不变。

### A2 [P0] 创建链激活失败后补偿删除——应改为"保留壳+引导修复"

- **现象**：ZCL_TABDATA_TABLE_ACCESS 重建 6 次才成功。每次 WRITE_SOURCE→语法错→**补偿删除**→下次重建又要 CREATE_SHELL（偶发 60s 超时）→失败→再删。同时产生 TADIR 孤儿与对象锁残留（30-60 分钟回收）。
- **根因**：`compensationLimits` 设计为"激活失败即补偿删除"。但对**同包同传输的连续迭代创建**场景（AI 生成代码逐步修语法），删除再重建是纯浪费且制造锁残留。
- **建议**：DEV 角色 + auto 确认模式下，激活失败后**保留壳对象**并在失败响应中携带完整 ABAP 语法错误明细；agent 用变更链（previewAbapChange）修复而非重建。
- **验收**：同场景下重建次数从 6 次降为 1 次；无 TADIR 孤儿新增。

### A3 [P1] 创建链语法错误信息不含 ABAP 行号（变更链却有）

- **现象**：创建链 WRITE_SOURCE 失败只回传 SAP 消息文本（如 `"UP" is not allowed here`），无行号；变更链 `previewAbapChange` 的 `syntaxMessages` 带 `line/offset/severity` 明细。
- **建议**：创建链 WRITE_SOURCE 失败响应改为调用变更链同源的 syntax check 接口，返回结构化 `syntaxMessages`。
- **验收**：失败响应含 `{line, offset, severity, text}` 数组。

### A4 [P1] REAL_DEV_VALIDATION 配置耦合过粗

- **现象**：`REAL_DEV_VALIDATION=true` 时前缀/包/传输三元组强绑定，且 `assertValidationRequest` 对 writable kind 直接抛 `POLICY_DENIED`（"must remain below REAL_DEV_VERIFIED maturity"）——常规开发被迫整体关闭 validation。
- **建议**：拆分为两个独立开关：`REAL_DEV_VALIDATION`（验证目录战役，维持三元组强绑定）与 `REPO_CREATE_GUARD`（常规开发的白名单前缀/包校验，不要求匹配验证传输号）；互斥检查只在 `kind 未达 writable` 时生效。
- **验收**：`REPO_CREATE_GUARD` 单独开启时可对 writable kind 走标准创建链；验证战役模式行为不变。

### A5 [P1] DDIC 创建协议缺陷集（一次部署全部踩中）

| 缺陷 | 现象 | 建议 |
|---|---|---|
| STRING 字段生成裸 `string` DDL | 激活失败"数据类型 不存在" | 生成 `abap.sstring(n)` 或 `abap.string`；SSTRING(n) 已验证可行 |
| 固定长类型接受 length 报错文案 | CLNT/DATS/TIMS/INT1/INT4/FLTP 带 length 即拒，文案只说"does not accept" | 在 schema 层直接剔除这些类型的 length 字段并文档化 |
| CURR/QUAN 用 `type: DEC + referenceField` 被拒 | 必须 `type: CURR/QUAN` | 校验器给出明确提示"请使用 CURR/QUAN 类型" |
| referenceField 必须先于引用字段 | 顺序错报"must appear before" | 生成器自动重排字段顺序满足依赖 |

- **验收**：SSTRING/CURR/QUAN/固定长类型四类字段在 schema 校验阶段零失败。

### A6 [P2] previewAbapChange 巨型响应

- **现象**：每次 preview 回传全量源码 + 全量 diff（30-60KB），长迭代会话上下文爆炸。
- **建议**：提供 `responseMode: 'stat' | 'diff' | 'full'` 参数；stat 模式只回 `{addedLines, removedLines, syntaxMessages}`。

### A7 [P2] 补偿/残留行为不确定

- **现象**：中断后残留有的重建时 absence 通过（ZTABDATA_DEMO、backup）、有的 ADT 解析 500（backup 第一版）、有的报 OBJECT_ALREADY_EXISTS——行为不可预测。
- **建议**：absence 检查统一为"ADT 资源可解析且可读"才判存在；失败残留物在 plan 元数据中标记 `dirty: true` 供后续决策。

---

## B. 客户端问题（ZCode，反馈给 ZCode 团队或用户配置）

### B1 [P0] 30s 工具超时 + 超时杀 stdio server

- **现象**：默认 30s 超时后杀 server 进程 → plan store 丢失、apply 腰斩、锁残留。
- **正确配置**：`config.json → mcp.servers.<name>.timeoutMs`（数字毫秒）。**改动需重启 ZCode 客户端**（仅 kill server 进程不会重读配置）。字段名 `timeout` 无效——需从 zcode.cjs `callTool` 的 `o?.config.timeoutMs ?? odt` 链路确认。
- **交接任务**：1) 在 `docs/使用指南.md` 增加 timeoutMs 配置说明与"改配置必须重启客户端"警告；2) 向 ZCode 反馈：超时后不应杀 stdio server（应仅放弃等待），以及 MCP_TIMEOUT/MCP_TOOL_TIMEOUT 环境变量支持。

### B2 [P2] 查询工具偶发 30s 超时

- classComponents/getObjectSource 偶发超时，当日复测秒回；与多请求串行门排队相关。建议 server 端读操作排队队列输出等待进度。

---

## C. ABAP 代码生成层（两系统两通道共同踩坑——通道无关）

以下语法规则在 sap-demo（BASIS 816 严格模式）与 ED1（7.51）同时验证，**应沉淀为 AI 生成 ABAP 的生成器约束清单 + abaplint 自定义规则集**：

| # | 规则 | 两系统表现 |
|---|---|---|
| 1 | SELECT INTO 目标禁 field symbol（`@<fs>` 与裸 `<fs>` 均禁） | 816 语法 E；用 `INTO TABLE @lr->*`（ref 解引用） |
| 2 | UPDATE/INSERT FROM 行参数须 `@<fs>` | 816 E |
| 3 | UP TO 子句在 INTO 之后 | 816 E（"UP not allowed here"） |
| 4 | string 模板 `{` 后必须空格 | 两系统均检查 |
| 5 | 模板内 `{{`/`\X` 字面转义被新内核误解析 | 816 E（孤立 `}` 或表达式误判）——JSON/正则拼接一律用单引号字符串 + `&&` |
| 6 | `CONV i ( x+N )` 词法歧义（N 解析为结构组件） | 816 E——偏移先算入变量 |
| 7 | string 类型无长度偏移禁用；string 偏移+内联声明禁用 | 816 E——SHIFT 或预声明 c 变量 |
| 8 | 方法内显式 DATA 声明必须在可执行语句之前 | 816 E |
| 9 | CX 子类 CONSTRUCTOR 声明激活时被 SEO 重写 → 创建链源码验收失败 | 816 实证——用静态工厂方法替代 |
| 10 | RETURNING 参数禁泛型表类型内联（`TYPE STANDARD TABLE OF ...`） | 816 E——类内预定义具体类型 |
| 11 | P/F 文本化：generic TYPE any 表达式禁 NUMBER/STYLE 指令；FLTP style 名为 `scientific` 非 `fltp_string` | 816 E——经 decfloat34 中转 |
| 12 | X030L 结构无 TABCLASS 组件 | 816 E——查 DD02L |
| 13 | CX_SALV_MSG 未捕获（SALV 调用需 TRY 包裹） | 7.51 实证 |

**交接任务**：将此表转为 abaplint 自定义规则集（或生成器 prompt 约束），并在 `sap/tabdata/` 的 CI 中增加 lint 步骤。

---

## D. 从 sess_7d40bb2c 借鉴：文本元素能力（本 MCP 缺失，已有成熟实现）

### D1 [P1] 新增文本元素/文本池读写工具

- **背景**：ZTABDATA_TOOL report 含 GUI 文本（选择屏标题 gv_t* 等），但两通道都建不了文本元素：ADT textelements 资源 7.52+ 才有（ED1 404）；ZADT_VSP SetTextElements WebSocket 500。
- **已验证实现**（sess_7d40bb2c，ED1 包 Z001，传输 ED1K925124）：函数组 `ZVSP_COMPAT` 的 FM `ZVSP_COMPAT_751`，操作码分发：
  - `TEXTPOOL_GET`：`READ TEXTPOOL`（实测读回 ZMM_R067 9 条）
  - `TEXTPOOL_SET`：`RPY_TEXTELEMENTS_INSERT` 完整 TEXTPOOL 覆盖写 + `E_TEXTPOOL` 读回核验
  - `TABLE_CREATE`：`RPY_TABLE_INSERT` + `DDIF_TABL_ACTIVATE`
- **借鉴任务**：在**本仓库受控链**内新增 `previewTextElementsChange` / `applyTextElementsChange` 工具对：
  1. ABAP 端封装上述两个标准 API（可直接复用 ZVSP_COMPAT_751 的 FM 逻辑，或独立实现）；
  2. 走与对象创建相同的 plan/确认/auto 模式/审计纪律；
  3. 支持按对象名 + 语言读取（TEXTPOOL_GET）与整体覆盖写（TEXTPOOL_SET）+ 读回核验；
  4. **不依赖 ZADT_VSP WebSocket**（纯 RFC/ADT REST 均可），也**不依赖系统版本**（7.51/816 通用）。
- **验收**：为 ZTABDATA_TOOL 写入选择屏标题文本元素后在 GUI 可见；7.51 与 816 两系统均可运行。

### D2 [P2] 评估 ZVSP_COMPAT_751 的 TABLE_CREATE 与受控 CreateTable 差异

- ED1 通道用 `RPY_TABLE_INSERT + DDIF_TABL_ACTIVATE` 创建透明表（一步到位）；本仓库受控链用 ADT DDL。两者在旧系统的兼容性可互补：受控链在 7.51 类系统可降级走 RPY 路线（参考 `vsp-751-compat-fallback` 记忆与 `zvsp_compat.ed1-adaptations.md`）。

---

## E. 部署收尾任务（ZTABDATA 工具本体，非 MCP 优化）

### E1 [P0] ZTABDATA_TOOL report 重建

- **阻塞**：SAP 会话锁（"使用者 068157 当前编辑 ZTABDATA_TOOL"），SM12 级 30-60 分钟自动回收；或用户 SE80/SE16N 手动删残留。
- **就绪度**：源码已无已知语法错误（backup 用同模式一次通过）；本地 `sap/tabdata/ztabdata_tool.prog.abap`（首行 `REPORT ZTABDATA_TOOL.` 大写、无前置注释）。
- **操作**：锁释放后 `previewRepositoryObjectCreation(PROGRAM, ZTABDATA_TOOL, Z001, S4HK900031)` + apply。

### E2 [P1] 清理实验残留

- 受控清理链删除：`ZCX_TABDATA_MIN` / `MIN2` / `MIN4` / `MIN5`（已建成激活）；`ZCX_TABDATA_MIN3` / `MIN7` 未建成无残留。
- 另有 `ZCL_TABDATA_TYPE_CONV` 的 TADIR 孤儿已被真对象覆盖，无动作。

### E3 [P1] 真机 ABAP Unit 全类型往返测试

- 对 `ZCL_TABDATA_TYPE_CONV` 跑 `runUnitCoverage`：C/N/D/T/P/F/I/b/s/8/x/y/g 全类型 to_text→from_text 双向往返断言（含 FLTP 精度、NUMC 前导零、RAW hex）。
- 对 `ZCL_TABDATA_XLSX` 跑 write→read 矩阵往返（含 sharedStrings、空单元格、富文本）。
- 对 `ZCL_TABDATA_BACKUP` 跑 serialize→deserialize 往返（含转义字符、MD5）。

### E4 [P0] 用户 GUI 四模式验证 + 我方只读对账

- 按设计文档 §8：用户在 SAP GUI 跑导出/导入/备份/恢复四模式；每步后我方 datapreview 只读对账（Excel 内容 vs DD02L 直读、备份文件 vs 表状态）。
- 注意：report 首行 `REPORT ZTABDATA_TOOL.` 已去 NO STANDARD PAGE HEADING（服务端创建门校验大小写敏感的产物），如需恢复该属性在 ADT 中手动加上即可。

---

## 执行顺序建议

1. **立即可做（无外部依赖）**：A1 剩余审计+单测、A3 错误明细、A5 协议文案修正、C 规则集转 abaplint、D1 文本元素工具开发（对照 ZVSP_COMPAT_751）。
2. **等锁释放（约 30 分钟后）**：E1 report 重建 → E3 ABAP Unit → E4 GUI 验证。
3. **需要决策**：A2 补偿策略变更（涉及纪律文档更新）、A4 配置拆分（涉及部署模板）、D2 双通道评估。
