# 受控传输请求创建链（仅创建）真机验证

日期：2026-09-29。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。
所有者授权：使用 sap-demo 进行真机测试（2026-09-29 会话指示）；边界=仅创建，
释放/删除/改属主/加用户与直改 E071·E071K 维持禁止。

## 交付

受控传输请求创建链（`cts.create-request` 专属动作）三工具：

1. `previewTransportCreation`：只读 CTS 预检（ADT `/sap/bc/adt/cts/transportchecks`，
   REF=server 从包名推导的 `/sap/bc/adt/packages/<devclass>`）→ 冻结 immutable plan
   （包名、请求描述 ≤60、锚点 URI、payloadHash、TTL）。不接受调用方任何 URL；
   本地 `$` 包与非法包名在 preview 本地校验即拒。
2. `applyTransportCreation`：MCP form elicitation 原生确认（decision 必须为
   `create_transport`）→ executionGate 内单次创建（`CreateCorrectionRequest`
   POST `/sap/bc/adt/cts/transports`）→ `transportDetails` 读回验证请求号一致
   方可 SUCCEEDED。重复 apply/过期/跨上下文 plan 拒绝。
3. `getTransportCreationStatus`：本地查询 plan 终态与有界结果摘要。

可见性：仅 DEV 角色 + `development`/`development-workbench`（含 focused 别名）；
`legacy-full` 不收录（专家继续用原子 `createTransport`）；QAS/PRD/未知角色
隐藏且 dispatch 拒绝。profile 计数：development 188→191、workbench 155→158。

## 真机结果：SMOKE OK（`node scripts/transport-creation-real-dev-smoke.mjs`）

29/29 断言全 PASS（最终轮，目标包 Z001，验证请求 S4HK900023）：

- catalog：三工具可见 + `transportRelease`/`transportDelete`/`transportSetOwner`/
  `transportAddUser` 四个禁止工具不在受控目录（仅创建边界）。
- 负向探针：`$TMP` 被 preview 本地校验拒绝（VALIDATION_FAILED），零写入零 plan。
- preview：只读预检通过（Z001 `RECORDING='X'`），锚点 URI 由服务端推导，
  `confirmationRequired=true`。
- 原生确认两分支：预期关键词不匹配 → 应答器 cancel → `confirmation_declined`
  （plan 保持 PREVIEWED 可再次确认）；关键词匹配 + `create_transport` → 单次创建。
- 创建成功：S4HK900023，属主 068157（剥零比较），状态 D（未释放）；
  阶段轨迹 PREVIEW→EXECUTE→READBACK 齐全，plan 终态 SUCCEEDED。
- 重复 apply → `PLAN_ALREADY_CONSUMED`。
- 独立佐证：直连 ADT `transportDetails(S4HK900023)` 请求号/状态一致；
  E070 对照——新请求号不在创建前基线（14 个既有请求）中、创建后可查到
  （SAP 侧持久化）。

## 残留声明

本轮 smoke 共创建 **4 个空工作台请求**（分属 4 轮运行，其中 3 轮为脚本断言
迭代）：S4HK900017、S4HK900019、S4HK900021、S4HK900023。全部核实：
TRSTATUS=D（未释放）、属主 068157、E071 零对象（空请求）。按"AI 不删除传输"
边界不自动清理，属主可在 SE09 手工删除。

## 环境取证（真机新事实）

- **包锚点 CTS 预检在 sap-demo 可用**：`transportchecks` 接受
  `/sap/bc/adt/packages/z001` 形态 REF（RESULT='S'，RECORDING='X'）——与 ED1
  7.51 的"transportchecks 无法映射包 URI"缺陷不同（该缺陷为 7.51 特有）。
- **创建动作会把包锁进会话（SM12 级），进程被杀后锁滞留数分钟**：首轮 smoke
  在 apply 后被脚本断言失败终止（子进程无 logout），紧接着的第二轮 preview
  报"对象 Z001 已由 068157 编辑"（CTS 预检拒绝）；约几分钟后锁被服务端回收，
  stateless 探针复测通过。运维含义：MCP 客户端异常断开后，短时间内在**新会话**
  对同一包再 preview 可能被拒，等待锁回收即可；同会话内不受影响。
  TLOCK 无对应行（E071 也为空）——锁在 enqueue 层而非 CTS 对象锁。
- **创建自动生成一个子任务（taskCount=1）但不登记任何对象**（E071 零行）：
  "锚定包"只影响传输层/目标派生，不会把包本身写进请求。
- **数字型用户名前导零会被剥**：登录名 `068157`，ADT `tm:owner` 与 E070
  `AS4USER` 返回/存储 `68157` 形态——属主比较需剥零。
- **MCP `runQuery` 响应形态**为 `{status, result:{columns, values}}`（freestyle
  直连为 `{columns, values}`）；`values` 为行对象数组。

## 门禁

- `npm test -- --runInBand`：174 suites / 1860 tests 全绿（连续两轮）；
  `npm run build` 通过。
- 真机 smoke：`SMOKE OK`（29/29），脚本
  `scripts/transport-creation-real-dev-smoke.mjs`（红线：仅允许 sap-demo IP）。
- 尚未发布（npm 包仍为 0.9.0 之前的 0.8.4 行）；MCP 客户端部署需硬重启后按
  `docs/agent-setup-prompt.md` 验收。

---

# 边界调整追加（2026-09-29 同日）：空请求受控清理链

所有者边界调整：**空请求允许删除**。落地为受控清理三件套（与创建链同构，
同一 handlers 类暴露，目录计数 development 191→194、workbench 158→161）：

1. `previewTransportCleanup`：只读 `transportDetails` 核验三条红线——
   **未释放（状态 D）+ 零对象（请求本体 + 全部子任务）+ 本人属主**（数字型
   用户名剥前导零比较）；任一不满足即 VALIDATION_FAILED 且不建 plan。
2. `applyTransportCleanup`：form elicitation 原生确认（decision=
   `delete_transport`）→ executionGate 单次执行 ADT
   `DELETE /cts/transportrequests/<number>` → 只读读回验证**缺席**
   （仍可读即 UNKNOWN_OUTCOME 终结）。
3. `getTransportCleanupStatus`：本地查询清理 plan 终态。

红线之外仍然禁止：非空请求（会丢弃开发成果）、已释放请求、他人属主请求
一律不可删；释放、改属主、加用户与直改 E071/E071K 维持禁止。

## 清理链真机结果：CLEANUP OK + SMOKE OK（零残留）

- **4 个历史残留请求受控删除**（`scripts/transport-cleanup-real-dev.mjs`，
  显式请求号、逐个红线核验）：S4HK900017/019/021/023 全部
  preview 核验通过（status=D、objects=0、owner=68157）→ 确认删除 →
  链内缺席验证 + 直连只读缺席复核双通过。SUMMARY：删除 4、跳过 0。
- **完整 smoke 自清理闭环**（smoke 脚本扩展第 11–13 步）：创建 S4HK900025
  → 全链验证 → 清理 preview 红线核验（0 对象、D）→ 原生确认删除 →
  链内缺席验证 + 直连缺席复核 → `RESIDUAL 无`。此后 smoke 运行零残留。
- 删除通道实证：ADT `DELETE /sap/bc/adt/cts/transportrequests/<number>`
  （legacy transportDelete 同端点），删除后 transportDetails 立即报错（缺席）。

## 门禁（追加后）

- `npm test -- --runInBand`：176 suites / 1895 tests 全绿（新增
  TransportCleanup.test.ts，25 用例：三条红线逐条/剥零属主/缺席验证/
  UNKNOWN_OUTCOME 不重试/六工具门控/原子 transportDelete 不进受控目录）；
  `npm run build` 通过。
- 残留：**无**（历史 4 个空请求已删 + smoke 自清理闭环）。
