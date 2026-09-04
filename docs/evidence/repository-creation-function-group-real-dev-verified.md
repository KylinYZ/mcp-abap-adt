# Function Group Real DEV Verification

验证目标：DEV client `300`；包 `Z001`；未释放传输主请求 `S4HK900009`、子任务 `S4HK900010`。

<a id="create"></a>
## Create and Active Readback

- 硬重启后，healthcheck 为 `disconnected/generation=0`，历史 `ZVPFG8` creation/cleanup plan 均返回 `PLAN_NOT_FOUND`；`ZVPFG8` 与 `ZVPFM8` search 均为空。
- 全新身份 `FUGR/F ZVPFG9` 连同首个 `FUGR/FF ZVPFM9` 由 creation plan `409df9213ed61d484f776b6f6cda0857` 创建。原生确认后完成创建、模块 `source/main` 写入、syntax check、unlock、模块 activation、父组和模块 active readback，终态 `APPLIED`。
- 模块 active source 仅使用受控 `FUNCTION_MODULE_FORMAT_NORMALIZED`：SAP 注入固定 parameter-template 注释与独立签名句号；业务正文未放宽。

<a id="transport"></a>
## Transport

- 创建后的只读 `transportInfo` 显示函数组技术键 `LIMU/REPS/SAPLZVPFG9`，主请求为 `S4HK900009`、实际任务为 `S4HK900010`；包为 `Z001`。
- cleanup 同一开放传输中接受标准业务 CTS 键 `R3TR/FUGR/ZVPFG9` 作为 SAPL/LIMU 技术键的受限别名；传输号、包、对象类型与唯一性校验仍保持严格。

<a id="cleanup"></a>
## Cleanup and Absence

- 独立 cleanup plan `c7ffdbfe-8399-46f1-80d9-060c6ea691dd` 只删除 `FUNCTION_GROUP ZVPFG9`。锁定、删除、函数组 absence 以及唯一 neutral CTS entry 均成功，终态 `COMPLETED_LOCAL_ABSENCE`。
- 独立 search 同时确认 SAP 级联删除 `ZVPFM9`；未执行 E071/E071K 或数据库操作。
- 此证据只晋级 `FUNCTION_GROUP`。`FUNCTION_MODULE` 虽完成创建、激活和级联缺失，但尚未冻结并验证其自身最终 CTS 键，保持 `AUTOMATION_VERIFIED`。
