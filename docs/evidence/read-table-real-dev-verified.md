# RFC_READ_TABLE 表读取真机验证（rfc.remote-enabled.read-table → EQUIVALENT）

- 日期：2026-09-18
- 环境：专用 DEV（10.30.254.48，client 300，用户 068157；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`；RFC 直链
  host 10.30.254.48 + sysnr **01**（网关 3301））
- 方式：`node ./scripts/read-table-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层 open-rfc 直连网关调用
  RFC_READ_TABLE，全只读 SELECT，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 UNVERIFIED →
  **EQUIVALENT**（evidence + real-dev-verified）。

## 真机 smoke 输出

1. catalog 可见性：readRfcTable 在 focused 运行时 catalog。
2. T001 全量（maxRows 10）：读回 10 行，每行非空数组。
3. WHERE 过滤（`BUKRS = '1000'`）：成功返回 0 行（该 client 300 无公司代码
   1000，动态 Open SQL 行为正确；非缺陷）。
4. 列投影（fields=[BUKRS,BUTXT]）：读回 5 行，样例
   `[["0001","SAP SE"],["0003","SAP US (IS-HT-SW)"]]`。
5. 注入负例（`Z';--`）：处理器层 InvalidParams 拒绝，零网络往返。

## 过程中定位并修复的三个缺陷（全部有真机/单测证据）

1. **open-rfc 递归序列化器决策门**（阻塞项）：含 TABLES 参数的调用（如
   RFC_READ_TABLE）发送前要求显式对端序列化器观测，否则拒发
   `live-decision-required`。修复：`OpenRfcTransport` 构造缺省注入
   classic-xRFC 观测策略（profile abap-7.58 + observation
   classic-xrfc/classic-xrfc；部署级断言：经典 RFC 直链无 basXML 协商），
   构造 options 可覆盖。open-rfc 决策门四判定（live / classic-xrfc /
   sendAllowed / basxmlNegotiation=disabled）经该观测组合恰好产出。
   单测：`OpenRfcTransportPolicy.test.ts`（3 例）。
2. **DELIMITER 宽度**：RFC_READ_TABLE 的 DELIMITER 参数为 CHAR1，open-rfc
   按元数据宽度严格校验，此前的双字符 `'~~'` 被拒（"does not fit its
   classic CHAR width"）。修复：改回 VSP 同款单字符 `'|'`；列值含 `'|'`
   串列为已知限制（VSP 同面，解析按列数保守补齐/截断）。
3. **WHERE 单引号翻倍**：OPTIONS TEXT 由 RFM 内部作为动态 Open SQL 片段
   执行，字面量引号必须保持调用方写法；此前的翻倍处理触发 ABAP 侧
   DB_Error（msgclass SAIS）。修复：引号按原样透传，注入防线保留
   （控制字符/分号/换行拒绝 + 表名/列名白名单 + 72 字符上限；VSP 亦直传
   TEXT，暴露面一致）。此前注释中"VSP sqlQuote 语义"系误记，VSP
   readtable.go 实际不转义引号。

## 过程中发现并适配的系统形态差异（S/4 增强 RFC_READ_TABLE）

该 S/4HANA DEV 的 RFC_READ_TABLE 接口经 SAP 增强（真机元数据实测）：
新增导入参数 `USE_ET_DATA_4_RETURN`（BOOLE_D）与导出表 `ET_DATA`
（类型 h，行类型 SDTI_RESULT_TAB）。行为差异：

- 不带开关：经典 `DATA`/`FIELDS` 回填路径已死（全部空返回，无错误）；
- 带 `USE_ET_DATA_4_RETURN='X'`：数据经 `ET_DATA[].LINE`（按 DELIMITER
  分列）返回，`FIELDS` 仅在调用方投影时回传列目录；
- open-rfc 请求侧按元数据校验参数名，旧系统（无该增强）发此开关会报
  `unknown parameter` 拒发。

适配（`src/rfc/read-table-adapter.ts`）：能力探测双路径——经
`TransportAdapter.getFunctionInterface`（本轮新增的可选传输能力，
`OpenRfcTransport` 委托 open-rfc `Client.getFunctionInterface` 实现，
仅保留参数名/方向类结构化视图）探测 `USE_ET_DATA_4_RETURN` 存在性：
存在则载荷带开关并从 ET_DATA[].LINE 解析；不存在（或适配器无元数据
能力，如 Loopback）保持经典 DATA[].WA 路径。探测结果按适配器实例缓存
（WeakMap，一次元数据往返）；探测失败如实抛传输级错误且不缓存（静默
降级会在增强系统上产生"0 行成功"的假阴性）。
单测：`ReadRfcTableEtData.test.ts`（5 例，含旧系统/无元数据能力/缓存/
失败不缓存分支）。

## 门禁记录

- Jest：153 suites / 1430 tests 全绿（本能力新增 8 例）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（RFC_READ_TABLE 为无副作用只读系统 RFM；探测/读取全程
  只读 SELECT）。
- 无投影时的列目录：增强系统在调用方未指定 fields 时不回传 FIELDS，
  此时 `fields: []` 且行保持全列拆分（调用方点名列即可获得列目录），
  已在工具语义内如实呈现。
- rfc.remote-enabled.call/describe（callRfm 泛化）为下一 RFC 轮次候选。
