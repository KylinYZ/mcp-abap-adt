# RFC 探测只读工具真机验证（rfc.remote-enabled.discovery → EQUIVALENT）

- 日期：2026-09-18
- 环境：专用 DEV（10.30.254.48，client 300，用户 068157；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`；RFC 直链
  host 10.30.254.48 + sysnr **01**（网关 3301），与 .vsp.json rfc_sysnr 实测一致）
- 方式：`node ./scripts/rfc-probe-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层为 open-rfc 直连网关的
  RFC_PING + RFC_SYSTEM_INFO，零写操作）
- 结果：**SMOKE OK**（耗时 3442ms），全部断言 PASS。矩阵行 PARTIAL →
  **EQUIVALENT**（evidence + real-dev-verified）。

## 实现范围（所有者放开 RFC/helper 方向后的首个落地）

- `src/rfc/open-rfc-transport.ts`：open-rfc（npm `open-rfc@0.2.3`，纯 TS
  classic RFC 客户端，与 VSP 的 open-rfc-go 同源同协议）适配为
  `TransportAdapter`——阶段 0 的接口校验/白名单/连接池上层全量接通真实网络：
  - 错误分级：open-rfc 网络/登录/系统故障 → RFC_TRANSPORT_FAILURE（池剔除）；
    FM 侧 RAISE 的 ABAP 异常 → RFC_ABAP_EXCEPTION（新错误码，连接不剔除）；
  - 连接参数由既有 ADT 环境推导（SAP_URL 主机 + SAP_CLIENT + SAP_USER/
    SAP_PASSWORD + RFC_SYSNR 覆盖，缺省 '01'），不引入第二套凭据。
- `src/handlers/RfcProbeHandlers.ts`：`probeRfcSystem` 工具——RFC_PING 连通
  + RFC_SYSTEM_INFO 系统指纹，allowlist 门控（RFC_PING/RFC_SYSTEM_INFO/
  RFC_READ_TABLE），探测失败不抛错（discovery 语义）。
- `src/rfc/errors.ts`：RfcErrorCode 联合新增 RFC_ABAP_EXCEPTION。
- 通道侦察（rfc-channel-recon 探针，2026-09-18）：经典 RFC 网关 3200/3300
  ECONNREFUSED（容器仅暴露 8001 HTTP）；SOAP-RFC 桥可用但被正确路线取代——
  RFC 直链 sysnr=01（.vsp.json rfc_sysnr 实测值）。

## 真机 smoke 输出

1. catalog 可见性：probeRfcSystem 在 focused 运行时 catalog。
2. RFC_PING：直连网关连通（ping=true）。
3. RFC_SYSTEM_INFO 全量指纹：sysid=S4H、release=816、host=sapides、
   dbsys=HDB、ip=10.30.254.48、kernel=916、instance=01。
4. 只读门控的结构性证明：工具无入参、固定调用面（RFC_PING/RFC_SYSTEM_INFO），
   无法携带任意 FM 名。

## 过程中发现的环境/库行为（已适配）

- open-rfc CPIC logon 要求语言为单个 ASCII 字母：中文简体内部码为数字 '1'
  被拒——RFC 会话语言固定 'E'（仅影响 RFM 消息文本语言，与工作语言解耦是
  RFC 生态通用做法）。
- ZH 的 2 位 ISO 输入 languageIsoToSap 转换正常（'1'），但后续字母校验拒绝
  数字；固定 'E' 后该路径不再触发。

## 门禁记录

- Jest：149 suites / 1422 tests 全绿（本能力新增 13 例：SOAP 版删除后重建为
  open-rfc 适配版）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（RFC_PING/RFC_SYSTEM_INFO 均为无副作用系统 RFM）。
- RFC_SIMULATE_AUTH_CHECK 授权模拟探测、RFC_READ_TABLE 表读取（P1
  rfc.remote-enabled.read-table）为后续轮次候选。
