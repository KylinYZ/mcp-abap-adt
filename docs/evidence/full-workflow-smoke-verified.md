# 完整工作流测试（0.9.0 全链真机回归）— 证据与发现

日期：2026-09-30。系统：sap-demo（10.30.254.48:8001，client 300，Basis 7.58，专用 DEV）。
授权：所有者 2026-09-29/30 会话指示（使用 sap-demo 跑完整工作流测试；阶段 3 全跑；
"删对象→请求变空→清理链放行"闭环假设按 SAP 实际语义修正，见发现 D6）。
覆盖来源会话：0.9.0 MCP v2 双栈迁移、受控传输创建/清理链、受控创建链传输登记门禁。

## 一、阶段结果（全部 SMOKE OK / PASS）

| 阶段 | 内容 | 结果 |
| --- | --- | --- |
| 0 | 离线基线：jest 全绿、build、coverage、diff --check | PASS（含发现 D1 修复后终验 178 suites / 1907 tests 全绿） |
| 1 | MCP v2 双栈：discover 676ms、modern/legacy 双 era 各 162 工具、focused=workbench、禁用工具零暴露 | PASS |
| 2 | 只读基线 9/9（query 限流/缓存/FIFO 串行）+ focused 只读 5/5 | PASS |
| 3 | MRTR 确认链×3：message-text（ZMCTEXTSM2993）、rename（双确认嵌套）、description | 全 SMOKE OK，零残留 |
| 4 | 受控传输创建链：全断言（$TMP 拒/确认两分支/读回/重复 apply 拒/E070 对照/自清理 S4HK900027） | SMOKE OK |
| 5 | 受控创建链×传输登记门禁（新代码首证）：脚本 `scripts/full-workflow-stage5-creation-gate.mjs` | SMOKE OK（发现 D3 修复后） |
| 6 | 恢复链：预造残局→apply FAILED→绑定清理→POLICY_DENIED/PLAN_NOT_FOUND 负例 | SMOKE OK |
| 7 | 传输清理链红线：S4HK900029 含 5 条历史登记 → preview 拒 `VALIDATION_FAILED` | PASS（红线正确生效） |

## 二、阶段 5 门禁语义真机首证（本轮核心交付）

- **preview 透出 `transportValidation`**（位置 `review.transportValidation`）：
  `{"requestCheck":{"channel":"ADT_TRANSPORT_DETAILS","modifiable":true,"status":"D"},
  "packageCompatibility":"SAP_CONFIRMED","notes":[],"attempts":[]}`。
- **负例 A**（不存在请求号 ED1K999999）：双通道皆败 → preview 拒 `TRANSPORT_INVALID`、零 plan。
  修复 D3 后拒绝语义升级为正确归因："Transport … was not found in E070"（E070 通道真正参与判定）。
- **负例 B**（已释放请求）：sap-demo 无 TRSTATUS='R' 样本，按红线不释放任何请求，如实跳过。
- **正例**：指定 S4HK900029 创建 PROGRAM → apply → plan 终态 **APPLIED**（创建链终态语义，
  区别于传输链的 SUCCEEDED）→ 外部佐证双通道：`getTransportScope` 成员含 R3TR PROG +
  E071 SQL 行（TRKORR=子任务 S4HK900030，OBJFUNC=''，LOCKFLAG='X'）。
- **执行门豁免**：确认型 apply 在串行门（maxConcurrentTools=1）下全部无死锁完成。

## 三、发现与修复（D1–D7）

**D1（目录缺口，已修）** `getUsageExamples` 已入 workbench/policy 但漏 operations-readonly，
而能力矩阵已声明该角色 → `ToolProfiles.ts` 补录（operations 53→54），`ToolCatalogIntegrity`
计数同步；`focused-entrypoint-smoke.mjs` 硬编码 158 过期 → 同步 162。

**D2（smoke 误连系统，已修）** `description-real-dev-smoke.mjs` 硬编码 `sap-dev.env`（ED1 7.51），
违反"smoke 默认 sap-demo.env"（2026-09-22 指示）→ 改 argv + sap-demo 默认 + 红线预检。
顺带产出 ED1 偶然观察（见 D7）。核查其余脚本：message-text/rename/recover/transport-*
均指向 sap-demo，PASS 有效。

**D3（runQuery 未绑定提取，已修）** `AbapObjectCreationWorkflow` 两处
`const runner = this.client.runQuery` 裸引用提取 → 调用时 `this` 为 undefined →
`reading 'h'` TypeError → E070/E071 SQL 通道恒死（门禁误判"两路皆败"，归属证明静默退化
ADT 备通道）→ 改 `?.bind(this.client)`，新增原型形态回归测试。

**D4（transportDetails 解析缺口，已修）** ADT 响应把对象条目放在请求级 `<tm:all_objects>`
包装下（条目属性 `tm:pgmid/tm:type/tm:name`，**无 tm:obj_func**），解析器只找直接子级
`tm:abap_object` → objects 恒空 → 清理链核验"看不见"任何条目。`parseRequest` 兼容两种
形态；新增 `TransportsParser.test.ts`（真机 XML fixture）。

**D5（清理键与去重，已修）** ① PROGRAM 的 transportInfo 锁键是 LIMU/REPS（include 源级）
而登记条目是 R3TR/PROG（主对象级）→ `expandCleanupTransportKeyAliases` 补 R3TR/PROG 别名
（与函数组 REPS→FUGR 同构）；② tm:all_objects 把请求级与任务级视图合并输出（同一对象
逐字节重复两条）→ 传输条目按 pgmid|type|name 三元组去重后再核验。修复后
1800/3445 完整走通 preview→确认→删除→absence（plan 成功）。

**D6（SAP 真机语义，记录不改码）**
- 对象删除后 **E071 登记行不消失**（OBJFUNC 保持 ''，删除也是请求内变更）——
  含对象历史的请求永远无法回到"零对象"，传输清理链红线（正确地）拒绝删除。
  "删对象→请求变空→清理链放行"假设不成立，属主只能 SE09 处置此类请求。
- 受控对象清理链只接受归属于**配置校验传输**（`SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT`，
  sap-demo=S4HK900009）的对象；清扫本战役对象时以 env 覆盖指向 S4HK900029（本战役
  自建、未释放、本人属主），边界不放宽。
- ADT `deleteObject`（对象登记在开放任务时）删除源码但**遗留 TADIR 孤儿行**——
  目录残留无害，随请求删除一并回收。

**D7（ED1 偶然观察，preview-only 零写入）** D2 修复前两次误连 ED1（7.51）：
新门禁在 ADT transportDetails（7.51 无 URI 映射）与 datapreview E070 通道皆败时
正确拒绝并给出双端点 `transportAttempts` 诊断——7.51 降级安全语义得到一次意外真机佐证；
完整降级路径仍按计划留 ED1 验证（`creation-transport-gate-751-compat.md` 第 5 节）。

## 四、残留记账（属主处置清单）

| 对象/请求 | 状态 | 处置 |
| --- | --- | --- |
| ZPRGWF0447/0864/1295 | 源码已删，TADIR 孤儿行 | 随 S4HK900029 删除回收（SE09） |
| ZPRGWF1800/3445 | 已受控删除 + absence | 无 |
| S4HK900029（+子任务 S4HK900030） | 未释放 D、属主 068157、E071 含 5 条中性历史行 | **SE09 手工删除**（清理链红线正确拒绝） |
| S4HK900009–016 | 战役前既有（各 smoke 共用锚定传输） | 维持现状 |
| S4HK900027 及全部 smoke 自建对象 | 本轮自清理 + absence | 无 |

## 五、验证分类

- **真机已验证（sap-demo）**：本文全部阶段与 D3–D5 修复的对应路径。
- **自动化已验证**：178 suites / 1907 tests 全绿（含本轮新增 TransportsParser 2 例、
  绑定回归 1 例）、`check:repository-creation-coverage` 28 REAL_DEV_VERIFIED 零缺证据。
- **未验证 / 待环境**：ED1 7.51 全链（降级路径 + E070 通道可用性，待对方用户复测）、
  npm publish（用户定时机）、ZCode 0.16.9 auto 终验（无复现环境）。

## 六、复跑入口

```powershell
npm test -- --runInBand && npm run build
node scripts/mcp-v2-dual-era-smoke.mjs
node scripts/sap-dev-readonly-smoke.mjs "C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env"
node scripts/message-text-real-dev-smoke.mjs
node scripts/rename-controlled-real-dev-smoke.mjs
node scripts/description-real-dev-smoke.mjs
node scripts/transport-creation-real-dev-smoke.mjs
node scripts/full-workflow-stage5-creation-gate.mjs          # 自建 TR_NEW 全闭环
node scripts/recover-failed-create-real-dev-smoke.mjs
node scripts/full-workflow-residue-cleanup.mjs <校验传输号> <对象名...>   # 残留清扫
node scripts/transport-cleanup-real-dev.mjs "C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env" <空请求号...>
```
