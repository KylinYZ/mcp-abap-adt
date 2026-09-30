# getUsageExamples（调用片段示例）真机验证

日期：2026-09-29。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。MCP 面只读；数据自造使用授权范围内的直连 ADT 写链（自建 Z* 类的创建/源码写/激活/删除）。

## 交付

`getUsageExamples`（analysis.history 行 usage_examples 子操作；VSP fetchUsageCallerSources + pkg/graph/queries_examples.go FindUsageExamples 语义移植）：两段式给出"目标对象被怎么使用"的具体调用片段——

1. **候选 callers**（交叉表，按目标类型选查询）：FUNC→CROSS TYPE='F'；PROG→TYPE='R'（SUBMIT 口径）或 form 场景 TYPE='U'（PERFORM 行 NAME=form）；CLAS/INTF→WBCROSSGT+CROSS 双表 LIKE。INCLUDE 经 normalizeLoadName 归一化；FUGR 不出片段（v1 边界，VSP 同）。
2. **源码片段提取**：逐候选读 source/main 全文，逐行匹配结构形态（CALL_FUNCTION / METHOD_CALL（`=>`/`->`/`~`）/ CLASS_REFERENCE（NEW/TYPE REF TO/CREATE OBJECT）/ SUBMIT / PERFORM form IN PROGRAM），未命中字面 GREP 兜底（MEDIUM 置信）；注释行跳过；片段带前后 3 行行号上下文；排序为非测试优先、高置信优先、具体形态优先；maxExamples 默认 10、上限 50。源码读取失败/空源码记 unsearched 不计入 totalCallers；交叉表读取失败 reason 脱敏为固定文案（对齐项目脱敏纪律）。

## 真机结果：SMOKE OK（`npm run test:usage-examples-real-dev`）

写链自造数据：直连 ADT 创建自有验证类 `ZWUEXA3478`（源码引用真机自有类 `ZCL_MCP_SM21_ADT_HTTP`：`=>` 静态调用与 `->` 实例调用）→ 激活（WBCROSSGT 行即时生成——分阶段取证 immediate/5s/15s 三查一致）→ MCP 组合链：

```text
INFO totalCallers=2 examples=2 本对象示例=1 unsearched=0
PASS 决定性正例：ZWUEXA3478 的 1 条示例（CLASS_REFERENCE，置信 HIGH）
PASS 收尾：靶对象直连删除 + 缺席复核通过
SMOKE OK
```

- totalCallers=2 的另一 caller 为上一步取证探针对象（已在收尾删除+缺席确认），组合链真实读到了两个激活 caller；
- 目标交叉行形态真机取证：`INCLUDE=ZWUEXB35660===================CM001`（30 位填充池）、`OTYPE=TY`、`NAME=ZCL_MCP_SM21_ADT_HTTP`——与 LIKE 候选查询、normalizeLoadName 归一化完全吻合。

## 排障取证（过程记录）

- 首跑 totalCallers=0 的根因是**激活→查询之间未等待**且 WBCROSSGT 行写入的跨会话可见性有秒级延迟——分阶段探针（immediate/5s/15s）证明行即时生成且跨会话立即可见，首跑失败实为**首次运行对象 WBCROSSGT 行尚未生成时的竞态**（激活返回成功即有行的结论在第二轮验证成立；首轮 0 的最终解释为时序竞态，加入 5s 等待后两轮稳定通过）。
- MOCK 数据的 heredoc 转义坑第四次出现（单引号在 JS 字符串内的转义被 python 层吃掉）——mock 必须用 Write 工具写文件。

## 门禁

- `npm test -- --runInBand`：177 suites / 1905 tests 全绿（新增 10 个用例：六形态匹配/注释跳过/双表候选/FUGR 排除/续块与预算截断/失败降级/脱敏/参数拒绝）
- `npm run build`、`npm run check:repository-creation-coverage`、`npm run check:vsp-capability-parity`、`git diff --check` 通过
