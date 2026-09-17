# SPOOL/后台作业只读二工具真机验证（diagnostics.spool-jobs → PARTIAL）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/spool-jobs-real-dev-smoke.mjs <sap-dev.env>`
  （MCP stdio 启动 `dist/index.js`；底层仅自由 SQL SELECT，零写操作）
- 结果：**SMOKE OK**，全部断言 PASS。矩阵行 GAP → **PARTIAL**
  （evidence + real-dev-verified；只读子集，非 EQUIVALENT，边界见下）。

## 实现范围

- `src/adt/SpoolJobApi.ts`：VSP `pkg/adt/spool.go`（SpoolRequests L73-165、
  spoolJobRefs L171-190、temseHeaders L192-216）与 `pkg/adt/jobs.go`（Jobs
  L69-191、jobStatusText L53-55）的自由 SQL 路径移植，走本项目 runQuery 的
  datapreview 通道（decode=true）：
  - `listSpoolRequests`：TSP01 清单 + TST01 头增补（storage/码页/行数/字节）
    + TBTCP 作业步骤反查（listident 补零 10 位，VSP padSpoolIDs）；
  - `listJobs`：TBTCO 清单（状态码+释义、计划/实际起止、时长、服务器）
    + TBTCP 步骤增补（程序/变体/用户/spool 号/外部命令）。
- `src/handlers/SpoolJobHandlers.ts` + `src/index.ts` 接线；ToolProfiles/
  ToolOperationPolicy（read-only 类）同步。
- 注入防线：名字类参数（owner/program/job/user）处理器层白名单（InvalidParams
  语义）、作业名放行 `*`/`%` 通配、LIKE 值引号转义 + 控制字符拒绝、日期格式
  校验、状态码白名单（P/S/Y/R/F/A/Z）。

## 刻意边界（矩阵记 PARTIAL 的原因，随结果 notes 返回）

- spool 内容读取（TST03/TemSe 块解码 + 码页/列表格式转换，VSP pkg/temse 约
  209 行）未移植；
- 作业日志：TemSe 对象大多存文件，VSP 经 RFC/XBP 读取——本项目暂无 RFC 传输
  （矩阵 rfc.* 行；2026-09-17 规划修订后阶段 1 基座定为 open-rfc，
  落地后此边界可解除）。

## 真机 smoke 输出

1. catalog 可见性：listSpoolRequests/listJobs 在 focused 运行时 catalog。
2. listJobs（近 7 天窗口）：50 个作业；样例 `/IWXBE/EVENT_STATISTICS`
   status=F(finished)、步骤 1（程序 /IWXBE/R_CRP_EVENT_COLLECTION）。
3. listSpoolRequests（近 7 天）：50 个请求；样例 #23200 owner=DDIC doc=LIST
   storage=D codepage=4103 lines=1 bytes=1434 job=SAP_MM_PUR_PO_AND_IR_FROM_QTN。
4. 交叉印证：作业步骤的 spool 号与 spool 清单对照（同表数据两条路径）。
5. 负例：`name='A\nDROP TABLE tbtco'` 在参数层被 InvalidParams 拒绝（零网络）。

## 过程中发现并适配的端点缺陷

- **tbtco/tbtcp 的 WHERE+ORDER BY 组合确定性报解析错**：`"DES" is not allowed
  here. "." is expected.`（DESCENDING 段在 WHERE 之后被解析器丢弃/截断）；
  tsp01 同型查询正常。已实测验证：同表无 WHERE 的 ORDER BY、无 ORDER BY 的
  WHERE、逐列组合均正常，仅组合形态失败。
- 适配：`runWithOrderFallback`——先按 VSP 原样（WHERE + ORDER BY）尝试，失败
  则回退 WHERE-only + 客户端排序，并在结果 notes 如实标注（此时排序作用于取
  回的 limit 行内，非全表 top-N）。spool 主查询（tsp01）不受影响。
- 另修复负例层级：名字白名单预检从 API 层上移到处理器参数校验（InvalidParams
  而非 InternalError），API 层保留为纵深防御。

## 门禁记录

- Jest：136 suites / 1299 tests 全绿（本能力新增 21+8 例：API 13 + Handlers 8）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`、`git diff --check` 全绿。

## 遗留

- 无系统残留（全程只读 SELECT）。
- spool 内容读取与作业日志（RFC/XBP）维持边界；解除条件写入矩阵行 liftCondition。
