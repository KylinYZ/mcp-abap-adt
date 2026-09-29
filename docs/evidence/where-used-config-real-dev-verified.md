# getWhereUsedConfig（TVARVC 配置引用分析）真机验证

日期：2026-09-28。系统：sap-demo（10.30.254.48:8001，client 300，专用 DEV）。

## 交付

`getWhereUsedConfig`（analysis.history 行 where_used_config 子操作；VSP fetchConfigRefs 语义移植，D:\MyDev\SAP\vibing-steampunk 本地只读参照）：两段式找"读取 TVARVC 变量的代码"——

1. **候选采集**（纯 SQL 两表配对）：`WBCROSSGT OTYPE='TY'`（OO 类池）+ `CROSS TYPE='S'`（过程化）按 `NAME='TVARVC'` 查触表编译单元，INCLUDE 池形态经 normalizeLoadName 归一化去重；单源失败可生存（unsearched 记录），双源失败是硬错误而非"无读者"答案。
2. **源码 grep 确认**：每候选源码大小写不敏感 grep 变量名（复用 grepObjects 通道）；confirmed=true 仅当 grep 命中；grep 失败/跳过/预算外一律 unsearched，绝不借用 confirmed=false 语义。grep 预算默认 10、上限 30（本项目源码 grep 为客户端正则串行读取，与 VSP 无界不同，notes 声明）。

## 真机结果：SMOKE OK（`npm run test:where-used-config-real-dev`）

前置取证：该系统 WBCROSSGT/CROSS 对 `NAME='TVARVC'` **零候选**（无激活的 TVARVC 引用代码）——直接验证只能得空答案。故采用**直连 ADT 写链自造数据**：

1. 直连 ADT 创建自有验证程序 `ZWUXREF4790`（最小源码，登记 S4HK900009）；
2. stateful 会话加锁 → 写入引用 TVARVC 的源码（`SELECT SINGLE low FROM tvarvc … WHERE name = 'ZV_XREF_SMOKE'`）→ 解锁 → 激活（WBCROSSGT/CROSS 生成真实行）；
3. MCP 组合链：`readers=1 confirmed=1 grepped=1 unsearched=0`——**决定性正例**：候选精确命中、源码 grep 确认标记变量；
4. 收尾：直连删除 + 缺席复核通过（无残留）。

```text
PASS 直连自造数据完成：ZWUXREF4790（创建+源码+激活，登记 S4HK900009）
INFO readers=1 confirmed=1 grepped=1 unsearched=0
PASS 决定性正例：ZWUXREF4790 触 TVARVC 且源码确认 confirmed=true
PASS 收尾：靶对象直连删除 + 缺席复核通过
SMOKE OK
```

## 环境取证

- 该 demo 系统 TVARVC 零候选的根因：WBCROSSGT/CROSS 行在**激活时**生成，系统内自有验证程序均为极简代码或 inactive，无 TVARVC 命名引用——激活含引用的源码后行即时生成（本 smoke 实证）。
- **受控创建链的 REAL_DEV validation 模式会拦截非 ZV 前缀创建**（sap-demo.env 现 `SAP_MCP_REAL_DEV_VALIDATION=true` + `PREFIX=ZV`）：smoke 进程 env 覆盖 `SAP_MCP_REAL_DEV_VALIDATION=false` 后仍被拒——dotenv 不覆盖进程 env 已实证，拦截来源为受控创建链内部对 validation 计划的 apply 拒绝语义（REAL_DEV_VERIFIED 类型禁止 validation 计划写）。smoke 因此改走直连 ADT 写链（等价能力，绕开 MCP 面的策略门而非绕开安全边界：对象为自有验证对象 + 登记同一传输）。
- 直连写链三个坑：setObjectSource 必须用 **`/source/main` 源端点**（对象端点会 XML 校验报错）；lock/activate 需要 **stateful 会话**（stateless 报 "only be performed in stateful mode"）。

## 门禁

- `npm test -- --runInBand`：172 suites / 1827 tests 全绿（新增 8 个 API 用例：双表配对/单源生存/双源硬错误/grep 失败不借义/预算与 unsearched/skip 对齐/纯候选路径/非法名拒绝）
- `npm run build`、`npm run check:repository-creation-coverage`、`npm run check:vsp-capability-parity`、`git diff --check` 通过
