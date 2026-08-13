[English](README.md) | [简体中文](README.zh-CN.md)

免责声明：本服务仍处于实验阶段。默认 `safe` 模式提供受控的源码变更与对象创建流程，但 SAP 权限设计、传输治理、备份和人工复核仍由使用方负责。

# ABAP-ADT-API MCP 服务

## 项目说明

`mcp-abap-abap-adt-api` 是一个连接 MCP 客户端与 SAP ABAP Development Tools（ADT）接口的 MCP 服务。它基于 [`abap-adt-api`](https://github.com/marcellourbani/abap-adt-api/)，提供 ABAP 对象读取、安全源码修改、受控对象创建、传输校验、语法检查、激活、失败恢复和审计能力。

> **分发状态（2026-08-12）：** 当前修改版**尚未发布到 npm 或 MCP Registry**。必须在本项目源码目录安装依赖并构建，再让 MCP 客户端运行 `dist/index.js` 的绝对路径。`package.json` 和 `server.json` 中的 npm/Registry 字段只是未来可能发布时使用的元数据，不代表线上已经存在可安装包。

完整安装、客户端接入和操作步骤见 [使用指南](docs/使用指南.md)。

> **相关项目：** 如果需要更高层、以只读为主的 ABAP 工具（例如 `GetProgram`、`GetClass`、`GetTable`），请使用独立的 [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) 项目。本项目提供的是较底层的 ADT 能力，并在其上增加了默认启用的安全源码变更门面。

## 功能

### 默认 `safe` 模式

- **支持四类源码对象**：`PROGRAM`、`INCLUDE`、`CLASS`、`FUNCTION_MODULE`。
- **支持三类对象创建**：`PROGRAM`、`FUNCTION_GROUP`、`FUNCTION_MODULE`，也可一次预览“新函数组 + 首个函数模块”。
- **先审阅、后修改**：读取精确对象的完整当前源码，验证完整目标源码，执行语法检查并返回完整 diff；预览阶段不会锁定、写入或激活 SAP 对象。
- **跨客户端确认**：客户端支持 MCP `elicitation.form` 时使用原生弹框；不支持时，可按配置启用绑定计划的一次性文字确认。
- **策略边界**：只允许 DEV 角色、白名单主机、客户端和命名空间；拒绝 `$TMP`，并要求 SAP 为目标对象返回一个已有且未释放的传输请求。
- **应用阶段保护**：再次校验传输和源码哈希，获取有状态 `MODIFY` 锁，只写入已确认计划中的源码，再次检查语法，然后解锁、激活并复读源码哈希。
- **失败自动恢复**：写入后发生错误时恢复原源码；必要时重新获取恢复锁，随后解锁、重新激活原版本并校验原始哈希。
- **脱敏审计**：以 JSONL 记录执行阶段，不记录密码、授权头、Cookie、锁句柄、完整源码、diff、确认短语或验证码。

### 兼容 `legacy-full` 模式

只有明确需要原始低层 ADT 能力时才设置 `SAP_MCP_TOOL_PROFILE=legacy-full`。该模式会在七个安全工具之外开放原有的认证、对象 CRUD、传输、激活、DDIC、代码分析、调试和跟踪等工具。

低层写入和删除工具不会经过安全源码变更流程，因此只应作为兼容能力使用。

### 性能与资源护栏

`safe` 与 `legacy-full` 的所有工具统一经过中央参数和响应保护。FIFO 执行门控只保护使用共享有状态 ADT 客户端的操作；原生确认等待、本地状态查询和 `healthcheck` 不占 SAP 执行槽。确认成功后，完整应用、复核、回滚或创建补偿流程仍在同一个 gate 内原子执行。默认并发数为 `1`，因为 ADT 操作共享 Cookie、CSRF、会话类型和锁生命周期。只有在受控 SAP DEV 环境验证后才应提高并发数。

| 环境变量 | 默认值 | 有效范围 | 用途 |
| --- | ---: | --- | --- |
| `SAP_MCP_ADT_TIMEOUT_MS` | `60000` | 5000–600000 | 传给 ADT 客户端的真实 HTTP 超时。 |
| `SAP_MCP_MAX_CONCURRENT_TOOLS` | `1` | 1–8 | 同时执行的工具数；生产建议保持 `1`。 |
| `SAP_MCP_MAX_QUEUED_TOOLS` | `50` | 0–1000 | FIFO 等待容量，超出后返回繁忙错误。 |
| `SAP_MCP_QUERY_DEFAULT_ROWS` | `200` | 1–查询上限 | `tableContents` 与 `runQuery` 默认行数。 |
| `SAP_MCP_QUERY_MAX_ROWS` | `5000` | 1–100000 | 查询行数硬上限。 |
| `SAP_MCP_SEARCH_DEFAULT_RESULTS` | `50` | 1–搜索上限 | `searchObject` 默认数量。 |
| `SAP_MCP_SEARCH_MAX_RESULTS` | `500` | 1–10000 | 搜索结果硬上限。 |
| `SAP_MCP_MAX_RESPONSE_BYTES` | `10485760` | 1–100 MiB | 单次工具响应允许的 UTF-8 文本总字节数。 |
| `SAP_MCP_SOURCE_CACHE_MAX_ENTRIES` | `20` | 0–1000 | 会话源码缓存条目数；`0` 表示关闭。 |
| `SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES` | `2097152` | 64 KiB–20 MiB | 允许缓存的单份源码上限。 |
| `SAP_MCP_SOURCE_CACHE_TTL_SECONDS` | `900` | 60–3600 | 源码缓存有效期。 |
| `SAP_MCP_CHANGE_PLAN_MAX_ENTRIES` | `100` | 1–1000 | 内存中变更计划记录上限。 |
| `SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS` | `86400` | 3600–604800 | 回滚失败后恢复源码保留时间。 |
| `SAP_MCP_MAX_ARGUMENT_BYTES` | `5242880` | 64 KiB–50 MiB | 单次工具参数的 UTF-8 JSON 字节上限，包含完整源码。 |
| `SAP_MCP_LOG_LEVEL` | `warn` | `error`、`warn`、`info`、`debug` | 普通 stderr 日志最低级别。 |

配置越界时服务启动失败。显式查询或搜索数量超过上限会在访问 SAP 前拒绝，不静默截断，也不改写 SQL。`getObjectSource` 分页是在首次完整读取 SAP 后使用受限的进程内会话缓存切分，不是 SAP 服务端分页。写请求超时代表远端结果未知，必须先检查对象或变更计划状态，再决定是否重试，禁止盲目重复写入。

审计 JSONL 仍逐条等待并串行落盘。服务不自动轮转或删除审计日志；部署环境必须负责保留、归档、磁盘容量告警和访问控制。

## 安全 ABAP 源码变更与对象创建

默认 `SAP_MCP_TOOL_PROFILE=safe`，只暴露七个高层工具：

- `inspectAbapObject`：读取一个精确且在白名单内的 `PROGRAM`、`INCLUDE`、`CLASS` 或 `FUNCTION_MODULE` 对象，返回完整源码、对象元数据和源码哈希。
- `previewAbapChange`：校验目标对象、传输请求、完整目标源码和语法，返回完整 diff 和短时变更计划；不修改 SAP。
- `applyAbapChange`：在用户明确确认后执行先前生成的计划，包含源码漂移检查、锁定、写入、语法检查、解锁、激活、复读校验和失败恢复。
- `getAbapChangeStatus`：读取本地计划状态和阶段结果，不返回完整源码、凭据、Cookie 或锁句柄。

### 标准操作流程

1. 调用 `inspectAbapObject`，读取精确对象的完整当前源码，并以它作为编辑基线。
2. 调用 `previewAbapChange`，传入完整替换源码和一个已有且未释放的传输请求。
3. 向用户展示服务器返回的完整 diff。预览不会锁定、写入或激活对象。
4. 使用返回的 `changePlanId` 调用 `applyAbapChange`。用户确认由服务器通过 MCP 客户端获取，不能由模型自行声明。
5. 需要查看执行阶段、错误、解锁或回滚结果时，调用 `getAbapChangeStatus`。

变更计划只保存在当前 MCP 进程内，具有有效期且只能消费一次。MCP 重启后计划会丢失。默认有效期为 900 秒，允许配置为 60–3600 秒。计划不存在、已过期、已消费或出现源码漂移时均不能写入 SAP，必须重新预览。
- `previewAbapObjectCreation`：只读校验并冻结 `PROGRAM`、`FUNCTION_GROUP`、`FUNCTION_MODULE` 创建计划；不创建、锁定、写入或激活 SAP 对象。
- `applyAbapObjectCreation`：用户明确确认后，按依赖顺序创建、写入、检查、激活和复读；失败时只对当前计划能证明归属的对象尝试反向删除补偿。
- `getAbapObjectCreationStatus`：读取创建计划、已创建对象和补偿状态，不返回完整源码、确认短语或锁句柄。

### 确认交互

- 支持 MCP form elicitation 的客户端会显示精简弹框，包含 `应用变更` 和 `取消` 两个选项。只有客户端返回接受且选择 `应用变更` 时才会开始修改。
- 选择 `取消`、点击跳过、关闭弹框或未返回选择，都视为取消，不消费计划，也不锁定或写入 SAP。
- 原生弹框最多等待 15 分钟，同时不会超过计划剩余有效期。超时按取消处理，计划保持 `PREVIEWED`；只要计划仍有效，用户可以再次调用应用工具重新弹框。
- 客户端不支持 form elicitation 时，只有设置 `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true` 才能应用。第一次调用会返回绑定计划的一次性短语，第二次调用必须提交完全一致的 `textConfirmation`。
- 支持原生弹框的客户端始终使用更强的弹框确认，并忽略文字确认参数。两种确认机制都不可用时，服务返回 `CONFIRMATION_UNSUPPORTED` 并拒绝写入。

创建对象时改用 `previewAbapObjectCreation`、`applyAbapObjectCreation` 和 `getAbapObjectCreationStatus`。支持单个 `PROGRAM`、单个 `FUNCTION_GROUP`、已有函数组中的单个 `FUNCTION_MODULE`，以及“新函数组 + 首个函数模块”。完整中文 JSONC 参数和恢复说明见[使用指南](docs/使用指南.md#9-安全创建对象)。

函数模块接口参数维护仍未接入。首期只创建函数模块及其完整实现源码；函数组源码由 SAP 生成。创建失败后的删除是尽力补偿，不是数据库事务，结果不确定时必须人工检查而不能盲目重试。

### 计划与恢复状态

| 状态 | 含义 |
| --- | --- |
| `PREVIEWED` | 计划有效，等待确认；尚未开始修改 SAP。 |
| `APPLYING` | 已确认，受控应用流程正在执行。 |
| `APPLIED` | 激活和目标源码哈希复核成功。 |
| `FAILED` | 在写入源码前失败，无需回滚。 |
| `ROLLED_BACK` | 写入后发生错误，原源码已恢复、重新激活并通过哈希复核。 |
| `ROLLBACK_FAILED` | 自动恢复未完成，必须人工检查对象、锁、非活动版本和传输。 |
| `EXPIRED` | 计划在应用前过期，必须重新预览。 |

### 当前验证状态

截至 2026-08-13，第一阶段安全工作流及主要只读运行护栏已在约定范围内完成实现和核心验收：

- **自动化验证**：22 个 Jest 测试套件、164 项测试全部通过，除安全流程外，还覆盖运行配置、FIFO 执行门控、请求/响应限制、受限源码缓存、计划保留、源码换行规范化、日志和审计串行写入；TypeScript 构建与 `git diff --check` 通过。
- **真实 SAP DEV 成功流程**：`PROGRAM`、`INCLUDE`、`CLASS`、`FUNCTION_MODULE` 均完成真实读取、预览、锁定、写入、语法检查、解锁、激活、复读哈希和审计验证。
- **真实保护流程**：已验证预览语法错误、用户持锁、源码漂移、MCP 重启后计划失效、计划自然过期、成功计划不可重复消费、原生弹框应用/取消/关闭和确认超时。
- **真实回滚流程**：在源码写入后可控地模拟第一次激活失败，工作流成功重新获取恢复锁、写回原源码、解锁、真实激活原版本、复核原始哈希，并进入 `ROLLED_BACK`；最终无残留锁或目标非活动版本。
- **真实 SAP DEV 运行护栏**：已验证查询/搜索超限在访问 SAP 前拒绝、搜索默认数量、查询数量参数透传、1 MiB 响应替换为 `413`、源码分页缓存命中、LRU 淘汰、60 秒 TTL 过期，以及同一 MCP 进程内单并发 FIFO 和队列满 `429`。当前 SAP ADT 表预览会稳定返回请求数量外加一条 lookahead 行，例如请求 `5` 行返回 `6` 条。
- **换行规范化**：`ZCODEX_MCP_TEST` 已真实得到 `LINE_ENDING_NORMALIZED`，计划进入 `APPLIED`，且激活、解锁和复读哈希均成功。
- **对象创建实测**：`PROGRAM ZMCP_CREATE_TEST` 已在客户端 `300`、开发包 `Z001`、传输 `S4HK900011` 中完成创建、写入、语法检查、解锁、激活和复读验证并保留。首次创建 `FUNCTION_GROUP ZMCP_IF_TEST` 时，旧实现的字符串激活返回失败；工作流已证明对象归属并删除补偿成功，终态为 `COMPENSATED`，`FUNCTION_MODULE Z_MCP_IF_TEST` 尚未创建且只读复查无残留。函数组 typed activation 修复已通过自动化与构建，仍需重新启动 MCP 后做真实 DEV 复测。
- **激活未知结果保护**：激活请求抛出超时或连接异常时，先只读核对 active/inactive 版本；无法确定远端结果时撤销自动删除资格并进入人工检查状态，禁止盲目重试。
- **HTTP 超时**：已使用本机停滞 HTTP 端点端到端确认底层 ADT 客户端在配置 `5000 ms` 时约 5 秒取消请求；没有通过故意运行慢查询压测 SAP。
- **待专项验证**：调试、ATC、trace 等长任务的专用超时，提高 `SAP_MCP_MAX_CONCURRENT_TOOLS` 后的共享会话行为，以及不同 SAP 版本、权限模型和生产部署。

以上结论不代表已经穷举所有 SAP 版本、权限模型、网络故障或恢复过程再次失败的场景。出现 `ROLLBACK_FAILED` 或 `UNLOCK_FAILED` 时应停止自动重试并人工检查 ADT/SAP，避免反复写入扩大风险。

## 前置条件

- 可通过 ADT 访问的 SAP ABAP 系统，包括系统 URL、用户名、密码和客户端号。
- SAP 事务 `SICF` 中已启用 `/sap/bc/adt` 服务。
- 用户具有所需 ADT 权限以及目标对象和传输请求的修改权限。
- Node.js 18 或更高版本以及 npm。可用 `node -v` 和 `npm -v` 检查。

## 从源码安装

当前修改版只支持源码安装，不支持通过 `npx`、npm 包或 MCP Marketplace 安装。

```cmd
cd 包含当前修改的源码目录\mcp-abap-abap-adt-api
npm install
copy .env.example .env
npm run build
npm run start
```

必须使用确实包含当前本地改动的源码副本。当前改动尚未通过 npm、MCP Registry 或正式 Release 分发，不能假定重新克隆上游仓库即可得到本文描述的版本。

编辑 `.env`：

```env
SAP_URL=https://your-sap-server.com:44300
SAP_USER=YOUR_SAP_USERNAME
SAP_PASSWORD=YOUR_SAP_PASSWORD
SAP_CLIENT=100
SAP_LANGUAGE=ZH

SAP_MCP_TOOL_PROFILE=safe
SAP_MCP_SYSTEM_ROLE=DEV
SAP_MCP_ALLOWED_HOSTS=your-sap-server.com
SAP_MCP_ALLOWED_CLIENTS=100
SAP_MCP_ALLOWED_NAMESPACES=Z,Y
SAP_MCP_CHANGE_PLAN_TTL_SECONDS=900
SAP_MCP_AUDIT_PATH=C:\sap-mcp-audit
SAP_MCP_ALLOW_TEXT_CONFIRMATION=false
SAP_MCP_ADT_TIMEOUT_MS=60000
SAP_MCP_MAX_CONCURRENT_TOOLS=1
SAP_MCP_MAX_QUEUED_TOOLS=50
SAP_MCP_QUERY_DEFAULT_ROWS=200
SAP_MCP_QUERY_MAX_ROWS=5000
SAP_MCP_SEARCH_DEFAULT_RESULTS=50
SAP_MCP_SEARCH_MAX_RESULTS=500
SAP_MCP_MAX_RESPONSE_BYTES=10485760
SAP_MCP_SOURCE_CACHE_MAX_ENTRIES=20
SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES=2097152
SAP_MCP_SOURCE_CACHE_TTL_SECONDS=900
SAP_MCP_CHANGE_PLAN_MAX_ENTRIES=100
SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS=86400
SAP_MCP_LOG_LEVEL=warn
```

不要将 `.env` 提交到版本库。`SAP_MCP_AUDIT_PATH` 必须允许 MCP 进程写入。安全源码修改要求角色、主机、客户端、命名空间白名单和审计目录全部满足策略。
SAP_MCP_MAX_ARGUMENT_BYTES=5242880

源码构建完成后，让 MCP 客户端直接运行绝对路径下的 `dist/index.js`：

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "command": "node",
      "args": ["D:\\path\\to\\mcp-abap-abap-adt-api\\dist\\index.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

修改 `.env`、重新构建 `dist` 或调整 MCP 配置后，需要重启 MCP 客户端。Codex/Claude 配置示例、验证步骤、安全源码修改、对象创建和错误处理见 [使用指南](docs/使用指南.md)。

## 推荐给模型的自定义指令

```text
默认 safe 模式支持受控修改 PROGRAM、INCLUDE、CLASS、FUNCTION_MODULE，以及受控创建 PROGRAM、FUNCTION_GROUP、FUNCTION_MODULE。

1. 先调用 inspectAbapObject 读取精确对象的完整当前源码和元数据。
2. 使用完整目标源码、精确对象和已有未释放传输调用 previewAbapChange。
3. 向用户展示服务器返回的完整 diff。用户明确同意前不要调用应用工具。
4. 只使用返回的 changePlanId 调用 applyAbapChange。客户端支持 form elicitation 时，必须显示服务器发起的原生确认弹框并提交用户选择。
5. 客户端不支持 form 且服务器启用了文字降级时，先展示服务器返回的一次性短语，再用同一个 changePlanId 和完全一致的 textConfirmation 调用一次。
6. 使用 getAbapChangeStatus 检查阶段、解锁和恢复结果，不暴露完整源码。

不要传入或信任模型生成的 confirmedByUser。只有应用结果明确表示语法检查、激活、源码哈希复核和解锁均成功时，才能声明修改成功。出现源码漂移时重新读取和预览。回滚或解锁失败时，要求用户在 ADT/SAP 中人工检查非活动对象、锁和传输。

legacy-full 会额外开放原有低层 ADT 工具。原始写入和删除操作绕过安全流程，只能作为兼容能力使用。
```

## 数据库访问建议（仅 `legacy-full`）

默认七工具 `safe` 模式不开放数据库查询工具。使用 `legacy-full` 时：

- 始终使用明确的 `WHERE` 条件，避免无边界读取。
创建对象时，先调用 previewAbapObjectCreation 展示完整对象图、源码、传输和补偿警告；用户明确同意后只使用 creationPlanId 调用 applyAbapObjectCreation，再用 getAbapObjectCreationStatus 检查创建与补偿状态。不要给 FUNCTION_GROUP 传 source，不要声称可以维护 FUNCTION_MODULE 接口参数。

- 只查询实际需要的字段。
- 确定提供完整主键时使用 `SELECT SINGLE`。
- 不能保证完整主键但只需要一条记录时，使用 `UP TO 1 ROWS`。
- `tableContents` 用于读取表数据，不用于查看字段定义；临时查询可使用 `runQuery`。

## DDIC 定义检查（仅 `legacy-full`）

- 先用 `searchObject` 将对象名解析为 URI，再调用 `objectStructure` 查看对象或 DDIC 结构。
- `ddicElement` 用于读取数据元素或域等 DDIC 元素。
- `ddicRepositoryAccess` 用于读取指定路径的 DDIC 仓库信息。
- `GetTable`、`GetStructure` 和 `GetTypeInfo` 不属于本服务，它们来自独立的 `mcp-abap-adt` 项目。

## 常见问题

- **通过 `npx` 或 Marketplace 找不到包**：当前修改版尚未发布。请从源码构建，并使用 `node` 加 `dist/index.js` 绝对路径启动。
- **SAP 连接失败**：检查 URL、用户、密码、客户端、ADT 权限、网络连通性以及 `SICF` 中的 `/sap/bc/adt` 服务。
- **自签名证书错误**：仅在开发环境设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- **`CONFIRMATION_UNSUPPORTED`**：改用支持 MCP form elicitation 的客户端，或明确启用安全性较低的文字确认降级。
- **`PLAN_NOT_FOUND`**：计划只存在于内存中，MCP 重启后必须重新预览。
- **`PLAN_EXPIRED` / `PLAN_ALREADY_CONSUMED`**：重新预览；计划不能延期或重复应用。
- **`SOURCE_DRIFT`**：重新读取 SAP 当前源码后再预览；服务不会覆盖预览后发生的人工修改。
- **`LOCK_FAILED`**：在 ADT/SAP 中检查锁持有者；释放锁后，如果源码已变化，应重新预览。
- **`ROLLBACK_FAILED` / `UNLOCK_FAILED`**：停止自动重试，人工检查非活动对象、锁、源码版本和传输请求。
- **`AUDIT_FAILED`**：恢复 `SAP_MCP_AUDIT_PATH` 的写权限后再尝试源码修改。

## 开发验证

```cmd
npm test -- --runInBand
npm run build
git diff --check
```

自动化测试不能替代真实 SAP DEV 验证。对生产环境或新的 SAP 版本、权限模型进行部署前，应使用专用测试对象和已有测试传输重新验证完整流程。

## 参与贡献

1. Fork 仓库并创建功能分支。
2. 保持默认 `safe` 模式的安全边界，不要让低层写入工具绕过配置暴露。
3. 为修改添加对应测试并运行测试、构建和格式检查。
4. 提交分支并创建 Pull Request。

## 许可证

本项目使用 [MIT License](LICENSE)。
