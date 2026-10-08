# cluster_read + impact 收编真机验证（2026-10-07）

- 系统：sap-demo（10.30.254.48:8001，client 300，DEV 角色）；全程只读 SELECT
- smoke：`scripts/cluster-impact-real-dev-smoke.mjs`（`npm run test:cluster-impact-real-dev`）——**SMOKE OK**
- 结论：`diagnostics.knowledge-queries`（cluster_read 收编）与 `analysis.history`（impact 收编）双双晋级 **EQUIVALENT**——VSP 对齐 **59/71**（MCP_SUPERSET=13、EQUIVALENT=46、PARTIAL=1、RESTRICTION=11）

## cluster_read：readClusterTable（knowledge-queries 第五工具）

VSP `pkg/adt/cluster.go` ReadClusterRecords/ClusterTable 语义移植：

- **动态结构发现**：DD03L 查活跃版本列——SRTF2/CLUSTR/CLUSTD 三续块列存在性校验（普通透明表拒绝）+ KEYFLAG 键列提取（client 列排除）。
- **读取**：SELECT 键列+SRTF2,CLUSTR,CLUSTD（ORDER BY 键,SRTF2）→ 按键分组续块 → joinFragments → S/2 解码（V5/V6/LZH/LZC 全语义，对象级容错）。
- **截断语义**（VSP 同款）：行数达上限时**丢弃最后一个可能不完整的集群**并如实上报，绝不返回半截数据。
- 解码失败按键记 notes，不冒充完整；注入防线（where 控制字符/分号拒绝——引号是调用方 SQL 片段语法的一部分，原样透传与 VSP readtable 同款）；表名 token 校验零查询拒绝。
- 任意 INDX 型表通用（BALDAT/INDX/EUFUNC/STXL…）。

## impact：getImpactAnalysis（analysis.history 第十二工具，TransportHistoryHandlers）

VSP `handleImpact` + `fetchReverseDeps` 骨干移植：

- **逐层 WBCROSSGT 反向引用采集**：目标 → `NAME LIKE 'target%'`（每层 300 行上限）→ INCLUDE 归一化为对象级节点（normalizeLoadName）→ includeBelongsToName 归属过滤（前缀拖进兄弟对象排除）→ BFS frontier 扩展（maxDepth 默认 3、上限 5）。
- **查询预算控界**：每轮最多 12 次 WBCROSSGT 查询（datapreview 按会话预算防线），超限如实 notes。
- 输出：直接调用方（depth 1）/各深度影响集/逐边证据（原始 INCLUDE 池名保留可回查）/totalAffected 去重计数。
- 动态调用不解析（VSP 同款 DYNAMIC_CALL 语义）；parse 增补与 co-change 增补为 VSP 可选扩展不在本轮（骨架已覆盖核心语义）。

## 真机结果（SMOKE OK）

| 场景 | 结果 |
| --- | --- |
| EUFUNC C162_SPEC_GET_BY_ID | 2 续块行 → 2 集群全解码（V5/1100，与 fm_test_data 基线同源交叉印证） |
| 透明表 T001 | 结构校验拒绝（"is not a cluster table"——需 SRTF2/CLUSTR/CLUSTD） |
| 分号注入 where | 拒绝（控制字符/分号防线） |
| ZCL_ABAPGIT_AUTH 影响面 | 1 受影响对象（PROG:ZABAPGIT_FORMS →(d1) ZCL_ABAPGIT_AUTH——与部署轮实证引用吻合；重复边为同 include 两条引用语句的证据级真实形态，levels 按节点去重） |
| 非法 objectType XYZ | InvalidParams 拒绝 |

smoke 目标取舍说明：ZCL_MCP_SM21_ADT_HTTP 在 WBCROSSGT 无激活引用行（usage_examples 轮的引用 caller 已清理），换 ZCL_ABAPGIT_AUTH（部署轮 abapGit 源码实证 ZABAPGIT_FORMS 引用它）。

## 自动化基线

191 suites / 2131 tests 全绿（ClusterRead 9 例 + ImpactAnalysis 6 例 + handler/计数同步）；build、coverage（28）、parity（71 行 **59/71**）、git diff --check 全绿。

## 门控与边界

- 只读工具（readOnlyHint=true；SQL SELECT 通道），focused/workbench/legacy-full/development/diagnostic/operations 全只读面收录。
- 边界声明（notes 恒带）：cluster 对象名=EXPORT 名、字段按位置编号；impact 为交叉表骨干（激活时引用快照）、动态调用不解析。
- E070A CR 分组（服务器未配置）与 ui5.write（需具备写控制器的目标 DEV）为全矩阵仅剩的非完成项（RESTRICTION/PARTIAL 各 1）。
