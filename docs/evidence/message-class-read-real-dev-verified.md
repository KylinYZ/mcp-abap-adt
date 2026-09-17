# 消息类文本只读工具真机验证（read.message-class-texts → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/message-class-read-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 messageclass 资源 GET，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 GAP → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/MessageClassReadApi.ts`：VSP `pkg/adt/client.go` GetMessageClass
  （L998-1021）与 `pkg/adt/i18n.go` GetMessageClassTexts（L122-146）的只读移植：
  - GET `/sap/bc/adt/messageclass/<名（小写、路径转义）>`，
    Accept `application/vnd.sap.adt.mc.messageclass+xml`；
  - 可选 `sap-language` qs 参数覆盖登录语言（VSP OverrideLanguage 同义）；
  - XML 解析按属性名后缀容错匹配（兼容 `mc:msgno` 与无前缀形态），消息号
    以字符串保留前导零（对该解析关闭 fast-xml-parser 属性数值化）；
  - 名字白名单：最长 20 位、可选单级命名空间 /NS/NAME（对齐
    objectcreator.ts MESSAGE_CLASS maxLen 口径）。
- `src/handlers/MessageClassReadHandlers.ts` + `src/index.ts` 接线；
  ToolProfiles（workbench 显式名单）与 ToolOperationPolicy（read-only 类）同步。
- 写入方向（VSP WriteMessageClassTexts，i18n.write）刻意不移植，维持缺口。

## 真机 smoke 输出

1. catalog 可见性：getMessages 在 focused 运行时 catalog。
2. 标准消息类 `00`：读回 **901** 条消息，msgno 前导零保留（"000"/"001"/"002"），
   按号升序，count 与数组一致，文本为字符串。
3. 语言覆盖：`language=EN` 与 `language=DE` 均成功，返回体回显语言键；
   901 条 DE/EN 对比文本差异 0 条（该系统两类文本一致，仅记录不判定失败）。
4. 负例：`messageClass="A';--"` 与 `language='CHN'` 均在参数层被
   InvalidParams（-32602）拒绝，零网络往返。

## 过程中发现并修复的问题

- 属性数值化：fast-xml-parser 默认把 `mc:msgno="001"` 解析成数字 1，丢失前导
  零——已对消息类解析关闭 `parseAttributeValue` 并补前导零断言。
- 负例层级：名字/语言白名单预检上移到处理器参数校验（InvalidParams 而非
  InternalError），API 层保留为纵深防御。

## 门禁记录

- Jest：138 suites / 1315 tests 全绿（本能力新增 16 例：API 8 + Handlers 8）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 GET）。
- i18n.write 维持 PARTIAL（RESTRICTION 方向不做）。
