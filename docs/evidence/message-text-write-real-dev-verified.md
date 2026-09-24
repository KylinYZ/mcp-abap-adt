# 消息类文本受控写入——真实 DEV 端到端验证证据

- 日期：2026-09-24
- 系统：sap-demo（10.30.254.48:8001，client 300，单机 HANA+应用，专用 DEV）
- 工具链：`previewMessageTextChange` → `applyMessageTextChange` → `getMessageTextChangeStatus`
- 脚本：`npm run test:message-text-real-dev`（`scripts/message-text-real-dev-smoke.mjs`）
- 结论：**SMOKE OK**——受控创建 → plan 冻结 → 对象锁 → PUT → readback → 同值短路 → 受控清理 → absence 零残留，全链真机通过

## 验证序列（终版 smoke 输出）

```text
PASS 消息类 ZMCTEXTSM7486 受控创建完成
PASS plan 冻结（old=0 条 → new=2 条）
PASS apply 成功（newTexts=[001 "Message text smoke A", 002 "Message text smoke B"]）
PASS 同值短路：status=success sameValue=true（未锁未写）
PASS absence 复查通过（零残留）
SMOKE OK
```

## 真机协议事实（排障实验确立，写入代码注释）

1. **消息级 LOCK_MSG 与对象级 `_action=LOCK` 双向 EU510 互斥**：消息类的对象锁是
   msgno 初值的泛型锁（锁全部消息）。先对象锁后 LOCK_MSG 报"当前编辑 … 001"，
   先 LOCK_MSG 后对象锁报"当前编辑 <类名>"。两个方向均在真机复现。
2. **PUT 只认对象级锁句柄**：query `lockHandle` 传消息级句柄时服务端报
   "Resource 消息类 X is not locked (invalid lock handle)"。
3. **PUT 的 Content-Type 必须是 `application/*`**：`application/vnd.sap.adt.mc.messageclass+xml`
   形态 PUT 返回 200 但服务端**静默忽略**（历史多轮"写入未生效"的根因）。
   本仓库受控创建链 `setObjectSource`（XML → `application/*`）早已真机验证通过，
   本次对齐该契约。
4. **GET Accept 必须是裸媒体类型**（不带 charset），带 `charset=utf-8` 直接
   4xx "The message content is not acceptable"。
5. **消息行形态**：富属性（`mc:msgno/mc:msgtext/mc:selfexplainatory/mc:documented/
   mc:lastchangedby/mc:lastmodified/adtcore:name`）+ 两条 atom:link 子元素，
   与受控创建链 appendMessages 同源，真机已被服务端接受。
6. **锁生命周期**：LOCK_MSG 锁绑定 stateful 会话，logout 不释放、跨会话
   UNLOCK_ALL 不释放（200 但无效），只能显式 UNLOCK 带句柄或等服务端会话
   回收（本系统约 30–60 分钟）。对象锁用标准 `UNLOCK+lockHandle` 可靠释放。
7. **解析器单元素折叠**：fast-xml-parser 对单消息消息类返回对象而非数组，
   `parseMessageClassTexts` 已归一化（否则单消息类 readback 恒为空）。

## 工作流锁序（最终）

```text
对象 LOCK（accessMode=MODIFY）→ GET（裸 Accept + Accept-Language）
→ 注入富属性行 → PUT（Content-Type: application/*，query lockHandle+corrNr）
→ readback 比对 → UNLOCK（finally 必释，失败不掩盖主结果）
```

失败语义：PUT 发出后异常按 `UNKNOWN_OUTCOME` 终止（不自动重试），底层错误
文本透传（errorSummary 审计 + message 便于排障）。

## 排障期间残留与清理

| 对象 | 状态 |
| --- | --- |
| ZMCTEXTSM6657 / 3465 / 1949 / 1616 | 已受控清理并 absence 复核通过 |
| ZMCTEXTSM7846 | 排障期泄漏的消息锁阻塞对象锁，等 SAP 端会话超时后执行 `previewRepositoryObjectCleanup`（MESSAGE_CLASS）+ apply 即可 |

## 门禁

- `npm test -- --runInBand`：162 suites / 1548 tests 全绿
- `npm run build`：通过
- `npm run check:repository-creation-coverage`：REAL_DEV_VERIFIED=28，证据零缺失
- `npm run check:vsp-capability-parity`：71 行校验通过（晋级后 MCP_SUPERSET=12）
