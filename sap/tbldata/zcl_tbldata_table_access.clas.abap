" =====================================================================
" ZCL_TABLDATA_TABLE_ACCESS - 动态表访问与写路径（含安全护栏）
" ---------------------------------------------------------------------
" 用途：ZTABLDATA_TOOL 表数据工具的表读写层。
"       load_catalog()       取 DDIC 字段目录（排除 MANDT，标记键/hex）
"       guard_table()        表来源护栏（黑名单硬拒 / 默认仅 ZY / 放行标准表）
"       select_data()        动态全量/条件 SELECT -> 字符串矩阵
"       fill_dynamic_table() 字符串矩阵 -> 动态类型内表（写路径共用）
"       upsert()             按主键 upsert（Excel 导入语义）
"       replace_all()        全表删除后灌入（备份恢复语义）
"       count_rows()         当前行数（恢复前差异摘要）
"
" 安全与事务边界（重要）：
"   1. 本类只操作透明表（x030l-TABCLASS = 'TRANSP'），簇表/池表拒绝；
"   2. 黑名单表（DDIC 元数据/传输系统/系统安全表）不受放行开关影响，
"      始终硬拒——这些表损坏会导致系统不可用；
"   3. 客户端字段 MANDT 不进矩阵：动态内表行里 MANDT 恒为初值，写入时
"      依赖 Open SQL 自动客户端处理（忽略 wa 中 MANDT、写入 SY-MANDT），
"      杜绝跨客户端污染；
"   4. 本类不做 COMMIT/ROLLBACK——LUW 边界由报表壳统一控制，
"      保证"任一步失败整体回滚"的原子性承诺。
" =====================================================================
CLASS zcl_tbldata_table_access DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_upsert_result,
             inserted TYPE i,   " 新插入行数
             updated  TYPE i,   " 更新行数
             skipped  TYPE i,   " 跳过行数（模式不允许的操作）
           END OF ty_upsert_result.

    " upsert 模式：'A'=存在则更新/不存在则插入；'I'=仅插入（冲突跳过）；'U'=仅更新（缺失跳过）
    CONSTANTS: gc_mode_upsert TYPE c LENGTH 1 VALUE 'A',
               gc_mode_insert TYPE c LENGTH 1 VALUE 'I',
               gc_mode_update TYPE c LENGTH 1 VALUE 'U'.

    CLASS-METHODS load_catalog
      IMPORTING
        !iv_table        TYPE tabname
      RETURNING
        VALUE(rt_fields) TYPE zcl_tbldata_type_conv=>ty_fields
      RAISING
        zcx_tbldata_error.

    CLASS-METHODS guard_table
      IMPORTING
        !iv_table     TYPE tabname
        !iv_allow_std TYPE abap_bool        " 是否放行标准表（用户勾选）
        !iv_reason    TYPE string           " 放行标准表时强制的原因说明
      RAISING
        zcx_tbldata_error.

    CLASS-METHODS select_data
      IMPORTING
        !iv_table        TYPE tabname
        !it_fields       TYPE zcl_tbldata_type_conv=>ty_fields
        !iv_where        TYPE string DEFAULT ''  " 可选 WHERE 子句（用户输入，单引号需自行转义）
        !iv_max_rows     TYPE i DEFAULT 1000000  " 行数上限保护
      RETURNING
        VALUE(rt_matrix) TYPE zcl_tbldata_type_conv=>ty_matrix
      RAISING
        zcx_tbldata_error.

    CLASS-METHODS upsert
      IMPORTING
        !iv_table        TYPE tabname
        !it_fields       TYPE zcl_tbldata_type_conv=>ty_fields
        !it_matrix       TYPE zcl_tbldata_type_conv=>ty_matrix
        !iv_mode         TYPE c DEFAULT gc_mode_upsert
      RETURNING
        VALUE(rs_result) TYPE ty_upsert_result
      RAISING
        zcx_tbldata_error.

    CLASS-METHODS replace_all
      IMPORTING
        !iv_table          TYPE tabname
        !it_fields         TYPE zcl_tbldata_type_conv=>ty_fields
        !it_matrix         TYPE zcl_tbldata_type_conv=>ty_matrix
      RETURNING
        VALUE(rv_inserted) TYPE i
      RAISING
        zcx_tbldata_error.

    CLASS-METHODS count_rows
      IMPORTING
        !iv_table       TYPE tabname
      RETURNING
        VALUE(rv_count) TYPE i
      RAISING
        zcx_tbldata_error.

  PROTECTED SECTION.
  PRIVATE SECTION.

    " 黑名单判定（DDIC 元数据/传输系统/系统安全表，始终硬拒）
    CLASS-METHODS is_blacklisted
      IMPORTING
        !iv_table        TYPE tabname
      RETURNING
        VALUE(rv_result) TYPE abap_bool.

    " 字符串矩阵 -> 动态类型标准表（写路径 upsert/replace 共用）
    CLASS-METHODS fill_dynamic_table
      IMPORTING
        !iv_table     TYPE tabname
        !it_fields    TYPE zcl_tbldata_type_conv=>ty_fields
        !it_matrix    TYPE zcl_tbldata_type_conv=>ty_matrix
      RETURNING
        VALUE(rr_tab) TYPE REF TO data
      RAISING
        zcx_tbldata_error.

    " SQL 字面值转义（动态 WHERE 拼接前的单引号加倍）
    CLASS-METHODS quote_value
      IMPORTING
        !iv_text       TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

ENDCLASS.


CLASS zcl_tbldata_table_access IMPLEMENTATION.

  METHOD load_catalog.

    DATA: lt_dfies TYPE STANDARD TABLE OF dfies WITH DEFAULT KEY,
          ls_x030l TYPE x030l.

    " ---- DDIF_FIELDINFO_GET：DDIC 权威字段目录 + 表类别 ----
    CALL FUNCTION 'DDIF_FIELDINFO_GET'
      EXPORTING
        tabname   = iv_table
        langu     = sy-langu
        all_types = 'X'
      IMPORTING
        x030l_wa  = ls_x030l
      TABLES
        dfies_tab = lt_dfies
      EXCEPTIONS
        not_found = 1
        OTHERS    = 2.

    IF sy-subrc <> 0 OR lt_dfies IS INITIAL.
      zcx_tbldata_error=>raise( |表 { iv_table } 不存在或无字段信息（DDIF_FIELDINFO_GET 返回 { sy-subrc }）| ).
    ENDIF.

    " ---- 仅透明表：簇表/池表的动态读写语义不同，直接拒绝 ----
    IF ls_x030l-tabclass <> 'TRANSP'.
      zcx_tbldata_error=>raise( |表 { iv_table } 类别为 { ls_x030l-tabclass }（非透明表），本工具仅支持透明表| ).
    ENDIF.

    " ---- 组装字段目录；MANDT 不导出不导入（依赖 Open SQL 自动客户端处理） ----
    LOOP AT lt_dfies ASSIGNING FIELD-SYMBOL(<fs_df>).

      CHECK <fs_df>-fieldname <> 'MANDT'.

      " 未知类型类别在 to_text/from_text 中会被防御性拒绝，这里直接透传
      APPEND VALUE zcl_tbldata_type_conv=>ty_field(
            name     = <fs_df>-fieldname
            kind     = <fs_df>-inttype
            length   = <fs_df>-leng
            decimals = <fs_df>-decimals
            key      = COND #( WHEN <fs_df>-keyflag = abap_true THEN abap_true ELSE abap_false )
            hex      = COND #( WHEN <fs_df>-inttype = 'x' OR <fs_df>-inttype = 'y' THEN abap_true ELSE abap_false )
            descr    = <fs_df>-scrtext_l )
        TO rt_fields.

    ENDLOOP.

  ENDMETHOD.


  METHOD guard_table.

    " ---- 黑名单优先：不受放行开关影响 ----
    IF is_blacklisted( iv_table ) = abap_true.
      zcx_tbldata_error=>raise( |表 { iv_table } 属于系统关键表黑名单（DDIC 元数据/传输系统/系统安全表），任何模式下都禁止操作| ).
    ENDIF.

    " ---- 默认仅 Z/Y 自定义表；标准表需显式放行 + 原因说明 ----
    IF iv_table(1) = 'Z' OR iv_table(1) = 'Y'.
      RETURN.
    ENDIF.

    IF iv_allow_std <> abap_true.
      zcx_tbldata_error=>raise( |表 { iv_table } 不是 Z/Y 自定义表。如确需操作标准表，请勾选"放行标准表"并填写业务原因| ).
    ENDIF.

    IF iv_reason IS INITIAL.
      zcx_tbldata_error=>raise( |放行标准表 { iv_table } 必须填写业务原因（审计要求）| ).
    ENDIF.

    " 放行合法：审计输出由报表壳负责（原因已校验非空）

  ENDMETHOD.


  METHOD is_blacklisted.

    " 精确表名 + 危险前缀两类规则；前缀只收敛在确实致命的系统对象族，
    " 避免误伤业务自定义表
    DATA(lv_tab) = to_upper( CONV string( iv_table ) ).

    CASE lv_tab.
      WHEN 'T000'        " 客户端主数据
        OR 'TADIR'       " 对象目录
        OR 'TFDIR'       " 函数模块目录
        OR 'TRDIR'       " 程序目录
        OR 'PROGDIR'     " 程序目录（新）
        OR 'REPOSRC'     " 源码库
        OR 'REPOLOAD'    " 源码装载
        OR 'CROSS'       " 交叉引用
        OR 'D010INC'     " include 关系
        OR 'D010SYMB'.   " 编译符号表
        rv_result = abap_true.
        RETURN.
    ENDCASE.

    " 前缀规则：DDIC 元数据(DD*)、传输系统(E0*)、交叉引用(WBCROSS*)、
    " 类池元数据(SEO*)、用户与权限(USR*)、角色授权(AGR*)
    IF lv_tab CP 'DD*' OR lv_tab CP 'E0*' OR lv_tab CP 'WBCROSS*'
       OR lv_tab CP 'SEO*' OR lv_tab CP 'USR*' OR lv_tab CP 'AGR*'.
      rv_result = abap_true.
    ENDIF.

  ENDMETHOD.


  METHOD select_data.

    DATA: lr_tab TYPE REF TO data.

    IF iv_max_rows <= 0.
      zcx_tbldata_error=>raise( |行数上限必须为正数（当前 { iv_max_rows }）| ).
    ENDIF.

    " ---- 动态创建结果内表并读取 ----
    TRY.
        CREATE DATA lr_tab TYPE STANDARD TABLE OF (iv_table).
      CATCH cx_sy_create_data_error INTO DATA(lo_cd).
        zcx_tbldata_error=>raise( text_message = |表 { iv_table } 动态类型创建失败: { lo_cd->get_text( ) }| previous = lo_cd ).
    ENDTRY.

    ASSIGN lr_tab->* TO FIELD-SYMBOL(<lt_tab>).

    " 动态 Open SQL：WHERE 可选；按主键排序保证导出顺序稳定可复现；
    " 经典语法顺序：UP TO n ROWS 置于 ORDER BY 之后
    TRY.
        IF iv_where IS INITIAL.
          SELECT * FROM (iv_table)
            INTO TABLE <lt_tab>
            ORDER BY PRIMARY KEY
            UP TO iv_max_rows ROWS.
        ELSE.
          SELECT * FROM (iv_table)
            INTO TABLE <lt_tab>
            WHERE (iv_where)
            ORDER BY PRIMARY KEY
            UP TO iv_max_rows ROWS.
        ENDIF.
      CATCH cx_sy_dynamic_osql_semantics cx_sy_dynamic_osql_syntax
            cx_sy_open_sql_db INTO DATA(lo_sql).
        zcx_tbldata_error=>raise( text_message = |表 { iv_table } 读取失败: { lo_sql->get_text( ) }| previous = lo_sql ).
    ENDTRY.

    " ---- 逐字段文本化为矩阵（列序与字段目录一致） ----
    LOOP AT <lt_tab> ASSIGNING FIELD-SYMBOL(<ls_row>).

      DATA(lt_row) = VALUE zcl_tbldata_type_conv=>ty_row( ).

      LOOP AT it_fields ASSIGNING FIELD-SYMBOL(<fs_f>).

        ASSIGN COMPONENT <fs_f>-name OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv_comp>).
        IF sy-subrc <> 0.
          zcx_tbldata_error=>raise( |表 { iv_table } 字段 { <fs_f>-name } 与运行时结构不匹配| ).
        ENDIF.

        APPEND zcl_tbldata_type_conv=>to_text(
                 iv_kind     = <fs_f>-kind
                 iv_decimals = <fs_f>-decimals
                 iv_value    = <lv_comp> )
          TO lt_row.

      ENDLOOP.

      APPEND lt_row TO rt_matrix.

    ENDLOOP.

  ENDMETHOD.


  METHOD fill_dynamic_table.

    " ---- 构建动态类型标准表（行类型 = 源表结构） ----
    CREATE DATA rr_tab TYPE STANDARD TABLE OF (iv_table).
    ASSIGN rr_tab->* TO FIELD-SYMBOL(<lt_tab>).

    DATA: lr_row TYPE REF TO data,
          lv_line_no TYPE i.     " 矩阵行号（错误定位）

    LOOP AT it_matrix ASSIGNING FIELD-SYMBOL(<fs_row>).

      lv_line_no = sy-tabix.

      IF lines( <fs_row> ) <> lines( it_fields ).
        zcx_tbldata_error=>raise( |表 { iv_table }：第 { lv_line_no } 行单元格数 { lines( <fs_row> ) } 与字段目录 { lines( it_fields ) } 不一致| ).
      ENDIF.

      " 单行动态结构；MANDT 未映射保持初值（写入时 Open SQL 自动写 SY-MANDT）
      CREATE DATA lr_row TYPE (iv_table).
      ASSIGN lr_row->* TO FIELD-SYMBOL(<ls_row>).
      CLEAR <ls_row>.

      LOOP AT it_fields ASSIGNING FIELD-SYMBOL(<fs_f>).

        ASSIGN COMPONENT <fs_f>-name OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv_comp>).
        IF sy-subrc <> 0.
          zcx_tbldata_error=>raise( |表 { iv_table } 字段 { <fs_f>-name } 与运行时结构不匹配| ).
        ENDIF.

        " 列号与字段目录同序
        READ TABLE <fs_row> INTO DATA(lv_text) INDEX sy-tabix.

        zcl_tbldata_type_conv=>from_text(
          EXPORTING
            iv_kind     = <fs_f>-kind
            iv_decimals = <fs_f>-decimals
            iv_text     = lv_text
            iv_max_len  = <fs_f>-length
            iv_context  = |表 { iv_table } 第 { lv_line_no } 行 字段 { <fs_f>-name }: |
          CHANGING
            cg_value    = <lv_comp> ).

      ENDLOOP.

      " 标准表按矩阵顺序追加，保证后续 upsert 的行号对齐
      APPEND <ls_row> TO <lt_tab>.

    ENDLOOP.

  ENDMETHOD.


  METHOD upsert.

    " ---- 文本矩阵 -> 动态内表（类型转换错误在此集中抛出） ----
    DATA(lr_tab) = fill_dynamic_table( iv_table  = iv_table
                                       it_fields = it_fields
                                       it_matrix = it_matrix ).
    ASSIGN lr_tab->* TO FIELD-SYMBOL(<lt_tab>).

    " ---- 主键字段清单（WHERE 拼接依据） ----
    DATA(lt_key_fields) = VALUE zcl_tbldata_type_conv=>ty_fields( ).
    LOOP AT it_fields ASSIGNING FIELD-SYMBOL(<fs_f>) WHERE key = abap_true.
      APPEND <fs_f> TO lt_key_fields.
    ENDLOOP.
    IF lt_key_fields IS INITIAL.
      zcx_tbldata_error=>raise( |表 { iv_table } 无主键字段，无法执行按主键 upsert| ).
    ENDIF.

    " ---- 动态行 wa（存在性探测用，避免覆盖待写行） ----
    DATA: lr_probe TYPE REF TO data.
    CREATE DATA lr_probe TYPE (iv_table).
    ASSIGN lr_probe->* TO FIELD-SYMBOL(<ls_probe>).

    " ---- 逐行存在性判定 + 写入（LUW 边界由报表壳控制） ----
    DATA(lv_src_line) = 0.

    LOOP AT <lt_tab> ASSIGNING FIELD-SYMBOL(<ls_row>).

      lv_src_line = sy-tabix.

      " 内表行与矩阵行同序（fill 按矩阵顺序追加）
      READ TABLE it_matrix ASSIGNING FIELD-SYMBOL(<fs_srcrow>) INDEX lv_src_line.

      " 按 PK 拼动态 WHERE（值取矩阵原文文本并转义单引号）
      DATA(lv_cond) = VALUE string( ).
      LOOP AT lt_key_fields INTO DATA(ls_kf).

        " 键字段在字段目录中的列号 == 矩阵列号
        DATA(lv_col) = line_index( it_fields[ name = ls_kf-name ] ).
        READ TABLE <fs_srcrow> INTO DATA(lv_kv) INDEX lv_col.

        IF lv_cond IS NOT INITIAL.
          lv_cond = lv_cond && | AND |.
        ENDIF.
        lv_cond = lv_cond && |{ ls_kf-name } = '{ quote_value( lv_kv ) }'|.

      ENDLOOP.

      " 存在性探测
      SELECT SINGLE * FROM (iv_table) INTO <ls_probe> WHERE (lv_cond).

      IF sy-subrc = 0.
        " 已存在：按模式更新或跳过
        CASE iv_mode.
          WHEN gc_mode_upsert OR gc_mode_update.
            UPDATE (iv_table) FROM <ls_row>.
            IF sy-subrc <> 0.
              zcx_tbldata_error=>raise( |表 { iv_table } 第 { lv_src_line } 行 UPDATE 失败（SY-SUBRC { sy-subrc }）| ).
            ENDIF.
            rs_result-updated = rs_result-updated + 1.
          WHEN gc_mode_insert.
            rs_result-skipped = rs_result-skipped + 1.
        ENDCASE.
      ELSE.
        " 不存在：按模式插入或跳过
        CASE iv_mode.
          WHEN gc_mode_upsert OR gc_mode_insert.
            INSERT (iv_table) FROM <ls_row>.
            IF sy-subrc <> 0.
              zcx_tbldata_error=>raise( |表 { iv_table } 第 { lv_src_line } 行 INSERT 失败（SY-SUBRC { sy-subrc }，主键冲突或约束不符）| ).
            ENDIF.
            rs_result-inserted = rs_result-inserted + 1.
          WHEN gc_mode_update.
            rs_result-skipped = rs_result-skipped + 1.
        ENDCASE.
      ENDIF.

    ENDLOOP.

  ENDMETHOD.


  METHOD replace_all.

    " ---- 文本矩阵 -> 动态内表 ----
    DATA(lr_tab) = fill_dynamic_table( iv_table  = iv_table
                                       it_fields = it_fields
                                       it_matrix = it_matrix ).
    ASSIGN lr_tab->* TO FIELD-SYMBOL(<lt_tab>).

    " ---- 时点全量替换：先清后灌（LUW 由报表壳控制，失败整体回滚） ----
    DELETE FROM (iv_table).
    IF sy-subrc <> 0.
      zcx_tbldata_error=>raise( |表 { iv_table } 全表 DELETE 失败（SY-SUBRC { sy-subrc }）| ).
    ENDIF.

    IF lines( <lt_tab> ) > 0.
      INSERT (iv_table) FROM TABLE <lt_tab>.
      IF sy-subrc <> 0.
        zcx_tbldata_error=>raise( |表 { iv_table } 批量 INSERT 失败（SY-SUBRC { sy-subrc }），当前 LUW 将被回滚| ).
      ENDIF.
    ENDIF.

    rv_inserted = lines( <lt_tab> ).

  ENDMETHOD.


  METHOD count_rows.

    " 行数统计（恢复前差异摘要展示用）
    SELECT COUNT(*) FROM (iv_table) INTO @DATA(lv_cnt).
    rv_count = lv_cnt.

  ENDMETHOD.


  METHOD quote_value.

    rv_text = iv_text.
    " 动态 WHERE 字面值转义：单引号加倍防注入/防语法错
    REPLACE ALL OCCURRENCES OF '''' IN rv_text WITH ''''''.

  ENDMETHOD.

ENDCLASS.
