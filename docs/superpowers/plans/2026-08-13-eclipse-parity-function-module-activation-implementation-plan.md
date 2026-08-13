# Eclipse 同构函数模块创建与激活实施计划

## 目标

依据目标 SAP DEV 系统 Eclipse ADT 3.60.2 的真实 Communication Log，修正安全对象创建和函数模块源码变更流程：组合创建时不单独激活函数组；函数模块统一使用只包含对象名和对象 URI、且 `preauditRequested=true` 的字符串激活重载；函数接口参数继续作为完整 `source/main` 源码维护。

本次不新增 Function Builder 参数 API，不修改 `abap-adt-api`，不猜测 standalone 空函数组的激活协议，不执行真实 SAP 写入。

## 实施原则

- 以已确认设计 `docs/superpowers/specs/2026-08-13-eclipse-parity-function-module-activation-design.md` 为范围基线。
- 先补失败测试，再修改实现。
- 保留现有确认、传输校验、锁定、写后语法检查、源码回读、换行规范化、结果不确定保护和反向补偿。
- standalone `FUNCTION_GROUP` 在预览阶段稳定拒绝，避免进入已知不可靠的独立激活路径。
- 工作区存在用户的 SM21 未提交改动；只编辑必要代码块，验证和汇报时区分本次修改与完整脏工作区。
- 自动化通过不代表真实 SAP DEV 已验证；真实复测需要重启 MCP、重新预览并再次明确确认。

## 任务 1：回归测试锁定 Eclipse 请求契约

文件：

- `src/__tests__/AbapObjectCreationWorkflow.test.ts`
- `src/__tests__/AbapChangeWorkflow.test.ts`

步骤：

1. 修改组合创建成功测试，断言函数组没有独立 `activate` 调用。
2. 断言函数模块激活调用精确为：对象名、实际对象 URI、`undefined`、`true`。
3. 增加父函数组 active 版本复核断言。
4. 增加已有函数组下创建函数模块的同构激活断言。
5. 增加 standalone 函数组预览被拒绝且零写入测试。
6. 修改既有函数模块源码变更测试，断言应用和回滚均使用字符串重载。
7. 先运行两个定向测试文件，确认旧实现不能满足新断言。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts src/__tests__/AbapChangeWorkflow.test.ts
```

## 任务 2：修正对象创建流程

文件：

- `src/safe/AbapObjectCreationWorkflow.ts`
- 必要时局部修改 `src/safe/AbapCreationResolver.ts`
- 对应创建工作流测试

步骤：

1. 在预览解析阶段拒绝只有一个 `FUNCTION_GROUP` 的对象图，错误说明目标系统缺少 standalone 激活协议证据。
2. 组合计划创建函数组后只解析 inactive 版本并记录归属，不调用激活。
3. 创建并写入首个函数模块后调用字符串激活重载：`activate(name, actualObjectUrl, undefined, true)`。
4. 函数模块 active 版本和源码验证成功后，再解析父函数组 active 版本。
5. 删除本流程不再使用的 typed activation reference 构造逻辑；保留失败诊断和未知结果只读判定。
6. 不改变程序创建流程和补偿反向顺序。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts
```

## 任务 3：修正已有函数模块源码变更流程

文件：

- `src/safe/AbapChangeWorkflow.ts`
- `src/__tests__/AbapChangeWorkflow.test.ts`

步骤：

1. `FUNCTION_MODULE` 的 `activateOrThrow` 改用字符串重载，参数与 Eclipse 抓包一致。
2. 普通应用和回滚恢复均复用同一激活方法。
3. 更新注释，删除“函数模块需要 typed activation”的过时结论。
4. 其他对象仍保持现有激活方式。

验证：

```powershell
npm test -- --runInBand src/__tests__/AbapChangeWorkflow.test.ts
```

## 任务 4：同步中文文档和状态说明

文件：

- `README.zh-CN.md`
- `docs/使用指南.md`
- `CHANGELOG.md`
- 若英文 README 中存在会误导当前能力的事实，只同步必要句子

步骤：

1. 明确函数模块参数位于完整 ABAP 源码签名中，通过 `source/main` 维护。
2. 删除“必须等待独立接口元数据 API”及 typed activation 已解决问题的旧结论。
3. 记录真实抓包确认的 Eclipse 创建、写入、激活顺序和请求形态。
4. 明确 MCP 暂不提供结构化参数数组生成器，调用方仍需提交完整源码。
5. 明确 standalone 空函数组创建暂时拒绝，组合创建尚待修复后的真实 SAP DEV 复测。

验证：

```powershell
rg -n "接口参数|source/main|typed activation|standalone|函数组|函数模块" README.zh-CN.md docs/使用指南.md CHANGELOG.md
```

## 任务 5：定向与完整自动化验证

按风险从小到大执行：

```powershell
npm test -- --runInBand src/__tests__/AbapObjectCreationWorkflow.test.ts src/__tests__/AbapChangeWorkflow.test.ts
npm test -- --runInBand
npm run build
git diff --check
```

由于工作区包含 SM21 改动，测试结果分别记录：

- 本次两个定向套件。
- 完整当前工作区。
- 如果后续精确暂存本次修复，再验证暂存快照不依赖 SM21 改动。

## 任务 6：交付与真实复测边界

交付时报告：

- 已修改的创建、变更、测试和中文文档。
- 自动化、构建和差异检查结果。
- 未执行真实 SAP DEV 创建与激活。
- 工作区中保留的用户 SM21 改动。

真实复测必须使用新对象名、重新生成创建计划并再次获得明确确认。Communication Log 验收标准为：没有独立函数组激活；函数模块 PUT 包含完整签名；激活 XML 只包含函数模块 `uri + name`；函数模块及父函数组均能读取 active 版本；无遗留锁。
