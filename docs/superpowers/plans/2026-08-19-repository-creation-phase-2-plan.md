# 仓库对象创建平台 Phase 2 实施计划

## 1. 范围

Phase 2 接入十三类常规源码/服务对象。公共 MCP 面仍为五工具；本阶段不开放任意 URL、XML、媒体类型、header、annotation 或 lock handle。

## 2. 初始能力矩阵

| objectKind | ADT 类型 | 已有证据 | 当前等级 | 首要缺口 |
| --- | --- | --- | --- | --- |
| `ABAP_CLASS` | `CLAS/OC` | Eclipse、ADT 3.60.2 JAR、内置 ADT client | `AUTOMATION_VERIFIED` | 真实 DEV 创建、激活、复读和清理 |
| `ABAP_INTERFACE` | `INTF/OI` | Eclipse、ADT 3.60.2 JAR、内置 ADT client | `AUTOMATION_VERIFIED` | 真实 DEV 创建、激活、复读和清理 |
| `PROGRAM_INCLUDE` | `PROG/I` | Eclipse、ADT 3.60.2 JAR、内置 ADT client | `AUTOMATION_VERIFIED` | standalone/parent 语义与真实 DEV 清理 |
| `CDS_DATA_DEFINITION` | `DDLS/DF` | Eclipse、ADT 3.60.2 JAR、内置 client、vscode 参考 | `AUTOMATION_VERIFIED` | 真实 DEV 创建、激活、复读和清理 |
| `CDS_ACCESS_CONTROL` | `DCLS/DL` | Eclipse、ADT 3.60.2 JAR、内置 client、vscode 参考 | `AUTOMATION_VERIFIED` | 真实 DEV 的 STOB 引用、激活和清理 |
| `CDS_METADATA_EXTENSION` | `DDLX/EX` | Eclipse、ADT 3.60.2 JAR、内置 client、vscode 参考 | `AUTOMATION_VERIFIED` | 真实 DEV 的 DDLS 引用、激活和清理 |
| `CDS_ANNOTATION_DEFINITION` | `DDLA/ADF` | Eclipse、ADT 3.60.2 JAR、内置 ADT client | `AUTOMATION_VERIFIED` | 真实 DEV 创建、激活、复读和清理 |
| `SERVICE_DEFINITION` | `SRVD/SRV` | Eclipse、ADT 3.60.2 JAR、内置 client、vscode 参考 | `AUTOMATION_VERIFIED` | 真实 DEV 的 CDS 引用、激活和清理 |
| `BEHAVIOR_DEFINITION` | `BDEF/BDO` | Eclipse、ADT 3.60.2 JAR、vscode 参考 | `AUTOMATION_VERIFIED` | 真实 DEV 的根实体、激活和清理 |
| `CDS_TYPE` | `DRTY/STY` | Eclipse ADT 3.60.2 JAR、通信日志 | `AUTOMATION_VERIFIED` | 真实 DEV 创建、激活、复读和清理 |
| `CDS_ASPECT` | `DRAS/RAS` | Eclipse ADT 3.60.2 JAR、通信日志 | `AUTOMATION_VERIFIED` | 真实 DEV 创建、激活、复读和清理 |
| `CDS_ENTITY_BUFFER` | `DTEB/DF` | Eclipse ADT 3.60.2 JAR、通信日志 | `AUTOMATION_VERIFIED` | 真实 DEV 的 active CDS 引用、激活和清理 |
| `SERVICE_BINDING` | `SRVB/SVB` | Eclipse ADT 3.60.1 JAR、Eclipse 通信日志、vscode 参考 | `AUTOMATION_VERIFIED` | 真实 DEV 创建、配置复读和清理 |
| `DDIC_STRUCTURE` | `TABL/DS` | Eclipse ADT 3.60.2 JAR、ADT discovery 语义、旧客户端参考 | `CONTROLLED_IMPLEMENTED` | 目标系统 discovery、真实 DEV 创建、激活、复读和清理 |
| `DDIC_TYPE_GROUP` | `TYPE/DG` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、通信日志 | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、激活、复读和清理 |
| `DDIC_LOCK_OBJECT` | `ENQU/DL` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、通信日志 | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、复读和清理 |
| `LOGICAL_EXTERNAL_SCHEMA` | `DESD/TYP` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、通信日志 | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、JSON 写入、激活、复读和清理 |
| `NUMBER_RANGE_OBJECT` | `NROB/NRO` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、schema/configuration、现有对象复读 | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、JSON 写入、激活、复读和清理 |
| `SAP_OBJECT_TYPE` | `RONT/ROT` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、schema/configuration/content、validation | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、激活、复读、删除和清理 |
| `SAP_OBJECT_NODE_TYPE` | `NONT/NOT` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、schema/configuration/content、validation、active 示例 | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、引用复核、激活、复读、删除和清理 |
| `CHANGE_DOCUMENT_OBJECT` | `CHDO/CHD` | Eclipse ADT 3.60.2 JAR、目标 DEV discovery、schema/configuration、20 个现有对象复读 | `CONTROLLED_IMPLEMENTED` | 真实 DEV 创建、JSON 写入、激活、生成对象复读和人工清理证据 |

已实现对象均暴露受控输入 Schema，`available=true` 但仍 `writable=false`。公共 Schema 不包含 URL、XML、任意 JSON、媒体类型、header、annotation 或 lock handle；真实 DEV 验证前不会升级为可写。`LOGICAL_EXTERNAL_SCHEMA` 只开放 `defaultRemoteSchemaName` 和 ABAP language version，不开放 `$schema`、source URL 或 `usesRouting`；`NUMBER_RANGE_OBJECT` 只开放评审后的区间、缓冲和类型化引用字段；`SAP_OBJECT_TYPE` 只开放 PascalCase 语义名和六类可读类别，仓库名、类别短码、metadata、base64、XML 与 SAP 生成码全部由受控实现派生；`SAP_OBJECT_NODE_TYPE` 只开放 PascalCase 语义名、大写 RONT 仓库引用和 `rootNode`，RONT URI/CamelCase 语义名及全部 Blue 协议字段由受控实现冻结或派生。

## 3. 实施顺序

### Slice 2A：Class / Interface / Include

1. 从 Eclipse ADT 3.60.2 创建适配器和内置 client 提取自有协议摘要。
2. 对照当前 `objectcreator.ts`、对象 resolver 和 source API，明确 shell XML、source URL、lock、check、activation 与 active read。
3. 为每类建立类型化 ADT 客户端、契约 fixture 和未知结果分类。
4. 使用一个共享受控源码 adapter 编排生命周期，但 Class、Interface、Include 分别固定 validation/collection URL、ADT 类型、根元素、版本化媒体类型和源码形态；不得用调用方提供的通用 XML 适配器替代。
5. 达到 `AUTOMATION_VERIFIED` 后进入真实 DEV 分级验证；当前 Slice 2A 已达到此门，但没有执行真实写入。

### Slice 2B：CDS Definition / DCL / Metadata Extension

先处理依赖最少的 Data Definition，再处理 DCL 和 Metadata Extension。每类必须验证其引用对象存在性、检查 reporter、激活资源和 active source 语义。当前 Slice 2B 已达到 `AUTOMATION_VERIFIED`，但没有执行真实 SAP 写入。

### Slice 2C：Annotation / Service / Behavior Definition

已从 Eclipse ADT 3.60.2 JAR 锁定 DDLA、SRVD 和 BDEF 的 collection、validation、媒体类型和对象模型，并对照内置 client 与 `vscode_abap_remote_fs`。DDLA 使用 `ddic.ddla.v1`，SRVD 使用 `ddic.srvd.v1` 且固定 `sourceType=S`，BDEF 使用 Blue v1。当前只开放 Service Definition 和 Behavior Definition 的定义变体；Service 与 Behavior 都绑定 active CDS 实体，BDEF 还要求仓库名与根实体同名。当前 Slice 2C 已达到 `AUTOMATION_VERIFIED`，但没有执行真实 SAP 写入。

### Slice 2D：Service Binding

使用 Eclipse ADT Service Binding 插件、通信日志和 `vscode_abap_remote_fs` 锁定 `/sap/bc/adt/businessservices/bindings`、目标 discovery 发布的 `application/vnd.sap.adt.businessservices.servicebinding.v2+xml`、V2/V4 及 UI/Web API 类别映射。创建前绑定 active `SRVD/SRV`，创建后执行标准 ADT activation，并从 active 版本复核名称、包、Service Definition、协议版本、类别、`0001` 服务版本、`bindingCreated=true` 和 `published=false`。当前 Slice 2D 已达到 `AUTOMATION_VERIFIED`，但仍需新的真实 DEV 完整生命周期验证。

## 4. 每类对象的升级门

1. `SCHEMA_EXTRACTED`：字段、固定默认值、父对象和依赖明确。
2. `CLIENT_IMPLEMENTED`：类型化 HTTP 方法和契约测试完成。
3. `CONTROLLED_IMPLEMENTED`：preview/apply/status、验证和补偿接入。
4. `AUTOMATION_VERIFIED`：失败注入、全量测试、build、import audit 通过。
5. `REAL_DEV_VERIFIED`：独立确认下完成真实创建、active read 和清理。

抓包只用于消除媒体类型、锁或顺序歧义。Eclipse JAR 和 `vscode_abap_remote_fs` 用于建立候选协议，最终可写结论必须由目标 SAP 的真实 DEV 证据支持。

### 4.1 DDIC Structure 的协议边界

Eclipse ADT 3.60.2 的 `StructureCreationAdapter` 继承 server-driven 创建基类，创建请求的 accepted content type 来自 discovery collection member，而不是插件类中的固定常量。目标系统 discovery 原文显示：`/sap/bc/adt/ddic/structures` 接受 `application/vnd.sap.adt.structures.v2+xml` 和 `text/html`；受控实现只选择非 HTML 的 accepted type，preview 固定该值，apply 重新读取并拒绝协议漂移。当前只生成不含 key、未绑定 CURR/QUAN 引用的结构源，Data Element、Domain 仍没有 Eclipse 创建适配器，也不应仅凭其属性 PUT 接口把它们标成可创建。

### 4.2 Type Group 的协议边界

Type Group 使用 `/sap/bc/adt/ddic/typegroups` 和 `/sap/bc/adt/ddic/typegroups/validation`，目标 DEV discovery 当前接受 `application/vnd.sap.adt.ddic.typegroups.v2+xml` 与 `...v3+xml`。受控实现按 v2、v3 的固定优先顺序选择 discovery 结果，并把 preview 的媒体类型冻结到 apply；校验成功的目标响应可能为空 body，因此空 body 仅在 HTTP 成功时视为通过。Type Group 名称按目标系统限制为最多 5 个字符，创建壳固定为 `TYPE/DG`，源码必须声明对应的 `TYPE-POOL`，随后执行锁定、源码写入、语法检查、解锁、激活和 active source 复读。

### 4.3 Lock Object 的协议边界

Lock Object 使用 `/sap/bc/adt/ddic/lockobjects/sources` 和其 `/validation` collection，目标 DEV discovery 接受 `application/vnd.sap.adt.lockobjects.v1+xml`。创建请求是结构化 `enqu:lockobject` XML，而不是源码对象；受控输入只允许名称、描述、包和一个已存在的主表，`allowRFC=false`、空 `lockMode`、secondary tables、lock parameters 和 lock modules 均由服务端契约固定。创建后以 canonical response identity 和对象读取复核名称、类型及计划归属，不执行 source write 或单独 activation；删除补偿仍须先证明当前计划拥有对象。

### 4.4 Eclipse ADT 3.60.2 创建向导覆盖审计

完整目标不能只按 `creationAdapter` 扩展盘点。对本机 Eclipse ADT 3.60.2 全部插件重新关联 `org.eclipse.ui.newWizards`、`objectTypeInfoUI.newWizardId` 与 `objectTypeInfo.globalWorkbenchType` 后，共得到 142 个已安装 ABAP New Wizard 候选类型，其中仅 28 个声明显式 `creationAdapter`。`DDLA/ADF` 和 `DEVC/K` 都有真实 New Wizard 且当前已受控实现，却没有该扩展，证明 adapter-only 口径会漏报。

2026-08-20 进度：`FUGR/I` 已完成独立受控 objectKind、suffix 派生、函数组父级复核和统一创建工作流接线；其余真实 DEV 生命周期验证仍待执行。

142 个候选类型是“本机产品已安装向导”集合，不等于目标 SAP 一定可用，更不等于允许写入。每个类型仍须逐项通过目标 discovery/feature gate、协议提取、受控适配器、自动化失败验证和真实 DEV 验证。当前 MCP 映射 31 个候选类型，剩余 111 个进入后续路线图；`FUGR/I`、`DTEL/DE`、`DOMA/DD`、`MSAG/N` 和 `TTYP/DA` 已完成独立受控适配器接线，但尚未通过真实 DEV 生命周期验证。

此前因“没有显式 creationAdapter”而排除 `DTEL/DE`、`DOMA/DD`、`TTYP/DA`、`VIEW/DV`、`MSAG/N` 的结论撤销：它们均有已安装 New Wizard；其中 `DTEL/DE`、`DOMA/DD`、`MSAG/N` 已完成受控 adapter 接入，`TTYP/DA`、`VIEW/DV` 继续提取 UI strategy、server-driven schema 或通信协议。DDIC 字段等没有独立 New Wizard 映射的子资源仍不作为顶层候选类型。

冻结证据位于 `docs/evidence/eclipse-adt-3.60.2-creation-wizard-manifest.json`。`npm run check:repository-creation-coverage` 校验清单与当前 31 类能力目录一致；设置 `SAP_ADT_ECLIPSE_PLUGINS` 后运行 `npm run audit:eclipse-adt-creation`，可从本机 JAR 重新验证 142 个 Wizard 候选和 28 个显式 adapter，任何产品升级或插件漂移都会失败。

目标 DEV 的只读 discovery 进一步确认：

- Lock Object 使用 `/sap/bc/adt/ddic/lockobjects/sources`，接受 `application/vnd.sap.adt.lockobjects.v1+xml`；名称校验 collection 是 `/sap/bc/adt/ddic/lockobjects/sources/validation`，属性关系为 `.../enqudl/properties`。
- Type Group 使用 `/sap/bc/adt/ddic/typegroups`，接受 `application/vnd.sap.adt.ddic.typegroups.v2+xml` 和 `...v3+xml`，名称校验 collection 是 `/sap/bc/adt/ddic/typegroups/validation`。
- 两类 collection 当前均未在 discovery templateLinks 中直接声明创建 URL；Eclipse 通过 collection member 的 accepted content types 和 server-driven SFS 创建流程取得协议，不能把属性关系 URL 当作创建 POST 契约。

### 4.5 Table Type 的协议边界

- TTYP 使用 `/sap/bc/adt/ddic/tabletypes`、`/validation` 和 `TTYP/DA`；Eclipse ADT 3.60.2 的创建和属性保存均使用 `application/vnd.sap.adt.tabletype.v1+xml`。
- 创建壳只提交包和身份属性；创建后读取 canonical XML，锁定对象，再用同一份服务器模板只替换受控的 `rowType`、`initialRowCount`、`accessType`、主键定义/类别和二级键 allowed 值。服务器返回的 value-help、Atom links 和其他 SAP 管理字段不会由调用方提交。
- `GET /sap/bc/adt/ddic/codecompletion?path=*&type=abapType` 返回的 37 个目标类型及其 `ddicLengthMin/Max`、`ddicDecimalsMin/Max` 规则在 preview 冻结，在 apply 复核；`CURR` 与 `QUAN` 按目标返回范围接受，不做静态排除。
- 当前受控输入覆盖预定义 ABAP 类型、已捕获的行类型 kind、四种访问类型及 captured key defaults；`keyComponents` 的嵌套 XML 和复杂二级键仍需独立 Eclipse 抓包后开放。属性写入、working-area/active 复读、解锁和激活结果不明确时均进入 `OUTCOME_UNKNOWN`。

### 4.6 CDS Type、Aspect 与 Entity Buffer 的协议边界

- CDS Type 使用 `/sap/bc/adt/ddic/drty/sources`、`/validation` 和 `DRTY/STY`，名称最多 40 个字符；源码必须声明匹配的 `define type <name>: ...`。
- CDS Aspect 使用 `/sap/bc/adt/ddic/dras/sources`、`/validation` 和 `DRAS/RAS`，名称最多 30 个字符；源码必须声明完整的 `define aspect <name> { ... }` 块。
- CDS Entity Buffer 使用 `/sap/bc/adt/ddic/dteb/sources`、`/validation` 和 `DTEB/DF`；创建对象可以与被缓冲实体不同名，但必须提供现有 active CDS 实体的 `referencedObjectName`，并在 apply 时复核其 URI 与 active 状态。
- 三类对象使用 ADT Blue/DTEB XML 壳，随后按统一源码对象生命周期执行锁定、源码写入、语法检查、解锁、激活和 active source 复读；调用方不能提供 XML、媒体类型或 source URL。

### 4.6 Number Range Object 的协议边界

- Number Range Object 使用 `/sap/bc/adt/numberranges/objects`、`/validation`、`/$schema` 和 `NROB/NRO`；名称最多 10 个字符，创建壳为 discovery 明确接受的 `application/vnd.sap.adt.blues.v1+xml`。
- validation 响应必须使用目标系统要求的 `application/vnd.sap.as+xml`，成功结果包含 `CHECK_RESULT=X`；内容 source link 在目标系统中固定为 `application/json`，schema 使用 `application/vnd.sap.adt.serverdriven.schema.v1+json; framework=objectTypes.v1`。
- `numberLengthDomain` 必须保持为 active 的 `CHAR`/`NUMC` Domain 且长度为 1–20；`subType` 若提供则必须保持为 active Data Element，其 Domain 长度为 1–6 且存在检查表；`transactionId` 若提供则必须保持为 active `TRAN/T`。这些 URI 与属性在 preview 冻结并在 apply 串行复核。
- 所有会改变编号行为的字段均显式进入计划：`percentWarning`、`untilYear`、`rolling`、`prefix`、`buffering` 和 `bufferedNumbers`。调用方不能提交 JSON、URL、媒体类型或 lock handle，`prefix=true` 必须同时提供 `subType`。
- apply 使用 Blue v1 壳创建、server-driven source link 解析、锁定、JSON 写入、workingArea 复读、解锁、激活和 active 复读；未知 shell、JSON 写入、unlock 或 activation 结果均不重试、不盲删。

### 4.7 SAP Object Type 的协议边界

- SAP Object Type 使用 `/sap/bc/adt/businessobjects/rontrot`、`/validation` 和三份 `/$new/schema|configuration|content` 资源，ADT 类型固定为 `RONT/ROT`；创建壳必须是 discovery 提供的 `application/vnd.sap.adt.blues.v2+xml`。
- Eclipse ADT 3.60.2 `SapObjectTypeUtil` 会把 PascalCase 语义名转为大写仓库名，把 `name`、类别短码和 metadata 组成 JSON，再以 UTF-8 base64 放入 `blue:additionalCreationProperties/adtcore:content`；内容类型固定为 `application/vnd.sap.adt.serverdriven.content.v1+json`。
- 六类公开类别 `businessObject|technicalObject|analyticalObject|configurationObject|dependentObject|hierarchyObject` 分别映射为 `bo|to|ao|co|do|ho`。调用方不能提供仓库名、短码、metadata、JSON、base64、XML、URL、媒体类型或最长五位的 SAP 生成 `objectTypeCode`。
- preview 冻结 discovery 与三份 `newObjectTypes.v1` 契约；apply 重新核验后执行一次创建 POST，复读 inactive JSON、激活一次，再复读 active metadata/JSON。创建、激活或删除结果未知时不重试、不盲删。
- 目标 DEV 已只读确认 discovery、schema、configuration、初始 content 和 `CHECK_RESULT=X` validation；未执行真实创建、激活、删除或清理，因此保持 `writable=false`。

### 4.8 SAP Object Node Type 的协议边界

- SAP Object Node Type 使用 `/sap/bc/adt/businessobjects/nontnot`、`/validation` 和三份 `/$new/schema|configuration|content` 资源，ADT 类型固定为 `NONT/NOT`，创建壳为 Blue v2，embedded creation content 使用 `newObjectTypes.v1` JSON。
- 公开输入中的 `name` 是 PascalCase 节点语义名，仓库名由其大写形式派生；`sapObjectTypeName` 必须是现有 active `RONT/ROT` 的大写仓库名。preview 会复读 RONT active metadata/JSON，并冻结 URI 与 CamelCase 语义名。
- 创建 JSON 只包含 `name`、大写 RONT 仓库引用、显式 `rootNode` 和派生 metadata。调用方不能提供 RONT URI、CamelCase 语义名、JSON、base64、XML、URL 或媒体类型。
- apply 先重新搜索并复读 RONT 引用，再复核 discovery、三份契约和传输；随后只执行一次创建 POST、inactive JSON 复读、一次激活和 active JSON 复读。active `sapObjectType` 必须与冻结的 RONT 语义名一致；非 root 节点的 `rootNode=false` 可由 SAP 省略。
- SAP validation 强制同一个 RONT 最多只有一个 root node。目标 DEV 仅完成 discovery、schema、configuration、content、validation 与 active 示例的只读核验，未执行真实创建、激活、删除或清理，因此保持 `writable=false`。

### 4.9 Change Document Object 的协议边界

- Change Document Object 使用 `/sap/bc/adt/changedocuments/objects`、`/validation`、`/$schema` 和 `CHDO/CHD`；名称最多 15 个字符，壳为 Blue v1，validation 使用 `application/vnd.sap.as+xml`，内容 source 为 `application/json`。
- schema 支持 `standard|behaviorDefiniton` category、表/结构数组、可选引用表、五个日志布尔字段，以及三位错误消息号；configuration 将表/结构、引用表和消息类分别约束到 `TABL`、`TABL` 和 `MSAG`。
- 对目标系统 20 个 active 对象、59 个表/结构条目做有界只读抽样：canonical JSON 均省略 `category`，错误消息并不固定为 `CD/600`，激活生成对象既有 `*_WRITE_DOCUMENT` Function Module，也有 `CL_*_CHDO` Class。
- 公开类别使用拼写正确的 `standard|behaviorDefinition`，受控实现内部把后者映射为 SAP schema 的 `behaviorDefiniton`；调用方不能提供 `generatedObject`。preview 冻结 Blue v1/objectTypes.v1 契约、包/传输、表/结构、引用表和消息类，apply 使用壳创建、锁定、JSON 写入、workingArea 复读、解锁、一次激活和 active 复读。
- active 内容允许省略 category 与标准语言版本，但必须返回 generatedObject；`standard` 必须解析并复核为 active `FUGR/FF`，`behaviorDefinition` 必须解析并复核为 active `CLAS/OC`。激活尝试前的确定性失败只允许删除当前计划拥有的 inactive CHDO；激活一旦尝试，任何失败或复核不确定性都进入 `OUTCOME_UNKNOWN`，不自动删除 CHDO 或生成对象。
- 当前已注册为 `CONTROLLED_IMPLEMENTED`、`available=true`、`writable=false`。JAR、discovery、schema/configuration 和现有 active 内容均已只读核验；真实 DEV 创建、激活、生成对象验证与清理尚未执行。

## 5. Phase 2 当前结果

- Eclipse ADT 3.60.2 创建目标已从“显式 adapter 清单”纠正为 142 个已安装 New Wizard 候选；当前受控覆盖 31 个、待提取 111 个、`REAL_DEV_VERIFIED` 为 0。该数字是产品候选分母，目标系统可用性仍需逐类核验。
- 已实现五类固定 shell 契约、包身份继承、目标不存在校验、传输复核、服务端 source link 解析、锁定、源码写入、语法检查、解锁、激活和 active 复读；Lock Object 使用独立的结构化创建和对象复读流程。
- Class 创建壳按 Eclipse ADT 3.60.2 JAR 证据固定为 `public`、`final=true`；Class 主源码优先使用 main include 的 `text/plain` link。
- shell/source/unlock/activation 写结果不明确时进入 `OUTCOME_UNKNOWN`，不重试、不补偿；补偿只允许删除当前计划明确拥有的对象。
- DDLS 固定使用 `ddlSource.v2` 契约，DCL 固定使用 `dclSource` 契约；ADT 3.60.2 的 Metadata Extension 创建器使用 Blue 模型和 `ddic.ddlx.v1` 属性媒体类型，不沿用旧客户端的通用 `application/*`。
- DCL 与 Metadata Extension 的 preview 绑定服务端搜索得到的引用资源；apply 会复核 URI 和 active 状态，Metadata Extension 还会拒绝 DDLS extension 类型。调用方不能提供引用 URI、XML 或媒体类型。
- DDLA、SRVD 和 BDEF 使用 ADT 3.60.2 JAR 提取的固定契约；Service 与 Behavior 依赖 active STOB，BDEF extension 不在当前受控输入范围内。
- 未执行真实 SAP 写入；十三类 Phase 2 已实现对象和 `DDIC_STRUCTURE` 继续 `writable=false`，等待独立确认的真实 DEV 验证。
- Type Group 已接入相同的受控 preview/apply 工作流，但尚未执行真实 SAP 写入，继续 `writable=false`，等待独立确认的真实 DEV 验证。
- Lock Object 已接入结构化受控 preview/apply 工作流，但尚未执行真实 SAP 写入，继续 `writable=false`，等待独立确认的真实 DEV 验证。
- Logical External Schema 已接入 `$schema` 冻结、Blue 壳创建、server-driven JSON source 写入、激活和 active 内容复读；尚未执行真实 SAP 写入，继续 `writable=false`，等待独立确认的真实 DEV 验证。
- Number Range Object 已接入 `$schema` 冻结、Blue v1 壳创建、Domain/Data Element/Transaction 依赖冻结、`application/json` source 写入、激活和 active 内容复读；目标 DEV 的 discovery、schema/configuration、validation 与现有对象 canonical JSON 已只读核验，但尚未执行真实创建、激活或清理，继续 `writable=false`。
- SAP Object Type 已接入 Blue v2 壳、三份 `newObjectTypes.v1` 契约冻结、六类类别映射、embedded base64 JSON、inactive/active 内容复读和单次激活；目标 DEV 仅完成只读协议核验，未执行真实创建、激活、删除或清理，继续 `writable=false`。
- SAP Object Node Type 已接入 active RONT 引用冻结与复核、Blue v2 壳、三份 `newObjectTypes.v1` 契约、embedded base64 JSON、inactive/active 内容复读和单次激活；目标 DEV 仅完成只读协议核验，未执行真实创建、激活、删除或清理，继续 `writable=false`。
- Change Document Object 已接入 Blue v1/objectTypes.v1 契约冻结、表/结构/引用表/消息类复核、JSON 写入、workingArea 复读、单次激活和生成 `FUGR/FF|CLAS/OC` 复核；激活后的任何不确定结果都禁止自动删除。目标 DEV 仅完成只读协议核验，未执行真实创建、激活或清理，继续 `writable=false`。
- CDS Type、CDS Aspect 和 CDS Entity Buffer 已接入共享源码适配器；Entity Buffer 的仓库名与被缓冲 CDS 实体名允许不同，引用对象由计划冻结并在 apply 时复核。三类尚未执行真实 SAP 写入，继续 `writable=false`，等待独立确认的真实 DEV 验证。
