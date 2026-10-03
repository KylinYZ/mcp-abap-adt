# AMDP 受控调试工作流真机验证（debug.amdp-adt → amdp-debugger-controlled-workflow）

- 验证日期：2026-10-03
- 目标系统：专用 DEV sap-demo（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile，`SAP_MCP_CONFIRMATION_MODE=auto`）
- 矩阵行：`debug.amdp-adt` 由 PARTIAL 推进为 **EQUIVALENT**（四操作对齐 VSP 的 AMDP_ADT_* 面）
- 实现：`src/adt/api/amdpDebugger.ts`（协议层）+ `DebugControlWorkflow` 四操作受控链（preview → 原生确认 → apply，复用写域 stateful 主会话）
- smoke 脚本：`scripts/amdp-debugger-real-dev-smoke.mjs`；设计：`docs/superpowers/specs/2026-10-03-amdp-debugger-controlled-workflow-design.md`

## 真机结果（2026-10-03 最终轮，SMOKE OK 全链 14 步）

```
PASS checkAmdpDebugger available（HTTP 400 (mainId required)）
PASS 四操作 kind 已入 previewDebugOperation schema
PASS 受控创建 ZCL_AMDP_DBG_SM59A9D7（Z001，SQLScript 过程编译通过）
PASS AMDP_START：调试桥建立（mainId = 0050568496561FD1AFE5A1AEABB84000，
     hanaSession = sapides:30003:300159 读回——ABAP↔HANA 桥接证据）
PASS AMDP_SYNC_BREAKPOINTS：类:15 已同步（FULL，bpsync.v1+xml）
PASS await stopped=false + 断点判定 verdict = {"state":"VALID"}
     ——SAP 对 SQLScript 位置裁决通路真实工作（VALID=已接受，非命中）
PASS AMDP_TERMINATE（等待自解楔后；恢复路径验证）
PASS 负例：无会话 SYNC 拒止（AMDP_SESSION_REQUIRED，plan FAILED）
PASS 复启成功（stopExisting 重入，新 mainId）
PASS 收尾清理：AMDP 调试会话无残留
PASS 受控清理 + 缺席复核：测试类已删除
```

- 命中（stopped=true）未在本次验证：AWAIT 需要 debuggee 侧真实执行 AMDP 过程
  （需并发会话触发），本次验证覆盖到"判定通路 + 队列观察 + 恢复语义"；
  命中路径的协议形状已由单测按 VSP 真机形状样本覆盖（ON_BREAK 全字段解析）。

## 真机发现并修复的协议缺陷（四轮取证）

1. **start POST 415**：Content-Type 必须 `application/vnd.sap.adt.amdp.dbg.startmain.v1+xml`；
   且 **body 空串不可省**——axios 对无 body 的 POST 会剥离显式 Content-Type
   （transformRequest 行为），导致头丢失。
2. **406 表述协商**：该族资源响应表述是 AMDP 专属类型，`Accept: application/xml`
   不匹配即 406——真机取证显示 **session 实际已创建（Location 头已给）**，仅响应
   协商失败。修复：AMDP 族 Accept 全面对齐 VSP `acceptAnything`（`*/*`）。
3. **空队列 resume 是服务端长挂**：客户端放弃后服务端 handler 继续占用该
   stateful 会话（楔住），后续同会话操作排队超时；经验 1-2 分钟自解楔。
   修复：resume 客户端超时 8s / 其余 20s（对齐 MCP 客户端 30s 进程杀线），
   await note 增加楔住警告；恢复路径 = 等待后重试 terminate（或 start(stopExisting) 杀会话）。
4. **VSP 佐证差异**：VSP 的 ADT 请求走其 RFC→HTTP 桥（`debugsession.go` 的
   `d.adt.Do`），桥侧可能默认补头——其 Go 源 nil body 不带 Content-Type 能通，
   与本项目裸 HTTP 直连行为不同，属传输层差异，协议语义一致。

## 链路健壮性顺带验证

- 受控创建链对 AMDP 类的 HANA 编译错误如实拦截：SQLSCRIPT return type mismatch
  触发激活失败 → 链内干净补偿（壳删除）；错误消息直达调用方。
- 传输锁残留语义再确认：对象补偿删除后 E070/E071 请求锁可残留（S4HK900037/
  S4HK900041 为本轮遗留，锁对象已不存在），阻塞该传输的受控删除与同名对象重建
  ——**需人工 SE09 复核处置**；后续 smoke 以唯一类名规避。

## 验证层级声明

- 真实 DEV 已验证：AMDP 调试四操作受控链全生命周期（start/sync/await 判定/
  terminate/复启/负例拒止/清理缺席）、自动确权（auto-config 审计）、创建链对
  AMDP 编译错误的拦截与补偿。
- 未验证（另行立项）：断点命中路径（ON_BREAK 停止事件真实返回，需 debuggee
  并发触发）、AMDP_STEP/变量分页读取（矩阵注记的后续 wave）、表变量数据预览
  （VSP 自证未打通，不在范围）。
