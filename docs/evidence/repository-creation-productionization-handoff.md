# 仓库对象创建产品化交接

更新时间：2026-09-04

## 接手顺序

1. 读取根目录 `AGENTS.md`。
2. 读取本文件、[`repository-validation-campaign-matrix.md`](repository-validation-campaign-matrix.md) 和 [`repository-creation-maturity-evidence.json`](repository-creation-maturity-evidence.json)。
3. 需要历史根因时再查 `BLOCKED.md`、`PROGRESS.md`、`CHANGELOG.md` 与各 wave evidence。

不要重放历史 plan，不要清理现有对象，不要直接调用 raw create/delete。

## 当前目标与边界

目标是让 31 类对象在关闭 `SAP_MCP_REAL_DEV_VALIDATION` 后，按证据逐类进入正常 DEV Profile。真实验证仅使用专用 DEV 配置、已有未释放传输和一次原生确认；QAS/PRD 永远只读。

## 当前基线

- 版本：`0.6.0`。
- 自动化：109 个 Jest suites、793 个 tests。
- Profile 目录：`safe=7`、`development=124`、`diagnostic-readonly=99`、`legacy-full=161`、`development-workbench=87`、`business-readonly=17`、`operations-readonly=40`。
- 创建目录：31 类；`REAL_DEV_VERIFIED=28`、`CONTROLLED_IMPLEMENTED=1`、`AUTOMATION_VERIFIED=2`。
- 唯一成熟度权威：`repository-creation-maturity-evidence.json`；coverage 检查必须通过。

## 尚未晋级的三类

| objectKind | maturity | 阻塞 | 下一步 |
| --- | --- | --- | --- |
| `DDIC_LOCK_OBJECT` | `CONTROLLED_IMPLEMENTED` | 依赖表和完整 cleanup/CTS 证据不足 | 先补专用 DEV 生命周期证据 |
| `CDS_ANNOTATION_DEFINITION` | `AUTOMATION_VERIFIED` | 目标 SAP 拒绝创建授权 | 管理员补齐最小授权后用新身份复测 |
| `CDS_ENTITY_BUFFER` | `AUTOMATION_VERIFIED` | 缺少满足约束的 active CDS 实体 | 准备依赖后再 preview/验证 |

## 必须保持的规则

- `REAL_DEV_VERIFIED` 必须同时具备 create、active readback、transport、cleanup、absence 证据。
- unknown、compensated、compensation-failed 计划和身份不可重放；新验证必须新身份、新 preview。
- cleanup 是独立破坏性 workflow；不修改 E071/E071K，不释放传输，不执行数据库写操作。
- 源码/配置/构建输出修改后硬重启 MCP，并确认新 healthcheck session 与旧 plan `PLAN_NOT_FOUND`。

## 验收命令

```powershell
npm test -- --runInBand
npm run build
npm run check:repository-creation-coverage
git diff --check
```

真实 SAP smoke 只有在明确授权和专用 DEV 环境下运行；自动化门禁不等于部署或线上验证。
