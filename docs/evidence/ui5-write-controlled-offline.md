# 受控 UI5 filestore 写链离线落地（ui5.write 关缺口，阶段 A）

日期：2026-10-04。基线：`main` @ `85c641c`（含本轮未提交改动）。范围：ADT 客户端写协议实现 + 受控工作流 + 离线 mock 全绿；**未连接 SAP**，真机 DEV 端到端 smoke（nextMilestone=`ui5-write-real-dev-smoke`）待另行授权，完成前矩阵行保持 `PARTIAL`。

## 交付

- `src/adt/Ui5FilestoreApi.ts` 扩展：四写操作 + `isAdtNotFound` + `normalizeUi5ContentType` + 写客户端绑定 `createUi5WriteClient`（协议对照 VSP `pkg/adt/ui5.go` @ `9886d272` L273-419）。
- `src/safe/Ui5WriteWorkflow.ts`：受控工作流（kind 分派四操作，plan 状态机对齐文本池链）。
- `src/handlers/Ui5WriteHandlers.ts`：三工具 `previewUi5Operation` / `applyUi5Operation` / `getUi5OperationStatus`。
- 门控接线：`CONTROLLED_UI5_WRITE_TOOL_NAMES`（仅 DEV + development/development-workbench）；preview 挂写槽（`CONTROLLED_WRITE_CHAIN_READONLY_TOOLS`）、apply 入 advanced-mutation、status 入 local；index.ts 写域 stateful 主会话绑定。
- 测试：`Ui5WriteWorkflow.test.ts`（16）、`Ui5WriteHandlers.test.ts`（7）、`Ui5FilestoreApi.test.ts` 写契约段（8）；全量门禁 185 suites / 2039 tests、`npm run build`、`git diff --check` 通过。

## 协议事实（对照 VSP ui5.go，逐字对齐）

| 操作 | 端点 | 载荷 |
| --- | --- | --- |
| create_app | `POST /sap/bc/adt/filestore/ui5-bsp/objects?corrNr=<t>` | `bsp:application` XML（adtcore:name/description/packageName），Content-Type application/xml |
| upload_file | `PUT {base}/<APP%2fPATH>/content` | 文件内容原样，Content-Type 自定（缺省 application/octet-stream） |
| delete_file | `DELETE {base}/<APP%2fPATH>` | 无 |
| delete_app | `DELETE {base}/<APP>?corrNr=<t>` | 无 |

- 路径转义用 `encodeURIComponent`（输出大写 `%2F`；VSP Go `url.PathEscape` 输出小写 `%2f`——服务器等价接受，现有只读三工具真机已证该转义通路）。
- **filestore 写不走 ABAP workbench 对象锁**（BSP 容器操作，VSP 同款无锁）；事务边界由 preview 冻结旧状态 + apply readback 比对补齐。
- 防线：应用名白名单（A-Z0-9_$，可选单级命名空间）+ 命名空间前缀过 `SafetyPolicy.assertReadAllowed`；文件路径拒绝 `..`/查询串/控制字符；上传 ≤2 MiB；Content-Type 白名单形态（防 header 注入）；URL 一律由名称拼接转义，不接受调用方任意 URL。

## 受控链语义

1. **preview**：只读预检 fail-closed——create 时应用必须不存在、upload 时应用必须存在、delete 时目标必须存在；delete_app 冻结文件树条目数作为影响面证据；冻结 immutable plan（oldState/内容 sha256+字节数/TTL 15 分钟/上下文绑定），对外视图不回显内容全文。
2. **apply**：仅接受本 server 实例 planId；漂移复核（目标状态与 preview 时不符即 `STATE_DRIFT` 拒绝，写未发出）；单次执行 → readback（create 后存在、upload 后逐字节一致、delete 后缺席）不符即 `VERIFICATION_FAILED`；请求发出后异常按 `UNKNOWN_OUTCOME` 终结不重试；同值短路（upload 内容逐字节一致则 sameValue=true 不写）。
3. **确认**：原生表单 elicitation（取消即 `POLICY_DENIED`）；`SAP_MCP_CONFIRMATION_MODE=auto`（仅 DEV）由部署注入 autoApprove 跳过表单，plan 状态机与漂移校验不变，与既有受控链同纪律。

## 与 VSP 的边界差异（如实声明）

- VSP 另有 mutation gate（AllowedPackages 配置时 UI5 面直接阻断，因 app→package 解析未实现）；本链改为 create_app 显式包名必填 + 白名单校验，等价收敛且更明确。
- 内容传输为 UTF-8 文本形态（与既有 `ui5GetFileContent` 读回一致）；二进制文件（图片等）不在本链文本通道内，后续需要时再立任务。

## 真机取证（2026-10-05，sap-demo 10.30.254.48:8001/300，所有者授权）

curl 直连 ADT（与实现逐字同协议：POST `bsp:application` XML / PUT `<APP%2fPATH>/content` / DELETE），CSRF fetch 流程与 stateful 会话（secure cookie over HTTP 需手动管理 Cookie 头，含 `x-csrf-token: Required` 占位值过滤）全部打通，GET 读面正常（列表 3105 条、缺席应用 404）。

**结论：sap-demo 的 ui5-bsp filestore 资源控制器为只读面。** 全部写方法被控制器以 405 `ExceptionMethodNotSupported`（"Resource controller does not support method POST/DELETE"）拒绝——这是 ADT 控制器语义应答，证明客户端协议栈（CSRF、会话、路径、载荷）已正确到达资源控制器，缺口在目标系统未提供写控制器。独立佐证：sap-adt 服务器对同一系统的 feature 探测报 `✗ ui5`。PUT 404 与 create 未成功一致（应用不存在）；**无残留对象**（create 未成功，无需清理）。

- 阻塞定性：实现协议正确、目标环境缺写面；"自建应用→上传→读回→删除→缺席复核"全 kind 往返在该系统不可执行。
- 矩阵行为：ui5.write 维持 PARTIAL；liftCondition 更新为"在提供 filestore 写控制器的目标 DEV 上完成全 kind 往返 smoke"。

## 验证状态

- **自动化（已完成）**：单测覆盖 preview 校验/plan 冻结/状态机/漂移/UNKNOWN/同值/TTL/审计；写契约逐字断言 URL/method/qs/载荷。
- **真机（协议面已取证）**：CSRF/会话/GET 面正常；写方法 405 只读面定性（见上）。MCP 工具面（previewUi5Operation 等三件套）待 MCP 客户端硬重启加载后可选复验；全 kind 往返待具备写控制器的目标系统。
