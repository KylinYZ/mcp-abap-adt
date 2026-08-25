# 仓库对象 31 类真实 DEV 验证活动设计

## 目标

通过一次配置启用当前已注册的 31 类仓库对象真实 DEV 验证，不需要每验证一类就修改环境变量。每类仍独立执行 preview、原生确认、apply、只读复读、传输核验和清理，不新增批量 apply 或共享确认。

## 配置边界

- `SAP_MCP_REAL_DEV_VALIDATION=true` 只表示当前验证活动开启。
- `SAP_MCP_REAL_DEV_VALIDATION_OBJECTS` 显式列出当前 31 类，不支持 `*`，未来新增类型不会自动获得权限。
- 全局验证前缀使用 `ZV`，兼容名称上限最短的 DDIC Type Group。
- 包固定为 `Z001`，传输固定为 `S4HK900009`，系统仍必须是 DEV 且 Profile 为 `development` 或 `development-workbench`。
- Server 启动时冻结配置；活动结束后把总开关恢复为 `false` 并重启。

当前固定白名单为：

```text
PROGRAM,FUNCTION_GROUP,FUNCTION_GROUP_INCLUDE,FUNCTION_MODULE,PACKAGE,DATABASE_TABLE,DDIC_TABLE_TYPE,DDIC_STRUCTURE,DDIC_DOMAIN,DATA_ELEMENT,MESSAGE_CLASS,DDIC_TYPE_GROUP,DDIC_LOCK_OBJECT,LOGICAL_EXTERNAL_SCHEMA,NUMBER_RANGE_OBJECT,SAP_OBJECT_TYPE,SAP_OBJECT_NODE_TYPE,CHANGE_DOCUMENT_OBJECT,ABAP_CLASS,ABAP_INTERFACE,PROGRAM_INCLUDE,CDS_DATA_DEFINITION,CDS_ACCESS_CONTROL,CDS_METADATA_EXTENSION,CDS_ANNOTATION_DEFINITION,SERVICE_DEFINITION,BEHAVIOR_DEFINITION,CDS_TYPE,CDS_ASPECT,CDS_ENTITY_BUFFER,SERVICE_BINDING
```

## 名称校验

除函数组 Include 外，创建计划的最终仓库对象名必须以 `ZV` 开头。

计划目标独立冻结 `packageName` 和 `parentName`：前者用于验证活动的包约束，后者只表示父函数组、父包或业务引用。不得再把所有 `parentName` 都解释为包名。现有普通适配器可继续用 `parentName` 兼容表示包，父对象型 legacy 适配器必须同时写入真实 `packageName`。

`FUNCTION_GROUP_INCLUDE` 的公开 `name` 是三字符 suffix，而最终技术名由 SAP 派生为 `L<FUNCTION_GROUP><SUFFIX>`。该类型改为验证：

- `parentFunctionGroup` 必须以 `ZV` 开头并已存在；
- suffix 必须严格匹配字母开头的三字符格式；
- preview 校验公开的父函数组与 suffix，apply 校验计划冻结的 `parentName` 和 SAP 返回的完整目标名；
- 测试建议使用父函数组 `ZVFG1` 和 suffix `Z01`，预期完整名为 `LZVFG1Z01`；
- 后续复读和清理只使用 preview/status 返回的实际完整名称，不由调用方手工拼接。

## 执行与停止规则

- 31 类只共享验证配置，不共享计划、challenge、确认或执行结果。
- 每个 apply 必须打开一次可信原生确认；Windows 使用 Explorer broker 和一次性 named pipe。
- 每个计划最多进入一次 mutation；取消、超时、断开和迟到响应不得重放。
- 任一类型出现 `OUTCOME_UNKNOWN`，整场活动暂停，只允许状态、对象、属性和传输的只读调查；解决前不继续下一类。
- 创建确认不授权清理。清理必须取得独立授权，并仅处理能够证明属于当前验证活动的对象。

## 验证

- 配置解析必须接受当前 31 类显式白名单，并继续拒绝未知类型和通配符。
- 回归测试必须证明未来新增类型不会自动进入验证范围。
- preview/apply 必须拒绝错误前缀、包、传输、角色和 Profile。
- Include 测试必须覆盖 `ZVFG1` + `Z01` → `LZVFG1Z01`，并拒绝非 `ZV` 父函数组及非法 suffix。
- 保留确认 gate、自锁、不重放、未知结果停止和全量仓库测试。

## 操作顺序

配置和代码通过验证后只需重启一次。先运行负向策略检查，再按依赖顺序逐类验证；父对象和引用对象必须先创建或使用已确认的 active 对象。全部 31 类完成并清理后，将验证总开关改回 `false`，再次重启并确认普通未晋级能力恢复为 `writable=false`。
