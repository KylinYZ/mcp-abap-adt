# AMDP 调试器 discovery 真机验证（debug.amdp-adt 的 amdp-discovery-spike）

- 验证日期：2026-09-18
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 工具：`checkAmdpDebugger`（无状态只读 GET，零副作用，326ms）
- 语义来源：VSP `pkg/adt/features.go` probeAMDP（第 275-305 行）

## 结论

目标 DEV 系统**具备 ADT 原生 AMDP 调试资源**（服务端零安装，区别于
ZADT_VSP helper 路径）。矩阵行 `debug.amdp-adt` 由 GAP 推进为 **PARTIAL**：
discovery 前置已真机验证；调试会话本体为后续受控工作流。

## 真机结果

```
checkAmdpDebugger →
{
  "availability": "available",
  "message": "AMDP debugger available",
  "evidence": "HTTP 400 (mainId required)"
}
```

判定依据（与 VSP probeAMDP 判据一致）：无 mainId 的 GET 得到 400，响应体为
"Parameter mainId could not be found"——资源在说出它要求的参数，这正是
存在性的直接证据（404 才是缺失）。

## 真机发现并修复的缺陷

1. **ADT 客户端错误形态**：本项目 ADT 客户端把非 2xx 转成业务 Error（消息为
   ADT 错误响应体文本，无 response.status 属性），最初按状态码正则的分支全部
   落空 → 归为 unknown。修复：按消息内容分类（`mainId`/`400` → available，
   `404` → unavailable，其余 → unknown），改用 `includes` 子串判定（正则转义
   在多轮工具写入中曾损坏为控制字符——includes 从根上消除该类风险）。
2. mock 用例补充真机业务错误形态（mainId 消息），12 个用例全过。

## 关键事实记录（为后续调试会话立项）

- AMDP 调试句柄存于 ABAP 会话内存（class-data，VSP handlers_amdp_adt.go
  注释）：**调试会话的 start/breakpoint/await/stop 必须复用同一有状态 ADT
  会话**，第二个连接会拿到空会话且以"API 坏了"的方式失败。本项目 ADTClient
  默认 stateful，满足该前提。
- 未来受控工作流设计要点：会话独占、断点资源的有界清理、与本项目"结果未知
  即停止"边界的兼容。

## 验证层级声明

- 真实 DEV 已验证：AMDP 原生调试资源存在性（available）。
- 未实现/未验证：调试会话四动作（属后续受控工作流，届时另做真机验证）。
