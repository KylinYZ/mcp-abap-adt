# ADT 调试 Detach 协议研究

## 结论

**`DETACH_UNSUPPORTED`**

截至 2026-08-14，没有足够证据证明当前依赖和参考实现支持一种独立的、可复现的 ADT detach 协议，能够在不继续或终止 debuggee 的前提下明确释放远端调试 Attach。

因此，本项目不得把 Continue、Terminate、`dropSession()`、logout、关闭 HTTP/client 或本地状态清理称为 detach。MCP 收到 `DETACH` 控制请求时必须固定返回错误码 `DEBUG_DETACH_UNSUPPORTED`，不得自动执行任何替代动作。

## 研究范围

| 项目 | 固定版本 |
| --- | --- |
| 参考实现 | `vscode_abap_remote_fs` `v2.8.3` |
| 参考提交 | `cfbb0fc4e998d59cfe00d23ca2164fe22d598428` |
| 当前 MCP 锁定依赖 | `abap-adt-api@8.4.1` |
| 最新上游版本 | `abap-adt-api@8.4.2`，提交 `43f6dc7994dc402c3914a302a1c0c471dc45ec2c` |
| 依赖仓库 | `https://github.com/marcellourbani/abap-adt-api.git` |
| 研究方式 | 固定版本源码和已安装发布包的静态检查 |
| SAP 环境角色 | 未连接 SAP；未在 DEV、QAS 或 PRD 发起协议请求 |
| 测试资产 | 无；未使用业务事务或专用 debuggee |

本轮没有针对某次真实调试控制的单独用户授权，因此没有进行真实 SAP detach 探测。静态检查不能证明某个未公开协议不存在，但在缺少可验证请求证据时，安全结论只能是 `DETACH_UNSUPPORTED`。

## 参考实现的实际关闭调用链

VS Code DAP 的 disconnect 只进入以下调用链：

```text
AbapDebugSession.disconnectRequest()
  -> AbapDebugSession.logOut()
    -> DebugListener.logout()
      -> stopListener()
      -> 对每个 active thread 调用 stopThread()
        -> removeAllBreakpoints()
        -> debuggerStep("stepContinue")
        -> Continue 失败且 debuggee 未结束时 dropSession()
        -> DebugService.logout()
          -> statelessClone.logout()
          -> stateful client.logout()
```

证据位置：

- `client/src/adt/debugger/abapDebugSession.ts:66`：`logOut()` 调用 listener 清理。
- `client/src/adt/debugger/abapDebugSession.ts:143`：DAP `disconnectRequest()` 调用 `logOut()`。
- `client/src/adt/debugger/debugListener.ts:344`：`stopThread()` 删除断点后调用 `stepContinue`，失败时可能调用 `dropSession()`。
- `client/src/adt/debugger/debugListener.ts:399`：超出并发线程限制时，`resume()` Attach 后循环执行 `stepContinue` 直到 debuggee 结束。
- `client/src/adt/debugger/debugListener.ts:424`：listener logout 先删除 listener，再清理 active threads。
- `client/src/adt/debugger/debugService.ts:252`：service logout 只清理本地事件和 ADT client 会话。

这条链路没有独立的 detach 请求。它会改变 debuggee 的执行状态，或者只关闭会话，不能满足“保留当前暂停状态且明确释放 Attach”的 detach 语义。

## 各操作能证明什么

| 操作或观察 | 实际语义 | 是否证明远端安全 detach |
| --- | --- | --- |
| `debuggerStep("stepContinue")` | 恢复 debuggee 执行，可能运行到下一断点或自然结束 | 否；它会改变业务执行状态 |
| `terminateDebuggee` | 明确终止 debuggee | 否；它是终止，不是 detach |
| `dropSession()` | 丢弃 ADT HTTP 会话；参考实现只在 Continue 失败后尝试 | 否；没有远端 Attach 已释放的独立响应证据 |
| `logout()` / client close | 关闭 ADT client/session 并清理本地资源 | 否；连接关闭不等于远端调试状态已释放 |
| 删除 listener | 停止接收新的 debuggee | 否；不证明已有 Attach 已释放 |
| 空响应或请求断线 | 远端最终状态未知 | 否；必须保持 `UNKNOWN/cleanupRequired` |
| debuggee 自然结束 | 业务执行已结束 | 否；不是 detach，但可确认该 debuggee 不再暂停 |

## `detachDebugger` 字符串检查

参考实现只在 `client/src/adt/debugger/debugService.ts:151` 的 inspection-only 本地分支中比较字符串 `"detachDebugger"`，随后发送本地 `THREAD_EXITED` 事件。该分支没有调用 `ADTClient.debuggerStep()`，也没有发起任何 HTTP 请求。

因此，这个字符串只能证明本地代码曾考虑过一种关闭意图，不能证明 SAP ADT 支持 `method=detachDebugger`，更不能作为协议实现依据。

## `abap-adt-api` 的正式能力

MCP 当前使用的 `abap-adt-api@8.4.1` 公开以下 `DebugStepType`：

- `stepInto`
- `stepOver`
- `stepReturn`
- `stepContinue`
- `stepRunToLine`
- `stepJumpToLine`
- `terminateDebuggee`

上游 `v8.4.2` 的提交 `54058df1fdd7a5197f393a5a742c736cc0a3d46b` 只做了一项改动：在上述联合类型中增加 `detachDebugger`。`debuggerStep()` 的通用实现没有变化，调用形式是：

```http
POST /sap/bc/adt/debugger?method=<DebugStepType>&uri=<optional>
Accept: application/xml
```

因此，`v8.4.2` 提供了候选请求 `POST /sap/bc/adt/debugger?method=detachDebugger` 的类型入口，但没有专用 `debuggerDetach()` API、测试、README 说明、响应样例或错误契约。当前参考实现也没有实际调用该候选请求。

这一行类型声明说明候选协议值得在专用 DEV debuggee 上验证，但不能单独证明远端释放语义，更不能证明它不会 Continue 或 Terminate debuggee。在取得真实请求和响应证据前，结论仍为 `DETACH_UNSUPPORTED`。

## 冻结的实现规则

1. `DETACH` 请求固定返回 `DEBUG_DETACH_UNSUPPORTED`。
2. 返回失败时不得隐式 Continue、Terminate、dropSession、logout、重连或重放请求。
3. 关闭本地 Attach client 不能把远端状态标记为 released；未收到远端明确终态时保持 `UNKNOWN/cleanupRequired`。
4. listener 删除只表示不再接收新调试事件，不改变已有 Attach 的释放结论。
5. Phase 1 可以实现通用 `AbortSignal` 请求取消，但不得新增伪 detach API。
6. 将来只有在专用 DEV debuggee 上取得可复现的 endpoint、HTTP method、query/header/body、响应和错误证据，并证明不会继续或终止业务执行后，才能重新评审此结论。

## 未验证项

- 未抓取 SAP GUI、ADT/Eclipse 或其他官方客户端的网络请求。
- 未在任何 SAP 系统上探测 `v8.4.2` 暴露的 `method=detachDebugger` 候选请求或其他候选 endpoint。
- 未验证不同 SAP_BASIS 版本是否存在私有或版本特定协议。
- 未验证关闭底层 HTTP 会话后 SAP 内核最终何时、是否自动释放 Attach。

这些未验证项不会被解释为支持 detach 的间接证据。
