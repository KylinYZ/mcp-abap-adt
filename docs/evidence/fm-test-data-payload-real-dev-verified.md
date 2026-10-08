# FM 测试数据 payload 解码真机验证（2026-10-07）

- 系统：sap-demo（10.30.254.48:8001，client 300，DEV 角色）；全程**只读 SELECT**（EUFUNC），零写操作
- smoke：`scripts/fm-test-data-payload-real-dev-smoke.mjs`（`npm run test:fm-payload-real-dev`）——**SMOKE OK**
- 结论：`diagnostics.knowledge-queries` 的 **fm_test_data payload 内容层收编**（行维持 PARTIAL，cluster_read 待立项）

## 解码器工程轮（ClusterDataDecoder）

VSP `pkg/datacluster` + `pkg/sapcompress` 全语义 TS 移植（MIT，固定审计版
9886d272，attribution 沿用 third-party/vibing-steampunk/）：

- 集群格式：V5 legacy（15 字节对象头/单字节名/4 字节描述符项/BB 行）+ V6
  Unicode（32 字节头/UTF-16 名/7 字节描述符项含小数位/BC-CA-BE 帧行数据）
- 码页：4103（UTF-16LE）/4102（BE）/单字节 Latin-1 近似
- 压缩：LZH（raw DEFLATE + SAP 2..5 位前缀，node zlib inflateRaw）+ LZC
  （compress(1) LZW 变体自实现：块式读取/宽度增长/clear/KwKwK）
- 类型谱：CHAR/DATS/TIMS/NUMC/RAW/INT1/2/4/8/FLTP/DEC（packed 小数位）/
  DF16/DF34（密集打包十进制）/STRING/XSTRING/结构（filler/include）/表
  （顶层与 0xAD 嵌套表组件）
- 资源上限（远端不可信输入）：集群/解压 1MB、对象 64、叶 512、行 4096、
  行 64KB、深度 8、节点 4096、膨胀比 1024（绝对上限为主防线，比率为异常
  信号——64 会误伤合法高压缩流，sapcompress fixtures zeros/big 实测）
- fail-closed：未知版本/kind/marker/码页、截断、长度对账失败全拒绝；错误
  只含 marker/offset/长度（格式契约字段，无业务数据）
- 对象级容错（tolerant）：失败点之前对象照常解出 + partialErrors 精确诊断
  （部分成功显式可见，绝不冒充完整；cursor 失败点后不可信，到此为止）

## Go oracle 对照（开发时验证）

本机 Go 1.24 + 代理拉取 toolchain go1.26.8，直接编译 VSP 固定审计版源码为
oracle（一次性临时程序，不修改 VSP、不入库、已清理）：

- 集群 fixtures 7/7 恒等（eufunc_v5/-plain、indx_plain/-compressed/-ddic/
  -deep、baldat_a4h——覆盖 V5/V6、明文/压缩、单字节/UTF-16、DDIC 布局、
  deep 嵌套、真实宽表）
- 压缩 fixtures 12/12 逐字节恒等（big/random/short/text/utf16/zeros 各
  LZC+LZH 对）
- VSP 自身测试 `go test ./pkg/datacluster ./pkg/sapcompress` 全绿佐证
- 呈现口径差异（非解码差异）：Go 空表 `rows:null` vs TS `[]`；Go int64
  JSON 数字 vs TS INT8 字符串（JS number >2^53 丢精度，保全取舍）

入库测试用合成向量（零 fixture 复制——payload-spike 来源审计决定）。

## 真机结果（C162_SPEC_GET_BY_ID，标准 FM）

| 场景 | 结果 |
| --- | --- |
| 目录模式（includePayload 缺省） | 1 测试集 + 999 目录行；notes 声明 payload 开关 |
| includePayload=true 测试集 | **V6 集群全解**：inputs `I_IDENTNAM=EHSCATT*`、outputs `E_SUBID=000000002149`、runtime 8539884 µs、rc=0 |
| includePayload=true 接口快照 | FDESC_COPY **3 参数**（首 `I_IDENTNAM` CHAR） |
| 999 目录集群边界 | 集群为 **V5+1100（2000 年写入）且 FDESC_COPY 行类型真实含 0xAD 嵌套表组件**——VSP 上游 legacy 同款拒绝；对象级容错使失败点之前的对象照常解出，0xAD 精确诊断入 notes |
| 负例（includePayload 非布尔） | InvalidParams 拒绝 |

**V5 嵌套表边界定性**：真实 V5 集群（EUFUNC 999 目录）推翻了上游"V5 不含
表组件"的假设——0xAD 在 legacy 描述符中真实出现，但其行数据帧格式（V5 无
CA/BE 帧）无参照实现，维持 fail-closed（与上游一致的安全边界），精确诊断
留档。解除条件：取得 V5 嵌套表行格式的参照实现或抓包样本后另行评估。

## 自动化基线

191 suites / 2114 tests 全绿（+解码器 24 例含容错语义 + API 内容层 3 例）；
build、coverage（REAL_DEV_VERIFIED=28）、parity、git diff --check 全绿。
接线：FmTestDataApi includePayload（目录模式 SQL 不变；payload 模式追加
srtf2/clustr/clustd 三列 + 按集分组续块）、handler schema + 校验、
STRICT_TOOL_FIELDS、cluster 计数不变（无新工具，能力并入既有工具）。
