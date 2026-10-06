# devtools.execute-abap 受控执行链真机验证（2026-10-06）

- 系统：sap-demo（10.30.254.48:8001，client 300，DEV 角色）
- 方式：MCP focused 面 `executeAbap` 工具全链（stdio 子进程 + npm run test:execute-abap-real-dev）
- smoke 脚本：`scripts/execute-abap-real-dev-smoke.mjs`（`npm run test:execute-abap-real-dev`）
- 结论：**SMOKE OK**，`devtools.execute-abap` 晋级 **EQUIVALENT**（VSP 对齐 56/71）

## VSP 语义移植（pkg/adt/workflows_execute.go ExecuteABAP）

用户 ABAP 片段包进一次性 ABAP Unit 测试程序（`REPORT ZTEMP_EXEC_<ms尾段>`，
`$TMP` 本地包、**无 transport**）：`CLASS ltc_executor ... RISK LEVEL <声明>
DURATION SHORT`，方法体嵌用户代码，收尾
`cl_abap_unit_assert=>fail( msg = |EXEC_RESULT:{ lv_result }| )` 把返回变量值
带出测试沙箱（这是值离开测试方法的唯一通道）。链路：
create → lock → PUT source/main（text/plain）→ unlock → activate →
POST abapunit/testruns → 提取 EXEC_RESULT → lock → DELETE。

## 三态失败语义（同 VSP）

| 失败态 | 判定 | 真机取证 |
| --- | --- | --- |
| `syntaxError` | 激活步 200 内 E/A 消息（`type` 字段）或激活 HTTP 异常；不进入运行步 | `Field "UNDEFINED_VARIABLE_ZZ" is unknown.` |
| `notRun` | 激活成功但 ABAP Unit 零测试类（"空"不等于"通过"） | wrapper 恒有测试类，自然路径不触发 |
| PayloadFailure | 收尾断言（携带 EXEC_RESULT）之外的 exception 优先、critical/fatal 兜底；行号回译到用户代码 | `异常错误 <COMPUTE_INT_ZERODIVIDE>` |

清理语义：运行后临时程序即删（`keepProgram` 除外）；清理失败记
`cleanupWarnings` 不重试（UNKNOWN_OUTCOME 不回放），`cleanedUp=true` 仅在
DELETE 成功后置位。

## 真机场景与结果（2026-10-06）

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| happy path（字符串模板拼 sy-sysid） | success=true、output 恰 1 条、cleanedUp=true、程序名 `^ZTEMP_EXEC_` | PASS，`UNAME=hello from executeAbap SYSID=S4H`（ZTEMP_EXEC_28967590） |
| 缺席验证（happy path） | 直连 GET 程序 URL 抛 does not exist | PASS |
| 运行时异常（1/0） | success=false、failure.kind=exception、cleanedUp=true | PASS，`COMPUTE_INT_ZERODIVIDE` |
| 缺席验证（异常场景） | 同上 | PASS |
| 编译失败（未定义变量） | failure.kind=syntaxError、message "did not compile"、cleanedUp=true | PASS |
| 缺席验证（编译失败场景） | 同上 | PASS |
| keepProgram | success=true、cleanedUp=false、直连 GET 存在；随后直连锁删清理 | PASS（ZTEMP_EXEC_28985332） |
| negative（非法 returnVariable） | MCP InvalidParams（-32602）拒绝、零 SAP 调用 | PASS |

收尾核查：全部临时程序已删除，sap-demo 无 `ZTEMP_EXEC_*` 残留、无传输请求
产生（$TMP 本地包全程无 corrNr）。

## 自动化基线

- `src/adt/ExecuteAbapApi.test.ts`：10 用例（execResult 提取、payloadFailure
  挑选、wrapper 模板、riskLevel→flags 映射、happy path 全调用序列（含清理
  步二次 LOCK）、notRun、激活异常→syntaxError、DELETE 失败不重试、
  keepProgram、非法变量名零调用拒绝）。
- `src/handlers/ExecuteAbapHandlers.test.ts`：16 用例（schema 契约、枚举/
  长度边界、软失败透传、基础设施异常脱敏 InternalError、参数校验零触达）。
- catalog 计数：development-workbench 172→173、legacy-full 210→211
  （`ToolCatalogIntegrity.test.ts` 与 `ModernProtocol.test.ts` 基线同步）。
- 门禁：188 suites / 2078 tests 全绿；build 通过；coverage 检查
  （REAL_DEV_VERIFIED=28）通过。

## 门控与安全边界

- profile：development-workbench（focused 默认入口）显式名单 + legacy-full
  专家面；development 组合面与 diagnostic-readonly 不收录。
- 系统角色：OTHER_MUTATION 执行类（同 runClass/unitTestRun/runUnitCoverage），
  QAS/PRD/未知角色入口策略拒绝；执行门走写槽串行。
- 模板注入防线：returnVariable 必须满足 ABAP 变量名规则（字母/下划线开头、
  ≤30 位），handler 层 InvalidParams 前置 + API 层二次校验（零 SAP 调用）。
- 对象自持：临时程序名/URI/锁句柄由服务端生成，调用方无任何 URL/XML 入参。

## MCP 客户端面复验（2026-10-06）

客户端重启加载受控链后首次经 MCP 工具面执行：`executeAbap({ code: "rv_result = |OK: sy-subrc=| && sy-subrc && |, date=| && sy-datlo.", returnVariable: "rv_result", riskLevel: "harmless" })` → success=true，输出 `OK: sy-subrc=0, date=20261006` 正确捕获；临时程序 ZTEMP_EXEC_50839888 创建并清理（cleanedUp=true、零警告）。rawAlerts 中的 failedAssertion（标题含 EXEC_RESULT 前缀）是输出捕获协议的载体而非真实失败，与三态失败语义一致。
