# ABAP 变更预览与单次确认设计

## 目标

安全源码变更必须在会话中直接展示完整变更内容，并且在支持 MCP form elicitation 的客户端中只要求一次原生选项确认。用户不再需要先回复“确认应用”，再点击“应用变更”。

## 现状与根因

`previewAbapChange` 已返回完整 unified diff，但它被序列化为普通 JSON 文本，同时返回 `confirmationInstruction`，要求模型在调用应用工具前再次取得聊天文字确认。随后 `applyAbapChange` 又发起原生 MCP form elicitation，因此形成两重确认。

Codex 截图中的“已编辑 N 个文件”卡片表示本地工作区文件变更。ABAP diff 是远端 SAP 对象的预览，不是 Codex 工作区文件修改；当前公开 MCP 工具结果契约也没有已确认的字段可要求 Codex 将任意远端 diff 渲染成该本地变更卡片。因此本次不伪造本地文件修改，而是在工具结果中提供可直接显示的 Markdown diff。

## 方案

### 预览响应

`previewAbapChange` 保留现有机器可读字段 `status`、`plan`、`diff` 和 `confirmationRequired`，新增面向会话展示的 Markdown 文本，包含：

- 对象类型和名称；
- 传输请求；
- 增删行数；
- 带 `diff` 语言标记的完整 unified diff；
- 下一步说明：直接调用 `applyAbapChange`，由服务端取得唯一确认。

删除会诱导聊天前置确认的 `confirmationInstruction`。Markdown 内容由服务端根据已冻结的计划生成，不依赖模型重新拼接 diff。

### 确认流程

支持 `elicitation.form` 的客户端：

1. 模型展示预览响应中的完整 Markdown diff。
2. 模型直接调用 `applyAbapChange(changePlanId)`。
3. 服务端显示一次“应用变更 / 取消”原生表单。
4. 只有选择“应用变更”才开始 SAP 写入。

不支持 form 的客户端只有在 `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true` 时使用现有一次性文字挑战。该路径是兼容性降级，不与原生表单叠加。

### 安全边界

- 不删除服务端确认门禁。
- 不信任模型传入的 `confirmedByUser`。
- 不把预览调用标记为 SAP 写操作。
- 完整源码和 diff 仍不写入审计日志。
- 计划过期、源码漂移、锁定、语法检查、激活、验证和回滚逻辑保持不变。

## 验证

- 单元测试断言预览返回完整 Markdown diff，且不再包含聊天确认指令。
- 单元测试继续断言 form 客户端忽略文字短语，只接受原生选项结果。
- 单元测试继续覆盖无 form 客户端的文字降级与关闭失败。
- 运行相关 Jest 测试、TypeScript 构建和 `git diff --check`。
- Codex 会话实际渲染和原生表单交互仍需重启 MCP 后在客户端真实验证。
