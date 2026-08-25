# Eclipse ADT 3.60.2 受控仓库对象创建平台设计

## 1. 目标

在现有 `mcp-abap-abap-adt-api` 中建设统一的受控仓库对象创建平台，以 Eclipse ADT 3.60.2 在目标 SAP 系统中实际可创建的对象为完整能力目标。

平台必须同时满足：

- 复用 Eclipse ADT 3.60.2 创建适配器、内置 MCP、AFF Schema 和 URI discovery 提供的版本化契约。
- 复用 `vscode_abap_remote_fs` 与内置 `abap-adt-api` 已实现的 HTTP 协议和编排经验。
- 保留当前计划、确认、审计、DEV 限制、写后验证和未知结果保护。
- 对外保持少量稳定 MCP 工具，不为每一种对象永久增加一组工具。
- 只有完成真实 DEV 创建和验证的类型才标记为可写支持。

本设计不追求 Eclipse IDE 全功能复刻。调试、重构、Git、性能分析、编辑器体验和普通源码修改不属于本平台范围。

## 2. 已确认事实

- 目标 SAP 的 `typestructure` 返回 724 种仓库类型，其中 63 种宣告 `CREATE` 能力；该结果只能作为候选发现，不能单独证明 Eclipse 可创建或 MCP 可安全创建。
- Eclipse ADT 3.60.2 本地插件包含创建适配器、对象类型扩展注册、AFF Schema、URI discovery 和对象生成器实现。
- ADT 3.60.2 自己注册了四个通用创建 MCP 工具：列举可创建类型、读取类型详情、校验对象内容和创建对象。
- 当前内置 `abap-adt-api` 静态注册 21 种创建类型；`vscode_abap_remote_fs` 另行注册 `BDEF/BDO`。
- 当前受控创建仅真实覆盖程序、函数组和函数模块。
- 包、数据库表源码、表技术设置、表检查和激活协议已经通过 Eclipse 请求及真实 DEV 调用确认。
- `CURR` 和 `QUAN` 不是全局禁止类型；它们必须通过结构化输入声明有效的币种或单位引用字段。

## 3. 设计方案比较

### 3.1 继续扩展现有三类型工作流

为每种对象继续增加联合类型、分支和专用 MCP Schema。

优点是首批开发快，缺点是工作流会快速膨胀，动态字段、技术设置、多资源激活和对象生成器无法自然表达，最终仍需重构。

### 3.2 完全镜像 Eclipse 的动态创建模型

把 ADT 的字段模型直接映射成任意 `objectContent`，由调用方提交动态 JSON。

优点是表面覆盖快，缺点是会把版本相关、服务器驱动的内部字段直接暴露成任意写入口，无法提供稳定契约、类型级安全检查和可靠补偿。

### 3.3 受控动态适配器平台

采用稳定的五工具公共门面、统一计划状态机和按对象类型注册的适配器。发现与描述可以动态读取当前系统能力，写入则只允许白名单适配器执行。

这是本设计采用的方案。它将动态兼容性限制在能力发现和 Schema 生成层，把所有远端副作用保留在经过测试的适配器内。

## 4. 证据与支持等级

### 4.1 证据优先级

1. 目标 SAP 的 discovery、类型能力、对象响应和校验结果。
2. Eclipse ADT 3.60.2 的 `plugin.xml`、创建适配器、AFF Schema、内容处理器和内置 MCP 行为。
3. `vscode_abap_remote_fs` 的业务编排、兼容回退和测试。
4. 当前内置 `abap-adt-api` 的已有 HTTP 实现。
5. Eclipse 抓包，用于确认仍有歧义的媒体类型、锁、请求顺序或条件分支。
6. 真实 DEV 的创建、激活、读取、检查、补偿和清理结果。

不得把 SAP JAR、反编译源码或 SAP 专有 Schema 原文提交到仓库。仓库只保存为互操作实现而整理出的自有类型、派生契约、测试样例和证据摘要。

### 4.2 能力成熟度

每种对象按目标系统分别记录以下等级：

| 等级 | 含义 |
| --- | --- |
| `DISCOVERED` | SAP、ADT 插件或参考实现表明该对象可能可创建。 |
| `SCHEMA_EXTRACTED` | 已明确输入字段、父对象、资源和请求模型。 |
| `CLIENT_IMPLEMENTED` | 已有类型化 ADT 客户端方法及契约测试。 |
| `CONTROLLED_IMPLEMENTED` | 已接入统一 preview/apply/status、安全和补偿流程。 |
| `AUTOMATION_VERIFIED` | 单元、契约、失败注入、构建和工具注册验证通过。 |
| `REAL_DEV_VERIFIED` | 已在真实 DEV 完成创建、激活、读取验证和清理。 |
| `UNAVAILABLE` | 当前目标系统或 ADT 版本明确不可用。 |

只有 `REAL_DEV_VERIFIED` 才能在 `applyRepositoryObjectCreation` 中返回 `writable=true`。其他等级可以被列出和描述，但 apply 必须拒绝。

## 5. 公共 MCP 契约

平台新增五个稳定工具：

### 5.1 `listRepositoryObjectCreationCapabilities`

只读。返回当前 SAP 连接下的对象能力，而不是静态全局列表。

每项至少包含：

- 稳定 `objectKind`，例如 `PACKAGE`、`DATABASE_TABLE`、`ABAP_CLASS`。
- ADT 类型，例如 `DEVC/K`、`TABL/DT`、`CLAS/OC`。
- 显示名称、对象族和父对象类型。
- 当前成熟度、`writable`、不可写原因和证据来源。
- 是否需要源码、属性、技术设置、传输请求和独立激活。

### 5.2 `describeRepositoryObjectCreation`

只读。输入 `objectKind`，返回当前系统适用的结构化输入 Schema、字段说明、固定安全默认值、校验规则、执行阶段和补偿限制。

调用方不得提交任意 ADT URL、任意 XML、任意媒体类型或任意 annotation 列表。确需源码的对象只能在适配器声明的 source slot 中提交完整文本。

### 5.3 `previewRepositoryObjectCreation`

只读预检。输入一个对象创建请求和传输请求，执行：

- Profile、系统角色、主机、客户端、名称空间和包策略检查。
- 能力与成熟度检查。
- 结构化输入规范化。
- 父对象和目标缺失性确认。
- SAP 名称/属性校验和传输校验。
- 可执行阶段图构建。
- 完整预览、哈希、风险和补偿说明生成。

预览不得锁定、创建、写源码、写属性、激活或删除对象。

### 5.4 `applyRepositoryObjectCreation`

只接受 `creationPlanId`。所有名称、字段、源码、属性、技术设置和传输都来自不可变计划。

必须由服务端触发一次 MCP 原生 form confirmation；不接受聊天文本确认，不接受调用方传入 `confirmed=true` 绕过确认。

### 5.5 `getRepositoryObjectCreationStatus`

只读。返回计划状态、阶段、实际对象资源、检查、激活、验证、补偿和人工处理建议。

不得返回完整源码、凭据、Cookie、CSRF Token、锁句柄、确认内容或原始授权头。

## 6. Profile 与兼容性

- `safe` 的工具数量、名称和对外契约保持不变。
- 现有 `previewAbapObjectCreation`、`applyAbapObjectCreation` 和 `getAbapObjectCreationStatus` 保留，并在内部逐步委托给新平台的兼容适配器。
- 新五工具只在 `development` 和 `development-workbench` 中开放。
- `diagnostic-readonly`、`business-readonly` 和 `operations-readonly` 不开放创建平台。
- `legacy-full` 的原始低层工具保持兼容，但新平台不得通过 handler dispatch 调用它们绕过安全边界。
- QAS、PRD、缺失或非法系统角色始终只读；目录隐藏和 dispatch 拒绝必须同时成立。

## 7. 核心架构

### 7.1 `RepositoryObjectCreationRegistry`

注册所有类型适配器，并负责：

- 按 `objectKind` 和 ADT 类型查找适配器。
- 合并静态适配器信息、ADT 插件派生元数据和当前 SAP availability。
- 生成 list/describe 的稳定输出。
- 对未知、重复或未达到写入等级的适配器失败关闭。

Registry 不执行远端写入。

### 7.2 `RepositoryObjectCreationAdapter`

每个适配器只负责一种对象或一组协议完全一致的对象。统一边界包含：

- `describe`：返回结构化字段和安全约束。
- `availability`：核验当前 SAP 是否支持所需资源和媒体类型。
- `normalize`：把外部输入转换成不可变内部模型。
- `discoverState`：解析父对象、目标缺失性和现有相关状态。
- `validate`：执行本地和 SAP 校验。
- `buildPlan`：生成有序阶段图、验证目标和补偿策略。
- `executeStage`：执行一个类型受控的远端阶段。
- `verify`：读取实际对象、源码或属性并进行语义验证。
- `compensate`：只处理该适配器明确拥有且可证明由当前计划创建的资源。

适配器不能接收调用方提供的 URL、HTTP 方法、媒体类型或 XML 模板。

### 7.3 `RepositoryObjectCreationWorkflow`

统一状态机负责：

- 安全策略和传输检查。
- 计划创建、TTL、容量、上下文绑定和单次消费。
- 原生确认。
- 串行阶段执行。
- 阶段审计和脱敏状态输出。
- 失败分类、未知结果处理和逆序补偿。

工作流不包含对象类型分支；类型差异全部留在适配器。

### 7.4 `RepositoryObjectCreationPlanStore`

计划状态为：

- `PREVIEWED`
- `APPLYING`
- `APPLIED`
- `FAILED`
- `OUTCOME_UNKNOWN`
- `COMPENSATED`
- `COMPENSATION_FAILED`
- `EXPIRED`

终态计划清除完整源码和其他大 payload，只保留哈希、阶段摘要和验证证据。计划必须绑定系统主机、客户端、SAP 用户、系统角色和工具 Profile。

### 7.5 阶段图

适配器从以下有限阶段类型组合执行计划：

- `REVALIDATE_ABSENCE`
- `VALIDATE_TRANSPORT`
- `CREATE_SHELL`
- `RESOLVE_CREATED_OBJECT`
- `LOCK_RESOURCE`
- `WRITE_SOURCE`
- `WRITE_PROPERTIES`
- `WRITE_TECHNICAL_SETTINGS`
- `RUN_CHECKS`
- `UNLOCK_RESOURCE`
- `ACTIVATE_RESOURCE`
- `ACTIVATE_OBJECT`
- `VERIFY_ACTIVE_OBJECT`
- `VERIFY_SOURCE`
- `VERIFY_PROPERTIES`
- `VERIFY_TECHNICAL_SETTINGS`

阶段类型是内部枚举，不是公共任意操作接口。

## 8. 输入模型

### 8.1 通用字段

所有对象共享：

- `objectKind`
- `name`
- `description`
- `packageName` 或适配器声明的父对象字段
- `transportRequest`

语言、负责人、主系统等值由当前连接和 SAP 响应派生；只有适配器明确允许时才暴露覆盖字段。

### 8.2 源码型对象

源码必须是完整对象源码，平台保存原始哈希并在写后按对象类型执行比较。默认只容忍换行规范化；函数模块等存在已确认格式化行为的类型使用专用比较器。

### 8.3 数据库表

数据库表优先接受结构化定义，由适配器生成受控 DDL Source：

- 表注解使用受支持字段映射，不接受任意 annotation 注入。
- 字段包含名称、是否 key、类型、长度、小数位、not-null 和说明。
- `CURR` 必须声明 `referenceField`，且引用字段必须是同表币种字段。
- `QUAN` 必须声明 `referenceField`，且引用字段必须是同表单位字段。
- 引用字段必须在被引用数值字段之前或由生成器稳定排序。
- 技术设置使用独立结构：数据类、大小类别、缓冲、存储类型和日志。
- 第一阶段固定安全默认值为透明表、不可扩展、交付类 A、受限数据维护、禁止缓冲、日志关闭；开放项必须经过 describe 明示。

### 8.4 包

第一阶段包创建固定为：

- development package
- encapsulated
- record changes
- 已存在且可传输的父包
- 由 SAP constraints 和 value help 确认的软件组件、传输层和语言版本

不允许通过通用输入创建 main/structure package，也不允许调用方提供任意 package XML。

## 9. 执行与失败语义

### 9.1 正常执行

1. 原生确认后单次消费计划。
2. 重新执行策略、传输、父对象和目标缺失性检查。
3. 按阶段图串行执行。
4. 每个写请求后先记录明确响应，再解析实际资源。
5. 解锁后激活，保持 Eclipse 已验证的顺序。
6. 从 active 或 working area 读取实际状态。
7. 仅在所有声明的验证均通过后标记 `APPLIED`。

### 9.2 未知结果

网络错误、超时或响应解析错误发生在写请求之后时：

- 不自动重试该请求。
- 只读检查预期资源和版本。
- 能证明未发生写入时按普通失败处理。
- 能证明写入成功且所有权明确时可以继续后续阶段。
- 无法证明时标记 `OUTCOME_UNKNOWN`，停止写入和删除，并给出人工检查资源、传输和锁的指引。

### 9.3 补偿

- 仅补偿当前计划明确记录且所有权可证明的已创建资源。
- 按依赖关系逆序执行。
- 对源码或属性写入失败，优先删除新建对象，不把新建对象转换成修改工作流。
- 删除结果不明确时停止，不重试。
- 包含新包时，只有确认包为空且由当前计划创建，才能删除；否则转人工处理。
- 技术设置与表主体作为同一逻辑对象记录，但分别验证激活状态。

## 10. 对象族分期

### Phase 0：能力目录与平台骨架

- 建立 capability matrix、Registry、Adapter、统一 PlanStore、五工具和原生确认。
- 把现有程序、函数组、函数模块接入兼容适配器。
- 保持 `safe` 外部契约不变。

### Phase 1：包与数据库表

- `DEVC/K` 包创建。
- `TABL/DT` 数据库表源码、结构化字段、`CURR`/`QUAN` 引用和技术设置。
- 独立检查、激活、active 读取和补偿验证。

这是第一个实施计划的范围。

### Phase 2：常规源码对象

- 类、接口、程序 Include。
- CDS Data Definition、Access Control、Metadata Extension、Annotation Definition。
- Service Definition、Behavior Definition。

### Phase 3：DDIC 对象族

- Structure、Domain、Data Element、Lock Object、Type Group、Message Class。
- 按对象分别处理源码型和属性型协议，不用一个通用 XML 适配器替代。

### Phase 4：服务、安全与通用对象

- Service Binding、Authorization Field、Authorization Object。
- Number Range、Change Document、SAP Object Type、SAP Object Node Type、Logical External Schema 等 ADT generic object types。

### Phase 5：生成器与复合对象

- RAP/Object Generator discovery、Schema、preview 和 generate。
- 一个生成计划产生多个对象时，记录完整对象图、生成器预览差异和部分成功状态。
- 发布服务等额外副作用不默认合并到创建确认中，必须由单独显式操作处理。

### Phase 6：ADT 3.60.2 完整性收口

- 对照 Eclipse `plugin.xml` 创建适配器、内置 MCP 返回、目标 SAP `CREATE` 候选和 capability matrix。
- 对仍未支持的每个对象给出明确原因：系统不可用、缺少协议、缺少真实 DEV 验证或安全上不宜自动创建。
- 完整目标是“ADT 3.60.2 实际可创建对象有可追踪结论”，而不是把 63 个候选全部盲目开放写入。

## 11. 第一实施切片

第一实施计划只交付 Phase 0 和 Phase 1，避免一次性改造所有对象族。

交付内容：

- 五个新 MCP 工具及 Profile/dispatch 双重门控。
- capability matrix 初版。
- 通用 Registry、Workflow、PlanStore 和原生确认。
- 程序、函数组、函数模块兼容适配器。
- 包适配器。
- 数据库表适配器、受控 DDL 生成器和技术设置子资源。
- 表检查 reporters、表主体与技术设置激活、写后读取验证。
- 未知结果和补偿状态。
- 文档、Schema、审计脱敏和工具目录更新。

第一切片不实现其他 17 个已有静态创建类型，也不开放任意动态 `objectContent`。

## 12. 测试与验证

### 12.1 自动化

- Registry 重复、未知、不可写和系统不可用测试。
- 五工具 Schema、Profile、dispatch 和确认测试。
- 计划 TTL、容量、上下文绑定、单次消费和 payload 清理测试。
- 包 basic/full validation 参数、V2 XML、媒体类型和响应解析契约测试。
- 表 shell、source、checkrun、technical settings、activation 和 read-back 契约测试。
- 表类型生成测试，包括所有允许的内置类型以及 `CURR`/`QUAN` 正反例。
- 每个远端阶段的失败注入、未知结果、不重试和补偿测试。
- 旧三类型工具兼容测试。
- 完整 Jest、TypeScript build、ADT import audit、工具目录计数和 `git diff --check`。

### 12.2 真实 SAP DEV

按风险递增执行：

1. list/describe 和 availability，只读。
2. 包与表 preview，确认零写入。
3. 使用隔离名称创建并验证一个子包。
4. 创建并验证一张包含普通字段的表。
5. 创建或更新隔离测试表，验证 `CURR`/`QUAN` 合法引用。
6. 验证技术设置 active 状态。
7. 注入可控失败并验证补偿或 `OUTCOME_UNKNOWN`。
8. 确认无遗留锁，检查传输内容并清理测试对象。

所有真实写入仍必须经过新平台的原生确认。自动化通过不等于真实 SAP 验证通过。

## 13. 发布与回滚

- 首次发布保持现有 `safe` 工具完全兼容。
- 新工具先进入 `development` 与 `development-workbench`，不进入只读 Profile。
- capability 返回中的成熟度让未验证类型可见但不可写。
- 若新平台出现问题，可从工具注册中移除新五工具，旧 safe 创建工具仍可工作。
- 不删除低层 ADT 客户端实现，不在本阶段修改 npm 包身份或发布流程。

## 14. 验收标准

- 公共 MCP 创建面稳定为五工具，不随对象数量增长。
- `safe` 的现有七工具和返回契约保持不变。
- 新平台只在合法 DEV Profile 中可见和可调度。
- 调用方不能提交任意 URL、XML、媒体类型、锁句柄或确认绕过字段。
- preview 对 SAP 零写入，apply 只消费不可变计划一次。
- 包和数据库表完成创建、检查、激活、active 读取和验证闭环。
- `CURR`/`QUAN` 仅在引用关系完整时通过。
- 写请求结果未知时不重试、不盲删，并留下可查询状态。
- 只有完成真实 DEV 验证的对象返回 `writable=true`。
- 每个 ADT 3.60.2 可创建对象最终都有支持等级和证据结论。
