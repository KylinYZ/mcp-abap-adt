# AMDP 受控调试工作流设计（amdp-debugger-controlled-workflow）

日期：2026-10-03
目标矩阵行：`debug.amdp-adt`（VSP 能力对齐矩阵，当前 PARTIAL → 目标 EQUIVALENT）
状态：设计定稿，随实现落地

## 1. 目标与范围

把 ADT 原生 AMDP（HANA SQLScript）调试从"仅存在性探测"（`checkAmdpDebugger`）推进到
完整受控调试工作流，对齐 VSP 的 ADT 路径四操作面：

| VSP surface（矩阵行） | 本项目操作 kind |
| --- | --- |
| AMDP_ADT_START | `AMDP_START` |
| AMDP_ADT_BREAKPOINT | `AMDP_SYNC_BREAKPOINTS` |
| AMDP_ADT_AWAIT | `AMDP_AWAIT_STOP` |
| AMDP_ADT_STOP | `AMDP_TERMINATE` |

**v1 不做**（记录协议留作后续）：AMDP_STEP（POST `.../debuggees/{id}?step=over|continue`，仅两种步进）、
变量分页读取（GET `.../debuggees/{id}/variables/{name}?offset=0&length=8192` → Location 头
requestId → resume 等答）、表变量数据预览（`/sap/bc/adt/datapreview/amdpdebugger`——VSP 自证
**未打通**，HANA 侧 INIT 拒绝）。stop 事件自带变量清单与调用栈，四操作已覆盖核心调试需求。

## 2. 协议（来源：VSP pkg/saprfc/amdp.go，真机逆向结论；服务端零安装）

全部请求打在 `/sap/bc/adt/amdp/debugger/*`：

1. **start**：`POST /sap/bc/adt/amdp/debugger/main?requestUser=<USER>&stopExisting=true`
   - **mainId 只在 Location 响应头**（`/sap/bc/adt/amdp/debugger/main/{mainId}`）；
     body XML `parameter` 列表里的 `HANA_SESSION_ID` 是 HANA 侧会话（host:port:session），
     两者不是一回事（VSP 曾误认）。
   - `stopExisting=true` 清掉该用户遗留会话：二次 start 不带它会失败，崩溃客户端残留会
     阻塞直到超时。
2. **syncBreakpoints**：`POST .../main/{mainId}/breakpoints`
   - Content-Type：`application/vnd.sap.adt.amdp.dbg.bpsync.v1+xml`
   - body：`amdpdbg:breakpointsSyncRequest`（`syncMode="FULL"`——资源类只认 FULL/PROGRAM，
     其他报 INVALID SYNCMODE 且藏于异常 subType；v1 仅 FULL=全量替换式同步）
   - 每个断点：`amdpdbg:clientId`（自选，SAP 回显）+ `adtcore:uri`
     （`/sap/bc/adt/oo/classes/<小写类名>/source/main#start=<行号>`，普通 adtcore 引用）+
     `adtcore:name` + `adtcore:type="CLAS/OC"`。XML 模板可从
     `/sap/bc/adt/xslt/transformations/amdp_dbg_adt_sync_bp_req/source/main` 读到。
3. **resume（排空队列）**：`GET .../main/{mainId}`
   - 响应是 **mainResponse 队列**（每项带 `kind`/`debuggeeId`/`requestId` 属性）。
   - **ack 陷阱**：断点同步后第一个 answer 必是 `SYNC_BREAKPOINTS`（可能还有
     `ON_TOGGLE_BREAKPOINTS`）——它们是对同步的确认，不是 stop；把 ack 当 stop 会误判
     "断点没命中"而 debuggee 正堵在断点上。`ON_TOGGLE_BREAKPOINTS` 里带断点判定
     （`state=VALID` 表示位置被接受，**不等于已命中**；拒绝时有 errorMessage）。
   - 队列空时资源端异常（非 200）：不是硬故障，是"还没有东西跑起来"。
4. **stop 事件**（`ON_BREAK`，kind 有 debuggeeId）：value 内自带
   - `abapPosition`（procedureName + uri 带 `#start=` 行号）——停止位置；
   - `variables>variable`（name/type/scope/isNullValue/tableHandle）——全部在域变量，
     tableHandle 非零即表变量；
   - `callstack>callstackEntry`（abapPosition 行号 + nativePosition 的 schema/行号 +
     isDebugCompiled——未 debug 编译的帧断点永远打不中，值得如实报告）。
5. **terminate**：`DELETE .../main/{mainId}?hardStop=true`（不等待 debuggee）。

## 3. 架构与受控链设计

- **协议层**：新增 `src/adt/api/amdpDebugger.ts`（六函数 + 四解析器）；
  `AdtClient` 增加四个委托方法；`src/adt/index.ts` 导出类型。
- **受控链扩展**（不新增任何 MCP 工具）：
  - `DebugOperationKind` 增加上述四 kind；`DebugOperation` 联合类型扩展对应操作形状；
  - `SafeDebugClient` 接口增加四方法（AdtClient 已实现该接口，同步补齐）；
  - `DebugControlWorkflow.executeOperation` 增加四个 case；
  - `parseDebugOperation`/`operationDescription`/SafeDebugHandlers 的 `operationSchema` 同步扩展。
- **会话状态**：mainId 由工作流实例内存 Map 持有（按 targetUser 键控，模式对齐
  attachContexts）。**不接受调用方传入 mainId/调试句柄**（对齐项目安全边界：不受控句柄
  一律拒绝）；`AMDP_SYNC_BREAKPOINTS`/`AMDP_AWAIT_STOP`/`AMDP_TERMINATE` 在无已 start
  会话时拒止（`AMDP_SESSION_REQUIRED`）；TERMINATE 只能终止本工作流 start 的会话。
- **会话绑定**：调试句柄存于 ABAP 会话内存（class-data），四操作必须同会话——受控链
  apply 恒挂写槽（executionGate 串行）并绑定写域 stateful 主会话，天然满足，且永无并发。
- **策略**：复用 `assertDebugControlAllowed`（development/development-workbench profile +
  DEV 角色 + 主机/客户端白名单），四操作自动继承，无新策略面。
- **授权**：AMDP 链无 ATTACH 语义，不消耗 `authorizeDebugSession` 授权；JUMP_TO_LINE/
  TERMINATE_DEBUGGEE 的授权要求不适用。
- **AWAIT 语义**：apply 内循环 resume（默认 maxEvents=12，上限 50，每次 GET 快速返回），
  跳过 ack 收集判定，遇 debuggee 事件返回结构化结果；队列空/预算耗尽返回
  `{ stopped:false, ... }` 的**成功观察结果**（plan 状态 APPLIED，agent 可再次 await 轮询），
  仅协议/网络硬故障才置 FAILED/UNKNOWN。不引入服务端长挂起，规避 MCP 客户端超时。

## 4. 输出契约（AWAIT 结果）

```
stopped: boolean
breakpointVerdict?: { state, reason? }        // ON_TOGGLE_BREAKPOINTS 判定（VALID≠命中）
stop?: { debuggeeId, procedure, uri, line }   // ON_BREAK 位置（abapPosition）
variables: [{ name, type, scope, isNull, tableHandle?, tableLength?, isTrimmed? }]
callStack: [{ index, procedure, uri, line, nativeLine?, schema?, debugCompiled }]
events: [{ kind, debuggeeId?, requestId? }]   // 本次消费的队列事件序列
note?: string                                  // 队列空/预算耗尽时的说明
```

## 5. 验证策略

- **自动化**：`src/adt/api/__tests__/amdpDebugger.test.ts`——用 VSP 真机形状 XML 样本
  （含命名空间前缀、多 mainResponse、ack 序列、ON_BREAK 全字段）验证六函数与解析器、
  XML 转义；`src/__tests__/DebugControlWorkflow.amdp.test.ts`——fake client 验证四操作
  preview→apply 状态机、mainId 会话状态机（未 start 拒止/TERMINATE 后清空）、AWAIT 的
  ack 跳过与空队列语义、operationSchema 扩展。
- **真机（专用 DEV，sap-dev.env）**：checkAmdpDebugger → AMDP_START（读回 mainId 与
  HANA_SESSION_ID）→ SYNC_BREAKPOINTS（针对真 AMDP 类）→ AWAIT（断点判定回报，如实报告
  是否命中）→ TERMINATE → 复核 start 可再建。证据落 `docs/evidence/`。
- **矩阵**：`debug.amdp-adt` 状态 PARTIAL → EQUIVALENT（四操作对齐），证据升级
  real-dev-verified；完成率 54/71 → 55/71。
