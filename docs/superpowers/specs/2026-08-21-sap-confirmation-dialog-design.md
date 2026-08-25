# SAP 受控创建确认框视觉设计

> 实施状态（2026-08-24）：中文 SAP 蓝色窗口已在 Codex Desktop 显示并完成 cancel/apply 回传。实际实现使用 Explorer broker 启动临时 UTF-8 BOM `.ps1`，通过一次性 named pipe 返回；真实 DEV apply 已进入完整创建 workflow，未发生确认回路卡死。

## 目标

仅美化 Windows 原生确认框并将用户可见文案改为简体中文，保持现有 MCP 受控创建确认回路、named pipe 协议、超时和安全边界不变。

## 界面

- 窗口标题为“SAP 受控创建确认”。
- 顶部使用 SAP 蓝色标题带，正文使用浅色背景和 Segoe UI 字体。
- 正文分为“创建对象”和“执行信息”两组：对象类型、对象名称、开发包、传输请求、计划指纹、过期时间均保留。
- 对象名称使用较大字号突出显示。
- 在按钮上方显示“确认后将执行一次受控 SAP 创建流程。”风险提示。
- “有效期至”统一按北京时间（UTC+08:00）显示；内部计划、协议与审计时间仍使用 UTC。
- 操作按钮为“确认创建”和“取消”；默认焦点为“取消”，关闭、取消和超时均产生 `action=cancel`。

## 行为与协议

helper 继续通过一次性 Windows named pipe 接收请求并返回同样的单行 JSON。为避免美化后的脚本超过 Windows 命令行长度，Explorer broker 启动临时 UTF-8 BOM `.ps1` 文件；该文件只包含 UI 代码和 pipe 名称，不包含 SAP 凭据，并在流程结束时删除。确认最多等待 15 分钟，并在计划剩余有效期更短时自动收敛；不得让确认授权晚于计划失效。其余 `challengeId` 校验、结果解析和 provider 安全边界保持不变。

## 验证

- 更新 Windows provider 测试，检查中文标题、标签、风险提示和按钮文案存在于 helper 脚本及请求构造中。
- 运行定向 Jest、全量 build 和 `git diff --check`。
- 运行无 SAP 的 named-pipe cancel/apply smoke；真实 SAP apply 由重启 MCP Client 后的人工验收完成并记录到 `docs/evidence/real-dev-validation-phase-0-gate.md`。

## 不在范围内

- 不启用文字确认、不伪造 `ElicitResult`、不传入 `confirmed=true`。
- 不改变 MCP 原生 elicitation 路径，不启动 TCP/HTTP/SSE/WebSocket 端口。
- 不执行真实 SAP mutation，不重试历史计划，不修改确认协议。
