# sap-dev 全功能真机实测战役（2026-10-04，所有者授权）

- 目标系统：专用 DEV sap-dev（`10.30.255.42:8000`，client 200，用户 HP068157，focused profile 168 工具）
- 方式：三批扫描（只读面 106 项 → 修复第二遍 → 受控写入链 27 项）+ AMDP 专项（另行证据）
- harness：`scripts/dev-campaign-read-sweep.mjs`、`scripts/dev-campaign-write-sweep.mjs`（可复跑）
- 部署注入（进程级，未改 env 文件）：`SAP_MCP_CONFIRMATION_MODE=auto`、
  `SAP_MCP_REAL_DEV_VALIDATION=false`、`SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT=S4DK900109`、`RFC_SYSNR=00`

## 总览

| 批次 | 项数 | 通过 | 定性结论 |
| --- | --- | --- | --- |
| 只读面（B1 无参发现 + B2 对象模板 + status 错误语义） | 106+19 修复遍 | 96 通过（65+14+11+6） | 6 真缺陷/限制（见下） |
| 受控写入链 | 27 | 18 | 5 定性（2 真问题 + 2 响应丢失 + 1 写读不对称） |
| AMDP 专项（另行证据 `amdp-debugger-workflow-real-dev-verified.md`） | 6 操作 | 主工作流双系统全绿 | 命中递交系统性缺失 |
| 传输创建链 | 1 | PASS（S4DK900109 新建） | S4HK900009 已废的替代 |

## 真缺陷清单（本轮实测定性，待修复立项）

| # | 工具 | 症状 | 定性 |
| --- | --- | --- | --- |
| 1 | `getObjectSource` | 对 Z 类报 "Cannot read properties of undefined (reading 'match')" | 处理器崩溃（同族：响应缺结构时） |
| 2 | `classIncludes` | "clas.includes is not iterable" | 同族崩溃（includes 缺失路径） |
| 3 | `unitTestEvaluation` | 无测试类时 "Cannot read properties of undefined (reading 'map')" | 同族崩溃 |
| 4 | `previewDdicPropertyChange` | 无 metaData 校验器要求 metaData；带 metaData 后 Internal server error（-32603 无细节） | metaData 处理路径崩溃 |
| 5 | `applyDescriptionChange` | sap-dev 上 UNKNOWN_OUTCOME 且**读回证实未落地**（描述未变） | 执行未生效（区别于克隆/重命名的响应丢失） |
| 6 | 文本池写读对称性 | `applyTextPoolChange` symbols 写入 success，读回（含 category=symbols）只见 listHeader/columnHeader 条目 | 读回通路/工具 category 透传存疑 |
| 7 | `listJobs` | "listJobs failed." 无细节（sap-dev TBTCO 查询失败） | 错误信息不透明（吞细节） |

## 响应丢失族（操作已落地、响应超时丢失；链按 UNKNOWN 红线安全停止，读回证实）

- `applyCloneObject` / `applyControlledRename`：UNKNOWN 后读回证实目标对象存在/改名成功
  （重命名产物清理链 PASS 侧证）。sap-dev 响应慢于 sap-demo，多调用链的收尾响应易超时——
  **建议**：受控链的执行阶段超时对慢系统可配置化（当前 20s 量级）。
- 主工作流 smoke 的 terminate 首试超时、150s 重试成功的恢复路径每轮稳定复现。

## 环境/形态限制（NA，非缺陷）

- `sm21Read`：sap-dev 的 ADT SM21 SICF 服务未开放（工具如实报告并指引 SICF）。
- `debuggerListeners`：需真实存在调试监听器（无监听器时服务端异常形态）。
- `fragmentMappings` / `mainPrograms`：对类 include 形态不适用（404/invalid mapping）。
- `packageSearchHelp`：系统 404（资源未发布）。
- `atcWorklists`：需真实 ATC runResultId（未在本轮制造运行）。
- `RAP generate/preview`：需 RAP 就绪数据模型（只读探针 rapGenIsAvailable PASS）。
- `debug.authorize/execute/variableChange`：需真实挂起 debuggee（AMDP 专项已覆盖）。
- CDS 三件套：searchObject 未发现系统 CDS 源（两轮命名模式未命中）。
- 标准对象策略拦截（设计行为）：`inspectAbapObject` 对 CL_ABAP_TYPEDESCR 报
  POLICY_DENIED——专家白名单语义正确；Z 对象全部 PASS。

## 部署发现（sap-dev 运维建议）

1. **RFC_SYSNR=00**：实例号非缺省 '01'（HTTP 8000 对应实例 00）——RFC 三件套
   （callRfm/describeRfm/readRfcTable）注入后全 PASS。建议写入 `sap-dev.env`。
2. `S4HK900009` 传输已废；本轮经受控传输创建链新建 `S4DK900109` 作为 sap-dev 验证传输。
3. `SAP_MCP_REAL_DEV_VALIDATION=true` 会拒绝已达 REAL_DEV_VERIFIED 成熟度对象的
   validation 计划（ABAP_CLASS 实测被拒）——复验战役需进程注入 validation=false。
4. smoke 双脚本已参数化（env 路径入参/前缀推导/传输与确认模式注入），任意系统一条命令复验。

## 结论

- focused 入口 168 工具中，本轮直接实测 133 项（只读 106 + 写入链 27），加上
  AMDP 专项与历史真机证据（创建矩阵 31 类、传输链、文本池等），**功能面真机
  覆盖完成**；7 项真缺陷/问题定性待修复立项，8 项环境/形态限制如实记录。
- 全部结果 JSON：`dev-campaign-read-results.json`、`dev-campaign-second-results.json`、
  `dev-campaign-write-results.json`（战役目录留存）。
