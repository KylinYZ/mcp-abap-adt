# 受控描述修改链真机验证（crud.set-description）

- 验证日期：2026-09-21/22
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 工具：`previewDescriptionChange` / `applyDescriptionChange` / `getDescriptionChangeStatus`
- 脚本：`scripts/description-real-dev-smoke.mjs`（自建对象全闭环）、
  `scripts/description-verify-smoke.mjs`（MCP 层复验）
- 语义来源：VSP `pkg/adt/description.go` SetDescription（第 83 行起）

## 结论

受控描述修改链在真实 DEV 系统端到端验证通过，矩阵行 `crud.set-description`
由 PARTIAL 晋级 **MCP_SUPERSET**（比 VSP 多 immutable plan、原生确认与
readback 保证）。

## 真机闭环结果

| 步骤 | 结果 |
| --- | --- |
| 自建对象受控创建（PROGRAM ZDESCSMK3，原描述 "Desc probe v3"） | PASS |
| `previewDescriptionChange` 只读预检（old/new 冻结 + payloadHash） | PASS |
| 原生确认（decision=apply）后单次执行 | PASS |
| readback（重读元数据核验 = "Desc smoke updated"） | PASS |
| 同值短路复验（相同描述再 apply → sameValue 路径） | PASS |
| 受控清理 + absence 复查 | PASS（零残留） |

真机返回的长度限制为动态值（limit=70，来自元数据 descriptionTextLimit）——
长度校验按对象实际限制执行而非硬编码。

## 真机发现并修复的缺陷

1. **stateful 会话要求**：描述修改的锁句柄存于 ABAP 会话内存，stateless 会话
   中 PUT 报 "This operation can only be performed in stateful mode"——受控链
   必须走 stateful ADT 会话（本项目主 ADTClient 默认 stateful，满足）。
2. **锁返回键形态**：ADTClient.lock 原始行是大写列名（`LOCK_HANDLE`），提取需
   归一化；并在协议层把句柄提取移入 try 块——提取失败时用 raw 大写键兜底解锁，
   避免 ENQ 锁泄漏（真机教训，修复前 ZDESCSMK2 曾被锁占用）。
3. **同值短路**：VSP 的 old == new 短路语义已移植（不锁不写）。

## 验证层级声明

- 真实 DEV 已验证：受控描述修改全链路（预检/确认/执行/readback/同值短路/
  清理闭环）。
- 范围：PROG/CLAS/INTF/INCL 四类（对齐 VSP DescriptionObjectURL 子集）；
  其他类型的描述修改不在本轮。
