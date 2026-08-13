# SM21 ADT HTTP 服务部署

该方案直接复用 MCP 已有的 ADT HTTP 登录会话；MCP 主机不安装 `node-rfc`、SAP NW RFC SDK、JCo、NCo，也不配置 RFC destination。

## SAP 工件

1. 在 SE24 创建全局类 `ZCL_MCP_SM21_ADT_HTTP`，实现 `IF_HTTP_EXTENSION`，复制 [`ZCL_MCP_SM21_ADT_HTTP.abap`](ZCL_MCP_SM21_ADT_HTTP.abap) 并激活。
2. 在 SICF 创建服务节点 `/sap/bc/z-mcp/sm21`，Handler List 指向 `ZCL_MCP_SM21_ADT_HTTP`，激活服务。不要放在 `/sap/bc/adt` 下：该路径由 ADT 框架资源路由管理，自定义节点会返回 `ExceptionResourceNotFound`。
3. 只授权 MCP 使用的 SAP ADT 用户 `S_ADMI_FCD`，字段 `S_ADMI_FCD = SM21`。服务不使用 RFC，通常不需要增加 `S_RFC`。

该类直接调用标准 `CL_SYSLOG_FILTER` / `CL_SYSLOG`；不依赖 `Z_MCP_SM21_READ`、`ZMCP_SM21_LOG` 或 `ZMCP_SM21_LOG_T`。此前创建的函数模块和 DDIC 类型可保留在请求中，但不属于本服务的运行依赖。

保留 `/sap/bc/adt` 现有认证和 HTTPS 约束；不要建立匿名 SICF 服务、不要将用户/密码作为 query 参数，也不要将该服务暴露到非预期网络。

## HTTP 契约

仅支持 `GET /sap/bc/z-mcp/sm21`，请求参数为 `from`、`to`、`instances`、`users`、`programs`、`tcodes`、`messageIds`、`severity`、`offset`、`pageSize`。时间使用 `YYYYMMDDHHMMSS`；其他筛选是逗号分隔值。成功返回 JSON：

```json
{"hasMore":false,"total":1,"logs":[{"timestamp":"20260813080000","instance":"APP01","text":"..."}]}
```

错误响应为 JSON `{"error":"..."}`，无权限为 HTTP 403，参数或读取请求错误为 HTTP 400。响应不包含凭据、RFC destination、Cookie 或完整 HTTP 认证头。

## 验证

使用已有 ADT 用户以 HTTPS 请求该路径，同一 15 分钟窗口与 SM21 进行抽样比对。再用没有 `S_ADMI_FCD=SM21` 的 ADT 用户验证 HTTP 403 和空日志；测试超过 24 小时、超过 500 行和无效 offset 返回 HTTP 400。
