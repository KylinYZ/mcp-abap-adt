# `Z_MCP_SM21_READ` 内部读取核心部署说明

> 已不再是现行部署的运行依赖。现行 ADT HTTP 服务直接调用 `CL_SYSLOG_FILTER` / `CL_SYSLOG`，请使用 [`../adt-http/ZCL_MCP_SM21_ADT_HTTP-deployment.md`](../adt-http/ZCL_MCP_SM21_ADT_HTTP-deployment.md)。

此工件保留为早期的 SM21 本地读取函数示例，不应由现行 MCP 服务调用。它不是 Remote-Enabled RFC，也不需要任何 MCP 主机的 RFC SDK。

## 1. 先创建 DDIC 类型

在 SE11 创建以下客户命名空间对象并激活：

| 对象 | 类型 | 字段 |
| --- | --- | --- |
| `ZMCP_SM21_LOG` | 结构 | `LOG_DATE DATS`、`LOG_TIME TIMS`、`INSTANCE INSTANCEX`、`CLIENT MANDT`、`USER_NAME XUBNAME`、`PROGRAM PROGRAM_ID`、`TCODE TCODE`、`MESSAGE_ID RSLGNO`、`SEVERITY CHAR10`、`PROCESS CHAR20`、`MESSAGE_TEXT CHAR255` |
| `ZMCP_SM21_LOG_T` | 表类型 | 行类型 `ZMCP_SM21_LOG`，标准表，默认键 |

`BAPIRET2` 是标准结构，无需新建。源码使用目标系统已核验的 `RSLGENTRY` 显示字段；若 Basis 升级改变其字段定义，必须先在 SE11 核对再调整赋值语句。

## 2. 创建函数模块

1. 在 SE37 创建函数组，例如 `ZMCP_SM21`，创建函数模块 `Z_MCP_SM21_READ`。
2. 保持 **Remote-Enabled Module** 未勾选。
3. 按源码顶部的 Local Interface 创建导入/导出/Tables 参数；`ET_LOGS` 的结构使用 `ZMCP_SM21_LOG`。
4. 将 [`Z_MCP_SM21_READ.abap`](Z_MCP_SM21_READ.abap) 的实现粘入 Source code，执行语法检查并激活。
5. 将函数模块和 DDIC 对象纳入未释放开发请求；不得在生产直接修改。

## 3. 权限最小化

经 SICF 服务访问的现有 ADT 用户需要 `S_ADMI_FCD`，字段 `S_ADMI_FCD = SM21`。本地函数调用不需要 `S_RFC`；不要通过 `SAP_ALL` 或跳过函数内 `AUTHORITY-CHECK` 来绕过授权。

## 4. 激活后验证

在 SE37 使用 15 分钟窗口测试本地函数，例如：

- `IV_FROM` / `IV_TO`：`YYYYMMDDHHMMSS`；跨度不超过 24 小时。
- `IV_PAGE_SIZE`：`100`；`IV_OFFSET`：`0`。
- 任选已知实例、用户或程序作为逗号分隔筛选。

再在 SM21 使用相同窗口和筛选，抽样核对时间、实例、用户、程序、事务码、消息以及总数。无 `S_ADMI_FCD=SM21` 的账号必须返回错误且 `ET_LOGS` 为空。

函数不会写入、删除、归档、锁定或确认系统日志。`GET_INSTANCE_BY_FILTER` 读取多个实例时可能有部分实例不可用；上线前应按本系统 Basis 版本扩展并验证返回的部分失败信息。
