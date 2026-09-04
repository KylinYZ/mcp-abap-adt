# Function Group Include Real DEV Verification

验证目标：DEV client `300`；包 `Z001`；未释放传输主请求 `S4HK900009`、子任务 `S4HK900010`。

<a id="capture-correction"></a>
## Eclipse Contract Correction

- 用户提供的 Eclipse ADT 3.60.2 通信日志证明，`FUGR/I` 创建校验和创建 XML 均使用完整 include 名，例如 `LZMCP_ADT_TEST001`，父函数组通过 `containerRef` 绑定。
- `L...UXX` 是 SAP 自动生成或既有的函数池 include，不是本次创建的 include，不作为 activation target、source readback target、cleanup target 或成熟度证据对象。
- 独立 include 的可检查源码必须是顶层合法 include 声明；本轮使用 `DATA gv_zvpfgi13001 TYPE i VALUE 1.`。顶层 `WRITE 1.` 会触发语法检查失败，不能作为该对象的验证源码。

<a id="create"></a>
## Independent Include Lifecycle

- 临时父函数组 `FUGR/F ZVPFGI13` 及 bootstrap 模块 `ZVPFGI13A` 已 active，用于验证已有父组中的独立 include 语义；父组 creation plan 为 `39c8ad0f07ff0364cdef9e1fceb1db92`，bootstrap 模块 active source 以 `FUNCTION_MODULE_FORMAT_NORMALIZED` 通过。
- 全新 include `FUGR/I LZVPFGI13001` 的 creation plan `90546ae9-c48f-4be7-a430-484e77f5a13a` 终态 `APPLIED`：preview 冻结父组 `ZVPFGI13`、包 `Z001`、传输 `S4HK900009`、suffix `001` 和完整 `L...` 名。
- apply 阶段完成 include 创建、`source/main` 写入、syntax check、unlock、activation，并使用 created include 自身的 `source/main?version=workingArea` 复读源码。
- 独立 search 命中唯一 `FUGR/I LZVPFGI13001`，URI 为 `/sap/bc/adt/functions/groups/zvpfgi13/includes/lzvpfgi13001`，包为 `Z001`，描述为 `FGI validation include`。
- `objectStructure` 以 `version=workingArea` 复读 include metadata，返回 `adtcore:name=LZVPFGI13001`、`adtcore:type=FUGR/I`、`adtcore:version=active`，并暴露 `source/main` text/plain source link。
- `getObjectSource` 读取 `/sap/bc/adt/functions/groups/zvpfgi13/includes/lzvpfgi13001/source/main?version=workingArea`，源码为 `DATA gv_zvpfgi13001 TYPE i VALUE 1.`。

<a id="include-cleanup"></a>
## Include Cleanup

- Include cleanup plan `438c4ce4-fc81-41e9-8de5-c410af87f217` 单独锁定并删除 `LZVPFGI13001`，include absence 成功；该计划只在 `cleanup-transport` 终态 `FAILED`。
- 失败原因不是对象删除或 absence 失败，而是同一未释放传输内没有可接受的独立 deletion/neutral CTS 单键；对象本身已由 cleanup plan 证明删除。
- cleanup 期间发现目标 SAP 的 repository search 对 `objType=FUGR/I` 返回空，但无类型过滤 search 可命中正确 `FUGR/I`；实现已改为对 `FUGR/I` 不传 search type，再按返回的精确 name/type 过滤。

<a id="parent-transport"></a>
## Parent Transport Scope

- `transportInfo` 对 created include 返回 `PGMID=LIMU`、`OBJECT=REPS`、`OBJECTNAME=LZVPFGI13001`，锁定主请求 `S4HK900009` 与 task `S4HK900010`。
- 父组 cleanup plan `365e0bdc-2ef0-43e1-b3de-5be5e0649b14` 在同一开放传输中删除 `ZVPFGI13`，终态 `COMPLETED_LOCAL_ABSENCE`，并取得 `TRANSPORT_NEUTRAL_ENTRY_VERIFIED`。
- 最终重启后只读复查确认 `LZVPFGI13001`、`ZVPFGI13`、`ZVPFGI13A` 和 `FUGR/F ZVPFGI13` search 均为空；旧 include creation plan 返回 `PLAN_NOT_FOUND`。
- maturity evidence 显式冻结 include、父组 `ZVPFGI13`、include cleanup plan 和 parent cleanup plan：include 本身必须完成独立 create/active/delete/absence，CTS 收口使用同一验证生命周期中的父函数组作用域。

