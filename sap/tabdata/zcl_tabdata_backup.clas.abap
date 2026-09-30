" =====================================================================
" ZCL_TABDATA_BACKUP - 无损备份载体（JSONL + gzip + MD5，前端 PC 文件）
" ---------------------------------------------------------------------
" 用途：ZTABDATA_TOOL 表数据工具的备份/恢复载体层。
"       serialize()  ：字符串矩阵 -> 备份文件内容（gzip 压缩字节流）
"       deserialize()：备份文件内容 -> 头信息 + 字符串矩阵（含 MD5 校验）
"
" 备份文件格式（.jsonl.gz）：
"   第 1 行 头 JSON：
"     {"format":1,"table":"...","system":"...","client":"...","user":"...",
"      "timestamp":"YYYYMMDDHHMMSS","rows":N,"md5":"...","fields":[...]}
"   第 2..N+1 行 数据行 JSON：{"v":{"FIELD1":"文本值","FIELD2":""}}
"   所有字段值按字符串写入（与 Excel 共用 ZCL_TABDATA_TYPE_CONV 转换规则，
"   保证两载体语义一致）；全文 UTF-8 后 gzip（CL_ABAP_GZIP）。
"   md5 = 数据行文本（以 LF 连接、不含头行）的 UTF-8 MD5（大写 hex）。
"
" 关键约定：
"   1. JSON 转义由本类自实现（值内引号/反斜杠/控制字符转义），数据行
"      解析用自写状态机，不依赖外部 JSON 库——行为完全可控、可单测；
"   2. 值内的字面换行被转义为 \n 两字符，因此文件按字面 LF 分行是
"      安全的（这正是 JSONL 的设计要点）；
"   3. 备份文件不支持手工编辑（会破坏 MD5 校验被拒绝）；人工修订数据
"      请走 Excel 导出→导入通道。
" =====================================================================
CLASS zcl_tabdata_backup DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    " 头内字段目录条目（JSON 侧类型与 conv 类的 ty_field 对应）
    TYPES: BEGIN OF ty_field_json,
             name     TYPE string,     " 字段名
             kind     TYPE string,     " RTTS 类型类别（单字符，如 P/N/D/x）
             length   TYPE i,          " 字符位长
             decimals TYPE i,          " 小数位
             key      TYPE abap_bool,  " 是否主键
             hex      TYPE abap_bool,  " 值是否 hex 编码
           END OF ty_field_json,
           ty_fields_json TYPE STANDARD TABLE OF ty_field_json WITH DEFAULT KEY.

    " 头 JSON 对应的 ABAP 结构
    TYPES: BEGIN OF ty_header,
             format    TYPE i,              " 格式版本（当前恒为 1）
             table     TYPE string,         " 源表名
             system    TYPE string,         " SAP 系统标识 SY-SYSID
             client    TYPE string,         " 客户端 SY-MANDT
             user      TYPE string,         " 备份人 SY-UNAME
             timestamp TYPE string,         " 备份时间 YYYYMMDDHHMMSS
             rows      TYPE i,              " 数据行数
             md5       TYPE string,         " 数据行 MD5（大写 hex）
             fields    TYPE ty_fields_json, " 字段目录
           END OF ty_header.

    " 解析数据行得到的"字段名-值"对（调用方按字段目录顺序组行）
    TYPES: BEGIN OF ty_pair,
             name  TYPE string,
             value TYPE string,
           END OF ty_pair,
           ty_pairs TYPE STANDARD TABLE OF ty_pair WITH DEFAULT KEY.

    CLASS-METHODS serialize
      IMPORTING
        !iv_table      TYPE tabname                             " 源表名
        !it_fields     TYPE zcl_tabdata_type_conv=>ty_fields    " 字段目录
        !it_matrix     TYPE zcl_tabdata_type_conv=>ty_matrix    " 已文本化的数据矩阵（首列与字段目录同序）
      RETURNING
        VALUE(rv_gzip) TYPE xstring                             " gzip 压缩后的备份字节流
      RAISING
        zcx_tabdata_error.

    CLASS-METHODS deserialize
      IMPORTING
        !iv_gzip    TYPE xstring                                " gzip 压缩的备份字节流
      EXPORTING
        !es_header  TYPE ty_header                              " 解析出的头信息
        !et_matrix  TYPE zcl_tabdata_type_conv=>ty_matrix       " 还原的字符串矩阵
      RAISING
        zcx_tabdata_error.

  PROTECTED SECTION.
  PRIVATE SECTION.

    " JSON 字符串转义：\ " 控制字符；其余非法字面控制字符剔除
    CLASS-METHODS json_escape
      IMPORTING
        !iv_text       TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    " 解析一行数据行 JSON（严格匹配 serialize 产出的格式）为字段名-值对
    CLASS-METHODS parse_data_row
      IMPORTING
        !iv_line       TYPE string
      RETURNING
        VALUE(rt_pairs) TYPE ty_pairs
      RAISING
        zcx_tabdata_error.

ENDCLASS.


CLASS zcl_tabdata_backup IMPLEMENTATION.

  METHOD serialize.

    DATA: lt_lines  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_line   TYPE string,
          lv_text   TYPE string,
          lv_x      TYPE xstring,
          lv_hash   TYPE hash160,
          lv_fields TYPE string.

    " ---- 字段目录 JSON 片段（仅序列化时转换一次） ----
    LOOP AT it_fields ASSIGNING FIELD-SYMBOL(<fs_f>).
      IF lv_fields IS NOT INITIAL.
        lv_fields = lv_fields && ','.
      ENDIF.
      lv_fields = lv_fields
               && |{{"name":"{ json_escape( <fs_f>-name ) }","kind":"{ <fs_f>-kind }"|
               && |,"length":{ <fs_f>-length },"decimals":{ <fs_f>-decimals }|
               && |,"key":{ COND string( WHEN <fs_f>-key = abap_true THEN 'true' ELSE 'false' ) }|
               && |,"hex":{ COND string( WHEN <fs_f>-hex = abap_true THEN 'true' ELSE 'false' ) }}}|.
    ENDLOOP.

    " ---- 数据行：{"v":{"F":"val",...}}；行内单元格顺序必须与字段目录一致 ----
    LOOP AT it_matrix ASSIGNING FIELD-SYMBOL(<fs_row>).

      IF lines( <fs_row> ) <> lines( it_fields ).
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |备份序列化：第 { sy-tabix } 行单元格数 { lines( <fs_row> ) } 与字段目录 { lines( it_fields ) } 不一致|.
      ENDIF.

      lv_line = '{"v":{'.
      LOOP AT <fs_row> ASSIGNING FIELD-SYMBOL(<fs_cell>).
        READ TABLE it_fields INTO DATA(ls_f) INDEX sy-tabix.
        IF sy-tabix > 1.
          lv_line = lv_line && ','.
        ENDIF.
        lv_line = lv_line && |"{ ls_f-name }":"{ json_escape( <fs_cell> ) }"|.
      ENDLOOP.
      lv_line = lv_line && '}}'.

      APPEND lv_line TO lt_lines.

    ENDLOOP.

    " ---- MD5：数据行文本（LF 连接、不含头行）的 UTF-8 MD5 ----
    lv_text = concat_lines_of( table = lt_lines sep = |\n| ).
    lv_x    = cl_abap_codepage=>convert_to( lv_text ).
    CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
      EXPORTING
        alg  = 'MD5'
        data = lv_x
      IMPORTING
        hash = lv_hash.

    " ---- 头行 ----
    DATA(lv_head) = |{{"format":1|
                  && |,"table":"{ json_escape( CONV string( iv_table ) ) }"|
                  && |,"system":"{ sy-sysid }"|
                  && |,"client":"{ sy-mandt }"|
                  && |,"user":"{ sy-uname }"|
                  && |,"timestamp":"{ sy-datum }{ sy-uzeit }"|
                  && |,"rows":{ lines( lt_lines ) }|
                  && |,"md5":"{ lv_hash }"|
                  && |,"fields":[{ lv_fields }]}}|.

    " ---- 全文：头 + 数据行，UTF-8 后 gzip ----
    DATA(lv_full) = lv_head && |\n| && concat_lines_of( table = lt_lines sep = |\n| ).
    lv_x = cl_abap_codepage=>convert_to( lv_full ).

    cl_abap_gzip=>compress_binary(
      EXPORTING
        raw_in = lv_x
      IMPORTING
        gzip_out = rv_gzip ).

  ENDMETHOD.


  METHOD deserialize.

    DATA: lt_lines TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_text  TYPE string,
          lv_x     TYPE xstring.

    IF iv_gzip IS INITIAL.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：文件内容为空|.
    ENDIF.

    " ---- 解压 ----
    cl_abap_gzip=>decompress_binary(
      EXPORTING
        gzip_in = iv_gzip
      IMPORTING
        raw_out = lv_x ).

    lv_text = cl_abap_codepage=>convert_from( lv_x ).

    " 值内换行已被转义为字面 \n，因此按字面 LF 分行安全（JSONL 约定）
    SPLIT lv_text AT |\n| INTO TABLE lt_lines.

    IF lines( lt_lines ) < 1.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：解压后内容为空，不是合法备份文件|.
    ENDIF.

    " ---- 头行解析：手拼 JSON 用 /UI2/CL_JSON 还原（头字段名固定） ----
    DATA(lv_head_line) = lt_lines[ 1 ].
    IF lv_head_line(1) <> '{'.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：首行不是 JSON 头，文件不是本工具产生的备份|.
    ENDIF.

    /ui2/cl_json=>deserialize(
      EXPORTING
        json = lv_head_line
      CHANGING
        data = es_header ).

    IF es_header-format <> 1.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：格式版本 { es_header-format } 不受支持（当前支持 1）|.
    ENDIF.
    IF es_header-table IS INITIAL OR es_header-fields IS INITIAL.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：头信息缺少表名或字段目录|.
    ENDIF.

    " ---- 数据行解析 + MD5 校验 ----
    DATA(lt_data_lines) = VALUE STANDARD TABLE OF string WITH DEFAULT KEY( ).
    LOOP AT lt_lines INTO DATA(lv_data_line) FROM 2.
      APPEND lv_data_line TO lt_data_lines.
    ENDLOOP.

    IF lines( lt_data_lines ) <> es_header-rows.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：实际数据行数 { lines( lt_data_lines ) } 与头声明 { es_header-rows } 不一致|.
    ENDIF.

    DATA(lv_md5_text) = concat_lines_of( table = lt_data_lines sep = |\n| ).
    DATA(lv_md5_x)    = cl_abap_codepage=>convert_to( lv_md5_text ).
    DATA(lv_md5)      = CONV hash160( '' ).
    CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
      EXPORTING
        alg  = 'MD5'
        data = lv_md5_x
      IMPORTING
        hash = lv_md5.

    IF to_upper( lv_md5 ) <> to_upper( es_header-md5 ).
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：MD5 校验失败（文件已损坏或被修改）。头声明 { es_header-md5 }，实际 { lv_md5 }|.
    ENDIF.

    " ---- 逐行还原为矩阵（按头字段目录顺序取值组行） ----
    DATA(lv_line_no) = 0.
    LOOP AT lt_data_lines INTO lv_data_line.

      lv_line_no = lv_line_no + 1.
      DATA(lt_pairs) = parse_data_row( lv_data_line ).
      DATA(lt_row)   = VALUE zcl_tabdata_type_conv=>ty_row( ).

      LOOP AT es_header-fields ASSIGNING FIELD-SYMBOL(<fs_fj>).
        READ TABLE lt_pairs INTO DATA(ls_pair)
             WITH KEY name = <fs_fj>-name.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE zcx_tabdata_error
            EXPORTING
              text_message = |备份读取：第 { lv_line_no } 行缺少字段 { <fs_fj>-name }|.
        ENDIF.
        APPEND ls_pair-value TO lt_row.
      ENDLOOP.

      APPEND lt_row TO et_matrix.

    ENDLOOP.

  ENDMETHOD.


  METHOD json_escape.

    rv_text = iv_text.

    " 顺序敏感：先转义反斜杠自身
    REPLACE ALL OCCURRENCES OF '\' IN rv_text WITH '\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv_text WITH '\"'.
    " 控制字符转义（JSON 只允许转义形态出现在字符串内）
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv_text WITH '\r\n'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf(1) IN rv_text WITH '\r'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv_text WITH '\n'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv_text WITH '\t'.

    " 剔除其余 <0x20 字面控制字符（JSON 字符串内非法且无业务含义）
    DATA(lv_clean) = VALUE string( ).
    DATA(lv_i)   = 0.
    DATA(lv_len) = strlen( rv_text ).
    WHILE lv_i < lv_len.
      DATA(lv_ch) = rv_text+lv_i(1).
      IF lv_ch >= space
         OR lv_ch = cl_abap_char_utilities=>horizontal_tab
         OR lv_ch = cl_abap_char_utilities=>newline.
        lv_clean = lv_clean && lv_ch.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.
    rv_text = lv_clean.

  ENDMETHOD.


  METHOD parse_data_row.

    DATA: lv_pos TYPE i,     " 当前解析位置（1-based）
          lv_len TYPE i,     " 行长度
          lv_ch  TYPE c LENGTH 1,
          lv_nx  TYPE c LENGTH 1.

    CLEAR rt_pairs.
    lv_len = strlen( iv_line ).

    " 严格前缀 {"v":{
    IF lv_len < 7 OR iv_line(6) <> '{"v":{'.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |备份读取：数据行不是本工具的 {"v":{...}} 格式: { iv_line }|.
    ENDIF.

    lv_pos = 7.  " 从第 7 字符起解析字段对

    DO.
      IF lv_pos > lv_len.
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |备份读取：数据行意外结束（缺右花括号）: { iv_line }|.
      ENDIF.

      lv_ch = iv_line+lv_pos-1(1).

      " 行尾：}} 收官
      IF lv_ch = '}'.
        EXIT.
      ENDIF.

      " 非首字段：跳过逗号
      IF lv_ch = ','.
        lv_pos = lv_pos + 1.
        CONTINUE.
      ENDIF.

      " ---- 字段名：'"NAME":'（DDIC 字段名不含需转义字符） ----
      IF lv_ch <> '"'.
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |备份读取：数据行字段名格式异常（位置 { lv_pos }）: { iv_line }|.
      ENDIF.
      lv_pos = lv_pos + 1.
      DATA(lv_name) = VALUE string( ).
      WHILE lv_pos <= lv_len.
        lv_ch = iv_line+lv_pos-1(1).
        IF lv_ch = '"'.
          EXIT.
        ENDIF.
        lv_name = lv_name && lv_ch.
        lv_pos  = lv_pos + 1.
      ENDWHILE.
      IF lv_ch <> '"'.
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |备份读取：数据行字段名未闭合: { iv_line }|.
      ENDIF.
      lv_pos = lv_pos + 1.                  " 过掉结束引号
      IF lv_pos > lv_len OR iv_line+lv_pos-1(1) <> ':'.
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |备份读取：字段 { lv_name } 后缺少冒号: { iv_line }|.
      ENDIF.
      lv_pos = lv_pos + 1.                  " 过掉冒号

      " ---- 字段值：'"...."'（处理 \ " \\ \n \r \t 转义） ----
      IF lv_pos > lv_len OR iv_line+lv_pos-1(1) <> '"'.
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |备份读取：字段 { lv_name } 的值不是字符串: { iv_line }|.
      ENDIF.
      lv_pos = lv_pos + 1.
      DATA(lv_val) = VALUE string( ).
      WHILE lv_pos <= lv_len.
        lv_ch = iv_line+lv_pos-1(1).
        IF lv_ch = '\'.
          " 转义序列还原
          IF lv_pos >= lv_len.
            RAISE EXCEPTION TYPE zcx_tabdata_error
              EXPORTING
                text_message = |备份读取：字段 { lv_name } 转义序列意外截断|.
          ENDIF.
          lv_nx = iv_line+lv_pos(1).
          CASE lv_nx.
            WHEN '"'.
              lv_val = lv_val && '"'.
            WHEN '\'.
              lv_val = lv_val && '\'.
            WHEN 'n'.
              lv_val = lv_val && cl_abap_char_utilities=>newline.
            WHEN 'r'.
              lv_val = lv_val && cl_abap_char_utilities=>cr_lf(1).
            WHEN 't'.
              lv_val = lv_val && cl_abap_char_utilities=>horizontal_tab.
            WHEN OTHERS.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |备份读取：字段 { lv_name } 含不受支持的转义序列 \{ lv_nx }|.
          ENDCASE.
          lv_pos = lv_pos + 2.
        ELSEIF lv_ch = '"'.
          lv_pos = lv_pos + 1.              " 过掉结束引号
          EXIT.
        ELSE.
          lv_val = lv_val && lv_ch.
          lv_pos = lv_pos + 1.
        ENDIF.
      ENDWHILE.

      APPEND VALUE ty_pair( name = lv_name value = lv_val ) TO rt_pairs.

    ENDDO.

  ENDMETHOD.

ENDCLASS.
