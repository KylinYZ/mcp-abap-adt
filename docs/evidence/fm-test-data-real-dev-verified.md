# getFmTestDataSets（EUFUNC 目录层）真机验证

日期：2026-09-25。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。只读 SQL（EUFUNC datapreview），无写操作。

## 交付

`getFmTestDataSets`（diagnostics.knowledge-queries 行 fm_test_data 子集的目录层）：对指定函数模块只读 EUFUNC 的 key 与元数据列（`relid='FL' AND name='<FM>'`），列出已保存测试集（编号/作者/日期/时间，SRTF2 续块去重）与 NUMMER='999' 目录行元数据（TE_DATADIR/FDESC_COPY 所在集群行）。**payload（CLUSTD，EXPORT 数据集群）不解析**——内容级 inputs/outputs 需要 S/2 集群二进制解码器（VSP pkg/datacluster，约 2.2k 行 + sapcompress），独立工程轮；notes 恒带此声明。

## 真机取证与结果：SMOKE OK

前置取证（datapreview 直查）：
- EUFUNC 表可读，列形态 `RELID/GRUPPE/NAME/NUMMER/SEQID/SRTF2/LANGU/AUTOR/DATUM/ZEIT/VERSION/CLUSTR/CLUSTD` 与 VSP fmtest.go 的 key 取值完全对应；
- 决定性正例 `C162_SPEC_GET_BY_ID`（标准 FM）：存在 NUMMER='999' 目录行 + 数据行。

smoke（`npm run test:fm-test-data-real-dev`）：

```text
PASS getFmTestDataSets 在 focused catalog
INFO C162_SPEC_GET_BY_ID: group=EHSSUB04 sets=1 directory=999 author=SAP
PASS 决定性正例：C162_SPEC_GET_BY_ID 目录=999（author=SAP）+ 1 个测试集
PASS 自有 FM：空目录为正常回答（sets=0，notes=2 条）
PASS 负例：非法 FM 名 → InvalidParams
SMOKE OK
```

- 正例：999 目录行正确识别（含 author/date 元数据）、测试集与目录行分离、组名（EHSSUB04）回填、payload 未解码声明恒在；
- 自有 FM（Z_MCP_SM21_READ，从未保存过测试数据）：空目录 + notes 是**正常回答**而非失败；
- 负例：非法 FM 名参数层 InvalidParams。

## 边界

- 内容级数据（测试集的 inputs/outputs 值、999 目录行的标题/接口快照内容）需要集群解码器，不在本层且 notes 声明；
- datapreview 会话查询预算机制适用（知识查询层不做失败重试）；通道失败降级为空目录 + notes，不伪装成功。

## 门禁

- `npm test -- --runInBand`：169 suites / 1776 tests 全绿（新增 5 个 API 用例 + handler/目录计数断言同步）
- `npm run build`、`npm run check:repository-creation-coverage`、`npm run check:vsp-capability-parity`、`git diff --check` 通过
