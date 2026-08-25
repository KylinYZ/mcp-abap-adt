# Eclipse ADT 3.60.2 仓库对象创建后续支持路线图

## 目标与现状

目标是覆盖本机 Eclipse ADT 3.60.2 已安装的 142 个 ABAP New Wizard 候选。当前能力目录已映射 31 类，剩余 111 类；当前 31 类均保持 `writable=false`，没有任何类型达到 `REAL_DEV_VERIFIED`。候选清单和映射以 `docs/evidence/eclipse-adt-3.60.2-creation-wizard-manifest.json` 为准。

对象成熟度必须按以下顺序推进：

`WIZARD_EVIDENCE` → `PROTOCOL_CAPTURED` → `CONTROLLED_IMPLEMENTED` → `AUTOMATION_VERIFIED` → `REAL_DEV_VERIFIED`

不能因为向导存在、JAR 中有类、单元测试通过或抓包成功，就直接开放真实写入。

## 阶段和优先级

### 阶段 0：31 类真实 DEV 验证（最高优先级）

先验证已经实现的 31 类，而不是继续堆积未验证协议。每个类型都必须完成 preview、一次原生确认、创建、适用的写入与锁生命周期、适用的激活/生成步骤、active 或最终状态复读、传输核验和可证明归属的清理；没有独立激活资源的对象必须验证其完整替代生命周期。成功后才可把该类型提升为 `REAL_DEV_VERIFIED` 并按对象类型显式开放写入。

#### 当前验证门记录（更新至 2026-08-25）

- 31 类创建侧活动已全部形成明确结果，能力目录仍全部 `writable=false`，`REAL_DEV_VERIFIED` 仍为 0。
- 当前分布为 10 类 `APPLIED_ACTIVE_VERIFIED`、1 类 `ACTIVE_READBACK_ONLY`、5 类 active shell-only/unknown、2 类 compensated、2 类 unavailable、11 类 dependency missing。
- 下一步不再继续随机创建测试，而是按对象族补 cleanup/transport evidence 并逐类晋级。
- 现役设计、实施计划和接手现场分别见 `2026-08-25-repository-creation-productionization-design.md`、`2026-08-25-repository-creation-productionization-plan.md` 和 `docs/evidence/repository-creation-productionization-handoff.md`。

证据摘要见 `docs/evidence/real-dev-validation-phase-0-gate.md`。该记录不等同于 `REAL_DEV_VERIFIED`，也不授权绕过受控工作流。

### 阶段 1：高价值 DDIC 与平台对象（11 类）

优先解决日常开发最常用、协议复用度最高的对象：

`VIEW/DV`、`AUTH`、`HTTP`、`TABL/DTI`、`DTIX/DF`、`XINX/DTX`、`ENHO/XHB`、`ENHO/XHH`、`ENHS/XSB`、`SRVC/SVM`、`XSLT/VT`

每类先抓一条最小成功链，再补复杂字段、依赖对象和失败路径。`VIEW/DV` 是第一优先对象；它完成后可复用 DDIC server-driven、源码和激活验证框架。

### 阶段 2：DDIC 类型和结构化元数据（25 类）

`DCAT/TYP`、`DOBJ/DST`、`DSFD/SCF`、`DSFI/SFI`、`DTDC/DF`、`DTSC/DF`、`EDCC/TYP`、`EDCK/TYP`、`EDCR/TYP`、`NTTA/TYP`、`NTTY/TYP`、`PARA/R`、`PCFN/PCF`、`PINF/KI`、`RVBC/TYP`、`SITO/TYP`、`SKTD/TYP`、`SQSC/DU`、`SWCR/TYP`、`SUSO/B`、`CHKC/TYP`、`CHKO/TYP`、`CHKV/TYP`、`SPRV/TYP`、`COTA/TYP`

这一阶段重点是依赖图、server-driven schema、复杂属性 XML/JSON、字段级校验和激活生成对象；不能把已有属性 PUT 接口误认为完整创建协议。

### 阶段 3：服务、集成和业务框架对象（33 类）

`AIFD/TYP`、`AIFI/TYP`、`AIFN/TYP`、`AIFR/TYP`、`AMSD/TYP`、`AOBJ/TYP`、`APIC/TYP`、`APLO/TYP`、`APOB/TYP`、`BGQC/TYP`、`BOBF`、`CDBO`、`CMPT`、`CSNM/TYP`、`DMON`、`EEEC/EVC`、`EVTB/EVB`、`EVTO/EVO`、`FTG2/FT`、`FTGL/AF`、`GSMP`、`HOTA/HDI`、`ILMB/IRM`、`INTM/INM`、`INTS/INS`、`NHDU/DUP`、`SAIA/TYP`、`SAJC`、`SAJT`、`SAMC`、`SAPC`、`SCO1`、`SCO3`、`SCP1/BCS`

这一阶段需要优先识别激活生成对象、跨对象引用和目标系统 feature gate；生成对象的激活或复核结果未知时不得自动删除或重试。

### 阶段 4：UI、门户和技术长尾（42 类）

`SFPF/5F`、`SIA1`、`SIA2`、`SIA5`、`SIA6`、`SIA8`、`SIAD`、`SMBC/TYP`、`SMTG`、`SOD1`、`SOD2`、`SPRX/30`、`SPRX/32`、`SPRX/34`、`SPRX/3C`、`SPRX/3K`、`SPRX/3M`、`SPRX/3N`、`SPRX/3P`、`SPRX/3U`、`SPRX/3Z`、`UIAD/TYP`、`UIPG/TYP`、`UIST/TOP`、`WDCA/Y01`、`WDCA/YA`、`WDCC/Y10`、`WDCC/Y11`、`WDCC/Y12`、`WDCC/Y13`、`WDCC/Y14`、`WDCC/YG`、`WDYA/Y20`、`WDYA/YY`、`WDYN/WQ`、`WDYN/WW`、`WDYN/WZ`、`WDYN/YC`、`WDYN/YD`、`WDYN/YW`

这些对象优先级较低，先完成只读 discovery/可用性报告；只有确认存在稳定、可控、可复核的 ADT 写协议后，才进入创建适配器开发。

## 协议取证策略

不是每个类型都必须由用户逐个抓包。取证顺序固定为：

1. 检查 ADT 3.60.2 JAR 中的 wizard、strategy、schema 和 endpoint 常量。
2. 检查 `vscode_abap_remote_fs` 等已有开源实现，复用只读/源码协议线索。
3. 调用目标系统 discovery、schema、configuration、codecompletion，确认目标版本是否支持。
4. 只有前三项无法闭合请求/响应/激活链时，才让用户抓 Eclipse 成功请求。

每次抓包最小要求：成功创建、validation、lock、写入、unlock、activation、active GET，以及必要的生成对象 GET。抓包只作为协议证据，不直接复制调用方提供的 URL、XML、媒体类型或 lock handle；这些必须转化为受控输入和服务端复核。

## 独立真实 DEV 测试线程

真实测试线程只负责已实现 31 类的目标系统前置检查、逐类执行和证据归档；主实现线程继续做协议提取，两个线程不得同时对同一对象执行写入或清理。

测试线程的硬边界：

- 只允许配置为 DEV 的 SAP 主机/客户端和明确测试包、测试传输。
- 每次只测试一个对象类型和一个测试名；未知结果立即停止，不重试远端 mutation。
- 创建成功后必须复读 active，并只删除当前计划能证明归属的对象。
- QAS/PRD、缺失 role、未知 transport、非空目标对象均不得写入。
- 测试报告必须区分代码测试、协议回放、真实 SAP 创建、active 验证和清理结果。

阶段 0 的通过门槛：该类型适用的创建、写入、激活/生成、最终状态复读、传输归属和清理全部成功，且没有未解释差异或 `OUTCOME_UNKNOWN`；否则保持 `writable=false`。

## 断点与交付物

- 每个阶段维护候选状态：`DISCOVERED`、`CAPTURE_NEEDED`、`CAPTURED`、`IMPLEMENTED`、`AUTOMATION_VERIFIED`、`REAL_DEV_VERIFIED`、`BLOCKED`。
- 每个对象必须留下协议摘要、请求/响应媒体类型、输入白名单、验证阶段、失败/补偿边界和真实 DEV 测试记录。
- 任一 SAP 产品升级后重新运行 `npm run audit:eclipse-adt-creation` 和 `npm run check:repository-creation-coverage`，先处理协议漂移，再继续下一阶段。
