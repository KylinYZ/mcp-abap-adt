# 安全 ABAP 源码变更工作流设计

## 状态

- 日期：2026-08-11
- 状态：跨客户端弹窗与文字降级方案已获批准并进入实现验证
- 主开发仓库：`mcp-abap-abap-adt-api`
- 配套策略仓库：`sap-skills`

## 目标

在现有 `mcp-abap-abap-adt-api` 源码上增量开发安全门面，复用当前 `ADTClient`、会话管理和底层 handlers，为 Codex 提供程序、Include、类和函数模块的受控源码修改闭环。

工作流必须保证：先读取与预览、用户在 Codex 中明确确认、再锁定与写入；同时强制开发系统白名单、客户命名空间、已有传输请求、源码漂移检查、语法检查、激活、失败恢复、解锁和本机审计。

## 第一阶段范围

支持以下 ABAP 对象：

- 程序
- Include
- 类
- 函数模块

提供以下高层 MCP 工具：

- `inspectAbapObject`
- `previewAbapChange`
- `applyAbapChange`
- `getAbapChangeStatus`

第一阶段不包含：

- `SM21`、`ST22`、`SLG1` 统一日志诊断接口
- 创建或释放传输请求
- `$TMP` 本地对象
- SAP GUI 或 Codex 之外的 Windows 本地确认窗口
- 测试系统或生产系统写入
- 对象删除、任意查询、任意 ABAP 执行、调试或 Trace 修改
- 自动提交 Git 变更

## 总体架构

现有底层 handlers 和 127 个工具保留，不逐个重写。在同一个 MCP 进程中增加安全门面：

### `SafetyPolicy`

负责读取、标准化和校验安全配置。只读检查可以在写配置不完整时继续运行；任何预览或写入操作在配置缺失或不匹配时失败关闭。

### `AbapObjectResolver`

把对象类型和名称解析为统一对象描述：

- 对象名称与类型
- 对象 URL
- 源码 URL
- 父对象
- 锁定目标
- 激活目标
- 函数组或主 Include 上下文

解析结果必须来自 ADT 元数据，不允许猜测 URL 或生成 Include 名称。

### `ChangePlanStore`

在 MCP 进程内保存短时变更计划。计划默认十五分钟有效，只能消费一次，MCP 重启后全部失效。

计划保存：

- 计划 ID 与创建、到期时间
- SAP 主机和客户端
- 对象描述
- 传输请求号
- 原始源码与目标源码
- 原始和目标 SHA-256
- diff 摘要
- 预检查与语法检查结果
- 当前状态和各阶段结果

源码只存在于进程内计划中，不写入审计日志。

### `AbapChangeWorkflow`

封装完整预览与执行状态机，直接复用当前服务器持有的 `ADTClient`。它不通过解析现有 handler 的序列化结果来编排流程，避免 JSON 二次封装和错误信息丢失。

### `AuditLogger`

以追加模式写入本机 JSONL。没有删除、清理或覆盖接口。

### `SafeAbapHandlers`

定义四个高层工具及 MCP annotations，并把请求交给上述模块。

## 工具暴露策略

默认配置为：

```text
SAP_MCP_TOOL_PROFILE=safe
```

`safe` 只注册四个高层工具。现有底层工具代码保持不变，但不出现在工具列表中，也不能通过工具调用分派执行。

只有显式设置以下配置才恢复现有工具：

```text
SAP_MCP_TOOL_PROFILE=legacy-full
```

`legacy-full` 同时暴露高层工具和现有底层工具，并在启动日志中输出安全警告。底层工具不承诺经过安全门面保护。

未知 profile 必须拒绝启动，不能静默回退到 `legacy-full`。

## 安全配置

```text
SAP_MCP_SYSTEM_ROLE=DEV
SAP_MCP_ALLOWED_HOSTS=host1,host2
SAP_MCP_ALLOWED_CLIENTS=100
SAP_MCP_ALLOWED_NAMESPACES=Z,Y
SAP_MCP_CHANGE_PLAN_TTL_SECONDS=900
SAP_MCP_AUDIT_PATH=<本机审计目录>
SAP_MCP_ALLOW_TEXT_CONFIRMATION=false
```

规则：

- `SAP_MCP_SYSTEM_ROLE` 必须精确等于 `DEV`。
- 主机从 `SAP_URL` 解析并规范化，按完整主机名精确匹配，不使用后缀或子串匹配。
- 客户端必须是三位数字并与 `SAP_CLIENT` 精确匹配。
- 对象名转为大写后检查命名空间；首期允许 `Z*`、`Y*`。
- 所有写入必须提供已有传输请求。
- 传输请求必须存在、未释放并适用于当前对象；SAP 权限检查仍是最终授权依据。
- 不创建、不释放传输请求，不允许 `$TMP`。
- 配置解析错误必须返回不包含密码或会话信息的明确错误。

## 对象解析规则

### 程序与 Include

通过精确对象搜索和对象结构定位源码 URL、锁定 URL及激活目标。Include 还需要解析主程序上下文；如果存在多个主程序且无法确定正确激活目标，预览必须停止并返回候选项。

### 类

通过类对象 URL、`classIncludes` 和对象结构确定主源码单元、锁定目标与激活目标。首期修改完整类主源码，不增加创建类或独立修改测试 Include 的能力。

### 函数模块

通过精确对象搜索和对象结构解析函数模块所属函数组，并直接使用 SAP 返回的函数模块独立源码 URI：`/sap/bc/adt/functions/groups/<group>/fmodules/<function>/source/main`。

- 预览、写入和复读均作用于该函数模块的独立源码资源，不切割或替换整个 Include。
- 锁定与激活目标同样来自 SAP ADT 元数据，不猜测函数组 Include 名称。
- 找不到唯一函数模块、缺少独立源码 URI 或父函数组不明确时拒绝修改。
- 真实 DEV 联调仍需单独验证目标 SAP 版本对函数模块锁定和激活端点的行为。

## 工具契约

### `inspectAbapObject`

输入：

- `objectType`：`PROGRAM`、`INCLUDE`、`CLASS` 或 `FUNCTION_MODULE`
- `objectName`

行为：

- 先校验 DEV、主机、客户端和命名空间白名单，再只读解析对象。
- 返回完整当前源码、统一对象描述、当前源码 SHA-256、源码总行数和激活上下文。
- 不返回凭据、Cookie 或锁句柄。
- 完整源码只存在于本次工具响应中，不写入审计日志或计划状态视图。
- 不创建变更计划，也不要求审计目录即可执行读取。

### `previewAbapChange`

输入：

- `objectType`
- `objectName`
- `newSource`
- `transportRequest`

行为：

1. 校验安全配置与命名空间。
2. 解析对象并验证传输请求。
3. 读取完整原始源码。
4. 对目标源码执行 ADT 语法检查。
5. 生成统一 diff、增删行数和风险摘要。
6. 创建短时、一次性的 `changePlanId`。
7. 记录不含源码的预览审计事件。

语法检查有错误时不创建计划，不锁定对象，也不修改 SAP。

### `applyAbapChange`

输入：

- `changePlanId`
- `textConfirmation`：仅在客户端不支持 form elicitation 且显式启用文字降级时可选

该工具不接受新源码、对象名或传输号，防止预览后替换内容。

MCP 客户端必须先向用户展示计划中的完整 diff。调用 `applyAbapChange` 后，服务器通过 `Server.getClientCapabilities()` 检查客户端是否声明 `elicitation.form`；支持时使用 `Server.elicitInput` 发起标准 `elicitation/create` 表单，由 Codex、Claude 或其他兼容客户端显示各自的确认界面。弹窗展示对象、传输请求、计划 ID、原始与目标哈希和 diff 摘要，并提供必选布尔项“我已审阅完整 diff 并确认应用”。

只有客户端响应同时满足 `action === 'accept'` 和 `content.confirmApply === true` 时，handler 才能把内部 `confirmedByUser: true` 传给 workflow。`decline`、`cancel`、缺少确认字段、字段为 `false` 或 elicitation 请求失败时全部关闭失败，不调用 workflow 的写入路径。支持弹窗的客户端不再需要用户在聊天中输入固定确认文字。

客户端未声明 `elicitation.form` 时检查 `SAP_MCP_ALLOW_TEXT_CONFIRMATION`。未显式设为 `true` 时返回 `CONFIRMATION_UNSUPPORTED / confirmation`；设为 `true` 时进入文字挑战降级，不按客户端名称维护白名单。

文字挑战由服务器随机生成六位验证码，并与 `changePlanId`、目标源码哈希和计划有效期绑定。第一次调用返回 `confirmationRequired: true` 和完整短语，例如 `确认应用 <changePlanId> 验证码 <code>`，但不消费计划、不锁定、不写 SAP。用户在聊天中回复完整短语后，客户端再次调用同一工具并传入 `textConfirmation`；服务器执行去除首尾空白后的完整字符串匹配，匹配后立即使挑战失效并进入 workflow。挑战明文不进入审计或状态接口，审计只记录 `confirmationMode: text-fallback`。

文字降级无法证明消息一定由人输入，安全等级低于原生 elicitation；文档、工具响应和审计必须明确这一点。支持 `elicitation.form` 的客户端始终使用原生弹窗并忽略 `textConfirmation`，不能主动选择较弱模式。当前开发环境显式启用文字降级，其他部署默认关闭。

执行顺序：

1. 校验计划存在、未过期且未消费，构造不含源码的确认摘要。
2. 检查客户端的标准 form elicitation 能力；支持时通过弹窗确认，未接受则停止且不消费计划。
3. 客户端不支持时检查文字降级开关；关闭则以 `CONFIRMATION_UNSUPPORTED` 停止，开启则生成或校验绑定计划的短时挑战。
4. 将弹窗接受结果或匹配成功的文字挑战转换为内部 `confirmedByUser: true`，并立即使文字挑战失效。
5. 重新校验安全策略和传输请求。
6. 重新读取 SAP 当前源码并比较原始 SHA-256。
7. 发生源码漂移时以 `SOURCE_DRIFT` 停止，不获取锁。
8. 锁定对象并保存 `lockHandle`。
9. 写入计划中的目标源码。
10. 再次执行语法检查。
11. 使用本次 `lockHandle` 解锁对象；解锁成功前禁止激活。
12. 激活解析得到的正确目标。
13. 复读源码并核对目标 SHA-256。
14. 标记计划成功并记录审计。

`abap-adt-api` 的状态会话约定是“锁定后写入、解锁后激活”。锁仅保护源码写入阶段，不能跨越激活请求；否则 SAP 可能把 MCP 自己持有的锁报告为“当前编辑”。

### `getAbapChangeStatus`

输入：

- `changePlanId`

返回计划状态、到期时间、对象信息、哈希、diff 摘要和阶段结果，不返回完整源码、密码、Cookie 或锁句柄。

## 失败恢复

在获得锁之前失败，不执行回滚。

在写入目标源码后发生语法检查、解锁、激活或最终哈希验证失败时：

1. 如果原写入锁仍有效，先在该锁内写回原始源码，再解锁；如果已经解锁，则重新获取恢复锁后写回原始源码。
2. 恢复写入完成后必须先释放恢复锁，再尝试激活原版本。
3. 复读活动源码并核对原始 SHA-256；只有恢复写入、解锁、激活和复读校验全部成功，才标记回滚成功。
4. 对每个仍持有的锁执行尽力解锁，并分别记录恢复写入、恢复解锁、恢复激活和源码校验结果。
5. 返回主错误、回滚结果和解锁结果，不让后续错误掩盖最初失败原因。

激活 API 返回失败结果或直接抛出异常时，主错误都必须归类为 `ACTIVATION_FAILED / activate`；不能由通用异常兜底误报为 `VERIFY_FAILED / apply`。

SAP 活动版本和版本管理是额外保障，不能替代 MCP 自己保存原始源码并执行尽力恢复。恢复失败时必须返回明确的人工处理说明，要求在 ADT/SAP 中检查非活动对象、锁和传输请求。

## 审计日志

每个阶段追加一条 JSONL：

- 时间戳
- 关联 ID
- 计划 ID
- 事件类型
- SAP 主机、客户端和声明的系统角色
- 对象类型、对象名称、父对象和激活目标
- 传输请求号
- 原始与目标源码 SHA-256
- diff 增删行数
- 阶段耗时和结果
- 统一错误码和经过清理的 SAP 错误摘要
- 是否触发回滚、回滚结果和解锁结果

严禁记录：

- SAP 密码
- Basic Auth 头
- Cookie 或会话标识
- `lockHandle`
- 完整原始源码、目标源码或完整 diff

## 错误契约

- `POLICY_DENIED`
- `CONFIRMATION_UNSUPPORTED`
- `OBJECT_RESOLUTION_FAILED`
- `TRANSPORT_INVALID`
- `SYNTAX_CHECK_FAILED`
- `SOURCE_DRIFT`
- `PLAN_NOT_FOUND`
- `PLAN_EXPIRED`
- `PLAN_ALREADY_CONSUMED`
- `LOCK_FAILED`
- `WRITE_FAILED`
- `ACTIVATION_FAILED`
- `VERIFY_FAILED`
- `ROLLBACK_FAILED`
- `UNLOCK_FAILED`
- `AUDIT_FAILED`

工具返回必须包含主错误码、失败阶段、清理后的消息和可执行的 `nextStep`。SAP 原始错误只保留诊断必要内容，并经过凭据与会话信息清理。

## MCP annotations

- `inspectAbapObject`：只读、可重复、访问外部 SAP 系统。
- `previewAbapChange`：只读 SAP，但在本地创建短时计划；不修改租户。
- `applyAbapChange`：修改 SAP 租户、非只读、`destructiveHint: true`、优先使用 MCP form elicitation；不支持时仅可按显式配置使用文字挑战，同一计划不可重复。
- `getAbapChangeStatus`：只读本地计划状态。

同时在工具 `_meta` 中记录 operation class 和 approval requirement，供支持这些字段的客户端显示风险。annotations 和自定义 `_meta` 只描述风险，不能代替 elicitation 返回的用户决定。

## 自动化测试

使用假的 `ADTClient`，不连接 SAP，覆盖：

- `safe` 与 `legacy-full` 工具列表。
- 未知 profile 拒绝启动。
- DEV、主机、客户端、命名空间和传输策略。
- 四种对象解析。
- 函数模块唯一定位、独立源码 URI，以及零个、多个匹配时的拒绝。
- 预览语法失败不生成计划、不锁定、不写入。
- 计划超时、篡改、重复消费。
- 源码漂移在锁定前阻断。
- 支持 `elicitation.form` 的客户端只有返回接受、`confirmApply=true` 时才调用 workflow，并忽略文字参数。
- 不支持客户端在文字降级关闭时返回 `CONFIRMATION_UNSUPPORTED`；开启时首次返回一次性短语，精确匹配后才调用 workflow。
- 弹窗拒绝、取消、未勾选、elicitation 失败、文字挑战缺失或不匹配时均不写 SAP、不消费计划。
- 文字挑战不进入审计和状态响应；审计仅记录 `confirmationMode: text-fallback`。
- 成功调用顺序：读、锁、写、检查、解锁、激活、复读。
- 写入、检查、解锁、激活或验证失败后的恢复；已解锁时恢复必须重新获取锁。
- 激活返回失败与激活抛异常都统一归类为 `ACTIVATION_FAILED / activate`。
- 回滚失败与解锁失败不掩盖主错误。
- JSONL 审计字段和敏感信息清理。
- MCP 工具 schema、annotations、错误结构和 TypeScript 构建。

## 真实 SAP 验证

本地自动化通过后，按以下顺序在明确允许的开发系统执行：

1. 验证只读连接与四种对象解析。
2. 对指定 `Z/Y` 测试对象生成预览，不写入。
3. 使用用户提供的已有传输请求，对专用测试对象执行一次真实修改。
4. 验证语法检查、激活状态、源码哈希和 SAP 版本记录。
5. 人工制造一次激活失败，验证恢复与解锁。
6. 单独验证函数模块独立源码资源及其锁定、激活关系。

不连接测试或生产系统，不创建或释放传输请求。每项结果分别记录为代码验证、真实开发系统验证或未验证。

## `sap-skills` 配套工作

核心实现完成并稳定后，在 `sap-skills` 新增独立的 `sap-abap-adt` 插件，而不是把租户写入能力直接加入通用 `sap-abap` 插件。

配套内容包括：

- 安全变更技能和使用说明
- 兼容客户端中的预览、MCP form elicitation 弹窗确认、执行工作流
- `.mcp.json` 连接配方
- Codex 手工 MCP 连接说明
- MCP 依赖与环境变量安全清单
- operation class 与审批要求
- 源码提交固定和验证证据
- 与现有 `sap-abap`、`sap-abap-cds` 的交叉引用

`sap-skills` 是策略与分发层，不能作为唯一安全边界；关键限制必须由 MCP 服务器代码强制执行。

## 验收标准

- 默认启动不会暴露任何现有底层写入、删除、执行、调试或传输释放工具。
- 四类目标对象均有明确且可验证的解析路径。
- 未预览、计划过期、计划重复使用、源码漂移或策略不匹配时无法写入。
- `applyAbapChange` 不再信任模型传入的确认布尔值；优先接受标准 MCP elicitation 结果，只有显式开启时才接受绑定计划的一次性文字挑战。
- 弹窗拒绝、取消、未勾选，或文字挑战缺失、不匹配时不消费计划，也不锁定或写入 SAP。
- 不支持 form elicitation 的 Codex、Claude 或其他客户端在文字降级开启时可以通过短语应用变更；关闭时仍可读取和预览，但无法写入。
- 当前开发环境启用 `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true`，示例配置和 README 明确标注其安全降级性质，其他部署默认关闭。
- 最终写入内容与用户确认的 diff 绑定，`applyAbapChange` 不能替换源码。
- 所有写入使用已有传输请求并遵守 DEV、主机、客户端和命名空间白名单。
- 成功路径完成锁定、写入、检查、解锁、激活和复读验证，且激活发生在解锁之后。
- 写入后失败会在有效锁内或重新获取恢复锁后写回原源码，并在解锁后重新激活。
- 审计可追踪完整阶段，但不包含密码、Cookie、锁句柄或完整源码。
- 自动化测试和 TypeScript 构建通过。
- 真实 SAP 验证结果与本地验证明确分开汇报。
