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

## 激活修复与端到端冒烟（2026-10-06 续）

**激活完整性修复**：首轮部署的"激活 OK"只激活了主源码 URI——8 个类的大量 include 段（definitions/implementations/methods）实际处于 inactive，导致用户创建 APC application 时报 `TY_MESSAGE is unknown`（引用解析失败）。修复方法：读 `/activation/inactiveobjects` 全量清单（注意 ioc:ref 的 URI 值含斜杠，正则必须非贪婪；对象 URI 是小写），按对象分组、逐组把全部 include 引用放进 activation 请求，循环至 `ALL INACTIVE CLEAN`。**教训：CLAS 激活必须整对象树（含全部 include 段），单 URI 激活不完整且响应无告警；inactive 复核正则大小写/斜杠敏感需实测验证。**

**补依赖类**：`ZCL_ADT_00_AMDP_TEST`（VSP 安装清单外的依赖，amdp_service L712 引用其 TT_RESULT）——创建 + main 源 + 激活完成；testclasses include 已创建但源写入 404（空壳合法，不影响桥；留档为 A8 侧小尾巴）。

**git 域禁用**：`zcl_vsp_git_service` 缺 abapGit 前置（`ZCX_ABAPGIT_EXCEPTION` unknown）——按 VSP 安装器 skip_git_service 同思路，apc_handler 的 class_constructor 中注释其域注册（行首 `*` 注释；注意缩进 `*` 在 ABAP 中不是注释）。git 域启用需先部署完整 abapGit。

**端到端冒烟（全部通过）**：

| 步骤 | 结果 |
| --- | --- |
| HTTP GET 服务面 | 501（APC 端点对非 WebSocket 请求的正常形态） |
| RFC 6455 握手 | **101 Switching Protocols**，sec-websocket-accept 与测试向量精确匹配，sap-authenticated=true |
| system/ping | `{"id":"mcp-smoke-1","success":true,"data":{"pong":true,"timestamp":"20261006T112014"}}` |
| 未实现 action | 结构化错误 `UNKNOWN_DOMAIN`（错误路径正常） |

用户操作完成：SAPC 创建 APC application（ID ZADT_VSP、Handler ZCL_VSP_APC_HANDLER、Stateful、包 $ZADT_VSP）+ SICF 激活节点。**桥已完全打通**：RFC/DEBUG/AMDP/REPORT 四域路由就绪，git 域待 abapGit。

## 剩余步骤（git.abapgit/桥前置）

1. **（已完成 2026-10-06）**：用户 SAPC 创建 APC application + SICF 激活，WebSocket 端到端冒烟通过（见上）。
2. **WebSocket 桥客户端**（本项目下一工程轮）：对接 `ZCL_VSP_APC_HANDLER` 的 JSON 消息协议（握手→带 id 的 JSON 请求→响应帧），实现 git 域只读导出（GitTypes/GitExport，跳确认链留审计）。前置：abapGit 部署 + 恢复 handler 的 git 域注册。
3. 矩阵 git.abapgit 行 nextMilestone=`websocket-bridge-client-engineering`。

## 验证状态

- 部署与激活：真机完成并复核（上表）。
- 服务面：基线已探测（未配置），待用户 SAPC/SICF 后复验。
- 矩阵：`git.abapgit` 行 restrictionReason 已更新（helper 就绪、剩用户两步 + 桥客户端工程），nextMilestone=`zadt-vsp-sapc-sicf-user-setup`。
