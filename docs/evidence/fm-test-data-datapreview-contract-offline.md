# datapreview CLUSTD wire 契约离线锁定（阶段 A）

日期：2026-09-28。基线：`main` @ `f808e7a`。范围：纯离线 mock contract 测试与隐私/资源边界审查；**未连接 SAP**，真机探针（阶段 B）待用户另行明确授权。

## 交付

- `src/__tests__/DatapreviewClustdWireContract.test.ts`：13 个契约用例，锁定 `parseQueryResponse` + `decodeQueryResult`（`src/adt/api/tablecontents.ts`）对 EUFUNC CLUSTD 场景的行为。
- 全量门禁：171 suites / 1807 tests、`npm run build`、`git diff --check` 通过。

## 实测锁定的 wire 契约事实（合成 XML，待真机证实适用性）

1. **RAW/XSTRING 原样性（接入的有利前提）**：`type='X'/'y'` 列在 `decode=true/false` 下均原样返回文本（`parseValue` default 分支）；`parseTagValue:false` 保证 hex 文本不被数值化、前导零与大小写保留、`trimValues:false` 不裁剪。多 SRTF2 续块逐行 `Buffer.from(hex,'hex')` 后按序拼接可精确还原源字节——这是"若 wire 为 hex 且无错位则字节无损重组"的 parser 层证明，不构成集成承诺。
2. **解析层无上限**：256KB 字节（512K hex 字符）单元格解析不截断；`rowNumber` 是唯一行闸（服务端截断在 body 中无标记可检测）。资源预算属未来接入层责任。
3. **危险现状一（NULL 省略错位）**：真机已证 NULL 列完全不输出 `<data>` 元素（见 95d4bf2）。`parseQueryResponse` 逐列独立按索引取值：任一列缺格则该列整体上移错位、末行 `undefined`，**无任何告警**；若 CLUSTD 自身缺格，片段拼接将静默错乱。contract 测试已将此行为锁定为回归警示。
4. **危险现状二（单行空串消失）**：实测发现 `xmlArray` 的 `if (node)` 对空字符串单元格判 falsy——单行查询中唯一单元格为空串时该列 values 为空，**整行静默消失返回零行**；多行时空串原位保留不错位。
5. **风险三（带属性单元格）**：`fullParse` 默认 `parseAttributeValue:true` 未被覆盖，`<data null="true"/>` 解析为对象 `{ "@_null": true }`（属性值还被数值化成 boolean）；`parseValue` default 分支原样返回对象，下游当字符串消费时才损坏。真实 wire 是否带属性未知，须由阶段 B 确认。
6. **风险四（DATS 有损转换）**：`decode=true` 把 `type='D'` 列转成 JS Date。EUFUNC 的 DATUM 是 DATS；若真机回报 `type='D'`，目录层 date 字段经 `cellText` 的 `String()` 会变成英文日期串而非 `YYYYMMDD`。既有真机 smoke 未断言 date 格式，此风险未被真机证据排除。
7. **格式校验缺位（设计现状）**：非法 hex 文本在 parser/decode 层原样通过——格式校验与 fail-closed 是 decoder 层（`EufuncV5DecoderPrototype` 已带 `MAX_*` 硬上限与白名单拒绝）的责任边界。

## 隐私审查

- 本轮全部测试数据为合成字节（确定性生成），无真实 payload、业务数据或未脱敏样本入库；`EufuncV5DecoderPrototype.test.ts` 亦为合成向量。
- 阶段 B 探针输出约束（沿用交接要求）：只记录脱敏后的列名/类型/长度、片段键与次序、读取状态；默认不打印 CLUSTD 原值；发现敏感字段立即停止保存样本。

## 阶段 B 探针确认清单（获批后逐项取证）

1. datapreview 对 EUFUNC `CLUSTD` 返回的列 `type` 属性值与单元格编码（hex/base64/其他）。
2. `<data>` 元素是否带属性；NULL 片段的真实形态。
3. DATUM 列回报的 type（是否 `'D'`）；截断时 body 是否有任何标记。
4. 多片段 cluster 的键/次序/缺失重复在真实响应中的表现。
5. 以上任一项与本文契约不符时，先修 parser 契约测试再谈接入。

## 结论

**阶段 A 完成。** RAW 原样性对接入有利，但 NULL 错位、单行空串消失、带属性单元格三项表明：**在 wire 证据到手且 parser 加固之前，CLUSTD 接入维持 NO-GO**，capability 保持 PARTIAL。真机读取需单独授权（专用 DEV、只读、串行、最小范围）。
