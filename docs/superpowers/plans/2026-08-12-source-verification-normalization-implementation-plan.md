# SAP 激活后源码规范化复核实施计划

> 状态：已实施并完成自动化验证。`LINE_ENDING_NORMALIZED` 成功路径的真实 SAP DEV 复测仍待执行。

## 1. 实施边界

依据已批准的设计，只修改安全源码复核和诊断输出。保留原始哈希、自动回滚、锁、激活、确认、传输校验和审计等待语义；不新增配置、解析器或模糊比较。

## 2. 测试先行顺序

1. 为 `sourceTools` 增加 `EXACT`、`LINE_ENDING_NORMALIZED`、`DIFFERENT` 的纯函数测试。
2. 为 `AbapChangeWorkflow` 增加激活后仅换行变化成功且不回滚的测试。
3. 增加真实内容差异仍回滚，并输出目标/实际哈希和匹配类型的测试。
4. 增加回滚后仅换行变化仍判定恢复成功的测试。
5. 增加计划视图和审计诊断字段测试，确保不输出完整源码。

## 3. 最小实现

1. 在 `src/safe/sourceTools.ts` 增加集中比较函数和匹配类型。
2. 在 `src/safe/types.ts` 增加写后与回滚后的可选诊断字段。
3. 在 `src/safe/AbapChangeWorkflow.ts` 的激活后验证和回滚验证中使用集中比较函数。
4. `DIFFERENT` 保持 `VERIFY_FAILED` 和自动回滚，并在错误详情中提供安全诊断字段。
5. 在计划视图和审计事件中透传诊断字段，不保存额外完整源码。

## 4. 自动验证

```powershell
npx jest src/__tests__/sourceTools.test.ts src/__tests__/AbapChangeWorkflow.test.ts src/__tests__/ChangePlanStore.test.ts src/__tests__/AuditLogger.test.ts --runInBand
npm test -- --runInBand
npm run build
git diff --check
```

## 5. 真实 SAP DEV 验收

对 `PROGRAM ZCODEX_MCP_TEST` 使用未释放请求 `S4HK900009`：

1. 确认当前源码仍为回滚后的原哈希。
2. 仅增加已批准的测试注释并预览。
3. 在用户既有确认范围内应用计划。
4. 验证最终状态为 `APPLIED`、测试注释存在、实际哈希与匹配类型已记录、无残留锁且审计链完整。
5. 若仍为 `DIFFERENT`，停止自动重试并依据新诊断字段分析。
6. 测试注释的后续移除作为独立变更再次预览并要求用户确认。
