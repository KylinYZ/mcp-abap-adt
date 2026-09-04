# 迁移到 npm `0.6.0`

本文只替换 MCP 的启动来源，不改变 SAP 连接、Profile、System Role 或安全白名单。目标包固定为 `@kylinyz/mcp-abap-abap-adt-api@0.6.0`。

## 迁移原则

1. 使用带作用域、固定版本的包；不要使用不带作用域的上游包或 `@latest`。
2. 保留现有别名、`SAP_MCP_ENV_FILE`、Profile、System Role、白名单、审计目录和资源限制。
3. 验证新版本前保留旧本地安装，不执行 SAP 写入、调试控制、质量检查或发布。
4. 不在命令输出、聊天或截图中暴露环境文件、密码或令牌。

新安装推荐使用角色入口：`focused`/`developer`（等价于 `development-workbench`）、`business`、`operations`、`expert`。旧 profile 名称继续兼容；角色入口的完整说明见 [`产品定位`](产品定位.md)。迁移线上包时只替换启动命令，不改变这些环境变量。

## 配置替换

先识别实际生效的 MCP 配置和旧启动方式（本地 `dist/index.js`、`.tgz`、`npm link` 或旧包）。只替换 `command` 与 `args`。

Codex TOML：

```toml
[mcp_servers.sap-dev]
enabled = true
startup_timeout_sec = 120
command = 'C:\Program Files\nodejs\npx.cmd'
args = ['-y', '@kylinyz/mcp-abap-abap-adt-api@0.6.0']

[mcp_servers.sap-dev.env]
SAP_MCP_ENV_FILE = 'D:\sap-mcp-config\sap-dev.env'
```

JSON/JSONC：

```json
{
  "mcpServers": {
    "sap-dev": {
      "command": "npx",
      "args": ["-y", "@kylinyz/mcp-abap-abap-adt-api@0.6.0"],
      "env": { "SAP_MCP_ENV_FILE": "D:\\sap-mcp-config\\sap-dev.env" }
    }
  }
}
```

多环境或多 Profile 别名逐个替换启动参数，不要合并进程，也不要把 QAS/PRD 改成 DEV。

## 只读验证

联网前可确认本机工具路径：

```powershell
where.exe node
where.exe npm
where.exe npx
```

需要访问 npm 时验证目标包：

```powershell
npm view @kylinyz/mcp-abap-abap-adt-api@0.6.0 version
npm view @kylinyz/mcp-abap-abap-adt-api@0.6.0 bin
```

预期版本为 `0.6.0`，bin 为 `mcp-abap-abap-adt-api`。若解析失败，停止并保留旧配置。

修改后完整退出并重启 MCP 客户端，然后按顺序确认：进程启动、工具列表加载、Profile 工具数、`healthcheck` 身份（如可用）和一次最小只读调用。

当前工具数基线：

| Profile | 工具数 |
| --- | ---: |
| `safe` | 7 |
| `development` | 124 |
| `diagnostic-readonly` | 99 |
| `legacy-full` | 161 |
| `development-workbench` | 87 |
| `business-readonly` | 17 |
| `operations-readonly` | 40 |

## 回退与清理

如果包无法解析、进程不能启动、工具数或身份不一致，完整退出客户端，恢复备份配置并重启。只有新版本验证成功后，才可处理旧全局安装；本地目录和 `.tgz` 不自动删除，先报告路径并等待用户决定。

迁移完成的最低条件：固定包可解析、环境文件仍被引用、别名/Profile/Role 不变、重启后工具数正确、只读调用成功，且未执行未授权 SAP 写操作。配置迁移不等于生产部署或真实 SAP 写入验证。
