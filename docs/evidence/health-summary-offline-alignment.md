# Health 聚合查询离线收编（analysis.history 行 health 子操作）

日期：2026-10-04。基线：`main` @ `85c641c`（含本轮未提交改动）。范围：聚合层逐行移植 + 采集层组合既有已验证原语 + 离线 mock 全绿；**未连接 SAP**（四信号源各自已有真机验证证据，health 组合层待真机端到端）。

## 交付

- `src/adt/HealthApi.ts`：verdict 聚合（summarizeHealth/incompleteSignalNames/healthNotes）+ 四信号采集器（依赖注入 `HealthCapability`，可离线单测）。
- `src/handlers/HealthHandlers.ts`：单工具 `analyzeHealth`（包级或对象级）。
- 门控：advanced-mutation（tests 信号**真正执行单测**，与 runUnitCoverage 同级）；catalog 仅 development-workbench 显式收录 + legacy-full 组合面，不给 development 组合面与 diagnostic-readonly（对齐 runUnitCoverage 纪律）。
- 测试：`HealthApi.test.ts` 12 用例；全量门禁 186 suites / 2051 tests、`npm run build`、矩阵校验通过。

## 移植对照（VSP internal/mcp/handlers_health.go @9886d272，573 行）

| 部分 | VSP | 本项目 |
| --- | --- | --- |
| tests（对象级） | RunUnitTests → classes/methods/alerts（0 类 NONE / 有告警 FAIL） | runUnitTest（主会话）→ summarizeUnitTests |
| tests（包级） | GetPackage + IsTestCaller 过滤，限 5 逐类跑；跑不动的进 missed | TADIR 枚举 CLAS + isTestCaller 名字启发式（TEST/LCL_TEST/LTH_），限 5 逐类跑；跑不动进 unsearched |
| atc | RunATCCheck（对象 100 / 包 200）→ summarizeATC（priority 1/2/其余） | createAtcRun + atcWorklists，同 maxResults 口径与 priority 分级 |
| boundaries | 图引擎 CheckBoundaries（对象级单对象源码 + 包级限 30） | **包级**复用 checkPackageBoundaries（已真机验证，analyzedObjects/violations/crossedPackages/violatingObjects + notes 上提）；**对象级不产出**（无单对象裁定器，如实 UNKNOWN + note 指向包级工具） |
| staleness | GetRevisions 最新日期；>365 天 STALE、>90 天 AGING；包级限 10 取最大 | revisions 同阈值；读不到历史的对象进 unsearched（日期取最大会因此偏旧） |
| verdict | FAIL→BAD、VIOLATIONS/FINDINGS/STALE→WARN、有缺口→UNKNOWN、否则 GOOD | 逐行 port |
| notes | 信号缺口提升到顶层（ERROR 信号文案"this check failed, so it is not evidence of health"） | 逐行 port |

## 防缺陷语义（VSP 测试用例 pin 的坑，单测逐条锁定）

1. **"没查到问题"≠"查过没问题"**：任何信号带 unsearched/note/ERROR 时 verdict 不得报 GOOD，只能 UNKNOWN 并点名缺口（incomplete 语义）。VSP 注释原文：健康报告是整个代码库里最不能吞失败的地方——没跑成的检查回来像"查过没问题"，对象就凭没人问出的问题宣判健康。
2. **跑失败的测试不是 PASS**：包级测试类执行失败记 ERROR/unsearched，不静默跳过（跳过=无告警=外面看着像全绿）。
3. **零扫描边界不判 CLEAN**：analyzedObjects=0 的包边界降为 UNKNOWN（VSP：只含子包的包曾报"CLEAN, 0 violations"）。

## 与 VSP 的边界差异（如实声明）

- 对象级 boundaries 信号不产出（VSP 走图引擎单对象裁定；本项目单对象裁定器无对等实现）。
- 包级测试类发现用对象名启发式，不含 VSP includeType（CCAU/TESTCLASSES）通道。
- 包级 tests 未复刻 VSP"全没跑成时从 PASS 降 UNKNOWN"之外的额外分支（本项目 ran=0 → UNKNOWN，同语义）。

## 真机取证（2026-10-05，sap-demo 10.30.254.48:8001/300，所有者授权）

目标：ZCL_MCP_SM21_ADT_HTTP（包 Z001），用现有 MCP 工具逐信号源取证，核对真机返回形态与 HealthCapability 消费契约的一致性：

| 信号 | 工具 | 结果 | 契约核对 |
| --- | --- | --- | --- |
| tests | RunUnitTests（sap-adt） | `{"classes": []}` | summarizeUnitTests→classes=0→NONE 语义正确；UnitTestClass 形态匹配 |
| atc | RunATCCheck（sap-adt）/ createAtcRun+atcWorklists（直连） | MCP 面两次 30s 客户端超时；**直连端到端实测 ATC 运行 262 秒**（22 findings：0 errors/0 warnings/22 infos→FINDINGS） | 超时根因即 ATC 运行时长本身；MCP 面复验需 `mcp.servers.timeoutMs` ≥300s 并重启客户端。直连端到端已完整验证 FINDINGS 信号与 summarizeATC 契约 |
| boundaries | checkPackageBoundaries（sap-demo） | 完整报告：analyzedObjects=10、violations=0、crossedPackages={}、violatingObjects=[]、notes 2 条 | 字段与 HealthCapability 契约一致；notes 非空→signal.note 上提→verdict 停 UNKNOWN，partial 传播正确 |
| staleness | revisions（sap-demo） | 1 条（2026-08-13，S4HK900011） | date 形态匹配；约 53 天→ACTIVE（90 天阈值内） |
| 包对象枚举 | checkPackageBoundaries 内部 SQL | 同款 `IN ('PROG','CLAS','INTF')` TADIR 查询真机成功（analyzedObjects=10） | listPackageObjects 的 IN 形态 SQL 在 ADT 客户端通道成立 |

附带发现（不涉 analyzeHealth 实现）：MCP `runQuery` 工具的 datapreview 通道对 `IN (...)` 列表 SQL 返回内部错误（单值 `=` 正常）；analyzeHealth 走 ADT 客户端 runQuery 通道（statelessClone），与 checkPackageBoundaries 同源，不受影响。datapreview 的 SQL 形态缺陷族此前已有先例（WHERE+ORDER BY，tbtco/tbtcp）。

## 直连端到端（2026-10-05，dist 直连真机，绕过 MCP 客户端超时）

对象级 `analyzeHealth(CLAS, ZCL_MCP_SM21_ADT_HTTP)` 完整执行成功（262.7 秒，大头为 ATC 运行）：

- verdict：`WARN "ATC findings detected"`（ATC 22 findings 优先表达实际发现；boundaries 缺口在 notes 顶层可见——与 VSP summarizeHealth 的优先级顺序一致）。
- tests=NONE（0 测试类）、atc=FINDINGS（0E/0W/22I）、boundaries=UNKNOWN（note 如实指向包级工具）、staleness=ACTIVE（53 天）。
- ATC 采集链（createAtcRun 空变体→worklist id→atcWorklists→summarizeATC 按 priority 分级）真机形态与契约逐项吻合。

**附带修复（真机缺陷 8）**：`isAdtNotFound` 真机形态失配——ADT 对不存在应用 404 造出的 AdtErrorException 把状态码放在 `err` 字段（status getter 不读它），且 message 为登录语言本地化文本（中文"应用程序 X 不存在"）。修复后三通道判定（err/status→父链→多语言词表），previewUi5Operation 全链路直连验证通过：create_app 对不存在应用正确冻结 plan（oldState.appExists=false）、delete_app 对不存在应用结构化 OBJECT_NOT_FOUND（fail-closed）。MCP 面此前对 Z001 的 Internal server error 即此缺陷（handler 吞了底层 message），已修复。

**包级端到端 `analyzeHealth(package=Z001)` 同日完成（211.9 秒）**：

- verdict `WARN "ATC findings detected"`；tests=PASS（candidates=2，ran=2——TADIR 枚举 + isTestCaller 真机发现 2 个测试类并实际执行，0 告警）；atc=FINDINGS（41E/37W/84I=162，包级 maxResults=200）；boundaries=CLEAN（analyzed_objects=30，objectLimit 上限生效，边界说明 notes 上提）；staleness=ACTIVE（1 天，checked=3）。
- **unsearched 防线在真实脏数据上生效**：Z001 内 7 个 `ZCL_AMDP_DBG_*` 为此前战役的 TADIR 孤儿（对象已删登记未清），revisions 对其 404——7 条 unsearched 逐条记录（"Resource CLASS ... does not exist"），note 如实声明 "read 3 of 10 listed objects; unread histories make the newest change older than reality"。
- **附带修复（真机缺陷 9）**：包级 tests 信号在 ran>0 且 totalClasses=0 时应报 NONE（跑了但没执行任何测试=没有测试），对齐 VSP handlers_health.go 的 PASS→NONE→FAIL 优先级；此前实现报 PASS。已修（真机形态单测锁定）。

**MCP 工具面复验（2026-10-05，客户端重启加载修复后）**：

- `analyzeHealth(CLAS, ZCL_MCP_SM21_ADT_HTTP)` 调用链完整（未被客户端 30s 杀死、返回结构完整）；四信号全 60s ERROR——根因（缺陷 10）：guardrails 的 per-request 60s 超时 + 四采集器并发共享同一 stateful 会话（SAP 同会话排队处理），262s 的 ATC 把快信号拖死。防线语义正确兜底：verdict=UNKNOWN、notes 逐信号点名 "this check failed, so it is not evidence of health"。
- **附带修复（缺陷 10）**：health 内部四采集器改顺序执行——慢信号只拖总时长、不再误伤快信号（直连端到端为并发但无 per-request 超时故能跑通；串行化在两种通道下均正确）。

## 验证状态

- **自动化（已完成）**：verdict 语义、缺口阻断、阈值、汇总计数、采集器行为（限 5/限 10、unsearched 传播、空扫描防线、串行化顺序）13 用例全绿；catalog 基线同步（development=201、workbench=172、legacy-full=210）。
- **真机（对象级+包级端到端均已完成，直连通道）**：四信号双 scope 端到端全通（ATC 262s/211.9s 实测）。MCP 工具面复验：analyzeHealth 调用链完整、防线语义正确兜底（缺陷 10 已修，串行后快信号不再被拖死；ATC 在默认 60s per-request 超时下仍为 ERROR，需 timeoutMs≥300s 才能全绿）。analysis.history 行的 health 子操作真机取证完成，行整体维持 PARTIAL（图引擎全量语义与 E070A CR 分组仍缺）。
