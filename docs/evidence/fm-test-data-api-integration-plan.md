# FM 测试数据 API 对接评估（离线源码审计）

日期：2026-09-28
范围：只读对比主项目 `FmTestDataApi` 与本机 VSP 源码；未连接 SAP，未运行真机查询，未修改业务代码。

## 结论

用户已提供 VSP 源码位置 `D:\Dev\sapMcp\vibing-steampunk`。本地源码含完整的 EUFUNC cluster 读取/解码实现与 MIT LICENSE，因此“缺少上游实现及许可材料”这一前置阻塞可解除到**源码可审阅、许可可审阅**层面；但不等于已固定/批准移植版本，也不等于证明当前 SAP datapreview 能给出解码器所需的完整、无损字段值。

建议先实施一个独立、仅在显式请求时运行的窄 `getFmTestData` API：从 datapreview 读取 EUFUNC 的 cluster key + `SRTF2/CLUSTR/CLUSTD`，按 key 和序号安全合并片段，再通过移植/复写的 cluster decoder 返回目录、接口快照和数据集 inputs/outputs。现有 `getFmTestDataSets` 保持目录快路径与兼容契约，不要把 payload 读取静默并入每次目录查询。实现前需通过合成表格响应测试；SAP 验证仍须以后另行获授权，不是本轮工作内容。

## 契约对照

| 关注点 | VSP 源码所表达的契约 | 主项目当前实现 | 评估 / 未知 |
|---|---|---|---|
| EUFUNC key | `fmtest.go` 注释称按函数组、FM、集编号；`FunctionTestData` 以 `RELID='FL' AND NAME=...` 调 `ReadClusterRecords`（`pkg/adt/fmtest.go:11-16,53-57`）。cluster table 的 DD03L 推断把 client 列和 `SRTF2` 排除，剩余主键按 DDIC 次序当 key（`pkg/adt/cluster.go:30-78`）。 | 只查 `RELID/NAME`，选择 `NAME,GRUPPE,NUMMER,AUTOR,DATUM,ZEIT`（`src/adt/FmTestDataApi.ts:75-81`）。 | 目录查询可获得 key/元数据；payload 查询至少须选择动态发现的 key 列及 `SRTF2,CLUSTR,CLUSTD`。不要硬编码 MANDT 或假设 key 字段顺序。VSP 表结构能力的 API 依赖 DD03L，而现有主项目没暴露可复用的 cluster schema helper。 |
| 续块 / 分片 | VSP 查询排序按全部 key + `SRTF2`，用全部 key 分组；`DecodeHex` 解码 CLUSTD，`Join` 校验序号无重复/无缺片并按 `CLUSTR` 去除 padding（`pkg/adt/cluster.go:94-163`; `pkg/datacluster/fragments.go:10-58`）。 | 注释声称同 NUMMER 多行是 SRTF2 续块；实际查询未选择 `SRTF2/CLUSTR/CLUSTD`，按 NUMMER 去重（`src/adt/FmTestDataApi.ts:5-10,77-81,91-108`）。 | 当前 API 不读取任何续块字节，不能证明“同 NUMMER 行”之间关系。未来分组必须按完整 key（不能只按 NUMMER），并验证 fragment 连续性；限制命中时丢弃可能不完整的最后一个 cluster，不能返回半 payload。 |
| NUMMER=999 | VSP 将 999 解析为目录 cluster，从 `TE_DATADIR` 读标题、`FDESC_COPY` 读接口快照（`pkg/adt/fmtest.go:81-105`）。 | 主项目把 999 作为目录条目元数据返回，不解析其 cluster；类型说明其不是普通测试集（`src/adt/FmTestDataApi.ts:27-36,102-105`）。 | 可沿用 999 作为角色分类，但标题和接口字段只可来自 cluster decoder 结果。现有作者/日期/时间列不是标题或接口快照。 |
| 普通集 payload | VSP 将每个非 999 cluster 对象映射 `%_I*` → inputs、`%_V*` → outputs，并保留 `TIME1/V_RC/VEXCEPTION` 和未知对象（`pkg/adt/fmtest.go:107-135`）。 | API 明确不解析 CLUSTD（`src/adt/FmTestDataApi.ts:7-10,61-73`）。 | 这是合理的新增能力范围，但应保留未知对象并对 cluster 错误逐集 notes 化；不得执行或导入 cluster 的 ABAP 数据。 |
| datapreview 与字段值 | VSP 的 `RunQuery` 发 POST `/datapreview/freestyle`，以 `rowNumber` 限行并解析 ADT tableData（`pkg/adt/client.go:1230-1259`）。cluster 读取先查 DD03L 的活动字段，再查询完整 key、序号、长度、数据列（`pkg/adt/cluster.go:35-78,106-115`）。 | 主项目 `runQuery` 同样使用 freestyle endpoint，`decode` 默认 true（`src/adt/api/tablecontents.ts:280-295`）；解析 XML 时列 metadata 保留 type，并按列 type 解码单元格（`:194-227`）。主项目 Fm API binding 固定传 `decode=true`（`src/adt/FmTestDataApi.ts:130-138`）。 | 路径/行数参数机制可复用；但当前证据不足以断言 CLUSTD 经过主项目 parser 后是十六进制文本、base64、原始字节或被截断/转码。VSP `DecodeHex` 只说明它期望自己的 datapreview/SE16 导出 CLUSTD 为 hex（`pkg/datacluster/fragments.go:45-58`），不是此主项目连接/环境的真机格式证明。原型首先需要在 fixture 中锁定 XML 中 RAW 类型解析、大小写、空值和 hex 表示契约。
| 行数/预算 | VSP `ReadClusterRecords` 行限是数据库 fragment 行，不是返回的 cluster 数；命中上限时去掉最后一组，避免返回不完整 cluster（`pkg/adt/cluster.go:81-91,94-98,121-163`）。默认最大行数语义另见 `pkg/adt/limits.go`。 | 现有目录 API cap 500，命中时报告可能不完整（`src/adt/FmTestDataApi.ts:42,109-110`）。 | payload 查询不能沿用“500 个目录条目”的思路。应设小而明确的 fragment 行预算（建议从 500 起），标识 truncation，舍弃边界 cluster 并报告 `partial`；若 999 目录 cluster 不完整，禁止宣称 title/interface available。 |

## Decoder 与迁移范围

本机 VSP 工作树当前 HEAD 为 `9886d2727f47506368b0a3c2f1c1766f1200f747`（使用 `git -c safe.directory=...` 只读查询；工作树无改动输出）。其 `LICENSE` 标明 MIT（`D:\Dev\sapMcp\vibing-steampunk\LICENSE:1-16`）。这只是当前本地工作树的参考点；若纳入代码，需把此 SHA 和文件来源记入第三方来源/许可证清单，并由项目维护者确认移植边界。

Decoder 并非仅“inflate + JSON”。`pkg/datacluster/cluster.go:144-198` 处理 header、压缩、代码页以及格式版本 5/6；`pkg/datacluster/legacy.go` 和 `pkg/datacluster/layout.go`/`values.go` 等共同完成二进制结构与数据类型解析。测试 fixture 说明至少有版本 5 / codepage 1100 的 EUFUNC 样本，测试验证 `TE_DATADIR`、`FDESC_COPY`、输入输出与运行结果（`pkg/datacluster/cluster_test.go:322-357`）。这属于 VSP 仓库自带 fixture/测试，不是对目标 SAP 系统、当前 datapreview 返回或所有 SAP kernel 版本格式的真机证据。VSP 未发现独立 `fmtest_test.go`；FM mapping 集成行为的独立测试覆盖证据需复核，不能把 parser fixture 测试等同 API 行为验证。

**建议的可控迁移方式：**

1. 新建纯 TypeScript `src/adt/data-cluster/` 内部模块，只移植完成 V5/V6 及所需 codepage 的最小 parser/decompressor；保留来源注释和许可证，不将整套 Go 包或无关功能带入运行时。
2. decoder 输入只接受经校验的 bytes；拒绝未知 cluster marker、版本、压缩算法、codepage、非法长度、缺失/重复 SRTF2 与超限片段。对长度、解压后字节数、对象数、字段数和单值大小加硬上限，防止恶意或损坏数据导致资源耗尽。
3. 业务层 separate `NUMMER=999` 与普通集：目录 cluster 只读取 TE_DATADIR/FDESC_COPY；普通集将 `%_I/%_V` 映射为 inputs/outputs，其余键放 `others`。数组/结构/内表类型保留 JSON-safe 的层级值，避免字符串化丢失。
4. API 区分完整、部分、单集解码失败；不把查询失败转成无提示空数据。绝不执行被解码出的内容，也不把输入数据自动传给 SAP FM 执行。

## 实施前/实现时验证矩阵

- **纯 parser 单测**：重用/移植 V5 fixture（旧 codepage）及版本 6 fixture；再覆盖未压缩、压缩、截断头/流、未知版本、非法 codepage、解压失败、尾标记缺失、损坏字段布局、结构/表格/空对象。
- **fragment 组装单测**：合成 datapreview rows：完整 key 隔离、SRTF2 有序、乱序可排序、重复/缺号拒绝、CLUSTR trimming、hex 大小写/空白、非法 hex、错误数据类型、行数 cap 时只丢不完整末组；测试 MANDT 有无的 DD03L schema 两种情况。
- **EUFUNC 映射测试**：999 中 TE_DATADIR 标题和 FDESC_COPY 参数；000/001 编号前导零标题关联；`%_I`、`%_V`、TIME1/V_RC/VEXCEPTION、未知对象；非 999 空数据、单集损坏、空 NUMMER、NULL 单元格、多语言/异常字符。
- **datapreview parser contract fixture**：以实际 ADT XML 结构构造 CLUSTD RAW 单元格样本，分别走 `decode=true/false`；确认原始十六进制字符串不被数值/编码转换，并对 XML 空列、行列长短不齐及响应大小设限。当前 `runQuery` 的 `decode=false` 能跳过 DDIC 解码（`tablecontents.ts:280-295`），适合作为先行探针，但是否可用仍需本地 mocked XML contract 测试而非 SAP 查询。
- **API/offline 测试**：无 SAP 的 query mock 验证 SQL 投影、窄 row limit、过滤条件、一次查询/失败降级语义、集群不完整提示、结果 schema 与工具 profile 隐藏/dispatch 边界。真实环境验证需另行授权并使用专用 DEV；本审计不授权或执行该步骤。

## 当前仍未知 / 不可声称

- 没有脱敏的本项目 ADT `tableData` XML 样本包含 CLUSTD 原值，因此无法确认本项目解析器的 RAW 返回格式与长度完整性。
- 没有目标系统上 EUFUNC 的 DD03L 列定义/主键顺序、CLUSTD 原始 datapreview 行及多 fragment cluster；VSP 的通用 DD03L 发现机制不能替代目标系统证据。
- 仓库 fixture 覆盖 V5 示例，代码宣称支持 V5/V6；仍需确认 V6 与相关 ABAP 字段/压缩组合的 fixture 充分性。
- 无证据证明主项目依赖树现有可复用的 SAP cluster decompression/parser；需要依赖/许可证及 Node 支持性审计。优先原生 TS 窄移植，或确认可接受依赖后再选方案。
- 不能从 VSP 注释、测试 fixture 或既有目录层真机记录推断当前可成功读取 CLUSTD，更不能称为“无损读取已验证”。

## 决策建议

**离线原型可 GO；SAP 验证仍未授权/未执行。** 下一步先由实现者提取并审查 VSP 的 parser 源码和 MIT 要求，制作 TS parser + fixture 测试，随后集成无 SAP 的 datapreview response mock。只有全部离线验收通过、输出大小/隐私边界明确后，再单独申请专用 DEV 的只读验证；未获得授权前不连接系统。目录 API 当前行为及其已记录的真实证据不应因这个原型改写。
