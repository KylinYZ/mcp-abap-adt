REPORT ZTABDATA_TOOL.

" =====================================================================
" ZTABDATA_TOOL - 表数据导出/导入/备份/恢复工具（选择屏幕壳）
" ---------------------------------------------------------------------
" 模式与语义（详见 docs/superpowers/specs 设计文档）：
"   导出 EXPORT：表数据 -> Excel(.xlsx)，全字段文本保真 + META 元数据页
"   导入 IMPORT：本工具导出的 Excel -> 原表，按主键 upsert（默认先自动备份）
"   备份 BACKUP：表数据 -> .jsonl.gz（JSONL+gzip+MD5，无损）
"   恢复 RESTORE：备份文件 -> 原表，时点全量替换（先强制快照+确认）
"
" 执行通道：文件下载/上传走 CL_GUI_FRONTEND_SERVICES，必须在 SAP GUI
" 前台会话运行（后台执行会在文件对话框处失败）。
"
" 安全护栏（实现在 ZCL_TABDATA_TABLE_ACCESS）：
"   - 黑名单系统表始终硬拒；默认仅 Z/Y 表，标准表需勾选放行+填写原因；
"   - 所有写路径单 LUW 原子：成功 COMMIT WORK，任何失败 ROLLBACK WORK；
"   - 导入前默认自动备份当前数据；恢复前强制快照当前数据（恢复可逆）。
" =====================================================================


" ---------------------------------------------------------------------
" 选择屏幕定义
" ---------------------------------------------------------------------
SELECTION-SCREEN BEGIN OF BLOCK b_mode WITH FRAME TITLE gv_tmo.
PARAMETERS:
  " 四模式互斥单选：导出/导入/备份/恢复
  rb_exp RADIOBUTTON GROUP mode USER-COMMAND mode_chg DEFAULT 'X',  " 导出 Excel
  rb_imp RADIOBUTTON GROUP mode,                                    " 导入 Excel
  rb_bak RADIOBUTTON GROUP mode,                                    " 备份
  rb_res RADIOBUTTON GROUP mode.                                    " 恢复
SELECTION-SCREEN END OF BLOCK b_mode.

SELECTION-SCREEN BEGIN OF BLOCK b_tab WITH FRAME TITLE gv_ttb.
PARAMETERS:
  " 目标表名：仅透明表；黑名单系统表任何模式拒绝。
  " 不用 OBLIGATORY：避免模式切换（USER-COMMAND 触发 PAI）时被必输校验拦截
  p_table TYPE tabname.
SELECTION-SCREEN END OF BLOCK b_tab.

SELECTION-SCREEN BEGIN OF BLOCK b_exp WITH FRAME TITLE gv_tex.
PARAMETERS:
  p_where  TYPE string LOWER CASE MODIF ID mex,   " 可选 WHERE 子句（导出）
  p_maxrow TYPE i DEFAULT 100000 MODIF ID mex,    " 导出行数上限（Excel 极限保护）
  p_fexp   TYPE string LOWER CASE MODIF ID mex.   " 导出文件路径（.xlsx）
SELECTION-SCREEN END OF BLOCK b_exp.

SELECTION-SCREEN BEGIN OF BLOCK b_imp WITH FRAME TITLE gv_tim.
PARAMETERS:
  p_fimp   TYPE string LOWER CASE MODIF ID mim,   " 导入文件路径（.xlsx）
  p_impbak TYPE abap_bool AS CHECKBOX DEFAULT 'X' MODIF ID mim,  " 导入前自动备份
  p_umode  RADIOBUTTON GROUP umo MODIF ID mim DEFAULT 'X',  " upsert
  p_uonlyi RADIOBUTTON GROUP umo MODIF ID mim,              " 仅插入
  p_uonlyu RADIOBUTTON GROUP umo MODIF ID mim.              " 仅更新
SELECTION-SCREEN END OF BLOCK b_imp.

SELECTION-SCREEN BEGIN OF BLOCK b_bak WITH FRAME TITLE gv_tbk.
PARAMETERS:
  p_fbak TYPE string LOWER CASE MODIF ID mbk.     " 备份文件路径（.jsonl.gz）
SELECTION-SCREEN END OF BLOCK b_bak.

SELECTION-SCREEN BEGIN OF BLOCK b_res WITH FRAME TITLE gv_trs.
PARAMETERS:
  p_fres TYPE string LOWER CASE MODIF ID mrs.     " 恢复文件路径（.jsonl.gz）
SELECTION-SCREEN END OF BLOCK b_res.

SELECTION-SCREEN BEGIN OF BLOCK b_sec WITH FRAME TITLE gv_tsc.
PARAMETERS:
  " 标准表放行开关：黑名单不受此开关影响，始终硬拒
  p_allow TYPE abap_bool AS CHECKBOX USER-COMMAND allow_chg,  " 放行标准表
  p_reason TYPE string LOWER CASE MODIF ID msn.             " 放行原因（审计）
SELECTION-SCREEN END OF BLOCK b_sec.

" ---------------------------------------------------------------------
" 全局数据
" ---------------------------------------------------------------------
DATA: gv_reason_valid TYPE abap_bool VALUE abap_true. " 放行原因非空校验结果

" ---------------------------------------------------------------------
" 局部类：四模式执行器（逻辑集中，报表事件块只做装配与输出）
" ---------------------------------------------------------------------
CLASS lcl_runner DEFINITION CREATE PRIVATE.

  PUBLIC SECTION.

    " 结果输出行（SALV 展示）
    TYPES: BEGIN OF ty_result,
             category TYPE string,   " 类别（统计/警告/错误/审计）
             item     TYPE string,   " 条目
             value    TYPE string,   " 数值/结果
             note     TYPE string,   " 补充说明
           END OF ty_result,
           ty_results TYPE STANDARD TABLE OF ty_result WITH DEFAULT KEY,
           ty_warn    TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    CLASS-METHODS get_instance
      RETURNING VALUE(ro_runner) TYPE REF TO lcl_runner.

    METHODS run_exp RAISING zcx_tabdata_error.  " 导出
    METHODS run_imp RAISING zcx_tabdata_error.  " 导入
    METHODS run_bak RAISING zcx_tabdata_error.  " 备份
    METHODS run_res RAISING zcx_tabdata_error.  " 恢复

    " 结果表（各 run_* 填充，START-OF-SELECTION 输出）
    DATA: gt_result TYPE ty_results READ-ONLY.

    " 记录一行结果
    METHODS add_result
      IMPORTING
        iv_category TYPE string
        iv_item     TYPE string
        iv_value    TYPE string DEFAULT ''
        iv_note     TYPE string DEFAULT ''.

  PRIVATE SECTION.

    " 结构漂移比对：META/备份字段目录 vs 当前 DDIC 目录
    " 返回警告清单（新增字段）；严格模式（恢复）任何差异抛异常
    METHODS compare_structure
      IMPORTING
        it_meta_fields  TYPE zcl_tabdata_type_conv=>ty_fields  " 文件内字段目录
        it_catalog      TYPE zcl_tabdata_type_conv=>ty_fields  " 当前 DDIC 目录
        iv_strict       TYPE abap_bool                         " 恢复=true：新增字段也拒绝
        iv_label        TYPE string                            " 错误定位标签
      RETURNING
        VALUE(rt_warn)  TYPE ty_warn
      RAISING
        zcx_tabdata_error.

    " 从 META sheet 解析头信息与字段目录（导入用）
    METHODS parse_meta_sheet
      IMPORTING
        !it_rows        TYPE zcl_tabdata_type_conv=>ty_matrix
      EXPORTING
        !ev_table       TYPE tabname
        !ev_rows        TYPE i
        !et_meta_fields TYPE zcl_tabdata_type_conv=>ty_fields
        !ev_client      TYPE string
        !ev_system      TYPE string
      RAISING
        zcx_tabdata_error.

    " 数据 sheet（首行表头）-> 按"当前字段目录列序"规整的矩阵
    METHODS normalize_data_sheet
      IMPORTING
        !it_rows        TYPE zcl_tabdata_type_conv=>ty_matrix
        !it_catalog     TYPE zcl_tabdata_type_conv=>ty_fields
        !iv_table       TYPE tabname
      RETURNING
        VALUE(rt_matrix) TYPE zcl_tabdata_type_conv=>ty_matrix
      RAISING
        zcx_tabdata_error.

    " 读本地文件为 xstring（GUI 通道）
    CLASS-METHODS read_frontend_file
      IMPORTING
        !iv_path   TYPE string
      RETURNING
        VALUE(rv_data) TYPE xstring
      RAISING
        zcx_tabdata_error.

    " 写 xstring 到本地文件（GUI 通道）
    CLASS-METHODS write_frontend_file
      IMPORTING
        !iv_path TYPE string
        !iv_data TYPE xstring
      RAISING
        zcx_tabdata_error.

    " 通用备份动作：当前表数据 -> .jsonl.gz（导入前自动备份/恢复前快照共用）
    METHODS snapshot_current
      IMPORTING
        !iv_table      TYPE tabname
        !it_catalog    TYPE zcl_tabdata_type_conv=>ty_fields
        !iv_tag        TYPE string          " 文件名标签（preimport / prerestore）
      RETURNING
        VALUE(rv_path) TYPE string          " 实际保存路径
      RAISING
        zcx_tabdata_error.

    " 构造 META sheet 行（导出用；与 parse_meta_sheet 互为逆操作）
    CLASS-METHODS build_meta_rows
      IMPORTING
        !iv_table   TYPE tabname
        !it_fields  TYPE zcl_tabdata_type_conv=>ty_fields
        !iv_rows    TYPE i
      RETURNING
        VALUE(rt_rows) TYPE zcl_tabdata_type_conv=>ty_matrix.

ENDCLASS.


CLASS lcl_runner IMPLEMENTATION.

  METHOD get_instance.
    " 工具无状态依赖，单例即可（会话内一次运行一个模式）
    STATICS: lo_instance TYPE REF TO lcl_runner.
    IF lo_instance IS NOT BOUND.
      CREATE OBJECT lo_instance.
    ENDIF.
    ro_runner = lo_instance.
  ENDMETHOD.

  METHOD add_result.
    APPEND VALUE ty_result( category = iv_category
                            item     = iv_item
                            value    = iv_value
                            note     = iv_note )
           TO gt_result.
  ENDMETHOD.

  " ===================================================================
  " 模式一：导出（表 -> Excel）
  " ===================================================================
  METHOD run_exp.

    " 1) 护栏 + 字段目录
    zcl_tabdata_table_access=>guard_table(
        iv_table = CONV tabname( p_table )
        iv_allow_std = p_allow
        iv_reason = p_reason ).
    DATA(lt_catalog) = zcl_tabdata_table_access=>load_catalog( CONV tabname( p_table ) ).

    " 2) 动态读取 + 文本化
    DATA(lt_matrix) = zcl_tabdata_table_access=>select_data(
        iv_table    = CONV tabname( p_table )
        it_fields   = lt_catalog
        iv_where    = p_where
        iv_max_rows = p_maxrow ).

    " 3) 组 sheet：首行表头 + 数据行；META 页记录指纹
    DATA(lt_sheets) = VALUE zcl_tabdata_xlsx=>ty_sheets( ).
    DATA(lt_data_rows) = lt_matrix.
    INSERT VALUE zcl_tabdata_type_conv=>ty_row(
             FOR <fs_f> IN lt_catalog ( CONV string( <fs_f>-name ) ) )
           INTO lt_data_rows INDEX 1.
    APPEND VALUE zcl_tabdata_xlsx=>ty_sheet(
             name = 'DATA' rows = lt_data_rows ) TO lt_sheets.
    APPEND VALUE zcl_tabdata_xlsx=>ty_sheet(
             name = 'META' rows = build_meta_rows(
                     iv_table = CONV tabname( p_table )
                     it_fields = lt_catalog
                     iv_rows = lines( lt_matrix ) ) ) TO lt_sheets.

    " 4) 写 xlsx 并下载
    DATA(lv_xlsx) = zcl_tabdata_xlsx=>write( lt_sheets ).

    DATA(lv_path) = COND string(
        WHEN p_fexp IS NOT INITIAL THEN p_fexp
        ELSE |{ p_table }_export_{ sy-datum }{ sy-uzeit }.xlsx| ).

    write_frontend_file( iv_path = lv_path iv_data = lv_xlsx ).

    " 5) 结果与提示
    add_result( iv_category = '统计' iv_item = '导出行数'
                iv_value = CONV string( lines( lt_matrix ) ) ).
    add_result( iv_category = '统计' iv_item = '字段数'
                iv_value = CONV string( lines( lt_catalog ) ) ).
    add_result( iv_category = '统计' iv_item = '导出文件' iv_value = lv_path ).
    IF lines( lt_matrix ) >= p_maxrow.
      add_result( iv_category = '警告' iv_item = '行数已达上限'
                  iv_value = CONV string( p_maxrow )
                  iv_note = '结果可能被截断，请确认或调大上限/使用备份通道' ).
    ENDIF.
    IF p_allow = abap_true AND p_reason IS NOT INITIAL.
      add_result( iv_category = '审计' iv_item = '放行标准表'
                  iv_value = p_table iv_note = p_reason ).
    ENDIF.

  ENDMETHOD.

  " ===================================================================
  " 模式二：导入（Excel -> 原表，upsert）
  " ===================================================================
  METHOD run_imp.

    " 1) 读 xlsx 并解析
    DATA(lv_xlsx) = read_frontend_file( p_fimp ).
    DATA(lt_sheets) = zcl_tabdata_xlsx=>read( lv_xlsx ).

    DATA(lt_data_sheet) = VALUE zcl_tabdata_type_conv=>ty_matrix( ).
    DATA(lt_meta_sheet) = VALUE zcl_tabdata_type_conv=>ty_matrix( ).
    LOOP AT lt_sheets ASSIGNING FIELD-SYMBOL(<fs_sheet>).
      CASE <fs_sheet>-name.
        WHEN 'DATA'. lt_data_sheet = <fs_sheet>-rows.
        WHEN 'META'. lt_meta_sheet = <fs_sheet>-rows.
      ENDCASE.
    ENDLOOP.
    IF lt_meta_sheet IS INITIAL OR lt_data_sheet IS INITIAL.
      zcx_tabdata_error=>raise( |导入：文件缺少 DATA/META 页，不是本工具导出的 Excel| ).
    ENDIF.

    " 2) 当前 DDIC 目录 + META 解析 + 结构漂移比对
    DATA(lt_catalog) = zcl_tabdata_table_access=>load_catalog( CONV tabname( p_table ) ).

    DATA: lv_meta_table TYPE tabname,
          lv_meta_rows  TYPE i,
          lv_meta_clnt  TYPE string,
          lv_meta_sys   TYPE string.
    parse_meta_sheet( EXPORTING it_rows = lt_meta_sheet
                      IMPORTING ev_table = lv_meta_table
                                ev_rows = lv_meta_rows
                                et_meta_fields = DATA(lt_meta_fields)
                                ev_client = lv_meta_clnt
                                ev_system = lv_meta_sys ).

    IF to_upper( lv_meta_table ) <> to_upper( CONV string( p_table ) ).
      zcx_tabdata_error=>raise( |导入：Excel 是表 { lv_meta_table } 的导出，与目标表 { p_table } 不一致| ).
    ENDIF.

    DATA(lt_warn) = compare_structure( it_meta_fields = lt_meta_fields
                                       it_catalog = lt_catalog
                                       iv_strict = abap_false
                                       iv_label = |导入| ).
    LOOP AT lt_warn INTO DATA(lv_w).
      add_result( iv_category = '警告' iv_item = '结构漂移' iv_value = lv_w
                  iv_note = '新增字段将按初值写入' ).
    ENDLOOP.
    IF lv_meta_clnt IS NOT INITIAL AND lv_meta_clnt <> CONV string( sy-mandt ).
      add_result( iv_category = '警告' iv_item = '客户端不一致'
                  iv_value = |Excel 来自客户端 { lv_meta_clnt }|
                  iv_note = |数据将写入当前客户端 { sy-mandt }（自动客户端处理）| ).
    ENDIF.

    " 3) 数据页规整（按当前字段目录列序）
    DATA(lt_matrix) = normalize_data_sheet( it_rows = lt_data_sheet
                                            it_catalog = lt_catalog
                                            iv_table = CONV tabname( p_table ) ).

    " 4) 写路径护栏
    zcl_tabdata_table_access=>guard_table(
        iv_table = CONV tabname( p_table )
        iv_allow_std = p_allow
        iv_reason = p_reason ).

    " 5) 导入前自动备份（默认勾选）
    IF p_impbak = abap_true.
      DATA(lv_snap_path) = snapshot_current(
          iv_table = CONV tabname( p_table )
          it_catalog = lt_catalog
          iv_tag = 'preimport' ).
      add_result( iv_category = '统计' iv_item = '导入前自动备份' iv_value = lv_snap_path ).
    ENDIF.

    " 6) upsert 写入（模式映射）
    DATA(lv_mode) = COND c( WHEN p_uonlyi = abap_true
                            THEN zcl_tabdata_table_access=>gc_mode_insert
                            WHEN p_uonlyu = abap_true
                            THEN zcl_tabdata_table_access=>gc_mode_update
                            ELSE zcl_tabdata_table_access=>gc_mode_upsert ).

    DATA(ls_up) = zcl_tabdata_table_access=>upsert(
        iv_table = CONV tabname( p_table )
        it_fields = lt_catalog
        it_matrix = lt_matrix
        iv_mode = lv_mode ).

    " 7) 结果 + 审计（COMMIT 由 START-OF-SELECTION 成功路径统一执行）
    add_result( iv_category = '统计' iv_item = '新插入' iv_value = CONV string( ls_up-inserted ) ).
    add_result( iv_category = '统计' iv_item = '已更新' iv_value = CONV string( ls_up-updated ) ).
    add_result( iv_category = '统计' iv_item = '跳过' iv_value = CONV string( ls_up-skipped ) ).
    IF p_allow = abap_true AND p_reason IS NOT INITIAL.
      add_result( iv_category = '审计' iv_item = '放行标准表'
                  iv_value = p_table iv_note = p_reason ).
    ENDIF.

  ENDMETHOD.

  " ===================================================================
  " 模式三：备份（表 -> .jsonl.gz）
  " ===================================================================
  METHOD run_bak.

    " 1) 护栏 + 目录 + 全量读取
    zcl_tabdata_table_access=>guard_table(
        iv_table = CONV tabname( p_table )
        iv_allow_std = p_allow
        iv_reason = p_reason ).
    DATA(lt_catalog) = zcl_tabdata_table_access=>load_catalog( CONV tabname( p_table ) ).

    DATA(lt_matrix) = zcl_tabdata_table_access=>select_data(
        iv_table = CONV tabname( p_table )
        it_fields = lt_catalog ).

    " 2) 序列化（头+MD5+gzip 由备份类完成）
    DATA(lv_gzip) = zcl_tabdata_backup=>serialize(
        iv_table = CONV tabname( p_table )
        it_fields = lt_catalog
        it_matrix = lt_matrix ).

    " 3) 下载
    DATA(lv_path) = COND string(
        WHEN p_fbak IS NOT INITIAL THEN p_fbak
        ELSE |{ p_table }_backup_{ sy-datum }{ sy-uzeit }.jsonl.gz| ).

    write_frontend_file( iv_path = lv_path iv_data = lv_gzip ).

    add_result( iv_category = '统计' iv_item = '备份行数'
                iv_value = CONV string( lines( lt_matrix ) ) ).
    add_result( iv_category = '统计' iv_item = '备份文件' iv_value = lv_path ).
    IF p_allow = abap_true AND p_reason IS NOT INITIAL.
      add_result( iv_category = '审计' iv_item = '放行标准表'
                  iv_value = p_table iv_note = p_reason ).
    ENDIF.

  ENDMETHOD.

  " ===================================================================
  " 模式四：恢复（备份 -> 原表，时点全量替换）
  " ===================================================================
  METHOD run_res.

    " 1) 读备份并解析（MD5 完整性在备份类内校验）
    DATA(lv_gzip) = read_frontend_file( p_fres ).
    DATA(ls_header) = VALUE zcl_tabdata_backup=>ty_header( ).
    DATA(lt_matrix) = VALUE zcl_tabdata_type_conv=>ty_matrix( ).
    zcl_tabdata_backup=>deserialize( EXPORTING iv_gzip = lv_gzip
                                     IMPORTING es_header = ls_header
                                               et_matrix = lt_matrix ).

    " 2) 目标一致性 + 结构严格比对（恢复要求结构完全一致）
    IF to_upper( ls_header-table ) <> to_upper( CONV string( p_table ) ).
      zcx_tabdata_error=>raise( |恢复：备份是表 { ls_header-table } 的数据，与目标表 { p_table } 不一致| ).
    ENDIF.

    DATA(lt_catalog) = zcl_tabdata_table_access=>load_catalog( CONV tabname( p_table ) ).

    " 头字段目录 -> conv 目录形态后严格比对
    DATA(lt_hdr_fields) = VALUE zcl_tabdata_type_conv=>ty_fields( ).
    LOOP AT ls_header-fields ASSIGNING FIELD-SYMBOL(<fs_fj>).
      APPEND VALUE zcl_tabdata_type_conv=>ty_field(
            name = CONV fieldname( <fs_fj>-name )
            kind = CONV abap_typekind( <fs_fj>-kind )
            length = <fs_fj>-length
            decimals = <fs_fj>-decimals
            key = <fs_fj>-key
            hex = <fs_fj>-hex )
        TO lt_hdr_fields.
    ENDLOOP.

    compare_structure( it_meta_fields = lt_hdr_fields
                       it_catalog = lt_catalog
                       iv_strict = abap_true
                       iv_label = |恢复| ).

    " 3) 写路径护栏
    zcl_tabdata_table_access=>guard_table(
        iv_table = CONV tabname( p_table )
        iv_allow_std = p_allow
        iv_reason = p_reason ).

    " 4) 恢复前差异摘要 + 强制快照（恢复可逆的保险）
    DATA(lv_cur_rows) = zcl_tabdata_table_access=>count_rows( CONV tabname( p_table ) ).

    add_result( iv_category = '统计' iv_item = '备份时间点'
                iv_value = |{ ls_header-system }/{ ls_header-client } { ls_header-timestamp } ({ ls_header-user })| ).
    add_result( iv_category = '统计' iv_item = '备份行数' iv_value = CONV string( ls_header-rows ) ).
    add_result( iv_category = '统计' iv_item = '当前行数' iv_value = CONV string( lv_cur_rows ) ).

    DATA(lv_snap_path) = snapshot_current(
        iv_table = CONV tabname( p_table )
        it_catalog = lt_catalog
        iv_tag = 'prerestore' ).
    add_result( iv_category = '统计' iv_item = '恢复前快照' iv_value = lv_snap_path ).

    " 5) 最终确认弹窗（差异摘要已展示，用户显式确认才动表）
    DATA(lv_answer) = CONV c( space ).  " '1'=YES '2'=NO 'A'=CANCEL
    CALL FUNCTION 'POPUP_TO_CONFIRM'
      EXPORTING
        title_bar              = '确认恢复'
        text_question          = |将把表 { p_table } 当前 { lv_cur_rows } 行全量替换为备份的 { ls_header-rows } 行（备份自 { ls_header-timestamp }）。当前数据已快照。确认执行？|
        display_cancel_button  = 'X'
      IMPORTING
        answer                 = lv_answer
      EXCEPTIONS
        OTHERS                 = 0.
    IF lv_answer <> '1'.
      zcx_tabdata_error=>raise( '恢复已取消（用户未确认），表数据未变动' ).
    ENDIF.

    " 6) 全量替换（失败由 START-OF-SELECTION 统一 ROLLBACK）
    DATA(lv_inserted) = zcl_tabdata_table_access=>replace_all(
        iv_table = CONV tabname( p_table )
        it_fields = lt_catalog
        it_matrix = lt_matrix ).

    add_result( iv_category = '统计' iv_item = '恢复灌入行数'
                iv_value = CONV string( lv_inserted ) ).
    IF p_allow = abap_true AND p_reason IS NOT INITIAL.
      add_result( iv_category = '审计' iv_item = '放行标准表'
                  iv_value = p_table iv_note = p_reason ).
    ENDIF.

  ENDMETHOD.

  " ===================================================================
  " 结构漂移比对
  " ===================================================================
  METHOD compare_structure.

    " 方向一：文件字段在当前表中不存在 -> 当前表缺字段，数据无处可落
    LOOP AT it_meta_fields ASSIGNING FIELD-SYMBOL(<fs_m>).

      READ TABLE it_catalog ASSIGNING FIELD-SYMBOL(<fs_c>)
           WITH KEY name = <fs_m>-name.
      IF sy-subrc <> 0.
        zcx_tabdata_error=>raise( |{ iv_label }：字段 { <fs_m>-name } 在当前表结构中不存在（结构已变化），操作拒绝| ).
      ENDIF.

      " 类型/长度/小数位漂移一律拒绝（文本还原规则依赖三者一致）
      IF <fs_m>-kind <> <fs_c>-kind
         OR <fs_m>-length <> <fs_c>-length
         OR <fs_m>-decimals <> <fs_c>-decimals.
        zcx_tabdata_error=>raise( |{ iv_label }：字段 { <fs_m>-name } 类型漂移（文件 { <fs_m>-kind }/{ <fs_m>-length }/{ <fs_m>-decimals } vs 当前 { <fs_c>-kind }/{ <fs_c>-length }/{ <fs_c>-decimals }），操作拒绝| ).
      ENDIF.

    ENDLOOP.

    " 方向二：当前表比文件多字段 -> 非严格模式警告（落初值），严格模式拒绝
    LOOP AT it_catalog ASSIGNING <fs_c>.

      READ TABLE it_meta_fields TRANSPORTING NO FIELDS
           WITH KEY name = <fs_c>-name.
      IF sy-subrc <> 0.
        IF iv_strict = abap_true.
          zcx_tabdata_error=>raise( |{ iv_label }：当前表存在备份中没有的字段 { <fs_c>-name }（结构已变化），恢复要求结构完全一致，请重新备份| ).
        ELSE.
          APPEND |字段 { <fs_c>-name }（当前表新增）| TO rt_warn.
        ENDIF.
      ENDIF.

    ENDLOOP.

  ENDMETHOD.

  " ===================================================================
  " META sheet 解析（导出 build_meta_rows 的逆操作）
  " ===================================================================
  METHOD parse_meta_sheet.

    CLEAR: ev_table, ev_rows, ev_client, ev_system.
    CLEAR et_meta_fields.

    LOOP AT it_rows ASSIGNING FIELD-SYMBOL(<fs_row>).

      " 每行两列：[键, 值]；FIELD 行的值形如 "NAME|KIND|LEN|DEC|K|H"
      READ TABLE <fs_row> INTO DATA(lv_key) INDEX 1.
      READ TABLE <fs_row> INTO DATA(lv_val) INDEX 2.

      CASE lv_key.
        WHEN 'TABLE'.    ev_table = CONV tabname( lv_val ).
        WHEN 'CLIENT'.   ev_client = lv_val.
        WHEN 'SYSTEM'.   ev_system = lv_val.
        WHEN 'ROWS'.     ev_rows = CONV i ( lv_val ).
        WHEN 'FIELD'.
          " 字段目录行：6 段竖线分隔
          SPLIT lv_val AT '|' INTO TABLE DATA(lt_seg).
          IF lines( lt_seg ) < 6.
            zcx_tabdata_error=>raise( |导入：META 字段行格式异常: { lv_val }| ).
          ENDIF.
          APPEND VALUE zcl_tabdata_type_conv=>ty_field(
                name     = CONV fieldname( lt_seg[ 1 ] )
                kind     = CONV abap_typekind( lt_seg[ 2 ] )
                length   = CONV i ( lt_seg[ 3 ] )
                decimals = CONV i ( lt_seg[ 4 ] )
                key      = COND #( WHEN lt_seg[ 5 ] = 'X' THEN abap_true ELSE abap_false )
                hex      = COND #( WHEN lt_seg[ 6 ] = 'X' THEN abap_true ELSE abap_false ) )
            TO et_meta_fields.
      ENDCASE.

    ENDLOOP.

    IF ev_table IS INITIAL OR et_meta_fields IS INITIAL.
      zcx_tabdata_error=>raise( |导入：META 页缺少表名或字段目录| ).
    ENDIF.

  ENDMETHOD.

  " ===================================================================
  " 数据 sheet -> 按当前字段目录列序规整的矩阵
  " ===================================================================
  METHOD normalize_data_sheet.

    DATA: lt_colmap TYPE STANDARD TABLE OF i WITH DEFAULT KEY.  " Excel 列序 -> catalog 序

    " 表头行：列名清单（与 META 字段集合一致性在此隐式校验）
    READ TABLE it_rows INTO DATA(lt_header) INDEX 1.
    IF sy-subrc <> 0.
      zcx_tabdata_error=>raise( |导入：数据页为空| ).
    ENDIF.

    " 列名 -> 当前字段目录列号映射（未知列名/重复列名直接拒绝）
    LOOP AT lt_header INTO DATA(lv_colname).

      DATA(lv_name_up) = to_upper( lv_colname ).
      DATA(lv_cat_idx) = line_index( it_catalog[ name = CONV fieldname( lv_name_up ) ] ).
      IF lv_cat_idx = 0.
        zcx_tabdata_error=>raise( |导入：数据页表头含未知字段 "{ lv_colname }"（可能被手工改过表头）| ).
      ENDIF.
      APPEND lv_cat_idx TO lt_colmap.

    ENDLOOP.

    " 数据行：按表头列序取值，重组为按 catalog 序的矩阵
    DATA: lv_line_no TYPE i.
    LOOP AT it_rows ASSIGNING FIELD-SYMBOL(<fs_row>) FROM 2.

      lv_line_no = sy-tabix.

      " 全空行跳过（Excel 尾部空行常见）
      DATA(lv_has_value) = abap_false.
      LOOP AT <fs_row> INTO DATA(lv_any) WHERE table_line IS NOT INITIAL.
        lv_has_value = abap_true.
        EXIT.
      ENDLOOP.
      IF lv_has_value = abap_false.
        CONTINUE.
      ENDIF.

      DATA(lt_out_row) = VALUE zcl_tabdata_type_conv=>ty_row( ).
      " 先按 catalog 全列填空，再按表头映射落值
      DO lines( it_catalog ) TIMES.
        APPEND '' TO lt_out_row.
      ENDDO.

      LOOP AT lt_colmap INTO DATA(lv_out_idx).

        READ TABLE <fs_row> INTO DATA(lv_cell) INDEX sy-tabix.
        IF sy-subrc = 0.
          lt_out_row[ lv_out_idx ] = lv_cell.
        ENDIF.

      ENDLOOP.

      APPEND lt_out_row TO rt_matrix.

      " 行定位文本在 from_text 的 iv_context 中带行号（fill 时统一 +1 表头偏移）

    ENDLOOP.

  ENDMETHOD.

  " ===================================================================
  " 前端文件读/写（GUI 通道）
  " ===================================================================
  METHOD read_frontend_file.

    DATA: lt_raw  TYPE STANDARD TABLE OF x255 WITH DEFAULT KEY,
          lv_len  TYPE i,
          lv_name TYPE string.

    lv_name = iv_path.

    cl_gui_frontend_services=>gui_upload(
      EXPORTING
        filename   = lv_name
        filetype   = 'BIN'
      IMPORTING
        filelength = lv_len
      CHANGING
        data_tab   = lt_raw
      EXCEPTIONS
        file_open_error   = 1
        file_read_error   = 2
        no_batch          = 3
        OTHERS            = 4 ).

    IF sy-subrc <> 0.
      zcx_tabdata_error=>raise( |读取文件失败（SY-SUBRC { sy-subrc }）: { iv_path }（后台运行/路径不存在均会触发）| ).
    ENDIF.

    CALL FUNCTION 'SCMS_BINARY_TO_XSTRING'
      EXPORTING
        input_length = lv_len
      IMPORTING
        buffer       = rv_data
      TABLES
        binary_tab   = lt_raw
      EXCEPTIONS
        OTHERS       = 1.

    IF sy-subrc <> 0 OR rv_data IS INITIAL.
      zcx_tabdata_error=>raise( |文件内容转换失败: { iv_path }| ).
    ENDIF.

  ENDMETHOD.

  METHOD write_frontend_file.

    DATA: lt_raw  TYPE STANDARD TABLE OF x255 WITH DEFAULT KEY,
          lv_len  TYPE i,
          lv_name TYPE string.

    CALL FUNCTION 'SCMS_XSTRING_TO_BINARY'
      EXPORTING
        buffer     = iv_data
      IMPORTING
        output_length = lv_len
      TABLES
        binary_tab = lt_raw.

    lv_name = iv_path.

    cl_gui_frontend_services=>gui_download(
      EXPORTING
        filename   = lv_name
        filetype   = 'BIN'
        bin_filesize = lv_len
      CHANGING
        data_tab   = lt_raw
      EXCEPTIONS
        file_write_error = 1
        no_batch         = 2
        OTHERS           = 3 ).

    IF sy-subrc <> 0.
      zcx_tabdata_error=>raise( |写入文件失败（SY-SUBRC { sy-subrc }）: { iv_path }| ).
    ENDIF.

  ENDMETHOD.

  " ===================================================================
  " 快照：当前表数据 -> .jsonl.gz（导入前自动备份 / 恢复前强制快照）
  " ===================================================================
  METHOD snapshot_current.

    DATA(lt_matrix) = zcl_tabdata_table_access=>select_data(
        iv_table = iv_table it_fields = it_catalog ).

    DATA(lv_gzip) = zcl_tabdata_backup=>serialize(
        iv_table = iv_table it_fields = it_catalog it_matrix = lt_matrix ).

    " 快照文件保存对话框变量（显式声明前置）
    DATA: lv_action TYPE i,
          lv_full   TYPE string,
          lv_path_s TYPE string,
          lv_fname  TYPE string.

    rv_path = |{ iv_table }_{ iv_tag }_{ sy-datum }{ sy-uzeit }.jsonl.gz|.

    " 快照文件保存对话框：用户可改目录；取消视为放弃本次操作

    cl_gui_frontend_services=>file_save_dialog(
      EXPORTING
        default_extension = 'jsonl.gz'
        default_file_name = rv_path
      CHANGING
        filename          = lv_fname
        path              = lv_path_s
        fullpath          = lv_full
        user_action       = lv_action
      EXCEPTIONS
        cntl_error        = 1
        OTHERS            = 2 ).

    IF sy-subrc <> 0 OR lv_action <> 0 OR lv_full IS INITIAL.
      zcx_tabdata_error=>raise( '快照保存被取消或失败：安全序列要求先完成快照才能继续写操作' ).
    ENDIF.

    write_frontend_file( iv_path = lv_full iv_data = lv_gzip ).
    rv_path = lv_full.

  ENDMETHOD.

  " ===================================================================
  " META sheet 构造（与 parse_meta_sheet 互逆）
  " ===================================================================
  METHOD build_meta_rows.

    APPEND VALUE ty_row( ( 'TABLE' ) ( CONV string( iv_table ) ) ) TO rt_rows.
    APPEND VALUE ty_row( ( 'CLIENT' ) ( CONV string( sy-mandt ) ) ) TO rt_rows.
    APPEND VALUE ty_row( ( 'SYSTEM' ) ( CONV string( sy-sysid ) ) ) TO rt_rows.
    APPEND VALUE ty_row( ( 'USER' ) ( CONV string( sy-uname ) ) ) TO rt_rows.
    APPEND VALUE ty_row( ( 'TIMESTAMP' ) ( |{ sy-datum }{ sy-uzeit }| ) ) TO rt_rows.
    APPEND VALUE ty_row( ( 'ROWS' ) ( CONV string( iv_rows ) ) ) TO rt_rows.

    " 字段目录行：NAME|KIND|LEN|DEC|KEY|HEX（K/H 用 X/空）
    " 注：string template 内不能写字面竖线，故用普通字符串拼接
    LOOP AT it_fields ASSIGNING FIELD-SYMBOL(<fs_f>).

      DATA(lv_detail) = CONV string( <fs_f>-name ) && '|'
                     && CONV string( <fs_f>-kind ) && '|'
                     && CONV string( <fs_f>-length ) && '|'
                     && CONV string( <fs_f>-decimals ) && '|'
                     && COND string( WHEN <fs_f>-key = abap_true THEN 'X' ELSE '' ) && '|'
                     && COND string( WHEN <fs_f>-hex = abap_true THEN 'X' ELSE '' ).

      APPEND VALUE ty_row( ( 'FIELD' ) ( lv_detail ) ) TO rt_rows.

    ENDLOOP.

  ENDMETHOD.

ENDCLASS.

" ---------------------------------------------------------------------
" 初始化：块标题 + 默认文件名提示
" ---------------------------------------------------------------------
INITIALIZATION.

  gv_tmo = '模式'.
  gv_ttb  = '目标表'.
  gv_tex  = '导出 Excel'.
  gv_tim  = '导入 Excel（upsert）'.
  gv_tbk  = '备份（.jsonl.gz 无损）'.
  gv_trs  = '恢复（时点全量替换）'.
  gv_tsc  = '安全护栏'.

" ---------------------------------------------------------------------
" 屏幕控制：按模式显隐参数块
" ---------------------------------------------------------------------
AT SELECTION-SCREEN OUTPUT.

  LOOP AT SCREEN.

    " 各模式专属参数：MODIF ID 前缀 m_exp/m_imp/m_bak/m_res
    DATA(lv_hide) = abap_false.
    CASE 'X'.
      WHEN rb_exp. IF screen-group1 = 'MIM' OR screen-group1 = 'MBK' OR screen-group1 = 'MRS'.
                     lv_hide = abap_true. ENDIF.
      WHEN rb_imp. IF screen-group1 = 'MEX' OR screen-group1 = 'MBK' OR screen-group1 = 'MRS'.
                     lv_hide = abap_true. ENDIF.
      WHEN rb_bak. IF screen-group1 = 'MEX' OR screen-group1 = 'MIM' OR screen-group1 = 'MRS'.
                     lv_hide = abap_true. ENDIF.
      WHEN rb_res. IF screen-group1 = 'MEX' OR screen-group1 = 'MIM' OR screen-group1 = 'MBK'.
                     lv_hide = abap_true. ENDIF.
    ENDCASE.

    " 放行原因输入框仅勾选"放行标准表"时可见
    IF screen-group1 = 'MSN' AND p_allow <> abap_true.
      lv_hide = abap_true.
    ENDIF.

    IF lv_hide = abap_true.
      screen-active = 0.
      MODIFY SCREEN.
    ENDIF.

  ENDLOOP.

" ---------------------------------------------------------------------
" 输入校验
" ---------------------------------------------------------------------
AT SELECTION-SCREEN.

  " 模式切换/放行开关切换时仅刷屏
  IF sy-ucomm = 'MODE_CHG' OR sy-ucomm = 'ALLOW_CHG'.
    RETURN.
  ENDIF.

  " 表名统一大写（DDIC 语义）
  p_table = to_upper( p_table ).

  " 放行标准表时原因必填（提前校验，避免到护栏层才失败）
  IF p_allow = abap_true AND p_reason IS INITIAL AND sy-ucomm <> ''.
    MESSAGE '放行标准表必须填写业务原因（审计要求）' TYPE 'E'.
  ENDIF.

" ---------------------------------------------------------------------
" 文件对话框（F4）
" ---------------------------------------------------------------------
AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_fexp.
  PERFORM f4_save_file USING 'xlsx' CHANGING p_fexp.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_fimp.
  PERFORM f4_open_file USING '*.xlsx' CHANGING p_fimp.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_fbak.
  PERFORM f4_save_file USING 'jsonl.gz' CHANGING p_fbak.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_fres.
  PERFORM f4_open_file USING '*.jsonl.gz' CHANGING p_fres.

" ---------------------------------------------------------------------
" 主流程：按模式执行 + LUW 边界控制 + 结果输出
" ---------------------------------------------------------------------
START-OF-SELECTION.

  DATA(lo_runner) = lcl_runner=>get_instance( ).

  TRY.

      IF rb_exp = abap_true.
        lo_runner->run_exp( ).
      ELSEIF rb_imp = abap_true.
        lo_runner->run_imp( ).
      ELSEIF rb_bak = abap_true.
        lo_runner->run_bak( ).
      ELSEIF rb_res = abap_true.
        lo_runner->run_res( ).
      ENDIF.

      " 写路径模式统一在此提交（导出/备份无脏数据，COMMIT 无副作用）
      COMMIT WORK.
      WRITE: / '执行成功。'.

    CATCH zcx_tabdata_error INTO DATA(lo_err).

      " 任何失败：整体回滚（导入/恢复的已写数据不入库）
      ROLLBACK WORK.
      WRITE: / '执行失败，已回滚：' COLOR COL_NEGATIVE.
      WRITE: / lo_err->get_text( ).

      " 失败也展示已收集的统计/审计行，便于定位
      WRITE: /.
      WRITE: / '过程记录：'.
      LOOP AT lo_runner->gt_result ASSIGNING FIELD-SYMBOL(<fs_r>).
        WRITE: / <fs_r>-category, <fs_r>-item, <fs_r>-value, <fs_r>-note.
      ENDLOOP.
      RETURN.

    CATCH cx_root INTO DATA(lo_root).

      " 非预期异常兜底（动态 SQL 未预期错误等），同样回滚
      ROLLBACK WORK.
      WRITE: / '非预期异常，已回滚：' COLOR COL_NEGATIVE.
      WRITE: / lo_root->get_text( ).

  ENDTRY.

  " ---- 成功结果输出（SALV 网格） ----
  IF lo_runner->gt_result IS NOT INITIAL.

    cl_salv_table=>factory(
      IMPORTING
        r_salv_table = DATA(lo_alv)
      CHANGING
        t_table      = lo_runner->gt_result ).

    " 结果列宽自适应 + 标题
    lo_alv->get_columns( )->set_optimize( abap_true ).
    lo_alv->get_display_settings( )->set_list_header( |表数据工具执行结果 - { p_table }| ).
    lo_alv->display( ).

  ENDIF.

" ---------------------------------------------------------------------
" FORM：文件对话框 helper
" ---------------------------------------------------------------------
FORM f4_save_file USING VALUE(iv_ext) TYPE string
                  CHANGING cv_path TYPE string.

  DATA: lv_action TYPE i,
        lv_full   TYPE string,
        lv_path   TYPE string,
        lv_fname  TYPE string.

  cl_gui_frontend_services=>file_save_dialog(
    EXPORTING
      default_extension = iv_ext
    CHANGING
      filename          = lv_fname
      path              = lv_path
      fullpath          = lv_full
      user_action       = lv_action
    EXCEPTIONS
      cntl_error        = 1
      OTHERS            = 2 ).

  IF sy-subrc = 0 AND lv_action = 0 AND lv_full IS NOT INITIAL.
    cv_path = lv_full.
  ENDIF.

ENDFORM.

FORM f4_open_file USING VALUE(iv_filter) TYPE string
                  CHANGING cv_path TYPE string.

  DATA: lt_file TYPE cl_gui_frontend_services=>file_table,
        lv_rc   TYPE i.

  cl_gui_frontend_services=>file_open_dialog(
    EXPORTING
      file_filter = iv_filter
    CHANGING
      file_table  = lt_file
      rc          = lv_rc
    EXCEPTIONS
      cntl_error           = 1
      OTHERS               = 2 ).

  IF sy-subrc = 0 AND lv_rc >= 1.
    READ TABLE lt_file INTO DATA(ls_file) INDEX 1.
    IF sy-subrc = 0.
      cv_path = ls_file-filename.
    ENDIF.
  ENDIF.

ENDFORM.
