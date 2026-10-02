# 受控程序文本池写入链（F1 完整方案）真机验证

日期：2026-09-30。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。

## 交付

`previewTextPoolChange` / `applyTextPoolChange` / `getTextPoolChangeStatus` 受控三件套（TextPoolWorkflow，复刻 MessageTextWorkflow 安全模型：immutable plan + 原生确认 + stateful 锁链单次执行 + readback + UNKNOWN_OUTCOME 终止 + 同值短路）。仅 DEV + development/development-workbench；分类 CONTROLLED_TEXT_POOL_TOOL_NAMES（read-only/advanced-mutation/写槽特判/DEV 门/workbench 门/执行门豁免全链注册）。

执行协议沿用 F1 最小方案固化的 text/plain 真机口径（@MaxLength 协议不变）；对象锁由 server 会话持有（真机实证跨会话句柄被拒）。

## 真机结果：SMOKE OK（`npm run test:textpool-controlled-real-dev`）

写链自造数据：直连 ADT 创建自有验证程序 ZWTPOL0714（引用 TEXT-001/002）+ 激活。

```text
PASS 受控文本池三件套在 focused catalog
INFO plan=9f44fe87… old=0 new=2
PASS preview 冻结受控 plan
PASS apply 执行成功（readback 核验通过，sameValue=false）
PASS status=SUCCEEDED
PASS 同值短路：sameValue=true（不锁不写）
PASS 收尾：靶对象直连删除 + 缺席复核通过
SMOKE OK
```

负例断言（mock）：非法 id/长度/重复 id 按 category 规则拒绝；跨上下文 plan 重放拒绝；双 false 开关拒绝。

## 边界

- ZTABDATA_TOOL 的 17 条选择文本实战写入（D1 验收场景）属所有者对象操作，留所有者确认后执行；本轮真机验收使用自建验证程序。
- 受控清理链对本靶对象不适用（直连创建无锁条目登记，TRANSPORT_INVALID）——收尾用直连删除 + 缺席（与 usage-examples 轮同先例）。

## 门禁

- `npm test -- --runInBand`：180 suites / 1965 tests 全绿（新增受控工作流/分类门用例）
- `npm run build`、`npm run check:repository-creation-coverage`、`npm run check:vsp-capability-parity`、`git diff --check` 通过
