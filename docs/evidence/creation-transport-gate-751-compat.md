# 受控创建链传输门禁 7.51 兼容改造（设计与实现记录）

- 状态：**已实现 + 离线测试覆盖；7.51 真机验证待对方用户在 ED1 执行**
- 日期：2026-09-29
- 影响面：`previewAbapObjectCreation`/`applyAbapObjectCreation` 与
  `previewRepositoryObjectCreation` 的 PROGRAM/FUNCTION_MODULE/FUNCTION_GROUP/
  FUNCTION_GROUP_INCLUDE 分支（两条入口共用 `AbapObjectCreationWorkflow`）。
  其余对象类型适配器与已有对象的修改链（`AbapChangeWorkflow`）维持原校验。

## 1. 根因（修正后定论）

ED1（7.51）两条受控创建链创建 PROGRAM 均报
`TRANSPORT_INVALID: No URI-Mapping defined for URI ...`：

- 预检从首版提交（90619c1）起传**自拼包 URI** `/sap/bc/adt/packages/<pkg>`
  给 `POST /sap/bc/adt/cts/transportchecks`，从不传不存在对象的 URI；
- `validateTransport` 的同一个 `try` 同时包住 `transportchecks`（包 URI POST）
  与 `transportDetails`（`GET cts/transportrequests/{tr}`），两者失败都被包装成
  同一错误码与文本，离线无法区分具体端点——"No URI-Mapping defined for URI"
  对"资源未注册"的 404 同样成立；
- 前一轮"7.51 无法映射不存在对象"的结论是该错误在 ED1 上的真实观测，但不是
  创建链实际发送的 URI；7.51/7.52 分界由用户断言 + sap-demo 行为探针侧证
  （sap-demo 文本池 ADT 资源存在 = 7.52 SP00+ 行为侧；其 transportchecks 对
  包 URI 与不存在对象 URI 均正常）；
- 真正的创建 POST（`?corrNr=`）与 VSP `CreateObject` 同协议，不依赖上述
  任何 URI 映射；VSP 在用户指定传输号时根本不做 transportchecks 预检，且
  检查失败不拦截写入（vibing-steampunk `transport_choice.go`）。

## 2. 改造语义（保持安全门控，不新增绕过受控链的写入口）

| 环节 | 原行为 | 新行为 |
| --- | --- | --- |
| 包 URI transportchecks | 硬门禁，失败即拒绝；候选不含请求即拒绝 | **软检查**：失败只记录诊断；候选不含请求降为提示 |
| 请求存在性/可修改性 | 仅 ADT transportDetails（与 transportchecks 同 try，无归因） | **双通道**：ADT transportDetails → 失败降级 E070 只读 SQL（datapreview，与 TransportHistoryApi 同通道）；"已释放"任一通道判定即拒绝；两路都失败才拒绝 |
| 预检 URI 来源 | 自拼 `parentPath`（小写化） | 优先 resolve 阶段搜索返回并经校验的 `parentUri`，缺失回退自拼 |
| 预览输出 | 无传输校验信息 | 新增 `transportValidation`（requestCheck 通道/状态、packageCompatibility、notes、attempts 诊断），并写入计划视图 |
| 创建后归属 | 仅对象存在性 + 源码比对 | 新增**归属证明**：E071 只读 SQL（请求+全部任务）为主、ADT 请求对象清单为备，证明新建对象已登记进指定请求；匹配不到 → `TRANSPORT_REGISTRATION_UNPROVEN`；两通道都不可用 → `TRANSPORT_REGISTRATION_UNKNOWN` |
| 失败后的补偿 | 按 ownershipProven 删除 | `transportRegistration ∈ {UNPROVEN, UNKNOWN}` 的对象**禁止自动删除**（记录 `OBJECT_COMPENSATION_SKIPPED:*`，计划状态 COMPENSATION_FAILED） |

诊断明细（`transportAttempts`）结构化记录端点、URI、错误分类
（`URI_MAPPING_UNAVAILABLE`/`RESOURCE_NOT_FOUND`/`AUTHORIZATION`/`TIMEOUT`/`OTHER`）
与已清洗消息；不透出原始响应体（沿用 `sanitizeMessage`）。

## 3. 文件清单

- 新增 `src/safe/TransportRegistration.ts`：纯函数层（错误分类、ADT 对象清单
  展平、登记匹配、SQL 构造器与 token 白名单）。
- `src/safe/AbapObjectCreationWorkflow.ts`：`validateTransport` 重写（软检查 +
  双通道）、`proveTransportRegistration`/`readTransportObjectEntries` 新增、
  补偿豁免、preview/apply 透出摘要。
- `src/safe/AbapCreationResolver.ts`：resolve 阶段采集 `parentUri`（含形态防线）。
- `src/safe/creationTypes.ts`：`parentUri`、`transportRegistration`、
  `transportValidation` 类型与可选 `runQuery` 通道。
- `src/safe/errors.ts`：新增 `TRANSPORT_REGISTRATION_UNPROVEN`/
  `TRANSPORT_REGISTRATION_UNKNOWN` 码与 nextStep。
- `src/safe/CreationPlanStore.ts`：计划视图透出新增字段。
- `src/safe/adapters/AbapSourceCreationAdapter.ts`：legacy 摘要透传到
  `previewRepositoryObjectCreation` 的 review。

## 4. 验证状态（如实区分）

- **已验证（离线）**：`npx tsc` 通过；`AbapObjectCreationWorkflow.test.ts`
  原有 11 用例 + 新增 7 用例（软检查降级、E070 双通道、双失败拒绝、候选
  不匹配提示、已释放双通道拒绝、UNPROVEN 禁删、UNKNOWN 禁删）全绿；
  新增 `TransportRegistration.test.ts` 纯函数 7 用例全绿。
- **已验证（sap-demo 只读探针，2026-09-29）**：包 URI（大小写两种形态）与
  不存在对象 URI 的 transportchecks 在 7.52+ 行为侧均正常——改造对健康系统
  只影响"候选不匹配从拒绝变提示"。
- **未验证（待 ED1 真机）**：① transportchecks 与 transportDetails 在 ED1 上
  哪个失败（新诊断会在 attempts 里直接给出端点与 URI）；② 降级后 ED1 能否
  完成创建 POST 与传输登记；③ E071 datapreview 通道在 ED1 的可用性。
  7.51 真机通过前，PROGRAM 等创建能力的 REAL_DEV_VERIFIED 成熟度结论不变，
  但其"验证系统基线为 7.52+ 行为侧"这一限定应随本证据一并理解。

## 5. ED1 侧复测指引

1. 硬重启 MCP 客户端（源码已变）。
2. 重跑 `previewAbapObjectCreation`（同一请求号或新请求号）：
   - 若成功：检查 `transportValidation.packageCompatibility`——预期
     `CHECK_UNAVAILABLE`（transportchecks 不可用）或 `NOT_CONFIRMED_BY_SAP`，
     `requestCheck.channel` 指明门禁走的通道；
   - 若仍失败：错误 `details.transportAttempts` 会列出精确端点、URI 与分类，
     直接反馈该文本即可定位。
3. apply 后如报 `TRANSPORT_REGISTRATION_*`：对象已存在，按 nextStep 在
   SE10/ADT 核对请求内容，禁止重放旧计划。
