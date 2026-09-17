# Spool 内容读取真机验证（diagnostics.spool-jobs 收尾）

- 验证日期：2026-09-18
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 脚本：探针式验证（listSpoolRequests 取样 → readSpoolContent 内容读取，全部只读）
- 语义来源：VSP `pkg/adt/spool.go` Spool()（第 302 行起）与 decodeHexCell（第 360 行）

## 结论

`readSpoolContent`（第三工具）补齐该行最后差距并真机验证通过，矩阵行
`diagnostics.spool-jobs` 由 PARTIAL 晋级 **EQUIVALENT**。至此该行四个 VSP
action 中 job_list/spool_list/spool_read 三者对齐；job_log（VSP 走 RFC/XBP）
属 rfc-transport-spike 方向后的接入范围，已在 restrictionReason 声明。

## 真机结果

| 工具 | 结果 | 真实数据 |
| --- | --- | --- |
| `listSpoolRequests`（复验） | PASS（18.6s） | 10 个真实请求；样例 #23674：LIST 类型、owner DDIC、TemSe SPOOL0000023674、storage=D、codepage=4103、1150 字节、产出作业 SAP_MM_PUR_PO_AND_IR_... |
| `readSpoolContent` | PASS（0.9s） | 查询链 tsp01→tst01→tst03（dpart/drowno 排序）；按 dcharcod=4103 UTF-16LE 解码，ABAP list 控制字节清理后取回 **568 字符可读文本**（真实报表标题 "Report to Create/Update Follow-On Documents for Quotation"、日期、结构线） |

## 真机发现并修复的缺陷

1. **双重引号包裹**：`quoteLiteral` 返回含引号的完整字面量，内容查询又手包一层
   → `''SPOOL...''` 触发 datapreview 解析错（"after ''"）。已去除手写外层引号。
2. **码页解码**：该 DEV 的 spool 内容为 UTF-16LE（dcharcod=4103），latin-1 近似
   产出乱码。已按 tst01.dcharcod 分支解码（4103/4110 → utf16le，其余 latin-1），
   并清理 ABAP list 控制字节（保留换行/制表）。mock 用例同步覆盖两条解码路径。

## 安全边界确认

- 全部只读（datapreview SELECT）；TemSe 名经 quoteLiteral（控制字符拒绝 + 引号
  翻倍）；spool 编号为服务端数字校验；零副作用、零传输操作。

## 验证层级声明

- 真实 DEV 已验证：spool 内容读取全链路（含真实 UTF-16 内容解码为可读文本）。
- 未验证/差异方向：OTF/二进制内容解码（返回 raw 说明）、ABAP list 精确排版
  还原（VSP temse.List 级）、job_log（RFC/XBP 方向）。
