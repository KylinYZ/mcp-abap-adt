# 受控对象重命名一站式工作流——真实 DEV 验证证据

日期：2026-09-22
矩阵行：`refactor.rename`
状态变更：PARTIAL → **MCP_SUPERSET**（evidence + real-dev-verified）
脚本：`scripts/rename-controlled-real-dev-smoke.mjs`（npm run test:rename-controlled-real-dev）
目标系统：sap-demo 专用 DEV（10.30.254.48/300，用户 068157，传输 S4HK900009）

## 能力构成

一站式受控重命名工作流（rename-controlled-write），三个工具：

| 工具 | 语义 | 门控 |
| --- | --- | --- |
| `previewControlledRename` | 只读预检：服务端解析源 URL 读源快照 → 本地声明改名 → 冻结 immutable rename plan（源 hash + 改名后源码 + payloadHash + 旧对象身份） | read-only，DEV 受控 profiles |
| `applyControlledRename` | 原生表单确认后单次执行两步：①克隆工作流落地新对象（受控创建链保证：壳创建/锁/写/语法检查/激活/源码 hash 比对/失败补偿）②受控清理链删除旧对象 | advanced-mutation（destructiveHint），仅 DEV + development/development-workbench |
| `getControlledRenameStatus` | 本地 plan 状态查询 | local-only |

一次确认覆盖"创建新对象+删除旧对象"两步（删除是重命名语义的固有组成，
确认消息显式标注两步副作用）。

## 与 VSP RenameObject 的关系（MCP_SUPERSET 依据）

VSP `pkg/adt/workflows_fileio.go` RenameObject（L28-210）：GetSource → 全文
字符串替换（大小写两遍 ReplaceAll）→ CreateObject → Lock/UpdateSource →
Activate → DeleteObject，直写无确认，失败路径把错误堆进 errors 数组返回。

本项目在其之上叠加整条受控链：immutable plan、上下文绑定重放拒绝、一次
原生确认、克隆侧受控创建链全部保证、删除侧受控清理链（身份/依赖/传输
校验与独立确认语义）。语义差异：

- 声明改名按对象类型精确锚定（REPORT/CLASS/INTERFACE 词边界正则，类两处
  同步），拒绝 VSP 全文盲目 ReplaceAll 的误伤面；
- 防御语义（对齐 VSP 激活未证实不删除旧对象的教训并加强）：创建失败绝不
  触碰旧对象（旧对象是唯一存活副本）；删除失败且缺席复核未证实旧对象已
  不在时按 PARTIAL_RENAME 收敛（双对象保留、如实报告、不自动重试不回滚）。

## 真机验证记录（2026-09-22，sap-demo 专用 DEV）

对象：`ZVRENOLD6375` → `ZVRENNEW6375`（Z001 包，传输 S4HK900009）
全部 7 项断言 PASS，输出 SMOKE OK：

1. 旧对象受控创建（immutable plan + 原生确认 + APPLIED）。
2. `previewControlledRename` 冻结：oldName/newName/packageName 一致、默认
   描述 `Renamed from <old>`、`declarationChanges=1`、hash 齐全、零写路径。
3. `applyControlledRename` 单确认两步执行成功。
4. 新对象 readback 独立直读与改名后期望逐字一致。
5. 旧对象 absence 复查通过（已删除）。
6. 新对象受控清理 + absence：系统零残留。
7. `getControlledRenameStatus` 本地复查 SUCCEEDED。

## 真机发现与修复（两处）

1. **传输证据校验在子任务聚合形态下失败**：删除动作实际已生效（REPOSRC
   无 A 版记录、objectStructure 不存在）后，清理链的传输证据分类在
   `transportDetails(请求级)` 读不到挂在其子任务（E070.STRKORR 指向请求）
   名下的对象条目，key 组零匹配报 VERIFICATION_FAILED。首轮按设计收敛
   PARTIAL_RENAME（防御语义正确工作）。
2. **修复（缺席复核收敛）**：删除侧失败时追加只读缺席复核（与 preview
   读源同一通道）。关键适配：本项目 ADT 客户端把非 2xx 转成
   AdtErrorException（状态码在 `err` 字段，消息本地化为中文"没有找到角色"），
   按状态码（`err`/`status` 双兼容）而非消息文本判定；409/403 与网络层异常
   保守不判缺席。缺席成立则收敛 SUCCEEDED 并在审计与返回中显式注明
   `deleteVerifiedBy: absence-recheck` 与替代证据说明（TADIR 残登记由 SAP
   后台作业回收）。修复后真机一次通过，零 PARTIAL。

## 自动化与接线

- 16 个 mock 用例（工作流 11 + 处理器 5）：plan 冻结、双委托顺序、
  PARTIAL 防御、缺席复核收敛（HTTP 形态 + ADT err 形态）、409/网络异常
  保守路径、创建失败不触碰旧对象、非法入参族、上下文重放拒绝、确认门。
- 接线：index.ts（controlledAdvancedTools 面 + dispatch）、ToolProfiles
  （workbench 显式名单 +3）、ToolOperationPolicy（read-only +1 / local +1 /
  advanced-mutation +1 / CONTROLLED_RENAME_TOOL_NAMES 专属门控 + 角色可见性）、
  serverGuardrails（applyControlledRename/getControlledRenameStatus 豁免外层
  gate——确认型工具，防 maxConcurrentTools=1 自我死锁）。
- 门禁：Jest 159 suites / 1526 tests、build、check:repository-creation-coverage、
  check:vsp-capability-parity、git diff --check 全绿。

## 环境切换说明

本轮真机验证从 sap-dev.env 切换到 **sap-demo.env**（所有者指示：后续所有
测试改用 sap-demo MCP 服务，传输号仍 S4HK900009）。sap-dev 上传输 S4HK900009
对 Z001 不可用（探针确认该系统 E070 中无此请求），sap-demo 上确认可用
（TRSTATUS=D，用户 068157）。
