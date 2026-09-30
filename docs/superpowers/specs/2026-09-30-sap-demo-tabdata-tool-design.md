# sap-demo 表数据导出/导入/备份/恢复工具 — 设计文档

- 日期：2026-09-30
- 目标系统：sap-demo（host 10.30.254.48，client 300，DEV 角色，SAP_BASIS 816）
- 状态：设计已获用户批准（2026-09-30 会话），进入实施
- 实施方式：ABAP 源码入库 `sap/tabdata/`，真机对象走受控创建链部署

## 1. 目标与非目标

用户需要一个 SAP 端报表工具，对任意（符合条件的）表完成：

1. **导出**：表数据 → Excel（.xlsx，前端 PC 文件），供查看与手工修订；
2. **导入**：修订后的 Excel → 回灌原表（upsert 语义）；
3. **备份**：表数据 → 无损压缩备份文件（.jsonl.gz，前端 PC 文件）；
4. **恢复**：备份文件 → 原表（时点全量替换语义）。

**非目标（刻意不做）**：多表打包、解析任意第三方 Excel、后台作业/定时、SLG1 日志对象、
簇表/池表支持、ALV 前台编辑。

## 2. 关键决策（用户已确认）

| 决策点 | 结论 |
|---|---|
| 备份载体 | 备份文件下载到前端 PC（JSON Lines + gzip），恢复时上传；恢复前强制自动快照 |
| 表范围护栏 | 默认仅 Z/Y 自定义表；显式勾选可放行标准表（强制填写原因+审计），系统关键表黑名单始终硬拒 |
| 写路径验证 | 分工验证：导入/恢复由用户在 SAP GUI 执行，我方只做只读对账与真机 ABAP Unit |

## 3. Excel 实现路线：自写轻量 xlsx 读写器

xlsx 本质是 zip+XML。使用系统自带 `CL_ABAP_ZIP`（已确认存在于 sap-demo）自写一个只支持
"单数据表"子集的读写器，不引入 abap2xlsx（500+ 对象过重）。收益：导出格式与导入解析
严格对称，全字段文本化保真完全可控。

**导入格式约束**：导入只接受本工具导出的 Excel（元数据 sheet 做指纹校验：表名+字段目录）。
但支持核心工作流"导出 → 手工改值/删行 → 导回"。因此 reader 除 inlineStr 外**必须支持
Excel 重保存后的 sharedStrings 结构与数值单元格**（Excel 另存会把 inline string 收进
sharedStrings 表）。

### 类型保真规则（ZCL_TABDATA_TYPE_CONV，Excel 与备份两载体共用）

所有字段导出为**文本单元格**，规避 Excel 日期/数字自动转换：

| DDIC/RTTS 类型 | 导出文本形式 | 还原要点 |
|---|---|---|
| C（CHAR/LCHR）/g（STRING） | 原样字符串 | 直接赋值 |
| N（NUMC） | 原样字符串（保前导零） | 校验长度+全数字 |
| D（DATS） | YYYYMMDD 原样字符串 | 校验 8 位数字 |
| T（TIMS） | HHMMSS 原样字符串 | 校验 6 位数字 |
| P（DEC/CURR/QUAN） | 无千分位小数字符串（string template `NUMBER = RAW`） | 正则校验后赋值，按 decimals 对齐 |
| F（FLTP） | 17 位有效数字文本（double 无损往返标准） | 还原为 f |
| I / b / 8（INT1/2/4/8） | 十进制字符串 | 直接赋值 |
| x / y（RAW/LRAW/RAWSTRING） | 每字节两个大写 hex 字符 | hex 解码回 xstring |
| MANDT | **不导出**（字段目录排除） | Open SQL 自动按当前客户端写入 |

## 4. 备份/恢复语义（与导出/导入的关键区分）

| 操作 | 载体 | 语义 |
|---|---|---|
| 导出→导入 | Excel（前端） | **upsert**：按主键存在则 UPDATE、不存在则 INSERT，不删除 Excel 中未出现的行 |
| 备份→恢复 | .jsonl.gz（前端） | **时点全量替换**：单 LUW 内 DELETE 全表 + 灌回备份行，任一步失败整体 ROLLBACK |

备份文件格式（文本可审计）：

- 第 1 行 JSON 头：`{"format":1,"table":...,"system":...,"client":...,"user":...,"timestamp":...,"rows":N,"fields":[{name,type,length,decimals,key,hexEncoding}...],"md5":...}`
- 第 2..N+1 行数据行：`{"v":{"FIELD":"字符串值",...}}`（所有字段按字符串写入，与 Excel 共用同一转换规则）
- 全文 gzip 压缩（CL_ABAP_GZIP，已确认存在）；`md5` 为数据行序列的 MD5（CL_ABAP_MESSAGE_DIGEST）

## 5. 对象架构（1 报表 + 5 类 + 1 异常类 + 1 测试表）

```
ZTABDATA_TOOL (PROG)            选择屏幕壳：四模式单选（导出/导入/备份/恢复）
 ├─ ZCL_TABDATA_TABLE_ACCESS    动态读/写表：SELECT、DDIF_FIELDINFO_GET 字段目录、主键识别、upsert、全量替换、护栏校验
 ├─ ZCL_TABDATA_TYPE_CONV       字符串↔ABAP 动态类型双向转换（见 §3 规则表）
 ├─ ZCL_TABDATA_XLSX            xlsx 组装与解析（CL_ABAP_ZIP + XML 构造/解析；inlineStr + sharedStrings + 数值单元格）
 ├─ ZCL_TABDATA_BACKUP          JSONL 头/数据行构造解析、gzip、MD5、前端文件读写
 ├─ ZCX_TABDATA_ERROR           统一异常（错误定位到 Excel 行列/备份文件行号）
 └─ ZTABDATA_DEMO (TABL)        类型矩阵测试表：CHAR/NUMC/DATS/TIMS/DEC/CURR/QUAN/INT/FLTP/STRING/RAW/组合键
```

报表输出用 CL_SALV_TABLE（已确认存在）；文件读写用 CL_GUI_FRONTEND_SERVICES。

## 6. 护栏

- **仅透明表**：DD02L-TABCLASS = 'TRANSP'，簇表/池表直接拒绝；
- **表来源**：默认仅 Z*/Y*（TADIR 校验）；勾选"放行标准表"才允许，且**强制填写业务原因**，
  放行操作连同原因输出到结果屏并写可选前端日志文件；
- **黑名单始终硬拒**（不受放行开关影响），原则：DDIC 元数据（DD*）、传输系统（E0*/E07*/TADIR）、
  系统与安全表（T000/USR*/AGR*/PROGDIR/REPOSRC/CROSS/WBCROSS*/SEO*/D010* 等），实现时定稿完整清单；
- **行数上限**：默认 100 万（Excel 物理极限内），超限拒绝并提示改用备份通道；
- **写操作安全序列**：
  - 导入前默认自动备份当前表状态（checkbox 默认勾选，可取消）；
  - 恢复前**强制**自动快照当前表状态（不可取消，使恢复本身可逆）；
- **原子性**：所有写操作单 SAP LUW，批次失败整体 ROLLBACK；
- **结构漂移检测**：Excel/备份内字段目录与当前 DDIC 结构比对，字段增减/类型变化列出差异并拒绝
  （可选项：忽略"多余列"，即源结构比目标多列时跳过该列）。

## 7. 数据流

### 导出（表→Excel）
护栏校验 → DDIF_FIELDINFO_GET 取字段目录（排除 MANDT）→ 动态 SELECT（可选 WHERE、按主键排序、
行数上限）→ 值文本化 → xlsx 组装（sheet1=数据+表头行，sheet2=元数据指纹）→ GUI_DOWNLOAD。

### 导入（Excel→原表）
GUI_UPLOAD → 解析 xlsx → 元数据指纹 vs 当前 DDIC 比对 → 逐行类型转换（错误定位行列）
→ （默认先自动备份）→ 按 PK 分批 upsert（1000 行/批，单 LUW，失败 ROLLBACK）
→ 结果统计（插入/更新/跳过/错误清单）。

### 备份（表→.jsonl.gz）
护栏校验 → 全量动态 SELECT → 值文本化 → JSONL 组装（头+数据行+MD5）→ gzip → GUI_DOWNLOAD。

### 恢复（.jsonl.gz→表）
GUI_UPLOAD → gunzip → 解析头与数据行 → MD5 完整性校验 → 字段目录 vs 当前 DDIC 比对
→ **强制快照当前表状态** → 展示差异摘要（当前行数 vs 备份行数）→ 确认 →
单 LUW：DELETE 全表 + INSERT 备份行 → COMMIT → 结果统计。

## 8. 执行通道与验证分工（重要修正）

报表使用 CL_GUI_FRONTEND_SERVICES 做文件下载/上传，**只能在 SAP GUI 前台会话执行**——
四个模式的运行全部由用户在 SAP GUI 完成（我方无报表执行通道且不应代执行写路径）。

| 环节 | 谁做 | 内容 |
|---|---|---|
| 开发/部署 | 我 | 源码入库、受控创建链部署 8 个对象、传输请求 |
| ABAP Unit | 我（真机执行） | 类型往返、xlsx 组装/解析往返、备份构造/解析往返、护栏校验、结构漂移检测 |
| 四模式真机操作 | 用户 | 按逐步操作清单在 SAP GUI 执行（导出/导入/备份/恢复） |
| 只读对账 | 我 | datapreview 直读 vs 用户产出的 Excel/备份文件、导入/恢复后的表状态逐值核对 |

## 9. 部署清单

真机对象（全走 preview→原生确认→apply 受控链）：1 PROG + 4 CLAS + 1 ZCX + 1 TABL + 1 传输请求。
包与传输目标在实施时按 sap-demo 现有开发包约定确定。源码同步入库 `sap/tabdata/`。
