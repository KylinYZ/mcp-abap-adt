# i18n 按语言只读四工具真机验证（i18n.read → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/i18n-language-read-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅 GET，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 PARTIAL → **EQUIVALENT**
  （evidence + real-dev-verified）。

## 实现范围

- `src/adt/I18nReadApi.ts`：VSP `pkg/adt/i18n.go` 四个只读函数移植：
  - `getObjectContentInLanguage` ← GetObjectTextsInLanguage（L61-78）：源 URL
    由 objectType+objectName 服务端解析（复用 RevisionSourceApi.
    resolveObjectSourceUrl），GET 带 sap-language 覆盖；
  - `getDataElementLabels` ← GetDataElementLabels（L80-120）：GET
    `/sap/bc/adt/ddic/dataelements/<名>`，Accept `vnd.sap.adt.dataelements.v2+xml`
    （通用类型 406，VSP L92-99 实测注释），解析 wbobj → dataElement →
    short/medium/long/headingFieldLabel；
  - `getTextPoolInLanguage` ← GetTextPoolInLanguage（L255-329）：三子资源
    symbols/selections/headings（Accept vnd.sap.adt.textelements.<子>.v1），
    key=value 行解析、@ 指令跳过、空文本保留、单子资源 404 记 missing 不报错；
  - `compareObjectLanguages` ← CompareObjectLanguages（L356-421）：双语内容
    按行对齐（line-N 键），只返回差异/缺失条目。
- `src/handlers/I18nReadHandlers.ts` + `src/index.ts` 接线；ToolProfiles
  （workbench 显式名单）与 ToolOperationPolicy（read-only 类）同步。
- 消息类文本按语言读取已由 getMessages 覆盖（read.message-class-texts 轮）；
  写入方向（i18n.write）维持缺口。
- ADT 行为差异如实透出：数据元素目标语言无翻译时以主语言应答（VSP L109-112），
  note 字段随结果返回。

## 真机 smoke 输出

1. catalog 可见性：四工具在 focused 运行时 catalog。
2. getDataElementLabels：标准元素 `LANGU` 读回四段标签（short=Sprache 等，
   EN/DE 均为德语原文——主语言回退行为，与 note 一致）。
3. getTextPoolInLanguage：RFITEMAP 解析 106 条文本池条目（I/S/H 分类），
   missing=[]。
4. getObjectContentInLanguage：RFITEMAP 读回 1412 行内容。
5. compareObjectLanguages：EN vs DE 双语行级对比，totalLines=1412、
   differing=0（纯代码行无语言差异，符合预期），differing 与 entries 一致。
6. 负例：非法语言键（CHN）与非法程序名（`Z';--`）均参数层 InvalidParams 拒绝。

## 门禁记录

- Jest：143 suites / 1352 tests 全绿（本能力新增 21 例：API 6 + Handlers 7 +
  定向补充 8）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 GET）。
- i18n.write 维持 PARTIAL（RESTRICTION 方向不做）。
