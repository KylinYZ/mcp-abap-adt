# CDS 依赖只读三端点真机验证（read.cds-analysis）

- 验证日期：2026-09-16
- 目标系统：专用 DEV（`10.30.254.48:8001`，client 300，用户 068157，focused/DEV profile）
- 验证对象：`ZVPCDS04`（DDLS/DF，Z001 包，"Repository validation CDS root unmanaged"，历史 campaign 创建的验证 CDS）
- 工具入口：`getCdsDependencies` / `getCdsImpactAnalysis` / `getCdsElementInfo`
- 脚本：`scripts/cds-analysis-real-dev-smoke.mjs`（纯只读，零副作用）

## 结论

三个只读 ADT 端点在真实 DEV 系统上全部验证通过，矩阵行 `read.cds-analysis` 由
UNVERIFIED 晋级 **EQUIVALENT**。

## 逐端点结果

| 端点 | 真机结果 | 证据 |
| --- | --- | --- |
| `getCdsDependencies` | PASS：`ZVPCDS04` 返回真实上游依赖 `T000`（TABLE，relation=FROM），statistics total=1/depth=2 | smoke PASS 输出 |
| `getCdsImpactAnalysis` | PASS：结构正确（direction=downstream，impactedObjects=[]，totalCount=0——该 CDS 无下游消费者，为合法空结果） | smoke PASS 输出 |
| `getCdsElementInfo` | PASS（降级路径）：目标系统未注册 `ddlsources.v2` 类型，回退老版 `ddlSource+xml` 成功（HTTP 200），元素清单为空并附 note 说明 | smoke PASS 输出 + note 文本 |

## 真机发现并修复的缺陷

**v2 内容类型兼容缺陷（照抄 VSP 上游引入）**：实现最初硬编码
`Accept: application/vnd.sap.adt.ddic.ddlsources.v2+xml`（与 VSP `pkg/adt/cds_tools.go`
一致），但该 DEV 系统仅接受 `application/vnd.sap.adt.ddlSource+xml`，返回
"The message content is not acceptable"。VSP 上游同样无回退逻辑，在此系统上
`GetCDSElementInfo` 同样不可用——即此环境限制对 VSP 与本项目一致。

修复：`src/adt/CdsDependencyApi.ts` 的 `getCdsElementInfo` 对"not acceptable"
错误自动回退老 Accept 类型重试一次；老表示不含元素清单，解析后返回空 elements
并附结构化 `note`，避免调用方把空清单误读为"该 CDS 没有字段"。非内容协商类
上游错误（403/网络等）保持原样传播。mock 契约测试同步补充回退用例
（`CdsDependencyApi.test.ts`，28 个用例全过）。

## 安全边界确认

- 三个端点全部只读（GET / 无副作用 usageReferences POST），对目标对象零副作用；
- 输入仅接受 objectType+objectName，ADT URI 全部服务端推导，不接受调用方任意 URL；
- 本验证未创建任何对象、未产生任何写入、未创建/释放传输。

## 验证层级声明

- 真实 DEV 已验证：三端点连通性、请求契约、响应解析（含真实数据 T000 依赖）、
  v2 兼容降级路径。
- 未验证：v2 结构化元素清单的完整解析（需支持 ddlsources.v2 的系统版本）。
