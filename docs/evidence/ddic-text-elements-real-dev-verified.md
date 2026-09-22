# 受控文本池/数据元素标签写入 REAL_DEV_VERIFIED 证据

日期：2026-09-22
目标：SAP DEV（sap-demo 基线）10.30.254.48 client 300
能力：`previewDdicPropertyChange` / `applyDdicPropertyChange`（kind=`SET_TEXT_ELEMENTS` 与 `SET_DATA_ELEMENT_PROPERTIES`）
smoke：`scripts/ddic-text-elements-real-dev-smoke.mjs`（`npm run test:ddic-text-real-dev`）
最终结果：SMOKE OK，14 项断言全 PASS，零残留
矩阵落点：`report.text-elements` PARTIAL → MCP_SUPERSET；`i18n.write` PARTIAL 收窄（write_labels 侧已验证）

## 验证内容（A 段：SET_TEXT_ELEMENTS）

自建 `PROGRAM ZDDCSMK6327`（包 Z001，传输 S4HK900009）：

1. 负例：非法 category 被验证层以 VALIDATION_FAILED 拒绝（不产生 plan）。
2. preview：向空文本池写入 TEXT-001/002（maxLength=132），immutable plan 冻结（changedFields=["elements"]，含 drift hash、恢复快照、期望 hash）。
3. 原生确认 apply：锁→写→解锁→激活→readback hash 比对，plan 终态 APPLIED。
4. 独立 readback：focused `getTextElements` 直读文本池，TEXT-001/002 文本逐字匹配。
5. 同值短路：相同内容再 preview 被 "identical to the current SAP state" 拒绝。
6. 受控清理 + absence：零残留。

## 验证内容（B 段：SET_DATA_ELEMENT_PROPERTIES 标签修改）

自建 `DDIC_DOMAIN ZDDCDOM6327`（CHAR(10)）→ 自建 `DATA_ELEMENT ZDDCDTE6327`（引用该 domain，初始四段标签）：

1. preview：仅改四段标签，其余属性原样提交（整体替换语义防类型信息被抹），plan 冻结（changedFields=14 条）。
2. 原生确认 apply：锁→写→解锁→激活→逐路径 verify，plan 终态 APPLIED。
3. 独立 readback：`getDataElementProperties` 直读，四段标签逐字匹配。
4. 受控清理 + absence：先数据元素后 domain，双对象零残留。

## 本轮固化的协议事实（S/4 实测，写入方必读）

`SET_TEXT_ELEMENTS` 在 S/4 上成功写入需同时满足三个条件（缺失任一即失败）：

1. **stateful 会话**：锁句柄与会话绑定，stateless PUT 报 "This operation can only be performed in stateful mode"。
2. **锁 REPT 子对象**：写入锁必须挂在文本池资源自身 URL（`/sap/bc/adt/textelements/programs/<name>`）上；锁主程序 URL 会被 SAP 以 "Resource REPT ... is not locked" 拒绝。
3. **每符号 @MaxLength 指令**：载荷中每个文本符号前必须有自己的 `@MaxLength:<n>` 行；缺失或一条指令修饰多个符号都会触发 DS512"文本元素包含错误；请更正所有不一致"。调用方未给 maxLength 时协议层按 SE32 默认上限 132 兜底。

`SET_DATA_ELEMENT_PROPERTIES` 的 verify 语义修正：DDIC 属性写入是"部分更新 + 服务器合法回填"（SAP 补齐标签长度 10/20/40/55、布尔默认值、包描述，并把 responsible 数字化），提交形态与读回形态整体 hash 永不相等。verify 已改为"提交路径逐项匹配"（只断言计划提交的叶子路径在读回中值一致，回填字段不参与比对；文本池整体替换语义保留精确 hash）。

## 诊断过程要点（历史记录）

- 首轮真机 PUT 被拒后经 19 个载荷/锁变体实验定位：行分隔（LF/CRLF）、尾空行、charset、text/plain 媒体类型均非根因（服务端枚举确认仅接受 `application/vnd.sap.adt.textelements.symbols.v1`）；V9 空 body 在锁 REPT 后成功、V19 每符号 @MaxLength 成功并精确读回，完成根因闭环。
- 上游 abap-adt-api 8.4.3 的 `setTextElements` 与本项目移植版逐字节一致（移植无变形），其载荷布局在本系统同样不满足条件 3。
- 顺带修复两处产品缺陷：① `stableJson(undefined)` 会让 `stableHash` 抛 ERR_INVALID_ARG_TYPE（changedFieldPaths 深对比一侧键缺失时触发，标签场景实证）——undefined 显式归一 'null'；② `handleError` 未分类异常兜底不再吞栈（stack 走 stderr 便于定位 500）。

## 残留与清场

- smoke 自建对象（程序/domain/数据元素）全部受控清理并 absence 复查通过。
- 诊断期 3 个 $TMP 实验程序（ZTMP_TXTPOOL_PROBE/ZTMP_TP_PROBE2/ZTMP_TP_PROBE3）经 lock→DELETE 删除并 absence 复查通过（$TMP 对象不受验证传输管辖，走协议直删）。
- 目标指纹与历史轮一致（10.30.254.48|300|DEV）。

## 结论

`previewDdicPropertyChange`/`applyDdicPropertyChange` 的 `SET_TEXT_ELEMENTS` 与 `SET_DATA_ELEMENT_PROPERTIES` 两条受控链已在真实 DEV 端到端验证（含负例、同值短路、verify 回滚路径的真实触发与恢复）。`report.text-elements` 晋级 MCP_SUPERSET；`i18n.write` 的 write_labels 侧获真机证据，剩余缺口收窄为消息类文本写入。
