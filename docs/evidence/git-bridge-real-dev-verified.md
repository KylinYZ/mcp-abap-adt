# git.abapgit 桥链路真机验证——部署补全与真实导出（2026-10-07）

- 系统：sap-dev（10.30.255.42:8000，client 200，用户 HP068157）——本轮所有者授权 sap-dev
- smoke：`scripts/git-bridge-real-dev-smoke.mjs`（`npm run test:git-bridge-real-dev`）——**SMOKE OK**
- 结论：桥链路真机全通 + **abapGit 部署补全（233 对象 + zabapgit 表）+ 真实 ZIP 导出核对通过**——git.abapgit 晋级 **EQUIVALENT**（VSP 对齐 57/71）

## 本轮修复

### 客户端（GitBridgeApi/GitBridgeHandlers）

1. **data JSON 字符串契约**：SAP 侧 `build_json_response` 的 data 是 JSON **字符串**，客户端首版当对象解析 → 成功但全空（mock 假服务端与真机契约脱节——message-text 轮同款教训第三次）。修为双形态兼容 + 真机字符串契约用例。
2. **skipped/errors 字段透出**：get_types 的 skipped（异常跳过计数）与 export 的 errors（逐对象诊断）映射进结果。
3. **错误语义映射**：GitBridgeError VALIDATION_FAILED → InvalidParams；其余 InternalError。
4. APCHandler 原始响应键：`{id, success, data|error:{code,message}}`。

### SAP 侧（ZCL_VSP_GIT_SERVICE，经 ADT 锁改激活，原源码备份 `docs/evidence/sap-dev-backups/`）

1. **handle_get_types 容错**：上游 `supported_list()` 逐类型做序列化器支持性检查且不接 CX_ROOT——本系统 INTF 的 AFF 检查抛 `CX_SY_DYNAMIC_OSQL_SEMANTICS` 拖死整个清单（bc298fb 遗留）。改为复刻其循环（TR_OBJECT_TABLE → R3TR 过滤）逐类型 TRY，单类型异常只跳过并计数，响应带 `skipped`。
2. **serialize_objects 错误收集**：CATCH 扩 cx_root（动态异常非 zcx_abapgit_exception 子类）且逐对象错误（对象+异常文本）随响应 `errors` 透出——原静默 CONTINUE 让 fileCount=0 无法定位。
3. 细节：ty_object_types 是 HASHED TABLE（APPEND 非法，须 INSERT INTO TABLE）。

写链要点（sap-dev ADT）：裸 fetch 会话上下文导致 PUT 423 invalid lock handle（锁属主绑定会话）——**必须用项目 ADTClient 直连模式**（login → stateful → lock → setObjectSource → unLock → activate，usage-examples 轮验证过的模式）；CSRF 头必须带（403）。

## 真机结果（SMOKE OK）

| 场景 | 结果 |
| --- | --- |
| gitTypes | count=1、skipped=1（CLAS 在列、INTF 异常跳过如实）——不再被 CX_SY_DYNAMIC_OSQL_SEMANTICS 拖死 |
| gitExport $ZADT_VSP | objectCount=13、fileCount=0、**errors 13 条逐对象**：10 个代码对象（CLAS/INTF）全为 CX_SY_DYNAMIC_OSQL_SEMANTICS（部署缺口）、3 个非代码对象（SAPC/SUSH/SICF）为序列化器不支持的正常忽略 |
| 负例（空 packages） | schema minItems:1 / VALIDATION_FAILED 双防线拒绝 |

## 剩余唯一阻塞：abapGit 部署完整性（精确定位）

- sap-dev 实装 **360/593** 对象（abapGit v1.134 全量，源码对象集本地解析），缺 **233**：CLAS 205、INTF 15、PROG 3、W3MI 7、FUGR/DEVC/TRAN 各 1——含 **182 个序列化器类**（ZCL_ABAPGIT_OBJECT_*，实装仅 14 个）与依赖表。
- executeAbap 逐步逼近定位：exists 检查正常 → serialize 直接复现 `SAPSQL_PARSE_ERROR: 数据库表 'ZABAPGIT' 未知`——动态 SQL 引用缺失依赖表/类。
- **补部署清单已生成**：`docs/evidence/sap-dev-backups/abapgit-deploy-missing.json`（全部 233 条 type+name，供部署脚本消费）。
- 该缺口同样影响 VSP 在同系统的 export（同库同协议）——非本项目链路缺陷。

## 自动化基线

191 suites / 2116 tests 全绿（GitBridgeApi 11 例：data 字符串契约/skipped/errors 映射/错误语义/RFC6455 向量）；build、coverage（28）、parity、git diff --check 全绿。catalog 计数不变（bc298fb 已收编两工具）。

## 部署补全与真实导出（同日三轮迭代）

1. **部署引擎**：`scripts/deploy-abapgit-missing.mjs`——缺失清单 × v1.134.0 本地源码（extracted/ 与实装同源，版本常量核对 1.134.0）：逐对象 createObject（CLAS/OC、INTF/**OI**——首版 INTF/OC 报 Unsupported object type）→ lock → PUT source/main → unLock；激活收敛循环（preauditRequested=true，依赖未激活的失败下一轮重试，无进展即停）。
2. **结果**：created 203+20（INTF 补创建）、written 223、activated 210；**zabapgit 表新建**（TADIR 孤儿条目实体缺失——createObject(TABL/DT) 建 shell + DDLS 表源（关键字字段名 "type"/"value" 带引号、sizeCategory 注释为整数非 #枚举，经 checkrun API 迭代至 0 错误）→ 激活 OK）。
3. **真实导出**：gitExport $ZADT_VSP → **13 对象、23 文件、38KB ZIP、errors=0**；ZIP 解包核对 24 条目（9 个 .clas.abap）含可读 ABAP 类定义、testzip 无损。gitTypes 158 类型支持（**INTF 恢复支持**，部署前被 AFF 检查异常跳过）、skipped=0。
4. **最终 SMOKE**：`npm run test:git-bridge-real-dev` 全场景 PASS（catalog/类型清单/真实导出/负例/ZIP 内容核对）。

## 遗留如实记录

- **13 个 AFF 序列化器 inactive**（ZCL_ABAPGIT_OBJECT_DOMA/DTEL/TABL/PROG/FUGR/FUGS/PINF/PDTS、ECATT 族已激活后余 MIGRATIONS/GUI_PAGE_TEMPLATE/OBJECTS_CI_TESTS/PERSIST_MIGRATE/AFF_PROG_V1）：依赖 locals include（LCL_AFF_METADATA_HANDLER 局部类），该 ADT 版本拒绝创建 locals_def/locals_imp include（"wrong input data for processing"）。影响：AFF 框架类型对象的导出；$ZADT_VSP 等常规包不受影响（已证）。解除：Eclipse/abapGit 桌面端补写 locals include 或上游 ADT 版本修复。
- **W3MI×7 / FUGR ZABAPGIT_PARALLEL / TRAN ZABAPGIT / DEVC PACKAGE** 未部署：MIME 图标/函数组/事务码非 ABAP CLAS/INTF 面，序列化链不依赖。
- SAP 侧 files[].bytes（size 字段）恒 0（ZCL_VSP_GIT_SERVICE files JSON 的 size 拼接时机），ZIP 实际内容完整——小瑕疵留档。
- sap-dev 系统残留：$ABAPGIT 包补部署的 223 对象 + zabapgit 表（abapGit 工程资产延续，所有者授权轮部署动作）。

## 自动化基线

191 suites / 2116 tests 全绿；build、coverage（28）、parity（71 行，**57/71**）、git diff --check 全绿。
