# 函数模块源码格式规范化实施计划

## 目标

基于已确认的真实 SAP DEV 证据，为函数模块增加受限源码格式规范化，使 SAP 仅调整签名后分隔空行时仍能通过激活后复核，同时继续严格识别参数、正文、注释、缩进和其他空行差异。

## 修改边界

- `src/safe/types.ts`
- `src/safe/sourceTools.ts`
- `src/safe/AbapChangeWorkflow.ts`
- `src/safe/AbapObjectCreationWorkflow.ts`
- `src/__tests__/sourceTools.test.ts`
- `src/__tests__/AbapChangeWorkflow.test.ts`
- `src/__tests__/AbapObjectCreationWorkflow.test.ts`
- 与本修复直接相关的中文状态文档

不修改 SM21、运行配置、底层 ADT 客户端、确认协议、锁、传输或补偿逻辑。

## 实施步骤

### 1. 扩展匹配类型

在 `SourceMatchType` 中加入 `FUNCTION_MODULE_FORMAT_NORMALIZED`，保留现有枚举值和对外字段。

### 2. 实现函数模块专用比较器

在 `sourceTools.ts` 新增导出函数：

- 先复用现有严格比较。
- 仅在结果为 `DIFFERENT` 时解析完整函数模块框架。
- 将换行统一为 LF，并移除文件末尾换行。
- 识别从 `FUNCTION` 开始到首个语句终止句点的签名。
- 只规范化签名终止句点后、首条非空正文前的连续空行。
- 无法可靠识别框架时失败关闭。
- 匹配成功返回原始哈希和 `FUNCTION_MODULE_FORMAT_NORMALIZED`。

### 3. 接入安全工作流

- `AbapChangeWorkflow` 根据对象类型选择比较器，覆盖激活后验证和回滚后验证。
- `AbapObjectCreationWorkflow` 对 `FUNCTION_MODULE` 使用专用比较器；其他可写对象继续使用通用比较器。
- 不改变错误码、恢复顺序或计划终态。

### 4. 增加单元测试

`sourceTools.test.ts` 覆盖：

- 现场三空行格式。
- 无参数函数模块。
- 参数、实现、注释、缩进、正文内部空行及尾部结构差异。
- 不完整源码失败关闭。

### 5. 增加工作流测试

- 函数模块创建接受 SAP 签名后空行格式并进入 `APPLIED`，不补偿。
- 函数模块修改接受相同格式。
- 函数模块回滚接受相同格式。
- 非函数模块仍拒绝中间空行变化。

### 6. 本地验证

依次运行：

```powershell
npm test -- --runInBand src/__tests__/sourceTools.test.ts src/__tests__/AbapChangeWorkflow.test.ts src/__tests__/AbapObjectCreationWorkflow.test.ts
npm test -- --runInBand --coverage=false
npm run build
git diff --check
```

由于工作区包含未提交 SM21 内容，提交前只暂存本计划白名单内文件，并检查 cached diff 不包含 `SM21`、`sm21` 或相关文件。

### 7. 真实 SAP DEV 复测

代码提交并重新构建后，要求用户重启 MCP。重新生成创建计划并只执行一次应用：

- 函数组：`ZMCP_IF_TEST`
- 函数模块：`Z_MCP_IF_TEST`
- 开发包：`Z001`
- 传输：`S4HK900011`

成功标准为计划 `APPLIED`、函数模块匹配类型 `FUNCTION_MODULE_FORMAT_NORMALIZED`、父组与模块 active、无补偿、active 源码包含参数和实现。

若发生超时、连接中断或未知激活结果，停止写入并只读检查，不重复应用。
