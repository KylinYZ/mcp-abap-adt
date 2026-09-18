# RFC 受控调用/接口描述真机验证（rfc.remote-enabled.call / describe → EQUIVALENT）

- 日期：2026-09-18
- 环境：专用 DEV（10.30.254.48，client 300，用户 068157；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`；RFC 直链
  host 10.30.254.48 + sysnr **01**（网关 3301））
- 方式：`node ./scripts/rfc-call-describe-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层 open-rfc 直连网关，全只读，
  零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 rfc.remote-enabled.call 与
  rfc.remote-enabled.describe 由 GAP → **EQUIVALENT**（两个 P0 GAP 同时
  关闭，evidence + real-dev-verified）。

## 实现范围（callRfm 泛化：一次工作关闭两个 P0 GAP）

- `describeRfm`（rfc.remote-enabled.describe）：FM 接口元数据 → 参数级
  结构化描述（方向/ABAP 类型码/关联 DDIC 类型/长度/可选性）+ 仅导入与
  变更参数构造的轻量 inputSchema（callRfm 组参输入面）+ allowlisted 提示。
  元数据通道复用 `TransportAdapter.getFunctionInterface`（OpenRfcTransport
  委托 open-rfc `Client.getFunctionInterface`；本轮把结构化视图从
  参数名/方向扩展到类型细节字段）。**describe 不执行目标 FM**（真机断言
  invoke 零调用）。表/结构行形状以 associatedType 引用（经 DDIC 元数据
  工具另查），不在本层递归展开。
- `callRfm`（rfc.remote-enabled.call）：受控只读 RFM 调用——allowlist
  硬门（白名单外 RF_CALL_NOT_ALLOWED 且 message 携带当前白名单；拒绝发生在
  任何网络往返之前）→ 载荷透传（顶层参数键大小写归一大写，嵌套键不动）
  → invokeFmCall 超时/取消链（timeoutSeconds 1..120，缺省 30）。
  RFC 域错误带原因透出（RfcError/RfcTransportError 消息为受控文本，
  无凭据）：allowlist 拒绝、unknown parameter、ABAP 异常、传输故障。
- 只读 allowlist 扩充（`src/rfc/allowlist.ts`，3 → 7）：新增
  RFC_GET_FUNCTION_INTERFACE（接口元数据，describe 同源通道）、
  RFC_METADATA_GET（元数据提供者）、RFC_FUNCTION_SEARCH（FM 检索）、
  RFC_SIMULATE_AUTH_CHECK（权限仿真，只读模拟）。准入标准写入注释：
  SAP 标准交付、无副作用、名称稳定；业务自定义 RFM 不走默认集合
  （经构造注入扩展的受控路径）。
- 接线：ToolProfiles（workbench 名单 +2）+ ToolOperationPolicy
  （read-only 类 +2）+ ToolCatalogIntegrity 计数（development=166、
  diagnostic-readonly=135、legacy-full=198、development-workbench=133）。

## 真机 smoke 输出（S/4 增强 RFC_READ_TABLE 的 describe 交叉印证）

1. catalog 可见性：describeRfm/callRfm 在 focused 运行时 catalog。
2. describeRfm RFC_READ_TABLE：11 个参数（含增强形态的
   USE_ET_DATA_4_RETURN/ET_DATA——与上轮元数据实测一致）；inputSchema
   required=[QUERY_TABLE]；allowlisted=true；FM 未被执行。
3. describe→call 组参闭环：describeRfm RFC_FUNCTION_SEARCH 发现导入参数
   FUNCNAME → callRfm 以 {FUNCNAME:'RFC_READ_TABLE'} 调用成功（元数据
   驱动组参的泛化语义闭环）。
4. callRfm RFC_SYSTEM_INFO：裸 RFM 透传保真——指纹在 RFCSI_EXPORT 结构内
   （RFCSYSID=S4H），不做扁平化（probeRfcSystem 才做归类）。
5. callRfm RFC_READ_TABLE：透传载荷（含 USE_ET_DATA_4_RETURN='X'）读回
   ET_DATA 2 行（LINE 列分隔文本）。
6. 安全负例：BAPI_USER_GET_DETAIL（remote-enabled 但不在白名单）被
   RF_CALL_NOT_ALLOWED 拒绝。
7. 参数负例：非法 FM 名参数层 InvalidParams 拒绝。

## 门禁记录

- Jest：153 suites / 1440 tests 全绿（本能力新增 10 例：处理器分派 10 +
  allowlist 扩充断言更新；describe 纯映射经处理器用例覆盖）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 边界与遗留

- 无系统残留（全部调用为只读系统 RFM 与元数据查询）。
- callRfm 的安全面 = 默认只读 allowlist（7 个 SAP 标准 RFM）；业务自定义
  只读 RFM 经 `createDefaultFmAllowlist(extra)` 注入扩展（按部署分层放
  开），不在默认集合开放。
- RFC_SIMULATE_AUTH_CHECK 已入白名单（授权模拟探测的输入面就绪），其结
  果语义化呈现（结构化授权判定报告）为后续独立轮次。
- 表/结构参数的行结构展开（inputSchema 深度化）为可选增强，当前以
  associatedType 引用。
