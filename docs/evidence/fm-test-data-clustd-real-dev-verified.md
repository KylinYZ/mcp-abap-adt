# EUFUNC CLUSTD datapreview 真机取证（阶段 B）

日期：2026-09-28。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。授权：所有者当日明确批准本次连接。只读 datapreview 查询（两进程共 8 次查询，串行，远低于会话预算），无写操作、无 FM 执行、无传输变更。

**隐私纪律**：全部输出脱敏——CLUSTD/CLUSTR 单元格只记录长度/字符集判定/SHA256 前 12 位指纹，原值未打印、未落盘、未回传模型；两探针脚本（`scripts/fm-test-data-clustd-probe.mjs`、`-probe2.mjs`）内置强制脱敏与凭据不序列化（AdtHTTP 异常对象携带 config/auth，错误仅取 message）。

## 结论：wire 契约已实证，重组规则确立；payload 解码 partial

**CLUSTD 经 datapreview 可无损读取**：列 metadata `type='X'`，`<data>` 元素**无属性**，单元格为**连续 mixed-case hex**，按 LRAW 声明宽度全额返回（实证 3800 字节 = 7600 hex 字符），有效字节数由 `CLUSTR`（**INT2，type='s'**，此前合成假设 RAW22 有误）给出，其余为全 `'0'` hex padding（实证 422 有效字节后 6756 字符 padding 全零）。

**无损重组规则**：每片段取 `CLUSTD` 前 `CLUSTR×2` 个 hex 字符 → hex decode → 按 `SRTF2` 升序拼接。真机 padding 模型验证 `paddingAllZeros=true`。

四层验收状态：目录读取 ✓（此前已证+本轮复证）｜CLUSTD 可读取 ✓｜单片段重组 ✓（padding 实证）｜**payload 可解码 partial**（原型 fail-closed，见下）。

## 确认清单逐项回答（对照 datapreview-contract-offline.md）

| # | 问题 | 实证结果 |
| --- | --- | --- |
| 1 | CLUSTD 列 type / 编码 | `type='X'`；连续 mixed-case hex（非 base64/其他） |
| 2 | `<data>` 是否带属性 | **无属性**（Q1-Q4 全部 dataWithAttributes=0）；阶段 A 风险三未在真实 wire 出现，parser 侧防御建议保留 |
| 3 | DATUM 列 type | **`type='D'`**——decode=true 转 JS Date 的风险四成真；已修 `createFmTestDataClient` 固定 `decode=false`（date 保持 `YYYYMMDD`） |
| 4 | NULL 片段形态 | NUMMER 列可整列无 `<data>`（C162 非 999 测试集行即此形态）——阶段 A 锁定的缺格错位契约在真机再现 |
| 5 | 多片段键/次序/完整性 | **partial**：本 FM 两个集群均单片段（SRTF2 序列 [0]）；>3800 字节 payload 才有续块，本轮样本未覆盖，不得据此宣称多片段已验证 |
| 6 | rowNumber 截断标记 | 返回行数 < cap，无截断场景可观察；body 中无截断标记字段，维持"截断不可从响应检测"契约 |

其他真机事实：SRTF2（type='I'）单元格呈现带**尾随空格**（如 `'0 '`，parseInt/trim 吸收）；EUFUNC 视图不暴露 MANDT 列（`Unknown column name "MANDT"`，与 VSP DD03L 排除 client 列一致）；CLUSTR/CLUSTD 同行返回时 datapreview 无表级限制报错。

## payload 可解码：partial（原型 fail-closed 如实记录）

真机 999 目录集群 bytes（422 字节，trim 后）送入隔离原型 `EufuncV5DecoderPrototype`：header/LZH inflate 阶段通过，解析器以 `unexpected trailing SAP LZH bytes` **fail-closed 拒绝**——原型的严格白名单/流终态校验未覆盖真机集群的尾部形态（可能为填充/尾标语义差异）。**这不证明 payload 不可解码**（真实格式已到手、拒绝点在解析尾部而非头部），但接入前必须以真机 bytes 扩展原型容错边界并建立 oracle 对照。

## oracle 解码轮（同日第二轮，追加授权范围内只读探针 ×3 次查询）

对照 VSP oracle 源码修正原型两处后，真机集群解码推进到对象级：

1. **inflate 尾部校验放宽为 VSP 语义**（`pkg/sapcompress inflate`）：VSP 只要求解压输出精确等于头部长度承诺，**忽略 DEFLATE 终块后的尾随字节**（真实 SAP 流的常态）；原型的"剩余压缩字节 ≤1"校验过严导致误拒。修正后真机集群 LZH 流完整解出（1089/1089 字节精确匹配）。
2. **kind 5/6（deep structure/table）接受**：VSP legacy 枚举值本身 Structure=5/Table=6，与 flat 2/3 同路处理、descriptor marker 相同；真机对象层曾以 kind 6 被原型拒绝。
3. **解析终态与上游共同边界**：真机第 3 对象（kind 6 deep table，`%_I*/%_V*` 类输入输出对象）的 line type 内**嵌套子表 descriptor（0xAD）**——VSP `legacyChildren` 对 0xAD 走 default 拒绝，V5 legacy 并声明 "version 5 cluster was not expected to hold tables/strings"。**原型 fail-closed 保持与上游一致，不强行放行未审形态**；错误消息已带 marker/offset 诊断上下文（格式契约字段，无业务数据）。

**对象级 oracle 判定**：999 目录集群核心两对象 **TE_DATADIR**（offset 0，kind 3，rowLength 88，8 个 leaf 字段 descriptor 正常收口）与 **FDESC_COPY**（offset 57，rowLength 156，fields sum=rowLength 校验通过、行区自洽）**全部符合 V5 legacy/VSP 语义并可解码**——目录行语义（标题+接口快照载体）已达可解码状态；对象布局位置（57+461=518）与原型游标精确吻合。全 cluster 整体解码止于上述上游共同边界；输入输出对象（`%_I*`/`%_V*`）解码需扩展 parser（上游同样不支持），为独立工程轮。

**验收矩阵更新**：目录读取 ✓｜CLUSTD 可读取 ✓｜单片段重组 ✓｜**payload 可解码：目录语义对象级 ✓ / 全量解码 ✗（上游共同边界，如实记录）**。

原型回归：新增合成用例 2 个（kind 6 flat line type 接受、嵌套 0xad 拒绝锁定），20/20 通过。探针脚本 `scripts/fm-test-data-clustd-probe3.mjs` 内置对象级 oracle 判定，可复跑。

## 阶段 A 契约假设与真机的对照汇总

- 成立：RAW hex 原样、decode 不转码、前导零/大小写保留、字节可逆。
- 成立（真机再现）：NULL 缺格错位形态（NUMMER 列）、INT 列尾随空格。
- 修正：CLUSTR 非 RAW22 而是 **INT2 片段字节数**；`<data>` 真机无属性（合成风险用例保留为防御性回归）。
- 新增缺陷并修复：`createFmTestDataClient` decode=true→false（DATS→Date 有损转换，`FmTestData.test.ts` 新增接线断言）。

## 边界与限制

- 单 FM 单系统样本：不据此声称支持所有 SAP 版本、cluster 类型或压缩组合。
- 多片段（SRTF2 续块）完整性检测、大 payload 分页截断、decoder 尾部容错：保持 partial，待后续获批样本扩展。
- 探针脚本为只读取证工具，不是生产 MCP 接口，也未扩展 handler/tool contract。

## 门禁

`npm test -- --runInBand` 171 suites / 1811 tests 全绿（+4：真机形态固化 3、decode=false 接线 1）；`npm run build`、`git diff --check` 通过。
