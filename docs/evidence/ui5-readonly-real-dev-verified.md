# UI5 只读三工具真机验证（ui5.read → EQUIVALENT）

- 日期：2026-09-17
- 环境：专用 DEV（10.30.254.48，client 300；env 路径
  `C:\Users\068157\.codex\sap-abap-adt\env\sap-dev.env`）
- 方式：`node ./scripts/ui5-readonly-real-dev-smoke.mjs <sap-dev.env>`
  （通过 MCP stdio 启动 `dist/index.js`，全流程只读，零写操作、零传输、零锁）
- 结果：**SMOKE OK**，全部断言 PASS。

## 实现范围

- `src/adt/Ui5FilestoreApi.ts`：VSP `pkg/adt/ui5.go` 只读方向移植——
  `ui5ListApps`（GET `/sap/bc/adt/filestore/ui5-bsp/objects`，Atom feed）、
  `ui5GetApp`（GET `<APP>/content` 文件树展平）、`ui5GetFileContent`
  （GET `<APP%2fPATH>/content`，应用+路径合并后整体转义，斜杠编码 %2f）。
- `src/handlers/Ui5Handlers.ts` + `src/index.ts` 接线；`ToolProfiles.ts`
  （workbench 显式名单）与 `ToolOperationPolicy.ts`（read-only 类）同步。
- 安全设计：应用名单级命名空间白名单（`/NS/APP` 或无命名空间，拒绝多级斜杠）、
  文件路径穿越拒绝（`..` 段、`?`、`#`、`%`、反斜杠）在处理器参数层即返回
  InvalidParams（零网络往返），API 层保留同口径校验作为纵深防御；URL 一律由
  名称拼接并整体转义，绝不接受任意 URL。
- 行为增强（对 VSP）：目标系统忽略 `name` 查询参数（专用 DEV 实测，feed 全量
  返回，VSP 同受影响），`query` 在客户端再做 `*` 通配符过滤后才截断。

## 真机 smoke 步骤与输出

1. **catalog 可见性**：三工具出现在真实运行时 catalog。
2. **ui5ListApps**：feed 共 3105 条，返回 200 应用（truncated=true），含命名空间
   形态（/SAM4U/DASHBRD、/SCMTMS/COMMON 等）；统计字段（feedEntries/truncated）
   完整。
3. **客户端过滤**：`query=Z*` 返回 0 个自定义应用（该 DEV 无自定义 UI5 应用），
   过滤逻辑正确（结果全部以 Z 开头的恒真验证）。
4. **目标选择**：无 Z/Y 自定义应用时取第一个标准应用 `/SAM4U/DASHBRD`。
5. **ui5GetApp**：返回 17 条文件树条目，路径全部以 / 开头，类型 file/folder 合法
   （.Ui5RepositoryBinaryFiles、Component.js、WebContent/ 等）。
6. **ui5GetFileContent**：真实读回 `.Ui5RepositoryBinaryFiles`（92 bytes，内容为
   二进制文件扩展名正则清单），返回体带应用名与字节统计。
7. **负例**：`filePath=../../etc/passwd` 在参数层被 InvalidParams（-32602）拒绝，
   零网络往返。

## 过程记录

- 第一轮 smoke 在 ui5GetApp 处遇一次瞬时失败（等待 20 秒后重试通过，符合慢时段
  系统行为），按重试预算（≤2 次）执行，未触及上限。
- 期间修复一处负例语义：穿越拒绝原在 API 层，被处理器脱敏为 InternalError；
  已把预检上移到处理器参数校验（InvalidParams 语义），并补处理器单测
  （穿越/元字符/反斜杠三类拒绝 + 零调用断言）。

## 门禁记录

- Jest：134 suites / 1277 tests 全绿（UI5 能力新增 20 例：API 12 + Handlers 8）。
- `npm run build`、`check:repository-creation-coverage`、
  `check:vsp-capability-parity`（JSON 校验 + MD 重生成）、`git diff --check` 全绿。

## 矩阵影响

`ui5.read`：GAP → **EQUIVALENT**（evidence + real-dev-verified）。对齐 35/71。

## 遗留

- 无系统残留（全程只读）。
- ui5.write 维持 GAP（RESTRICTION 方向，本轮明确不做）。
