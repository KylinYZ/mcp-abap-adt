# F1：程序文本池原子写纳入 focused profile——真机验证

日期：2026-09-30。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。

## 交付（所有者交接文档 F1 最小方案）

1. **focused/developer（development-workbench）入口纳入三个工具**：原子 `setTextElements`
   （RAW_ADVANCED_MUTATION，DEV 专属+写槽）及配套 `lock`/`unLock`（OTHER_MUTATION，
   DEV 专属）——"caller manages locking" 模式的锁句柄必须与写调用同 server 会话，
   缺锁工具则原子写在 focused 面不可用。
2. **分派门开口**：legacy 区域的"development/development-workbench 下非只读
   legacy 工具即拒"门为 `setTextElements`/`lock`/`unLock`（DEV + workbench）开口，
   其余非只读 legacy 工具照旧拒绝。
3. **协议修复（真机 415 取证）**：文本池 `/source/{category}` 端点**只接受
   text/plain**——`application/vnd.sap.adt.textelements.<category>.v1` 专用媒体
   类型的 PUT/GET 均被 415 拒绝（"Supported Media Types: text/plain"）。GET/PUT
   已对称修正；文本池本体就是源码形态（@MaxLength + KEY=TEXT 行），
   formatTextElements/parseTextElements 的 @MaxLength 协议（D1 真机固化）不变。

## 真机结果：SMOKE OK（`npm run test:f1-textpool-real-dev`）

```text
PASS focused 面运行时暴露 setTextElements（写工具标注正确）
PASS 靶程序直连创建+激活：ZWTXT2187
PASS setTextElements 写入 2 条文本符号（focused 面，同会话锁）
INFO 读回：[{"id":"001","text":"F1 冒烟文本一","maxLength":132},{"id":"002",…}]
PASS 读回断言：两条符号文本一致
PASS 收尾：靶对象删除 + 缺席复核通过
SMOKE OK
```

写链自造数据：直连 ADT 创建自有验证程序（源码引用 TEXT-001/002）+ 激活 →
MCP lock（同 server 会话拿锁）→ MCP setTextElements 写 2 条中文文本符号 →
MCP getTextElements 读回逐条断言一致 → MCP unLock → 直连删除 + 缺席。

## 排障过程记录

- 四层门逐层定位：catalog 可见（workbench 名单）→ assertToolOperationAllowed
  策略门（raw 族 legacy-full 专属）→ legacy 只读分派门（isReadOnlyLegacyTool）→
  协议 415。每层独立取证后修复。
- 策略门与分派门的放宽均限定 `setTextElements`/`lock`/`unLock` 三工具 + DEV 角色，
  其余 raw 族（setDomainProperties 等）维持 legacy-full 专属。
- 跨会话锁句柄不可用：直连会话拿锁 + MCP 面写会被 SAP 拒（锁属主绑定 HTTP 会话）
  ——必须走 MCP lock 工具（与写调用同 server 会话）。
- 残留锁（异常中断未解锁）会导致重入锁失败（"当前编辑"），等待锁超时或换新对象名。

## 门禁

- `npm test -- --runInBand`：180 suites / 1933 tests 全绿
- `npm run build`、`npm run check:repository-creation-coverage`、
  `npm run check:vsp-capability-parity`、`git diff --check` 通过

## 遗留

- 完整方案（`previewTextPoolChange`/`applyTextPoolChange` 受控工具对，复用
  formatTextElements 协议 + 受控工作流模式）为后续任务（F1 完整方案）。
