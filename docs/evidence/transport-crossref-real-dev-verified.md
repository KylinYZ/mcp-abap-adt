# getTransportScope crossref 结构边界真机验证

日期：2026-09-25。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。只读 SQL（E070/E071/WBCROSSGT/CROSS/D010INC datapreview），无写操作。

## 交付

`getTransportScope` 新增 `includeCrossRefBoundaries` 开关（与 `includeLoadBoundaries` 并列，至少一个为 true）：对传输范围内每个代码承载成员（CLAS/INTF/PROG/FUGR）采集 **WBCROSSGT/CROSS 出向结构边**（REFERENCES/CALLS 口径，对齐 VSP tr_boundaries 的边源），与 LOADS 源互补后统一进入边界分类器。行语义对齐 CrossReferenceApi（getCallees 真机验证过的同一读取口径）：WBCROSSGT 只留 DIRECT='X' 行（INDIRECT 是类型引用噪声）、CROSS 的 PERFORM 行 NAME/PROG 交换、组件段（`\ME:…`）合并为对象级边、兄弟池归属过滤、目标身份按成员名称集精确匹配（唯一类型）否则落 UNKNOWN 类型节点交由 Z/Y 启发式分类。脚本：`npm run test:transport-crossref-real-dev`。

## 真机结果：SMOKE OK

```text
INFO crossref 组合（S4HK900012）：structEdges=1
  sample=[{"from":"FUGR:ZMCP_TOOLS","to":"UNKNOWN:S_ADMI_FCD","kind":"CALLS","source":"CROSS"}]
INFO summary={"totalDependencies":1,…,"standardCandidates":1}
PASS crossref 组合链决定性正例：1 条结构边（含 CALLS→standardCandidates），恒等关系成立
PASS 同源对照：getCallees 在同一交叉表上读到 21 条引用（数据源真实可读）
PASS 双源组合：LOADS 与 REFERENCES/CALLS 边共存
PASS 负例：双开关 false → InvalidParams
SMOKE OK
```

决定性正例说明：S4HK900012（ZMCP_TOOLS 函数组所在传输）的 `LZMCP_TOOLS` 在 CROSS 有裸 SQL 取证的 DIRECT 行（NAME=S_ADMI_FCD）；组合链端到端产出 `FUGR:ZMCP_TOOLS → UNKNOWN:S_ADMI_FCD | CALLS | CROSS`，目标非成员且非 Z/Y → 正确分类 standardCandidates，summary 恒等关系成立，安全常量（deploymentReadinessVerified/systemWideComplete=false）不放宽。双源组合（S4HK900010，194 成员）因预算约束仅覆盖前 2 个成员（partial 如实传播），结构边 0 为该切片的真实结果。

## 环境事实（本轮取证）

- WBCROSSGT 真机行形态：INCLUDE 池名存在**无填充截断形态**（如 `ZCL_ABAPGIT_ABAP_LANGUAGE_VERSCCAU`——名长截断后直接拼段后缀），归属过滤按"精确/= 填充/L 前缀"规则正确处理了兄弟池误匹配；NAME 多段反斜杠（`类\组件\子组件`）主段剥离正确。
- S4HK900010 的自有验证类/程序在 WBCROSSGT 无 DIRECT 行（极简验证代码无跨对象命名引用，且部分对象 inactive 不生成交叉行）——组合链在该传输结构边 0 是真实结果。
- **datapreview 按会话查询预算（约 19 次）耗尽后 E070/E071 读取静默失败成空成员**——多段重查询的 smoke 必须按段拆独立 MCP 会话，并对"成员为空"做显式断言（不能把预算耗尽误读为无成员）。
- 排障坑复刻：bash heredoc 写 mock 数据时 `\\` 被吃成 `\` 再被 JS 宽容转义，伪造出 `unsupported-target-identity` 假象——mock 数据含反斜杠时必须用 Write 工具写文件（heredoc 转义地狱第三次踩坑）。

## 门禁

- `npm test -- --runInBand`：168 suites / 1771 tests 全绿（新增 6 个 crossref 用例：组件剥离/噪声与归属过滤/双源共存/失败跳过/同名歧义/双 false 拒绝）
- `npm run build`、`npm run check:repository-creation-coverage`、`npm run check:vsp-capability-parity`、`git diff --check` 通过

## 剩余缺口（analysis.history 维持 PARTIAL 的原因）

- CR（变更请求）级边界需要 E070A CR 分组（该服务器未配置）；
- 动态调用解析（DYNAMIC_CALL 边）与包归属元数据未实现；
- impact/health/graph_stats 仍是 VSP 图引擎轮范围。
