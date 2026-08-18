# MCP 本地分发包迁移到 npm 线上版本指南

本文用于将通过本地 `.tgz`、本地 `dist/index.js`、`npm link` 或本地全局安装运行的 MCP，迁移到正式 npm 包：

```text
@kylinyz/mcp-abap-abap-adt-api@0.5.0
```

文档既可供人工操作，也可以完整交给其他 Agent 执行。迁移只改变 MCP 的启动来源，不改变 SAP 连接配置、Profile、安全策略或授权边界。

## 1. 迁移原则

1. 必须使用带作用域且固定版本的 `@kylinyz/mcp-abap-abap-adt-api@0.5.0`。
2. 不要使用不带作用域的 `mcp-abap-abap-adt-api`，它是上游独立旧包。
3. 不建议使用 `@latest`，避免未经验证便自动升级。
4. 保留现有 MCP 别名、`SAP_MCP_ENV_FILE`、SAP client、Profile、System Role 和所有安全白名单。
5. 一个 MCP 进程的 Profile 在启动时固定；已有多个别名时必须继续使用多个进程，不能合并。
6. 验证线上版本成功前，不卸载、不删除旧本地包。
7. 迁移过程中只做本机配置和只读验证，不执行 SAP 源码修改、调试控制、质量检查、DDIC 修改、包迁移或 RAP 发布。
8. 不在命令输出、聊天或截图中暴露 `.env` 内容、SAP 密码或其他凭据。

## 2. 识别当前安装方式

先检查当前 MCP 配置使用哪种启动方式：

- `node` 加本地 `dist/index.js`；
- 指向本地 `mcp-abap-adt-api.cmd`；
- `npx` 加本地目录或旧包名；
- `npm link`；
- `npm install -g` 安装的本地 `.tgz`；
- MCP JSON/TOML 直接引用本地目录。

Windows 上可执行：

```powershell
where.exe node
where.exe npm
where.exe npx
npm list -g --depth=0
```

只记录安装路径和包名，不输出环境文件内容。

如果 MCP 配置由公司策略、安装器或配置管理系统生成，应先确认配置权威来源，不要直接覆盖生成文件。

## 3. 确认线上包

执行只读检查：

```powershell
npm view @kylinyz/mcp-abap-abap-adt-api@0.5.0 version
npm view @kylinyz/mcp-abap-abap-adt-api@0.5.0 bin
```

预期结果：

- 版本为 `0.5.0`；
- bin 中包含 `mcp-abap-abap-adt-api`。

如果包不存在、版本不匹配或 npm 网络不可用，停止迁移并保留原配置。

## 4. 备份配置

修改前备份实际生效的 MCP 配置，例如：

```text
config.toml -> config.toml.before-npm-2026-08-18.bak
mcp.json    -> mcp.json.before-npm-2026-08-18.bak
```

备份文件不要提交 Git。不要复制、打印或上传 SAP 环境文件内容。

## 5. 修改 Codex TOML 配置

原本地源码配置可能类似：

```toml
[mcp_servers.sap-dev]
enabled = true
startup_timeout_sec = 120
command = 'C:\path\to\node.exe'
args = ['D:\path\to\mcp-abap-abap-adt-api\dist\index.js']

[mcp_servers.sap-dev.env]
SAP_MCP_ENV_FILE = 'D:\sap-mcp-config\sap-dev.env'
```

迁移后改为：

```toml
[mcp_servers.sap-dev]
enabled = true
startup_timeout_sec = 120
command = 'C:\Program Files\nodejs\npx.cmd'
args = ['-y', '@kylinyz/mcp-abap-abap-adt-api@0.5.0']

[mcp_servers.sap-dev.env]
SAP_MCP_ENV_FILE = 'D:\sap-mcp-config\sap-dev.env'
```

如果 `npx.cmd` 不在示例路径，使用 `where.exe npx` 返回的实际绝对路径。

只替换 `command` 和 `args`。原有 `SAP_MCP_ENV_FILE` 路径必须保持不变。

## 6. 修改 JSON 或 JSONC 配置

```jsonc
{
  "mcpServers": {
    "sap-dev": {
      "command": "C:\\Program Files\\nodejs\\npx.cmd",
      "args": [
        "-y",
        "@kylinyz/mcp-abap-abap-adt-api@0.5.0"
      ],
      "env": {
        "SAP_MCP_ENV_FILE": "D:\\sap-mcp-config\\sap-dev.env"
      }
    }
  }
}
```

上例是带注释文档场景可使用的 JSONC；如果目标客户端要求严格 JSON，删除注释并保持标准 JSON 语法。

## 7. 多环境、多 Profile 配置

如果现有部署使用 Workbench 推荐的七个别名，应逐一迁移：

| 别名 | Profile | System Role |
| --- | --- | --- |
| `sap-dev` | `development-workbench` | `DEV` |
| `sap-dev-business` | `business-readonly` | `DEV` |
| `sap-dev-ops` | `operations-readonly` | `DEV` |
| `sap-qas-business` | `business-readonly` | `QAS` |
| `sap-qas-ops` | `operations-readonly` | `QAS` |
| `sap-prd-business` | `business-readonly` | `PRD` |
| `sap-prd-ops` | `operations-readonly` | `PRD` |

每个别名只替换启动命令和包参数。以下内容不得在迁移时改变：

- `SAP_MCP_ENV_FILE`；
- SAP URL、client 和语言；
- `SAP_MCP_TOOL_PROFILE`；
- `SAP_MCP_SYSTEM_ROLE`；
- host、client、namespace 和调试用户白名单；
- 审计目录；
- 并发、超时、数量和响应大小限制。

不要把 QAS 或 PRD 配置成 `DEV`。

## 8. 重启 MCP 客户端

修改配置后，完整退出并重新启动 Codex、Claude 或其他 MCP 客户端。

只刷新聊天窗口通常不足以替换 MCP 子进程。应确认旧的本地 MCP 进程已经退出，避免新旧版本同时运行。

## 9. 验证线上版本

按以下顺序验证：

1. MCP 进程能够启动；
2. 工具列表能够加载；
3. 工具数量符合当前 Profile；
4. host、client、System Role 和 Profile 与迁移前一致；
5. 如果 Profile 暴露 `healthcheck`，调用它核对配置身份；
6. 如果没有 `healthcheck`，检查工具目录并执行一个最小、明确的只读调用；
7. 不使用写入或调试控制来验证安装。

当前工具数量基线：

| Profile | 工具数 |
| --- | ---: |
| `safe` | 7 |
| `development` | 118 |
| `diagnostic-readonly` | 98 |
| `legacy-full` | 161 |
| `development-workbench` | 81 |
| `business-readonly` | 17 |
| `operations-readonly` | 40 |

如果工具数量、Profile、SAP client 或 host 与迁移前不一致，应停止并恢复备份配置。

## 10. 确认旧引用已经退出

检查实际生效的 MCP 配置，确认不再引用：

- 本地 `.tgz`；
- 本地 `dist/index.js`；
- 本地 `node_modules`；
- `npm link`；
- 不带作用域的 `mcp-abap-abap-adt-api`。

现役启动参数应明确包含：

```text
@kylinyz/mcp-abap-abap-adt-api@0.5.0
```

## 11. 处理旧本地安装

只有在新版本成功启动、工具目录正确且环境身份一致后，才能处理旧安装。

检查全局安装：

```powershell
npm list -g --depth=0
```

如果确认旧安装是全局安装的本地包，可在用户批准后执行：

```powershell
npm uninstall -g <明确确认的旧包名>
```

如果旧版本只是一个本地项目目录或 `.tgz` 文件，不要自动删除。先报告其绝对路径、用途和是否仍被配置引用，再由用户决定归档或删除。

## 12. 回退方法

出现以下任一情况时立即回退：

- npm 包无法解析；
- MCP 进程无法启动；
- 工具数量或 Profile 不一致；
- host、client 或 System Role 变化；
- 环境文件未加载；
- MCP 客户端出现无法解释的兼容问题。

回退步骤：

1. 完整退出 MCP 客户端；
2. 恢复备份的 TOML/JSON 配置；
3. 确认配置重新指向原本地入口；
4. 重启客户端；
5. 重新检查工具目录和只读连通性；
6. 保留线上迁移失败证据，不盲目重复修改。

## 13. 成功标准

只有同时满足以下条件才算迁移完成：

- npm `0.5.0` 可解析；
- MCP 配置使用带作用域且固定版本的线上包；
- 所有 SAP 环境文件仍被正确引用；
- 所有别名、Profile 和 System Role 保持不变；
- MCP 客户端重启后成功加载工具；
- 工具数量符合对应 Profile；
- host 和 client 与迁移前一致；
- 没有执行未经授权的 SAP 写操作；
- 旧本地安装没有在验证前被删除。

## 14. 交给 Agent 的执行指令

将以下内容与本文路径一起交给执行 Agent：

```text
请严格按照《MCP 本地分发包迁移到 npm 线上版本指南》执行迁移。

目标包固定为 @kylinyz/mcp-abap-abap-adt-api@0.5.0。

先识别当前本地安装和实际生效的 MCP 配置，再只读验证 npm 包，备份配置，仅替换 command/args，保留所有别名、SAP_MCP_ENV_FILE、Profile、System Role、安全白名单和审计路径。完整重启 MCP 客户端后，核对工具数量、环境身份和一个最小只读调用。

验证成功前不得卸载或删除旧包。不得使用不带作用域的包名，不得使用 @latest，不得输出凭据，不得执行 SAP 写入、调试控制、质量检查或发布操作。

最终必须分别汇报：已修改、已验证、未验证、回退状态、旧本地安装是否仍保留。不能把“配置已修改”描述成“真实 SAP 已验证”。
```

## 15. 最终汇报模板

```text
### 已修改

- MCP 配置文件：<绝对路径>
- 已迁移别名：<别名清单>
- 新启动方式：@kylinyz/mcp-abap-abap-adt-api@0.5.0

### 已验证

- npm 包解析：<结果>
- MCP 客户端重启：<结果>
- Profile/工具数量：<结果>
- host/client/System Role：<结果>
- 最小只读调用：<结果>

### 未验证

- 真实 SAP 写入：未执行
- 调试控制/质量检查：未执行
- 其他运行环境：<未验证范围>

### 旧安装与回退

- 旧本地安装路径：<路径>
- 是否仍被配置引用：<是/否>
- 是否保留：<是/否>
- 回退配置：<备份路径>
```
