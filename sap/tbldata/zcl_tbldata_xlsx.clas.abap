" =====================================================================
" ZCL_TABLDATA_XLSX - 轻量 xlsx 读写器（zip + XML，零第三方依赖）
" ---------------------------------------------------------------------
" 用途：ZTABLDATA_TOOL 表数据工具的 Excel(.xlsx) 载体层。
"       write()：字符串矩阵 -> xlsx 二进制（全单元格 inlineStr 文本）；
"       read() ：xlsx 二进制 -> 字符串矩阵。
"
" 业务规则：
"   1. 所有单元格写为 inlineStr 文本，规避 Excel 对日期/数字的自动
"      转换破坏 NUMC/DATS 前导零（类型保真的载体侧前提）；
"   2. read() 除 inlineStr 外必须兼容 sharedStrings 与数值单元格：
"      用户用 Excel 打开导出文件修改后另存，Excel 会把 inline string
"      收拢进 sharedStrings 表、把手工输入的数字写成 t="n"；
"   3. 空单元格也写出 <c r="..."/> 占位（保列位），读取按 r 属性的
"      列号精确定位，不怕空列跳位；
"   4. 单元格值做 XML 转义（& < > 回车），剔除 0x20 以下非法控制字符；
"   5. 本类不懂数据语义：只见"若干命名 sheet 的字符串矩阵"，
"      表头行/元数据 sheet 的组装由报表壳负责。
" =====================================================================
CLASS zcl_tbldata_xlsx DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    " sheet 定义：名称 + 行矩阵（每行一组单元格文本）
    TYPES: BEGIN OF ty_sheet,
             name TYPE string,                          " sheet 显示名
             rows TYPE zcl_tbldata_type_conv=>ty_matrix, " 字符串矩阵
           END OF ty_sheet,
           ty_sheets TYPE STANDARD TABLE OF ty_sheet WITH DEFAULT KEY.

    CLASS-METHODS write
      IMPORTING
        !it_sheets     TYPE ty_sheets          " 待写入的 sheet 集合
      RETURNING
        VALUE(rv_xlsx) TYPE xstring            " xlsx 文件内容
      RAISING
        zcx_tbldata_error.

    CLASS-METHODS read
      IMPORTING
        !iv_xlsx         TYPE xstring          " xlsx 文件内容
      RETURNING
        VALUE(rt_sheets) TYPE ty_sheets        " 解析出的 sheet 集合
      RAISING
        zcx_tbldata_error.

  PROTECTED SECTION.
  PRIVATE SECTION.

    " XML 文本转义 + 非法控制字符剔除
    CLASS-METHODS xml_escape
      IMPORTING
        !iv_text       TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    " 列序号(1-based) -> Excel 列字母（1=A, 26=Z, 27=AA...）
    CLASS-METHODS col_to_letters
      IMPORTING
        !iv_col           TYPE i
      RETURNING
        VALUE(rv_letters) TYPE string.

    " Excel 列字母 -> 列序号（配合单元格 r 属性解析；非法返回 0）
    CLASS-METHODS letters_to_col
      IMPORTING
        !iv_letters   TYPE string
      RETURNING
        VALUE(rv_col) TYPE i.

    " 单元格 r 属性（如 "AB12"）-> 列号/行号
    CLASS-METHODS parse_cell_ref
      IMPORTING
        !iv_ref TYPE string
      EXPORTING
        !ev_col TYPE i
        !ev_row TYPE i.

    " 用 iXML 解析单张 worksheet 的 sheetData -> 字符串矩阵
    CLASS-METHODS parse_sheet_xml
      IMPORTING
        !iv_xml         TYPE xstring
        !it_shared      TYPE ty_row             " sharedStrings 顺序表
        !iv_shared_cnt  TYPE i                  " sharedStrings 条数
        !iv_sheet_label TYPE string             " 错误消息定位用 sheet 名
      RETURNING
        VALUE(rt_rows) TYPE zcl_tbldata_type_conv=>ty_matrix
      RAISING
        zcx_tbldata_error.

ENDCLASS.


CLASS zcl_tbldata_xlsx IMPLEMENTATION.

  METHOD write.

    DATA: lo_zip    TYPE REF TO cl_abap_zip,
          lv_xml    TYPE string,   " 当前 part 的 XML 文本
          lv_xml_x  TYPE xstring,  " UTF-8 编码后的 XML 字节
          lv_ct     TYPE string,   " [Content_Types].xml 的 Override 片段
          lv_rels   TYPE string,   " workbook.xml.rels 的 Relationship 片段
          lv_sheets TYPE string,   " workbook.xml 的 <sheet> 片段
          lv_idx    TYPE i.        " sheet 序号（1-based）

    " ---- 逐 sheet 组装 worksheet XML 并入 zip ----
    CREATE OBJECT lo_zip TYPE cl_abap_zip.
    lv_idx = 0.

    LOOP AT it_sheets ASSIGNING FIELD-SYMBOL(<fs_sheet>).

      lv_idx = lv_idx + 1.
      DATA(lv_target) = |xl/worksheets/sheet{ lv_idx }.xml|.

      " sheet 数据体：行 -> 单元格。空值也写自闭合占位保列位
      lv_xml = |<?xml version="1.0" encoding="UTF-8" standalone="yes"?>|
            && |<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">|
            && |<sheetData>|.

      LOOP AT <fs_sheet>-rows ASSIGNING FIELD-SYMBOL(<fs_row>).

        lv_xml = lv_xml && |<row r="{ sy-tabix }">|.

        LOOP AT <fs_row> ASSIGNING FIELD-SYMBOL(<fs_cell>).

          " 单元格引用 = 列字母 + 行号（sy-tfill = 当前行内已填充行数）
          IF <fs_cell> IS INITIAL.
            lv_xml = lv_xml && |<c r="{ col_to_letters( sy-tabix ) }{ sy-tfill }"/>|.
          ELSE.
            lv_xml = lv_xml
                  && |<c r="{ col_to_letters( sy-tabix ) }{ sy-tfill }" t="inlineStr">|
                  && |<is><t xml:space="preserve">{ xml_escape( <fs_cell> ) }</t></is></c>|.
          ENDIF.

        ENDLOOP.

        lv_xml = lv_xml && |</row>|.

      ENDLOOP.

      lv_xml = lv_xml && |</sheetData></worksheet>|.

      lv_xml_x = cl_abap_codepage=>convert_to( lv_xml ).
      lo_zip->add( name = lv_target content = lv_xml_x ).

      " 同步累计 Content_Types / rels / workbook 三个 part 的片段
      lv_ct = lv_ct
           && |<Override PartName="/{ lv_target }" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>|.
      lv_rels = lv_rels
             && |<Relationship Id="rId{ lv_idx }" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{ lv_idx }.xml"/>|.
      lv_sheets = lv_sheets
               && |<sheet name="{ xml_escape( <fs_sheet>-name ) }" sheetId="{ lv_idx }" r:id="rId{ lv_idx }"/>|.

    ENDLOOP.

    IF lv_idx = 0.
      zcx_tbldata_error=>raise( |xlsx 写入：至少需要一个 sheet| ).
    ENDIF.

    " ---- [Content_Types].xml ----
    lv_xml = |<?xml version="1.0" encoding="UTF-8" standalone="yes"?>|
          && |<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">|
          && |<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>|
          && |<Default Extension="xml" ContentType="application/xml"/>|
          && |<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>|
          && lv_ct
          && |</Types>|.
    lo_zip->add( name = '[Content_Types].xml'
                 content = cl_abap_codepage=>convert_to( lv_xml ) ).

    " ---- 包级关系：唯一入口 xl/workbook.xml ----
    lv_xml = |<?xml version="1.0" encoding="UTF-8" standalone="yes"?>|
          && |<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">|
          && |<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>|
          && |</Relationships>|.
    lo_zip->add( name = '_rels/.rels'
                 content = cl_abap_codepage=>convert_to( lv_xml ) ).

    " ---- workbook.xml：声明 sheet 名与关系 id ----
    lv_xml = |<?xml version="1.0" encoding="UTF-8" standalone="yes"?>|
          && |<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"|
          && | xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">|
          && |<sheets>{ lv_sheets }</sheets></workbook>|.
    lo_zip->add( name = 'xl/workbook.xml'
                 content = cl_abap_codepage=>convert_to( lv_xml ) ).

    " ---- workbook 级关系：rId -> sheet 文件 ----
    lv_xml = |<?xml version="1.0" encoding="UTF-8" standalone="yes"?>|
          && |<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">|
          && lv_rels
          && |</Relationships>|.
    lo_zip->add( name = 'xl/_rels/workbook.xml.rels'
                 content = cl_abap_codepage=>convert_to( lv_xml ) ).

    rv_xlsx = lo_zip->save( ).

  ENDMETHOD.


  METHOD read.

    DATA: lo_zip      TYPE REF TO cl_abap_zip,
          lv_shared   TYPE zcl_tbldata_type_conv=>ty_row,   " sharedStrings 顺序文本表
          " CL_ABAP_ZIP=>GET 为 EXPORTING 风格（无 RETURNING），内容变量前置声明
          lv_shared_x TYPE xstring,
          lv_workbook TYPE xstring,
          lv_wbrels_x TYPE xstring,
          lv_sheet_x  TYPE xstring,
          lv_n        TYPE i,
          lv_n2       TYPE i.

    IF iv_xlsx IS INITIAL.
      zcx_tbldata_error=>raise( |xlsx 读取：文件内容为空| ).
    ENDIF.

    " ---- 解压 ----
    CREATE OBJECT lo_zip TYPE cl_abap_zip.
    lo_zip->load( zip = iv_xlsx ).

    " ---- sharedStrings（本工具原产文件没有此 part，可缺席） ----
    CLEAR lv_shared_x.
    lo_zip->get( EXPORTING name = 'xl/sharedStrings.xml' IMPORTING content = lv_shared_x ).
    IF lv_shared_x IS NOT INITIAL.
      DATA(lo_ss_ixml) = cl_ixml=>create( ).
      DATA(lo_ss_doc)  = lo_ss_ixml->create_document( ).
      DATA(lo_ss_par)  = lo_ss_ixml->create_parser(
                            stream_factory = lo_ss_ixml->create_stream_factory( )
                            istream        = lo_ss_ixml->create_stream_factory( )->create_istream_xstring( lv_shared_x )
                            document       = lo_ss_doc ).
      IF lo_ss_par->parse( ) <> 0.
        zcx_tbldata_error=>raise( |xlsx 读取：sharedStrings.xml 解析失败| ).
      ENDIF.

      " 每个 <si> 是一条字符串；富文本 si 含多个 <t> 片段，顺序拼接
      DATA(lo_si) = lo_ss_doc->find_from_name( name = 'si' ).
      WHILE lo_si IS BOUND.
        DATA(lv_txt) = VALUE string( ).
        DATA(lo_ts)  = lo_si->get_elements_by_tag_name( name = 't' ).
        DATA(lv_cnt) = lo_ts->get_length( ).
        DO lv_cnt TIMES.
          lv_txt = lv_txt && CAST if_ixml_element( lo_ts->get_item( sy-index - 1 ) )->get_value( ).
        ENDDO.
        APPEND lv_txt TO lv_shared.
        lo_si ?= lo_si->get_next( ).
      ENDWHILE.
    ENDIF.

    " ---- workbook.xml：sheet 名 + 关系 id ----
    CLEAR lv_workbook.
    lo_zip->get( EXPORTING name = 'xl/workbook.xml' IMPORTING content = lv_workbook ).
    IF lv_workbook IS INITIAL.
      zcx_tbldata_error=>raise( |xlsx 读取：缺少 xl/workbook.xml，不是合法 xlsx 包| ).
    ENDIF.

    DATA(lo_wb_ixml) = cl_ixml=>create( ).
    DATA(lo_wb_doc)  = lo_wb_ixml->create_document( ).
    DATA(lo_wb_par)  = lo_wb_ixml->create_parser(
                           stream_factory = lo_wb_ixml->create_stream_factory( )
                           istream        = lo_wb_ixml->create_stream_factory( )->create_istream_xstring( lv_workbook )
                           document       = lo_wb_doc ).
    IF lo_wb_par->parse( ) <> 0.
      zcx_tbldata_error=>raise( |xlsx 读取：workbook.xml 解析失败| ).
    ENDIF.

    " ---- workbook.xml.rels：rId -> sheet 文件路径（"rIdN"按下标存 Target） ----
    DATA(lv_rel_map) = VALUE ty_row( ).
    CLEAR lv_wbrels_x.
    lo_zip->get( EXPORTING name = 'xl/_rels/workbook.xml.rels' IMPORTING content = lv_wbrels_x ).
    IF lv_wbrels_x IS NOT INITIAL.
      DATA(lo_rel_ixml) = cl_ixml=>create( ).
      DATA(lo_rel_doc)  = lo_rel_ixml->create_document( ).
      DATA(lo_rel_par)  = lo_rel_ixml->create_parser(
                             stream_factory = lo_rel_ixml->create_stream_factory( )
                             istream        = lo_rel_ixml->create_stream_factory( )->create_istream_xstring( lv_wbrels_x )
                             document       = lo_rel_doc ).
      IF lo_rel_par->parse( ) = 0.
        DATA(lo_rel) = lo_rel_doc->find_from_name( name = 'Relationship' ).
        WHILE lo_rel IS BOUND.
          DATA(lv_rid) = CONV string( lo_rel->get_attribute( 'Id' ) ).
          DATA(lv_tgt) = CONV string( lo_rel->get_attribute( 'Target' ) ).
          IF lv_rid CP 'rId*' AND lv_rid+3 CO '0123456789' AND lv_rid+3 IS NOT INITIAL.
            lv_n = lv_rid+3.
            " 稀疏 rId 用空串补位
            WHILE lines( lv_rel_map ) < lv_n.
              APPEND '' TO lv_rel_map.
            ENDWHILE.
            lv_rel_map[ lv_n ] = lv_tgt.
          ENDIF.
          lo_rel ?= lo_rel->get_next( ).
        ENDWHILE.
      ENDIF.
    ENDIF.

    " ---- 逐 sheet 解析为矩阵 ----
    DATA(lo_sheet_node) = lo_wb_doc->find_from_name( name = 'sheet' ).
    WHILE lo_sheet_node IS BOUND.

      DATA(lv_name) = CONV string( lo_sheet_node->get_attribute( 'name' ) ).
      DATA(lv_rid2) = CONV string( lo_sheet_node->get_attribute( 'r:id' ) ).

      IF lv_rid2 CP 'rId*' AND lv_rid2+3 CO '0123456789' AND lv_rid2+3 IS NOT INITIAL.
        lv_n2 = lv_rid2+3.
        IF lv_n2 BETWEEN 1 AND lines( lv_rel_map ).
          DATA(lv_tgt2) = lv_rel_map[ lv_n2 ].
          IF lv_tgt2 IS NOT INITIAL.
            IF lv_tgt2(1) = '/'.
              lv_tgt2 = lv_tgt2+1.        " 绝对路径去掉前导斜杠
            ELSE.
              lv_tgt2 = |xl/{ lv_tgt2 }|. " 相对路径在 xl/ 目录下
            ENDIF.
            CLEAR lv_sheet_x.
            lo_zip->get( EXPORTING name = lv_tgt2 IMPORTING content = lv_sheet_x ).
            IF lv_sheet_x IS NOT INITIAL.
              APPEND VALUE ty_sheet(
                    name = lv_name
                    rows = parse_sheet_xml( iv_xml         = lv_sheet_x
                                            it_shared      = lv_shared
                                            iv_shared_cnt  = lines( lv_shared )
                                            iv_sheet_label = lv_name ) )
                TO rt_sheets.
            ENDIF.
          ENDIF.
        ENDIF.
      ENDIF.

      lo_sheet_node ?= lo_sheet_node->get_next( ).

    ENDWHILE.

    IF rt_sheets IS INITIAL.
      zcx_tbldata_error=>raise( |xlsx 读取：未解析出任何 worksheet| ).
    ENDIF.

  ENDMETHOD.


  METHOD parse_sheet_xml.

    DATA: lo_ixml   TYPE REF TO if_ixml,
          lo_doc    TYPE REF TO if_ixml_document,
          lo_parser TYPE REF TO if_ixml_parser,
          lo_data   TYPE REF TO if_ixml_element,
          lo_row    TYPE REF TO if_ixml_element,
          lo_c      TYPE REF TO if_ixml_element,
          lv_maxcol TYPE i,                 " 全表最大列数（短行补齐用）
          lv_sidx   TYPE i.                 " sharedStrings 下标

    lo_ixml = cl_ixml=>create( ).
    lo_doc  = lo_ixml->create_document( ).
    lo_parser = lo_ixml->create_parser(
                    stream_factory = lo_ixml->create_stream_factory( )
                    istream        = lo_ixml->create_stream_factory( )->create_istream_xstring( iv_xml )
                    document       = lo_doc ).
    IF lo_parser->parse( ) <> 0.
      zcx_tbldata_error=>raise( |xlsx 读取：sheet "{ iv_sheet_label }" XML 解析失败| ).
    ENDIF.

    lo_data = lo_doc->find_from_name( name = 'sheetData' ).
    IF lo_data IS NOT BOUND.
      " 无 sheetData 视为空表（0 行），交报表侧按 0 行处理
      RETURN.
    ENDIF.

    " 逐 row 逐 cell；cell 位置以 r 属性为准，缺 r 时按出现顺序兜底
    lo_row ?= lo_data->get_first_child( ).
    WHILE lo_row IS BOUND.

      DATA(lt_line) = VALUE ty_row( ).  " 当前行按列号展开
      DATA(lv_fb_col) = 0.              " 缺 r 属性时的顺序列号兜底

      lo_c ?= lo_row->get_first_child( ).
      WHILE lo_c IS BOUND.

        lv_fb_col = lv_fb_col + 1.

        " 列号：优先 r 属性（如 C5 -> 列 3）
        DATA(lv_ref) = CONV string( lo_c->get_attribute( 'r' ) ).
        DATA(lv_col) = 0.
        IF lv_ref IS NOT INITIAL.
          parse_cell_ref( EXPORTING iv_ref = lv_ref
                          IMPORTING ev_col = lv_col
                                    ev_row = DATA(lv_row_dummy) ).
        ENDIF.
        IF lv_col <= 0.
          lv_col = lv_fb_col.
        ENDIF.

        " 临时行扩容到当前列
        WHILE lines( lt_line ) < lv_col.
          APPEND '' TO lt_line.
        ENDWHILE.

        " 单元格取值三形态：
        "   t="inlineStr" -> <is> 内所有 <t> 拼接
        "   t="s"         -> <v> 为 sharedStrings 下标
        "   其他(t="n"/无) -> <v> 原文（数值文本，Excel 重存场景）
        DATA(lv_t)   = CONV string( lo_c->get_attribute( 't' ) ).
        DATA(lv_val) = VALUE string( ).

        IF lv_t = 'inlineStr'.
          DATA(lo_is) = lo_c->find_from_name( name = 'is' ).
          IF lo_is IS BOUND.
            DATA(lo_ts) = lo_is->get_elements_by_tag_name( name = 't' ).
            DATA(lv_tcnt) = lo_ts->get_length( ).
            DO lv_tcnt TIMES.
              lv_val = lv_val && CAST if_ixml_element( lo_ts->get_item( sy-index - 1 ) )->get_value( ).
            ENDDO.
          ENDIF.
        ELSE.
          DATA(lo_v) = lo_c->find_from_name( name = 'v' ).
          IF lo_v IS BOUND.
            lv_val = lo_v->get_value( ).
            IF lv_t = 's'.
              " sharedStrings 下标解引用；越界视为文件损坏
              lv_sidx = lv_val.
              IF lv_sidx BETWEEN 1 AND iv_shared_cnt.
                lv_val = it_shared[ lv_sidx ].
              ELSE.
                zcx_tbldata_error=>raise( |xlsx 读取：sheet "{ iv_sheet_label }" sharedStrings 下标 { lv_sidx } 越界（共 { iv_shared_cnt } 条）| ).
              ENDIF.
            ENDIF.
          ENDIF.
        ENDIF.

        lt_line[ lv_col ] = lv_val.

        IF lv_col > lv_maxcol.
          lv_maxcol = lv_col.
        ENDIF.

        lo_c ?= lo_c->get_next( ).

      ENDWHILE.

      APPEND lt_line TO rt_rows.
      lo_row ?= lo_row->get_next( ).

    ENDWHILE.

    " 短行补齐空单元格，保证矩阵行等长（报表侧按下标对齐字段目录）
    IF lv_maxcol > 0.
      LOOP AT rt_rows ASSIGNING FIELD-SYMBOL(<fs_r>).
        WHILE lines( <fs_r> ) < lv_maxcol.
          APPEND '' TO <fs_r>.
        ENDWHILE.
      ENDLOOP.
    ENDIF.

  ENDMETHOD.


  METHOD xml_escape.

    rv_text = iv_text.

    " 顺序敏感：先转义 & 自身，再转义 <>，否则会双重转义
    REPLACE ALL OCCURRENCES OF '&' IN rv_text WITH '&amp;'.
    REPLACE ALL OCCURRENCES OF '<' IN rv_text WITH '&lt;'.
    REPLACE ALL OCCURRENCES OF '>' IN rv_text WITH '&gt;'.
    " CR 必须实体化：XML 解析器会把字面 CR 规范化为 LF 导致换行信息丢失
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv_text WITH '&#13;&#10;'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf(1) IN rv_text WITH '&#13;'.

    " 剔除 XML 1.0 非法字面控制字符（保留 TAB 与 LF；CR 已实体化）
    DATA: lv_clean TYPE string,
          lv_i     TYPE i,
          lv_len   TYPE i,
          lv_ch    TYPE c LENGTH 1.  " string 偏移访问不能配内联声明
    lv_clean = ''.
    lv_i   = 0.
    lv_len = strlen( rv_text ).
    WHILE lv_i < lv_len.
      lv_ch = rv_text+lv_i(1).
      IF lv_ch >= space
         OR lv_ch = cl_abap_char_utilities=>horizontal_tab
         OR lv_ch = cl_abap_char_utilities=>newline.
        lv_clean = lv_clean && lv_ch.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.
    rv_text = lv_clean.

  ENDMETHOD.


  METHOD col_to_letters.

    DATA: lv_rest TYPE i,
          lv_mod  TYPE i.

    CONSTANTS lc_alpha TYPE c LENGTH 26 VALUE 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.

    CLEAR rv_letters.
    lv_rest = iv_col.
    WHILE lv_rest > 0.
      lv_mod = ( lv_rest - 1 ) MOD 26.
      rv_letters = lc_alpha+lv_mod(1) && rv_letters.
      lv_rest = ( lv_rest - 1 ) DIV 26.
    ENDWHILE.

  ENDMETHOD.


  METHOD letters_to_col.

    DATA: lv_up TYPE string,
          lv_i  TYPE i.

    CONSTANTS lc_alpha TYPE c LENGTH 26 VALUE 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.

    DATA lv_ch2 TYPE c LENGTH 1.  " string 偏移访问不能配内联声明
    rv_col = 0.
    lv_up  = to_upper( iv_letters ).
    lv_i   = 0.
    WHILE lv_i < strlen( lv_up ).
      lv_ch2 = lv_up+lv_i(1).
      IF lv_ch2 < 'A' OR lv_ch2 > 'Z'.
        rv_col = 0.  " 非字母即非法引用，返回 0 交调用方兜底
        RETURN.
      ENDIF.
      FIND lv_ch2 IN lc_alpha MATCH OFFSET DATA(lv_off).
      rv_col = rv_col * 26 + lv_off + 1.
      lv_i   = lv_i + 1.
    ENDWHILE.

  ENDMETHOD.


  METHOD parse_cell_ref.

    " 显式声明全部前置（ABAP 方法内 DATA 声明不得出现在可执行语句之后）
    DATA: lv_len     TYPE i,
          lv_pos     TYPE i,
          lv_row_txt TYPE string.

    CLEAR: ev_col, ev_row.

    " r 属性形如 "AB12"：前缀字母为列，后缀数字为行
    lv_len = strlen( iv_ref ).
    lv_pos = 0.
    WHILE lv_pos < lv_len.
      IF iv_ref+lv_pos(1) CA '0123456789'.
        EXIT.
      ENDIF.
      lv_pos = lv_pos + 1.
    ENDWHILE.

    IF lv_pos > 0.
      " string 源+变量长度偏移被禁，用 substring 内置函数取列字母前缀
      ev_col = letters_to_col( substring( val = iv_ref len = lv_pos ) ).
    ENDIF.
    IF lv_pos < lv_len.
      " 用 SHIFT 截取数字行号（string 类型禁止无长度偏移语法）
      lv_row_txt = iv_ref.
      SHIFT lv_row_txt BY lv_pos PLACES.
      ev_row = lv_row_txt.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
