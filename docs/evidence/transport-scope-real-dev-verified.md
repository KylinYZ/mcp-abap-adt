# getTransportScope 组合链真机验证（成员采集 + 加载边界）

日期：2026-09-25。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。只读 SQL（E070/E071/D010INC datapreview），无写操作、无传输修改。

## 验证脚本

`npm run test:transport-scope-real-dev`（`scripts/transport-scope-real-dev-smoke.mjs`），目标：历史验证传输任务 S4HK900010（父请求 S4HK900009）。

## 结果：SMOKE OK

```text
PASS getTransportScope 在 focused catalog
PASS 成员采集：父请求归并正确、194 个 R3TR 成员、status=partial
INFO graph: nodes=195 edges=194 (LOADS=0)
INFO analysis: totalDeps=0 … deploymentReady=false
INFO skipped=189 (dependency-query-limit: 78) dependencyQueryCount=5 status=partial
PASS 组合边界：成员+LOADS 出边+分类闭环（partial 正确传播，恒等关系成立）
PASS 负例 A：未知传输 → partial + unresolved 记录（不抛错）
PASS 负例 B：非法传输 ID → InvalidParams
SMOKE OK
```

补充定向验证：`buildLoadDependencyGraph` 对真实类 `ZCL_MCP_SM21_ADT_HTTP` 读回 **26 条 LOADS 边**（`CLAS:… -> CLAS:CL_ABAP_DATADESCR` 等，D010INC 真数据），证明依赖边采集在真机真实产生；组合链 LOADS=0 是该传输成员构成（BDEF/CHDO/TABL 为主）与查询预算的真实结果，partial 如实传播。

## 真机抓到并修复的缺陷

**NULL 列被解析为 undefined 导致顶层请求头被拒（采集链空转）**：

- 现象：`getTransportScope({transports:['S4HK900010']})` 返回空成员，issues 报 `parent-headers: invalid-or-out-of-scope-header + unresolved:S4HK900009`——离线 fixtures（STRKORR 空串）全绿，真机必现。
- 根因：SAP datapreview 对 NULL 列不输出 `<data>` 元素；`parseQueryResponse` 按 columns 补键后该单元格为 **undefined**（JSON 序列化时被省略，表现为"缺键"假象）。`cell()` 只接受字符串 → 顶层请求头（STRKORR 本应为空）被判为异常数据。
- 修复：`cell()` 把 undefined/null/键缺失统一归一化为空串（合法空值语义）；仅多同名键（歧义）与非字符串非空值仍视为异常。真机数据形态已用原生 `runQuery` 双模式（decode/raw）逐一取证。
- 回归：新增 undefined-STRKORR 用例；修正旧用例"缺 STRKORR 键=异常"的过时假设（该形态在真机即顶层请求语义）。

## 边界与安全常量复核

- `deploymentReadinessVerified=false`、`systemWideComplete=false` 恒成立（smoke 断言）。
- 恒等关系 `totalDependencies = inScope + missingCustom + unknownNamespace + dynamic + standardCandidates` 真机成立。
- `partial` 三来源（成员 non-r3tr-unresolved、LIMU 不映射、依赖查询预算截断）真机均如实传播。
- 排障全程未创建/释放传输、未触碰 E071/E071K 写面。

## 门禁

- `npm test -- --runInBand`：168 suites / 1766 tests 全绿（含新增 2 个真机形态回归用例）
- `npm run build`、`npm run check:repository-creation-coverage`、`npm run check:vsp-capability-parity`、`git diff --check` 通过

## 剩余缺口（维持 PARTIAL 的原因）

- 结构依赖边仍是 **D010INC LOADS 单一口径**（非 CALLS/REFERENCES 全集）；
- WBCROSSGT/CROSS 出边采集、E070A CR 分组、动态调用解析仍未实现；
- 排障期间遗留对象：无（S4HK900009 为既有传输，仅只读访问）。

## 后续证据更正（2026-09-28）

上面的“剩余缺口”记录早于 cross-reference 结构边接线，现已过时。2026-09-25 的专门只读 DEV 证据
[`transport-crossref-real-dev-verified.md`](transport-crossref-real-dev-verified.md) 验证了 WBCROSSGT/CROSS 出边采集及 LOADS + REFERENCES/CALLS 组合 TR 边界链；因此不能再将“WBCROSSGT/CROSS 出边采集未实现”当作当前结论。

该后续证据只覆盖特定 DEV 样本和有界读取，不宣称 CR 分组、动态图解析、包归属完整、系统级图引擎等价或全系统完整性。`analysis.history` 仍为 `PARTIAL`（54/71）；逐项缺口见 [`analysis-history-gap-audit.md`](analysis-history-gap-audit.md)。本更正不改变原验证日期、样本或原始 smoke 结果。
