# 受控对象激活链真机验证——部分通过（devtools.activate）

> **2026-09-16 更新：补跑已通过，矩阵行晋级 EQUIVALENT。**
> 最终验证证据见 [`object-activation-real-dev-verified.md`](object-activation-real-dev-verified.md)；
> 本文档保留为历史过程记录（含三次失败补跑的根因分析——其中 apply gate
> 自我死锁的发现与修复是最终通过的关键前置）。

- 验证日期：2026-09-16（同日补跑一轮，见文末"2026-09-16 补跑记录"）
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：`scripts/object-activation-real-dev-smoke.mjs`
- 审计日志：`D:\SAP-MCP\audit\dev\abap-change-audit.jsonl`

## 结论

受控激活链的大部分环节已在真实 DEV 系统验证，但 **`applyObjectActivation` 的
真实激活执行未完成**（受阻于测试过程自身在 SAP 端积累的对象锁，见下文）。
矩阵行 `devtools.activate` 因此**保持 UNVERIFIED**，不晋级 EQUIVALENT。

## 已真机验证的环节

| 环节 | 结果 | 证据 |
| --- | --- | --- |
| 三工具进入 DEV workbench 运行时 catalog | PASS | smoke listTools |
| `healthcheck` 目标身份（DEV/300） | PASS | smoke |
| 受控创建链 `previewRepositoryObjectCreation`→确认→`applyRepositoryObjectCreation`（PROGRAM ZVACTSMOKE2） | PASS：真实创建并自动激活（ACTIVE_VERIFIED 设计） | smoke PASS + 审计 CREATION_COMPLETED |
| 创建后 `inactiveObjects` 只读复查（对象不在未激活列表） | PASS | smoke PASS |
| `previewObjectActivation` 只读冻结激活 plan（objectNames 过滤、plan 仅含目标对象的全部 include 条目、payloadHash 冻结） | PASS（5 次，全部审计 `OBJECT_ACTIVATION_PREVIEW_CREATED`） | smoke PASS + 审计 |
| 确认门安全：确认取消后激活绝不执行 | PASS（审计证明：5 次 preview、0 次 CONFIRMED/COMPLETED——两次脚本关键词误配导致的取消均被正确处理，plan 终态 `confirmation_declined` 且不可复用） | 审计日志 |
| 重复 `applyObjectActivation` 拒绝 | PASS（confirmation_declined 后 plan 终结） | smoke PASS |
| 受控清理 `previewRepositoryObjectCleanup`→`applyRepositoryObjectCleanup`→absence 复查 | PASS（ZVACTSMOKE2/ZVACTSMOKE4 两轮闭环） | smoke PASS |

## 未完成的环节

**`applyObjectActivation` 的真实激活执行**（CONFIRMED→COMPLETED 审计链 +
激活对象离开 inactive 列表的目标状态复查）。原因：smoke 脚本多轮试错在 SAP 端
积累了 `ZVACTSMOKE`~`ZVACTSMOKE4` 的会话锁（ENQ），后续创建持续冲突
（"使用者 068157 当前编辑"）；且候选验证对象逐一被消耗或锁死，`ZVPCL01` 的
未激活状态在验证窗口内被外部因素翻转（审计证明非本服务所为——无任何确认后
激活事件）。系统响应随后变慢（MCP 请求 60s 超时），为避免对 DEV 系统继续加压
而停止验证。

## 试错过程中发现并修复的问题

1. **验证模式重放防护**：`SAP_MCP_REAL_DEV_VALIDATION=true` 会拒绝创建已
   REAL_DEV_VERIFIED 的类型（防重放已验证结果，符合设计）；smoke 应使用
   validation=false 的生产路径。
2. **SAP 端锁释放延迟**：删除-重建同名对象时旧 ENQ 未及时释放导致
   `REMOTE_WRITE_FAILED`；smoke 已加入锁冲突换名重试 + 20 秒等待。
3. **激活确认消息不含对象名**：消息形如 "Activate N inactive object(s) ·
   host/client · profile · Activation is a repository write..."，脚本关键词
   核对已修正（对象归属由 plan 断言保证）。
4. **`healthcheck.configuredTarget` 不含 sapUser**：归属核对改从 env 文件解析。

## 遗留系统状态（需要处理）

- SAP 端可能残留 `ZVACTSMOKE`、`ZVACTSMOKE3`（及可能的 2/4）的对象锁
  （SM12 可查；会话已终止，通常等待或手动删除即可）。
- `ZVACTSMOKE3` 对象可能仍存在（创建成功后未走到清理的轮次遗留）。
- 以上均为 Z001 包 + S4HK900009 验证传输内的 Z* 验证对象，不影响业务。

## 补跑方式

系统锁清理后，任选一个属于当前用户的 Z* 未激活对象（如 `ZVCL_CAMPAIGN`）：

```powershell
node ./scripts/object-activation-real-dev-smoke.mjs "C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env" <激活目标对象名>
```

预期输出 `SMOKE OK: 受控激活链端到端验证通过`；届时矩阵行
`devtools.activate` 可凭审计 `OBJECT_ACTIVATION_CONFIRMED/COMPLETED` 证据晋级
EQUIVALENT。

## 2026-09-16 补跑记录（闲时自动任务轮）

结论先行：**apply 真实激活执行仍未完成**（三次尝试均中断，重试预算用尽），
矩阵行保持 UNVERIFIED；但本轮**定位并修复了 apply 自我死锁缺陷**，这是此前
apply 一直无法完成的真正根因之一。下一次干净补跑只需一条命令。

### 关键发现与修复（代码级，已入库）

1. **applyObjectActivation 自我死锁（本轮最重要发现）**：
   `src/lib/serverGuardrails.ts` 的 `usesSapExecutionGate` 豁免名单漏了
   `applyObjectActivation`/`getObjectActivationStatus`。外层 CallTool 先占满
   唯一 SAP 执行槽（`SAP_MCP_MAX_CONCURRENT_TOOLS=1` 为默认值），确认后的
   `applyConfirmed` 内部再次 `executionGate.run(...)` 永远排队——真机表现为
   客户端 60s 超时、审计有 PREVIEW_CREATED 但无 OBJECT_ACTIVATION_CONFIRMED、
   SAP 端无任何激活发生（inactiveObjects 复查证实）。已修复豁免名单，并在
   `src/__tests__/serverGuardrails.test.ts` 增加死锁回归测试（45/45 通过）。
   注意：前一轮"锁堆积/系统超时"的叙述可能部分被此缺陷污染——60s 超时正是
   死锁的表现之一。
2. **激活目标必须含 parentUri 条目**：工作流
   `collectInactiveRecords`（ObjectActivationWorkflow.ts）要求未激活条目带
   `adtcore:parentUri` 才进入 plan（激活载荷需要精确 ADT 引用）。因此顶层
   INTF/DTEL/DOMA/PROG-I 这类无 parentUri 条目的对象（如 ZVIF2）无法作为
   目标；带 include 条目的类/函数组（如 ZVCL_CAMPAIGN）才适用。smoke 脚本的
   `inactiveEntries()` 不过滤 parentUri，两者判定不一致是第一次尝试失败的
   直接原因。
3. **smoke 脚本修复**：同名残留清理路径的 TDZ 引用错误
   （`programName` 在声明前使用，改为 `PROGRAM_NAME`）；激活 apply 调用改用
   `callTool(params, undefined, { timeout: 300_000 })` 放宽 SDK 默认 60s 超时
   （多 include 条目在 DEV 慢时段可能超 60s）。

### 三次尝试时间线

| # | 目标 | 中断点 | 原因 |
| --- | --- | --- | --- |
| 1 | ZVIF2 | previewObjectActivation 返回 no_inactive_objects | ZVIF2 条目无 parentUri，被工作流候选过滤排除（见发现 2） |
| 2 | ZVCL_CAMPAIGN | applyObjectActivation 客户端 60s 超时 | gate 自我死锁（见发现 1）；审计无 CONFIRMED，SAP 无副作用 |
| 3 | ZVCL_CAMPAIGN | 创建 preview 即失败 | SAP 端校验传输 S4HK900009 瞬时 HTTP 500（同传输数分钟前可用；只读探针证实系统整体响应正常） |

第 2 次尝试同时验证了：受控清理残留 ZVACTSMOKE → 重建 ZVACTSMOKE（ENQ 残留
自动换名 ZVACTSMOKE2）→ 受控创建 apply + 激活态复查 → 激活 preview 生成
6 条目 plan（全部属 ZVCL_CAMPAIGN，payloadHash 冻结）→ 归属用户核对通过。
即死锁点之前的全链路再次真实通过。

### 本轮门禁与遗留

- 本地门禁全绿后才碰真机：Jest 129 suites / 1178 tests（修复后）、build、
  check:repository-creation-coverage、check:vsp-capability-parity、
  git diff --check。
- SAP 端无新增残留：第 1/3 次尝试未创建对象；第 2 次自建的 ZVACTSMOKE2 已
  用一次性受控清理脚本（scripts/cleanup-zvactsmoke-residue.mjs）清理并
  searchObject absence 复查通过（清理 apply 的传输校验报 VERIFICATION_FAILED，
  系同一 SAP 端 500 不稳定所致，实际删除已生效）。
- 上一轮遗留的 ZVACTSMOKE3 及对象锁状态本轮未核查/处理。
- 下轮补跑：直接重跑上文"补跑方式"命令（目标 ZVCL_CAMPAIGN），预期一次通过；
  若传输校验 500 复现，先只读探针确认系统状态再重试。
