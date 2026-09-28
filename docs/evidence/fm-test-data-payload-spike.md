# FM 测试数据 payload 解码可行性审计

日期：2026-09-28
范围：静态审阅主项目 `FmTestDataApi` 及用户提供的 VSP 本地 checkout `D:\Dev\sapMcp\vibing-steampunk`；固定 revision 与工作区状态以只读 Git 命令核实。不连接 SAP、不读取或记录真实 payload、不实现解码。

## 结论

**条件可行；来源/许可审计已大幅解除，但当前仍 NO-GO 接入主项目，GO 做离线原型准备。** 用户提供了 `D:\Dev\sapMcp\vibing-steampunk`，该 checkout 的 HEAD 精确等于矩阵固定参考 SHA `9886d2727f47506368b0a3c2f1c1766f1200f747`，只读 status 无改动。已直接审阅 `pkg/datacluster`、`pkg/sapcompress`、EUFUNC 调用路径、测试与 LICENSE：源码在该固定版本中确实存在，根许可证为 MIT；解析器和压缩器之间只有仓库内部依赖，压缩算法主要使用 Go 标准库 `compress/flate`，LZC 为仓库自带代码，未发现这两个包直接引入第三方 Go 模块。因此“源码/锁定版本/基础许可证/直接依赖闭包缺失”不再是阻塞。仍未证明主项目 ADT 通道对 `CLUSTD` 的实际 wire 表示无损，也未确认随源码的 EUFUNC 测试 fixtures 可重分发且完成脱敏；不能将原 fixture 直接复制到主项目或据其宣称覆盖了生产数据。

适宜下一步是**限定范围的离线 decoder spike**：以审阅到的固定源码建立独立原型，不改生产 handler/tool contract；先用可重新生成的合成 cluster 向量与现有测试期望验证解析流程，再设计主项目自身的畸形输入/资源上限测试。接入 CLUSTD 前仍需对传输编码作离线可证伪的评估；真实 SAP 读取仍需另行明确授权，本次“暂不连接”的决定持续有效。

## 仓库证据与事实边界

- `src/adt/FmTestDataApi.ts:5-10, 18-37, 62-73, 75-121`：描述 EUFUNC key 和目录元数据；查询投影只选 `name, gruppe, nummer, autor, datum, zeit`（第 78 行），未选 `CLUSTR/CLUSTD`；类型也没有 payload 字段，notes 明示需外部集群解码器。
- `src/__tests__/FmTestData.test.ts`：覆盖目录行/测试集编号、续块去重、空目录、查询失败和非法 FM 名；使用 mock 行，不含 CLUSTD 字节和 decoder 测试向量。`src/adt/api/tablecontents.ts:205-227` 的 `parseQueryResponse` 将 datapreview XML `<data>` 作为字符串收集，未在 parser 中做 RAW 转码；主项目已有 `SpoolJobApi.decodeHexCell` 对 datapreview RAW hex 列转字节的窄例子，但尚无 EUFUNC/CLUSTD response fixture 或 contract test，故只能说存在可复用 hex 解码模式，不能断言 EUFUNC 的 wire 表示已验证。
- `docs/evidence/fm-test-data-real-dev-verified.md`：记录 2026-09-25 的目录层 SAP 真机验证；文档说明 EUFUNC 行形态含 CLUSTR/CLUSTD，但该 smoke 验证的是目录/API，不是 payload 读取或解码。
- `docs/evidence/dependency-graph-offline-alignment.md:41-42`、`docs/evidence/analysis-history-and-fm-test-data-roadmap.md:27`：记录 VSP 参考为 `pkg/adt/fmtest.go` → `pkg/datacluster`，并把格式、依赖、许可证和 sapcompress 审计列为前置项。
- 主项目 `third-party/vibing-steampunk/README.md` 与 `LICENSE`：现有 attribution 明确固定了同一 SHA，并说明只适用于已适配的 graph/query 源码。其 MIT 文件并非 datacluster 源码副本的逐文件 attribution；不过用户提供的本地源仓库根 `LICENSE` 也为 MIT，当前审阅的 `pkg/datacluster` 与 `pkg/sapcompress` 未见 package 内单独许可证头或第三方来源声明。复制时仍须在主项目增加针对这些复制源文件的明确 attribution/NOTICE，并由项目维护者确认 MIT 许可适用边界。
- `third-party/abap-adt-api/BASELINE.md` 与 `LICENSE`：描述的是嵌入 ADT API 的 MIT 来源，与 VSP decoder 的来源无关。
- 只读 Git 核验：VSP 当前本地 checkout HEAD=`9886d2727f47506368b0a3c2f1c1766f1200f747`，与矩阵固定 SHA 完全一致；`git status --short` 为空。每条 git 命令均使用 `-c safe.directory=...`，未改全局 Git 配置。
- 根 `package.json`：运行依赖为 MCP SDK、axios、xml/类型库、open-rfc 等，没有 Go decoder/sapcompress 依赖；仅搜索到项目自己的 ZIP `node:zlib` 用法，不能视作 SAP cluster 格式实现。

已审阅 decoder 实际规模（按当前固定 checkout 文件行数）：`pkg/datacluster` 的非测试 Go 源文件约 1,715 LOC，`pkg/sapcompress` 非测试 Go 源文件约 292 LOC，合计约 2,007 LOC；测试文件和 fixture 不计入。故之前“约 2.2k 行”的粗估接近但非精确口径。源码不在主仓库；当前只审阅、未复制。Go module 主依赖虽不少，但上述两个包只依赖 Go 标准库及同仓 `pkg/sapcompress`。

## 技术与依赖风险

1. **传输表示未知（阻塞）**：需证明 ADT datapreview 对 `CLUSTD` 返回 RAW/LRAW、hex/base64 或其他表示时，编码、长度和分块顺序可无损还原；当前真机证据只确认目录字段存在，未验证 payload 通道。
2. **解压/格式风险仍高但已有可审阅实现**：该版本支持 header format 1 plain、2 compressed；`sapcompress` 识别 LZH（源码将其描述为带 SAP 前缀的 raw DEFLATE）和 LZC（compress(1) 样式 LZW），cluster parser 还分 V5/V6 路径。`pkg/datacluster/cluster_test.go` 覆盖版本5 EUFUNC 压缩/未压缩 fixture；`pkg/sapcompress/sapcompress_test.go` 和各 cluster fixture 覆盖已知例子。但这不证明目标环境所有版本/压缩组合兼容，也不证明主项目送入 parser 前拼接正确。
3. **语义映射风险高**：EXPORT 描述符可能可还原类型/值，但组件字段名、DDIC 结构布局及嵌套表恢复策略必须另有可靠来源。没有完整 schema 时不得按位置猜字段名或把部分解码伪装成可信 inputs/outputs。
4. **引入边界**：当前服务是 Node/TypeScript，且运行时要求 Node >=22.14.0。引入 Go 子进程、CGO/native addon 或新大依赖会增加打包、Windows 安装、崩溃隔离和供应链负担；优先考虑可审计的纯 TypeScript 实现，或通过隔离的可选辅助进程做有数据支持的比较，不预先选型。任何复制/改写须保留来源、commit、版权/许可证和 NOTICE，并做许可证审查。
5. **在线供应链不可作为前置运行条件**：正式运行不能依赖临时下载源码或隐式调用 VSP。实现依赖必须锁定版本并进入可重复安装与 SBOM/许可证检查。

## 样本和测试要求（进入原型前）

- 固定并记录 VSP 源码 commit、decoder 与 compressor 文件列表、许可证及依赖闭包；保留对应测试向量和期望输出来源。
- 来自获准专用 DEV、已脱敏/可重分发的 fixture；不得把生产数据、用户数据、凭据、实际业务输入输出或原始未脱敏 CLUSTD 提交进仓库。若无法获得可提交数据，提供可追溯的本地受控样本流程和非敏感合成向量。
- 最小向量集覆盖：不同压缩标识/已确认格式版本、空与小 payload、文本/数值/packed 与字符编码、结构和内表、嵌套值、长值/多段、SRTF2 续块拼接、NUMMER=999 目录集群与普通测试集区分、截断/损坏/未知标识。
- 由 SAP/受控 ABAP IMPORT 导出的期望语义作 oracle；验证字节长度、字段结构和类型/值一致性，不能只验证“未抛异常”。每个向量都标注系统版本、来源、脱敏状态及采集步骤。
- 单元测试完全离线；不把 SAP smoke 混入默认测试。真机只读验证须单独授权，在 sap-demo 专用 DEV 串行运行，且禁止生产、传输变更及任何写操作。

## 安全边界与 DoS 防护要求

`CLUSTD` 是远端返回、不可直接信任的二进制输入。原型在设计上必须做到：

- 对 SQL 行数、每个 cluster 的字节数、每个 FM 累积字节数、续块数、嵌套深度、成员/数组长度、解析节点数和最终 JSON 输出分别设硬上限；超限必须返回明确的 `partial/limit exceeded`，不能静默截断后声称完整。
- 对压缩输入与输出分别限制大小，并设置解压比、CPU/墙钟时间、内存边界；禁止无界分配或一次性拼接无限续块。测试 zip-bomb 风格高膨胀率、深层嵌套、超长长度字段和整数溢出。
- 所有游标/偏移/长度先做边界与溢出检查；拒绝未知版本、类型、压缩格式、截断、缺块和意外尾随字节，错误信息不回显 payload 原文。
- 只解析白名单格式与值类型，不执行、不反序列化成可执行对象；不接受调用方任意压缩算法/路径/URL/布局。layout/schema 只能来自受信的只读 DDIC 查询并严格校验，缺少证据时不猜名。
- 不持久化原始 payload，不打日志，不把原始字节回传给模型；输出字段做敏感值策略/按需脱敏评估，避免测试数据被意外暴露。
- decoder 作为纯函数/隔离模块，无网络、SAP 写操作或文件系统副作用；失败默认关闭，记录可诊断错误类别，不能用空对象冒充成功。

## 阶段建议与 Go/No-Go 门

**阶段 0 — 来源审计（完成）**
固定 commit、源码入口、算法实现、直接依赖和仓库根许可证已审阅。复制代码到主项目前仍须附带来源 attribution/许可证文本，并核查其与本项目分发方式的兼容性；目前不复制。VSP 自带 EUFUNC fixtures 的数据来源、脱敏及再分发状态尚未确认，故不直接复用。

**阶段 1 — 隔离离线原型（GO）**
可用非敏感、可生成的合成字节向量进行解码试验，或在明确保留版权/许可证/NOTICE 后评估可复用代码；不连接 SAP、不读取未审定的 VSP fixtures、不接入 MCP handler/tool contract。先实现 header/压缩/版本 parser 的小范围回归与资源上限测试。

**阶段 1 Exit 门槛**
要进入下一阶段，需：decoder 对支持格式范围有明确白名单；错误/截断/缺块可靠拒绝；资源限制测试通过；fixture 来源及许可明确；主项目 ADT/SQL 返回 `CLUSTD` 的表示契约已有代码证据或 mock contract 测试覆盖。最后一项目前可通过主项目静态接口审阅与合成/mock 数据推进。

**阶段 2 — 接入设计审查（GO 门）**
只有当 decoder 对允许支持的版本/编码达到完整 oracle 通过、未知/损坏 payload 稳定拒绝、DoS 预算测试通过、license/SBOM 审核完成、Windows/Node 发布包可复现时，才审议 MCP 暴露接口。输出须携带 decoder/version/scope/partial 状态；不支持格式明确拒绝。

**阶段 3 — 只读 DEV 验证（单独授权）**
在专用 sap-demo DEV、串行和只读条件下，用少量已脱敏样本与 ABAP IMPORT 结果比对。未通过前 capability parity 保持 `PARTIAL`，不发布、不声称 inputs/outputs 完整。不得连接 PRD，不创建/释放传输，不执行写操作。

## 最终判断

**现阶段：GO 做隔离的离线解码原型；NO-GO 主项目生产接入、NO-GO 声称真实 CLUSTD 已解析。** 固定源码、解析算法、直接依赖及根许可证已静态核查；测试向量存在但其数据来源/脱敏/再分发资格未核定。仍需以主项目实际 datapreview/SQL response contract 证明 CLUSTD 可无损转成 bytes，并逐项验证格式/资源边界。暂不连接 SAP，故传输链真实端到端能力仍是未验证项。
