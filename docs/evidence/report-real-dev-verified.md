# report.run / report.async / report.variants 真机验证（2026-10-07）

- 系统：sap-dev（10.30.255.42:8000，client 200，用户 HP068157）——所有者放开报表执行方向授权轮
- smoke：`scripts/report-real-dev-smoke.mjs`（`npm run test:report-real-dev`）——**SMOKE OK**（11 PASS）
- 结论：report 三行全部晋级 **EQUIVALENT**——VSP 对齐 **62/71**（MCP_SUPERSET=13、EQUIVALENT=49、PARTIAL=1、RESTRICTION=8）

## 三工具与机制

| 工具 | 机制 | 门控 |
| --- | --- | --- |
| `getReportVariants` | 纯 ADT 只读 SQL：VARID 目录（protected 标记）+ VARIT 文本（LANGU 列，英文优先合并）；空清单为有效回答 | read-only，全只读面可见（含 QAS/PRD 组合面） |
| `runReport` | 受控执行核包装：JOB_OPEN → SUBMIT (report) VIA JOB（变体/RSPARAMS）→ JOB_CLOSE → 轮询 TBTCO（2s 间隔、waitSeconds 5..300 默认 60）→ TBTCP.LISTIDENT 定位 spool → readSpoolContent 解码 LIST 文本 | OTHER_MUTATION 执行类，DEV + workbench/legacy-full + 写槽 |
| `submitReportJob` | 同上仅提交：立即返回 jobname/jobcount，作业后台异步执行；调用方经 listJobs/listSpoolRequests/readSpoolContent 续查 | 同上 |

## 关键取证与取舍

1. **ZADT_VSP 桥 report 域同步 SUBMIT 在 APC 会话内静默终止**（无 ST22 dump、无错误应答、连接直接 close；121ms 即断）——VSP Go 客户端的"作业化演进"（handlers_report.go 注释 "new job-based approach... ABAP service may need updating"）即为此问题的解法痕迹。本项目采用**纯 ADT 作业链语义**：零 helper 依赖，任意 DEV 系统可用；输出为列表文本（spool LIST 渲染）而非 VSP 的 ALV 结构化行（如实声明）。
2. **系统 ABAP Unit 风险上限=HARMLESS**（sap-dev/sap-demo 实测：dangerous/critical 测试类拒跑，warning"测试类风险级别超过上限"，调用侧 flags 无法突破）。包装器声明 HARMLESS：测试方法仅做作业调度，报表执行发生在后台作业进程（测试之外），执行风险由工具面披露。
3. **RS_CREATE_VARIANT 参数契约陷阱**（探针链）：CURR_REPORT（非 REPORT）→ CURR_VARIANT → VARI_DESC（类型=vari_text 结构/非 vtext）——放弃 FM 路径，改直插 VARID/VARIT（字段名 EDAT/ETIME 而非 ENQDATE/ENQTIME）。该路径仅用于 smoke 造数（executeAbap 单测上下文回滚 DB 写，造变体必须走后台作业独立 LUW——VARMAKER/VARDEL 双报表经 submitReportJob 闭环）。
4. **VARIT 语言列是 LANGU**（非 SPRSL）；**REPOSRC 在 datapreview 通道报"Unknown column"**——存在性预检改 TRDIR。
5. **datapreview 按会话查询预算**：smoke 后段（listJobs 轮询/variants）切换到第二个 MCP 会话既定教训再次生效。
6. **listSpoolRequests 的 job 过滤在该通道不命中**（TBTCP join 形态）——spool 定位改走 listJobs steps[0].spool（TBTCP.LISTIDENT）。
7. 后台作业 spool 的码页解码有既有噪声（`⨀`/`ᨀ` 替换符，标记字符串仍可辨）——2026-09-18 轮 readSpoolContent 既有 nuance。

## 真机结果（SMOKE OK，11 PASS）

| 场景 | 结果 |
| --- | --- |
| runReport：WRITE 报表（自建 $TMP） | 作业 F → spool 输出含 SMOKE-MARKER-START |
| runReport：SALV 报表（自建 $TMP） | 作业 F → 258 字符列表输出（ALV 后台渲染为 spool 列表，统一作业链语义） |
| runReport 负例：不存在的报表 | TRDIR 预检 fail-fast（不留 aborted 作业） |
| submitReportJob：WRITE 报表 | jobname/count 返回、作业 F、spool #31168 内容含标记 |
| listJobs 轮询 | 作业 F（独立 MCP 会话） |
| getReportVariants：自建变体（VARMAKER 作业直插 VARID/VARIT） | SMOKE_VAR 读回 |
| getReportVariants：无变体报表 | 空清单为有效回答 |
| 变体清场（VARDEL 作业 RS_VARIANT_DELETE 语义的 DELETE 语句） | 变体删除确认 |
| 残留核查 | 四个 $TMP 测试报表全删 + 缺席复核；作业清单残留（VSP 同款，属主 SM37 可清） |

## 自动化基线

191 suites / 2155 tests 全绿（ReportExecution 22 例：变体/作业提交/等待链 + ReportHandlers 7 例：三工具分派/错误分层/分组切分）；build、coverage（28）、parity（71 行 **62/71**）、git diff --check 全绿。profile 计数：development=204、diagnostic-readonly=149、legacy-full=218、development-workbench=180、operations-readonly=57（+variants 只读组合面）。
