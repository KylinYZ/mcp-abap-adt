# Eclipse 同构函数模块创建与激活修正设计

## 1. 结论

目标 SAP DEV 系统的 Eclipse ADT 3.60.2 抓包已经证明：函数模块接口参数属于 `source/main` 的 ABAP 源码，不存在本次场景所需的独立 Function Builder 参数写入请求；函数模块激活使用只包含对象 URI 和对象名的最小引用。

本设计取代《函数组 Typed Activation 修复设计》中关于“函数组和函数模块必须使用 typed activation”的推测。后续实现以本次真实 Eclipse 会话为协议事实，不再尝试其他激活组合。

## 2. 现场证据

固定测试对象：

- SAP 客户端：`300`
- 开发包：`Z001`
- 传输请求：`S4HK900011`
- 函数组：`ZMCP_ADT_TRACE`
- 函数模块：`Z_MCP_ADT_TRACE`

Eclipse 的实际顺序为：

1. 创建函数组。
2. 创建函数模块；期间没有单独激活函数组。
3. 锁定函数模块。
4. 将包含 `IMPORTING`、`EXPORTING` 和实现代码的完整文本写入函数模块 `source/main`。
5. 读取 inactive 对象并执行语法检查。
6. 解锁函数模块。
7. 仅以函数模块 URI 和名称执行激活，`preauditRequested=true`。
8. 读取 working area 源码和对象元数据复核结果。

源码写入请求为：

```http
PUT /sap/bc/adt/functions/groups/zmcp_adt_trace/fmodules/z_mcp_adt_trace/source/main?lockHandle=...&corrNr=S4HK900011
Content-Type: text/plain; charset=utf-8
```

请求正文直接包含函数模块签名：

```abap
FUNCTION z_mcp_adt_trace
  IMPORTING
    VALUE(iv_input) TYPE string
  EXPORTING
    VALUE(ev_output) TYPE string.

  ev_output = iv_input.

ENDFUNCTION.
```

激活请求正文为：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference
    adtcore:uri="/sap/bc/adt/functions/groups/zmcp_adt_trace/fmodules/z_mcp_adt_trace"
    adtcore:name="Z_MCP_ADT_TRACE"/>
</adtcore:objectReferences>
```

该请求没有 `adtcore:type`，没有 `adtcore:parentUri`，也没有额外接口参数资源。

## 3. 根因

当前安全创建流程与 Eclipse 有两处关键差异：

1. 组合创建“函数组 + 首个函数模块”时，MCP 在创建函数组后立即单独激活函数组；Eclipse 没有这一步。
2. MCP 对函数模块调用 `abap-adt-api` 的 typed overload，发送 `uri + type + parentUri + name`，并使用 `preauditRequested=false`；Eclipse 对应 `activate(objectName, objectUrl, undefined, true)` 字符串重载，只发送 `uri + name`。

`abap-adt-api` 8.4.1 的字符串重载生成的 XML 与抓包完全一致，因此不需要修改依赖库，也不需要自行拼装 HTTP 请求。

## 4. 修正范围

### 4.1 包含

- 组合创建函数组及首个函数模块时，创建函数组后不单独激活，继续创建函数模块。
- 新建函数模块和已有函数模块源码变更均使用字符串激活重载：对象名、函数模块对象 URI、无 `mainInclude`、`preauditRequested=true`。
- 函数模块完整接口签名继续作为 `source/main` 的一部分参与预览、确认、写入、审计哈希和回读验证。
- 函数模块激活成功后，分别验证函数模块和父函数组的 active 版本。
- 更新中文文档，删除“接口参数需要后续专用元数据 API”的错误结论。
- 保留传输校验、确认、锁、语法检查、结果不确定保护、反向补偿和仅容忍换行规范化的源码验证规则。

### 4.2 不包含

- 不新增 Function Builder 参数 REST 客户端。
- 不修改 `abap-adt-api` 依赖源码。
- 不改变程序创建和激活流程。
- 不根据本次抓包猜测 standalone 函数组的激活协议。
- 不自动重试真实 SAP 写入。
- 不删除抓包对象 `ZMCP_ADT_TRACE`、`Z_MCP_ADT_TRACE`。

## 5. 对 standalone 函数组的处理

本次抓包只证明“函数组 + 首个函数模块”的 Eclipse 流程，没有证明单独创建空函数组后如何达到 active 状态。旧 typed activation 已在目标系统真实失败，因此不能继续把 standalone 函数组创建描述为已可靠支持。

实现阶段应采用保守边界：

- 组合计划按本设计执行。
- 单独 `FUNCTION_GROUP` 创建预览暂时拒绝，并返回明确提示：目标系统尚缺少 standalone 函数组激活的 Eclipse 抓包证据。
- 已有函数组下创建函数模块不受影响。

如果后续确实需要只创建空函数组，应另行抓取 Eclipse 对该对象执行 Activate 的请求，再恢复该请求形态。

## 6. 修正后的组合创建流程

1. 预览阶段校验开发系统、命名空间、开发包、传输、对象图和完整函数模块源码。
2. 应用前重新验证所有策略、传输和目标不存在。
3. 创建函数组并解析 inactive 版本，证明对象身份和本计划归属。
4. 不激活函数组；验证并创建其首个函数模块。
5. 解析函数模块 inactive 版本，锁定实际函数模块 URI。
6. 写入确认计划中冻结的完整 `source/main`。
7. 对已写入的函数模块执行权威语法检查。
8. 解锁函数模块。
9. 调用 `activate(functionModuleName, functionModuleUrl, undefined, true)`。
10. 解析函数模块 active 版本，并回读源码进行严格比较；仅换行差异可接受。
11. 解析父函数组 active 版本，证明组合对象整体已激活。
12. 所有验证通过后将计划标记为 `APPLIED`。

## 7. 既有函数模块源码变更流程

`AbapChangeWorkflow` 对 `FUNCTION_MODULE` 的激活也改用同一字符串重载，以保持创建与修改路径一致。预览、锁定、写入、写后语法检查、解锁、激活、回读验证和失败回滚顺序保持不变。

回滚恢复原源码后，也必须用相同的 Eclipse 同构激活方式重新激活，不能退回 typed overload。

## 8. 失败与补偿

- 函数组创建成功但函数模块尚未创建时失败：仅在归属可证明时补偿函数组。
- 函数模块创建或写入后失败：按函数模块、函数组的反向依赖顺序补偿。
- 激活明确返回失败：记录脱敏短消息和 inactive 数量后进入既有补偿流程。
- 激活请求超时、断连或结果未知：先只读检查 active/inactive 状态；无法证明结果时禁止自动删除。
- active 函数模块存在但父函数组 active 复核失败：报告验证失败并进入既有安全恢复逻辑，不盲目重发激活。
- 错误和审计不得记录凭据、Cookie、CSRF Token、锁句柄或完整原始响应。

## 9. 自动化验证

测试至少覆盖：

- 组合创建中函数组创建后没有独立 `activate` 调用。
- 函数模块使用字符串激活重载，参数精确为名称、实际 URI、`undefined`、`true`。
- 激活调用不会生成 `adtcore:type` 或 `adtcore:parentUri`。
- 函数模块激活完成后验证函数模块 active 版本和父函数组 active 版本。
- 已有函数组下创建函数模块采用相同激活方式。
- standalone 函数组预览被稳定拒绝且不产生 SAP 写入。
- `AbapChangeWorkflow` 的函数模块应用和回滚均使用字符串激活重载。
- 程序激活、确认、传输校验、补偿顺序和源码严格验证保持不变。
- 函数签名中的 `IMPORTING`、`EXPORTING` 内容完整进入预览和源码哈希，不被单独解析后丢失。

验证命令：

```powershell
npm test -- --runInBand
npm run build
git diff --check
```

工作区存在未提交的 SM21 改动，必须精确暂存本次文件；分别验证本次提交快照与完整工作区，不得把 SM21 内容带入提交。

## 10. 文档修正

中文使用指南和 README 应明确：

- 函数模块接口参数由完整 ABAP 源码维护。
- 当前安全源码预览/应用能力可以修改接口签名和实现代码。
- MCP 暂不提供结构化参数数组到 ABAP 签名的高级生成器；调用方需提交完整、可审阅的函数模块源码。
- 不再声称缺少 Function Builder 接口元数据端点阻碍参数维护。
- standalone 空函数组创建仍待目标系统真实协议确认。

## 11. 真实 SAP DEV 验收

实现和自动化验证完成、MCP 重启并重新取得用户确认后，再使用新的隔离对象进行一次真实组合创建。不得复用已经存在的抓包对象，也不得盲目重试历史计划。

成功标准：

- Communication Log 中组合流程不存在独立函数组激活请求。
- 函数模块源码 PUT 包含完整参数签名。
- 激活 XML 只包含函数模块 `uri + name`，查询参数为 `preauditRequested=true`。
- 函数模块和父函数组均能读取 active 版本。
- 活动源码与确认源码精确一致或仅存在换行规范化。
- 计划终态为 `APPLIED`，无补偿、无遗留锁。

最终汇报必须区分代码修改、自动化验证和真实 SAP DEV 验证，未执行真实验证前不得宣称部署可用。
