# ZADT_VSP helper 真机部署（sap-dev，client 200）

日期：2026-10-06。目标：`sap-dev`（10.30.255.42:8000/200，DEV）。所有者授权"实施 helper 相关的任务项"。通道：本项目 dist 的 ADT 协议栈直连（lock/PUT source/activation 全部真机验证过的实现），对象清单与顺序对齐 VSP `embedded.GetObjects()`，三个服务类用 `_s4d_fix` 修复版。

## 部署结果

包 `$ZADT_VSP`（本地包，VSP WebSocket Handler）创建成功；**9 对象全部创建、写源、激活、读回验证通过**：

| 对象 | 源版本 | 大小 |
| --- | --- | --- |
| ZIF_VSP_SERVICE（INTF） | 原版 | 733 B |
| ZCL_VSP_UTILS | 原版 | 6250 B |
| ZADT_CL_TADIR_MOVE | 原版 | 3934 B |
| ZCL_VSP_RFC_SERVICE | **_s4d_fix** | 24.7 KB |
| ZCL_VSP_DEBUG_SERVICE | **_s4d_fix** | 36.4 KB |
| ZCL_VSP_AMDP_SERVICE | **_s4d_fix** | 31.5 KB |
| ZCL_VSP_GIT_SERVICE | 原版 | 14.9 KB |
| ZCL_VSP_REPORT_SERVICE | 原版 | 20.0 KB |
| ZCL_VSP_APC_HANDLER | 原版 | 10.5 KB |

激活复核（幂等重激活）：**零 E/A/X 消息、零 inactive 残留**。D3 四类可移植性 bug（COND #()、syuname、FIND REGEX）经核验全部落在三个服务类且 `_s4d_fix` 版零残留，其余原版类无此类语法。

## 过程中的通道事实（后续部署复用）

1. **本地包创建**：POST 集合端点 `/sap/bc/adt/packages` + `pack:` 前缀 XML、`packageType="development"`（$ 包也用 development）、`softwareComponent=LOCAL`、`superPackage adtcore:name=""`——照抄 VSP `pkg/adt/crud.go` L812 模板后 201 成功；`pak:` 前缀/带名资源端点/masterSystem 空串等形态均 500/400。
2. **sap-dev 的 LOCK 与 sap-demo 行为差异**：`POST objectUrl?_action=LOCK&accessMode=MODIFY` 无 body 在 sap-dev 报"系统期望的是元素 abapClass"——必须走本项目 axios 栈（`X-sap-adt-sessiontype: stateful` 头 + cookie 管理）；纯 python urllib 复刻同 query 无 body 仍被拒。结论：**锁链路必须复用本项目 ADT 协议栈实现**，不手写。
3. **对象幂等创建判定**：sap-dev 对已存在对象返回 400 `ExceptionResourceAlreadyExists`（非 409），文案 "does already exist"。

## 剩余步骤（git.abapgit/桥前置）

1. **用户 GUI 两步**（无法经 ADT REST 完成）：SAPC 激活 APC application `ZADT_VSP` + SICF 服务发布。服务面探测基线（配置前）：`/sap/bc/apc/sap/zadt_vsp` → 501、`/sap/bc/sicf` 节点 → 404；配置后复验应非 404/501。
2. **WebSocket 桥客户端**（本项目工程轮）：对接 `ZCL_VSP_APC_HANDLER` 的 WebSocket 协议后，评估 git.abapgit 的只读导出（GitTypes/GitExport，跳确认链留审计）。

## 验证状态

- 部署与激活：真机完成并复核（上表）。
- 服务面：基线已探测（未配置），待用户 SAPC/SICF 后复验。
- 矩阵：`git.abapgit` 行 restrictionReason 已更新（helper 就绪、剩用户两步 + 桥客户端工程），nextMilestone=`zadt-vsp-sapc-sicf-user-setup`。
