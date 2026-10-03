# AI 生成 ABAP 代码的生成器约束清单（真机双系统验证）

> 来源：ZTABDATA 双系统部署实战（2026-09-30，交接清单 C 章沉淀）。
> 验证系统：sap-demo（BASIS 816 严格模式）与 ED1（7.51）；除特别标注外两系统同时验证。
> 用途：AI（agent）在生成 ABAP 源码（受控创建链 / previewAbapChange 载荷）时，必须在写码阶段遵守本清单——SAP 语法错误会让创建链走"写失败→补偿删除→重建"路径，每轮重建都制造锁残留与 TADIR 孤儿，代价远高于写码时多想一步。
> 使用方式：生成 ABAP 源码前通读；遇到本清单覆盖的构造直接按"正确写法"生成，不要赌语法。静态分析可用外部 abap-docs MCP 服务器的 `abap_lint` 工具做离线兜底（本仓库无内置 abaplint 引擎，见能力矩阵 analysis.lint 行）。

## 规则索引

| # | 规则 | 系统表现 |
|---|---|---|
| 1 | SELECT INTO 目标禁 field symbol | 816 语法 E |
| 2 | UPDATE/INSERT FROM 行参数须 `@<fs>` | 816 E |
| 3 | UP TO 子句在 INTO 之后 | 816 E |
| 4 | string 模板 `{` 后必须空格 | 两系统 |
| 5 | 模板内 `{{`/`\X` 字面转义被新内核误解析 | 816 E |
| 6 | `CONV i ( x+N )` 词法歧义 | 816 E |
| 7 | string 类型无长度偏移禁用；string 偏移+内联声明禁用 | 816 E |
| 8 | 方法内显式 DATA 声明必须在可执行语句之前 | 816 E |
| 9 | CX 子类 CONSTRUCTOR 声明激活时被 SEO 重写 | 816 实证 |
| 10 | RETURNING 参数禁泛型表类型内联 | 816 E |
| 11 | generic TYPE any 禁 NUMBER/STYLE 格式指令；FLTP style 名为 `scientific` | 816 E |
| 12 | X030L 结构无 TABCLASS 组件 | 816 E |
| 13 | CX_SALV_MSG 未捕获（SALV 需 TRY 包裹） | 7.51 实证 |

## 详细规则与正确写法

### 1. SELECT INTO 目标禁 field symbol

`SELECT ... INTO @<fs>` 与裸 `<fs>` 目标在 816 严格模式下均为语法错误 E。

```abap
" 错误：SELECT SINGLE * FROM ztab INTO @<fs> WHERE ...
" 错误：SELECT SINGLE * FROM ztab INTO <fs> WHERE ...
" 正确：目标为解引用后的 ref 变量
DATA lr_row TYPE REF TO ztab.
SELECT SINGLE * FROM ztab INTO @lr_row->* WHERE ...
" 或：INTO TABLE @lr_tab（ref 指向内表时）
SELECT * FROM ztab INTO TABLE @lr_tab->* WHERE ...
```

### 2. UPDATE/INSERT FROM 行参数须 `@<fs>`

写路径的行来源 field symbol 必须带转义 `@`（与 SELECT INTO 的禁用方向相反，不要混淆）。

```abap
" 错误：UPDATE ztab FROM <fs>.
" 正确：
UPDATE ztab FROM @<fs>.
INSERT ztab FROM @<fs>.
```

### 3. UP TO 子句在 INTO 之后

```abap
" 错误：SELECT * FROM ztab UP TO 10 ROWS INTO TABLE @lt_tab WHERE ...（816 报 "UP not allowed here"）
" 正确：
SELECT * FROM ztab INTO TABLE @lt_tab UP TO 10 ROWS WHERE ...
```

### 4. string 模板 `{` 后必须空格

```abap
" 错误：DATA(s) = |值:{lv_x}|.   "（部分场景两系统均报错）
" 正确：
DATA(s) = |值: { lv_x }|.
```

### 5. 模板内 `{{`/`\X` 字面转义被新内核误解析

816 新内核对模板内的字面花括号/控制转义（`{{`、`}}`、`\n` 等旧转义）解析不稳定，表现为"孤立 `}`"或表达式误判。**JSON/正则/HTML 拼接一律不用模板**，改用单引号字符串 + `&&`：

```abap
" 高风险：DATA(json) = |{ '{"k":"v"}' }| " 或模板内嵌 \n
" 正确：
DATA(json) = '{"k":"' && lv_val && '"}'.
DATA(windows_path) = 'C:\temp\file.xlsx'.
```

### 6. `CONV i ( x+N )` 词法歧义

`CONV` 后的偏移表达式里 `x+N` 的 `N` 会被解析为结构组件名。偏移先算入变量：

```abap
" 错误：DATA(i) = CONV i ( lv_x+3 ).
" 正确：
DATA(lv_off) = lv_x+3.
DATA(i) = CONV i( lv_off ).
```

### 7. string 类型无长度偏移禁用；string 偏移+内联声明禁用

```abap
" 错误：DATA(s2) = lv_string+5.        "（string 无固定长度，偏移无意义）
" 错误：DATA(s3) = lv_char10+5.        "（偏移+内联声明组合被拒）
" 正确：预声明或用子串函数
DATA lv_buf TYPE c LENGTH 10.
lv_buf = lv_char10.
DATA(s3) = lv_buf+5.
DATA(s4) = substring( val = lv_string off = 5 ).
```

### 8. 方法内显式 DATA 声明必须在可执行语句之前

```abap
" 错误：METHOD m. lv_x = 1. DATA lv_x TYPE i. ENDMETHOD.
" 正确：METHOD m.
"        DATA lv_x TYPE i.
"        lv_x = 1.
"      ENDMETHOD.
" 内联声明 DATA(...) 不受此限。
```

### 9. CX 子类 CONSTRUCTOR 声明激活时被 SEO 重写 → 用静态工厂

816 实证：异常类 `RAISING`/`IMPORTING` 形态的 CONSTRUCTOR 声明在激活时被 SEO 内核重写，导致创建链"激活后源码 hash 验收不一致"。异常类一律用**无自定义 CONSTRUCTOR + 静态工厂方法**模式：

```abap
" 高风险：METHODS constructor IMPORTING iv_text TYPE string.
" 正确：不声明 constructor，提供静态工厂
CLASS-METHODS raise_with_text
  IMPORTING iv_text        TYPE string
  RAISING   zcx_my_error.
```

### 10. RETURNING 参数禁泛型表类型内联

```abap
" 错误：METHODS get_rows RETURNING VALUE(rt) TYPE STANDARD TABLE OF ztab.  "（内联泛型表类型被拒）
" 正确：类内预定义具体类型
TYPES tt_rows TYPE STANDARD TABLE OF ztab WITH DEFAULT KEY.
METHODS get_rows RETURNING VALUE(rt_rows) TYPE tt_rows.
```

### 11. generic TYPE any 禁 NUMBER/STYLE 格式指令；FLTP style 名为 `scientific`

```abap
" 错误：|{ lv_any NUMBER = USER }|          "（generic 类型不支持格式指令）
" 错误：|{ lv_fltp STYLE = fltp_string }|   "（style 名不存在）
" 正确：FLTP 经 decfloat34 中转后再格式化
DATA(lv_df34) = CONV decfloat34( lv_fltp ).
DATA(s) = |{ lv_df34 STYLE = scientific }|.
```

### 12. X030L 结构无 TABCLASS 组件

查表类别（透明表/视图/簇表）用 DD02L，不用 X030L：

```abap
" 错误：SELECT SINGLE tabclass FROM x030l ...
" 正确：
SELECT SINGLE tabclass FROM dd02l INTO @lv_tabclass WHERE tabname = @lv_name.
```

### 13. CX_SALV_MSG 未捕获（SALV 调用需 TRY 包裹）

7.51 实证：`cl_salv_table=>factory` 等 SALV 入口抛 `cx_salv_msg`，未捕获直接 dump。所有 SALV 调用必须 TRY 包裹：

```abap
TRY.
    cl_salv_table=>factory( IMPORTING r_salv_table = lo_alv CHANGING t_table = lt_tab ).
    lo_alv->display( ).
  CATCH cx_salv_msg INTO DATA(lx_salv).
    " 降级处理：写 list 或忽略
ENDTRY.
```

## 补充：服务端创建门已固化的形态约束

以下不是 SAP 语法规则，而是本仓库受控创建链在真机上固化的验收约束，生成器同样必须遵守：

- PROGRAM 首行必须是大写 `REPORT ZPROG.`，对象名大写、前置，且前面不得有注释块（创建门校验大小写敏感）。
- `METHODS ... RETURNING` 的类型不得是内联泛型表（见规则 10）。
- 固定长 DDIC 类型（CLNT/DATS/TIMS/INT1/INT4/FLTP 等）不接受 length/decimals；STRING 无 length 生成 `abap.sstring(255)`、带 length 生成 `abap.sstring(n)`；CURR/QUAN 必须显式用 CURR/QUAN 类型而非 DEC+referenceField；referenceField 的声明顺序由服务端自动重排，无需手工保证（见 `src/safe/tableDefinition.ts`）。
- **CUKY/UNIT 裸内置类型在透明表 DDL 中不可用**（Basis 816 真机实证：`abap.unit` 激活报"位置的数量 < 数据类型最小数量"）——服务端生成标准数据元素 `waers`/`meins`，调用方仍写 `type: CUKY/UNIT`。
- **透明表 STRING 字段用 `abap.sstring(255)`**（真机两次实证：裸 `abap.string` 激活失败/激活后源码规范化致 verify-source 失败；sstring(255) 是 ZTABDATA_DEMO 已验证形态）。
- 文本池载荷每个文本符号必须带独立 `@MaxLength` 指令行（缺省 132，SE32 上限），缺失会触发 DS512"文本元素包含错误"。
- EUDB 编辑锁陷阱：创建失败补偿删除对象后，写源会话遗留的编辑锁**不会随删除清除**（阻塞同用户其他会话约 30-60 分钟）——保留壳策略（A2）下修复而非重建可完全规避。
