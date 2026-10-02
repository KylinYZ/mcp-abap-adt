" =====================================================================
" ZCL_TABDATA_TYPE_CONV 测试类（E3 真机 ABAP Unit 全类型往返）
" ---------------------------------------------------------------------
" 覆盖 E3 交接清单要求的 C/N/D/T/P/F/I/b/s/8/x/y/g 全类型
" to_text -> from_text 双向往返断言，并锁定以下回归点：
"   - FLTP 精度（decfloat34 中转 + scientific 样式，f 位级还原）
"   - NUMC 前导零保留
"   - RAW hex（x/y）大写 hex 编码往返
"   - P 小数保真（from_text 不得经 p0 中转舍入小数——修复回归点）
"   - int8 全范围还原（from_text 不得用 i 探针造成假溢出——修复回归点）
"   - 空文本还原类型初值
"   - 超长/脏值/hex 奇数长度防御性拒绝（沿 previous 链校验异常文本）
" =====================================================================
CLASS ltc_conv DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    METHODS roundtrip_all_kinds FOR TESTING.
    METHODS fltp_precision FOR TESTING.
    METHODS numc_leading_zeros FOR TESTING.
    METHODS raw_hex_roundtrip FOR TESTING.
    METHODS empty_text_initial_value FOR TESTING.
    METHODS dirty_values_rejected FOR TESTING.
    "! 统一断言：异常（或其 previous 链）文本须含预期片段。
    "! 816 类池实证：该场景下运行时可能把原始 ZCX_TABDATA_ERROR 包装进
    "! CX_SY_NO_HANDLER（previous=原始异常），沿文本链校验比校验对象类型可靠。
    METHODS assert_error_text
      IMPORTING io_ex      TYPE REF TO cx_root
                iv_pattern TYPE string.
ENDCLASS.


CLASS ltc_conv IMPLEMENTATION.

  METHOD roundtrip_all_kinds.
    " 各类型 to_text -> from_text 往返：还原值必须与原值一致
    DATA: lv_text TYPE string.

    " C：字符原样（超长校验用 max_len=10）
    DATA: lv_c  TYPE c LENGTH 10 VALUE 'HELLO',
          lv_c2 TYPE c LENGTH 10.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'C' iv_decimals = 0 iv_value = lv_c ).
    cl_abap_unit_assert=>assert_equals( exp = 'HELLO' act = lv_text msg = 'C to_text 原样' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'C' iv_decimals = 0 iv_text = lv_text iv_max_len = 10 CHANGING cg_value = lv_c2 ).
    cl_abap_unit_assert=>assert_equals( exp = 'HELLO' act = lv_c2 msg = 'C 往返' ).

    " N：NUMC 前导零保留（E3 重点）
    DATA: lv_n  TYPE n LENGTH 5 VALUE '00042',
          lv_n2 TYPE n LENGTH 5.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'N' iv_decimals = 0 iv_value = lv_n ).
    cl_abap_unit_assert=>assert_equals( exp = '00042' act = lv_text msg = 'N to_text 前导零' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'N' iv_decimals = 0 iv_text = lv_text iv_max_len = 5 CHANGING cg_value = lv_n2 ).
    cl_abap_unit_assert=>assert_equals( exp = '00042' act = lv_n2 msg = 'N 往返前导零' ).

    " D：DATS YYYYMMDD
    DATA: lv_d  TYPE d VALUE '20260930',
          lv_d2 TYPE d.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'D' iv_decimals = 0 iv_value = lv_d ).
    cl_abap_unit_assert=>assert_equals( exp = '20260930' act = lv_text msg = 'D to_text YYYYMMDD' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'D' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_d2 ).
    cl_abap_unit_assert=>assert_equals( exp = '20260930' act = lv_d2 msg = 'D 往返' ).

    " T：TIMS HHMMSS
    DATA: lv_t  TYPE t VALUE '123456',
          lv_t2 TYPE t.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'T' iv_decimals = 0 iv_value = lv_t ).
    cl_abap_unit_assert=>assert_equals( exp = '123456' act = lv_text msg = 'T to_text HHMMSS' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'T' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_t2 ).
    cl_abap_unit_assert=>assert_equals( exp = '123456' act = lv_t2 msg = 'T 往返' ).

    " P：DEC/CURR/QUAN 小数保真（修复回归点：不得舍入丢小数）
    DATA: lv_p  TYPE p LENGTH 10 DECIMALS 2 VALUE '123.45',
          lv_p2 TYPE p LENGTH 10 DECIMALS 2.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'P' iv_decimals = 2 iv_value = lv_p ).
    cl_abap_unit_assert=>assert_equals( exp = '123.45' act = lv_text msg = 'P to_text 无千分位小数' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'P' iv_decimals = 2 iv_text = lv_text CHANGING cg_value = lv_p2 ).
    cl_abap_unit_assert=>assert_equals( exp = '123.45' act = lv_p2 msg = 'P 往返小数保真' ).

    " I/b/s/8：整数族（int8 大数还原是修复回归点）
    DATA: lv_i   TYPE i VALUE -42,
          lv_i2  TYPE i,
          lv_b   TYPE int1 VALUE 255,
          lv_b2  TYPE int1,
          lv_s   TYPE int2 VALUE -32768,
          lv_s2  TYPE int2,
          lv_8   TYPE int8 VALUE 9007199254740993,
          lv_82  TYPE int8.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'I' iv_decimals = 0 iv_value = lv_i ).
    cl_abap_unit_assert=>assert_equals( exp = '-42' act = lv_text msg = 'I to_text' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'I' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_i2 ).
    cl_abap_unit_assert=>assert_equals( exp = -42 act = lv_i2 msg = 'I 往返' ).

    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'b' iv_decimals = 0 iv_value = lv_b ).
    cl_abap_unit_assert=>assert_equals( exp = '255' act = lv_text msg = 'b to_text' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'b' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_b2 ).
    cl_abap_unit_assert=>assert_equals( exp = 255 act = lv_b2 msg = 'b 往返' ).

    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 's' iv_decimals = 0 iv_value = lv_s ).
    cl_abap_unit_assert=>assert_equals( exp = '-32768' act = lv_text msg = 's to_text' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 's' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_s2 ).
    cl_abap_unit_assert=>assert_equals( exp = -32768 act = lv_s2 msg = 's 往返' ).

    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = '8' iv_decimals = 0 iv_value = lv_8 ).
    cl_abap_unit_assert=>assert_equals( exp = '9007199254740993' act = lv_text msg = 'int8 to_text 大数' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = '8' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_82 ).
    cl_abap_unit_assert=>assert_equals( exp = 9007199254740993 act = lv_82 msg = 'int8 往返大数' ).

    " g：STRING 含中文
    DATA: lv_g  TYPE string VALUE '中文ABC123',
          lv_g2 TYPE string.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'g' iv_decimals = 0 iv_value = lv_g ).
    cl_abap_unit_assert=>assert_equals( exp = '中文ABC123' act = lv_text msg = 'g to_text 中文' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'g' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_g2 ).
    cl_abap_unit_assert=>assert_equals( exp = '中文ABC123' act = lv_g2 msg = 'g 往返中文' ).
  ENDMETHOD.


  METHOD fltp_precision.
    " F（FLTP）：decfloat34 中转 + scientific 样式，f 位级还原（E3 精度重点）
    DATA: lv_f   TYPE f VALUE '3.141592653589793',
          lv_f2  TYPE f,
          lv_text TYPE string.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'F' iv_decimals = 0 iv_value = lv_f ).
    " 科学计数形态输出（double 无损需要 17 位有效数字）
    cl_abap_unit_assert=>assert_not_initial( act = lv_text msg = 'F to_text 非空' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'F' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_f2 ).
    cl_abap_unit_assert=>assert_equals( exp = lv_f act = lv_f2 msg = 'F 往返位级还原' ).

    " 大数与极小数也须无损
    DATA: lv_big  TYPE f VALUE '1.2345678901234567E+20',
          lv_big2 TYPE f.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'F' iv_decimals = 0 iv_value = lv_big ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'F' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_big2 ).
    cl_abap_unit_assert=>assert_equals( exp = lv_big act = lv_big2 msg = 'F 大数往返' ).

    DATA: lv_tiny  TYPE f VALUE '2.7182818284590452E-12',
          lv_tiny2 TYPE f.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'F' iv_decimals = 0 iv_value = lv_tiny ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'F' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_tiny2 ).
    cl_abap_unit_assert=>assert_equals( exp = lv_tiny act = lv_tiny2 msg = 'F 极小数往返' ).
  ENDMETHOD.


  METHOD numc_leading_zeros.
    " NUMC 专项：前导零在文本侧必须原样保留（Excel 数字格式的典型损耗点）
    DATA: lv_n  TYPE n LENGTH 10 VALUE '0000000123',
          lv_n2 TYPE n LENGTH 10,
          lv_text TYPE string.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'N' iv_decimals = 0 iv_value = lv_n ).
    cl_abap_unit_assert=>assert_equals( exp = '0000000123' act = lv_text msg = 'N 10 位前导零' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'N' iv_decimals = 0 iv_text = lv_text iv_max_len = 10 CHANGING cg_value = lv_n2 ).
    cl_abap_unit_assert=>assert_equals( exp = '0000000123' act = lv_n2 msg = 'N 往返 10 位前导零' ).
  ENDMETHOD.


  METHOD raw_hex_roundtrip.
    " x/y（RAW 族）：大写 hex 编码往返（编码规则记入字段目录）
    DATA: lv_x  TYPE x LENGTH 4 VALUE 'DEADBEEF',
          lv_x2 TYPE x LENGTH 4,
          lv_text TYPE string.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'x' iv_decimals = 0 iv_value = lv_x ).
    cl_abap_unit_assert=>assert_equals( exp = 'DEADBEEF' act = lv_text msg = 'x to_text 大写 hex' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'x' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_x2 ).
    cl_abap_unit_assert=>assert_equals( exp = 'DEADBEEF' act = lv_x2 msg = 'x 往返' ).

    DATA: lv_y  TYPE xstring VALUE '00FF10',
          lv_y2 TYPE xstring.
    lv_text = zcl_tabdata_type_conv=>to_text( iv_kind = 'y' iv_decimals = 0 iv_value = lv_y ).
    cl_abap_unit_assert=>assert_equals( exp = '00FF10' act = lv_text msg = 'y to_text' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'y' iv_decimals = 0 iv_text = lv_text CHANGING cg_value = lv_y2 ).
    cl_abap_unit_assert=>assert_equals( exp = '00FF10' act = lv_y2 msg = 'y 往返' ).
  ENDMETHOD.


  METHOD empty_text_initial_value.
    " 空文本统一还原类型初值（Excel 空单元格 / 备份空字符串语义）
    DATA: lv_c TYPE c LENGTH 5 VALUE 'ABCDE',
          lv_p TYPE p LENGTH 5 DECIMALS 2 VALUE '9.99',
          lv_i TYPE i VALUE 7.
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'C' iv_decimals = 0 iv_text = '' iv_max_len = 5 CHANGING cg_value = lv_c ).
    cl_abap_unit_assert=>assert_initial( act = lv_c msg = 'C 空文本 -> 初值' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'P' iv_decimals = 2 iv_text = '' CHANGING cg_value = lv_p ).
    cl_abap_unit_assert=>assert_initial( act = lv_p msg = 'P 空文本 -> 初值' ).
    zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'I' iv_decimals = 0 iv_text = '' CHANGING cg_value = lv_i ).
    cl_abap_unit_assert=>assert_initial( act = lv_i msg = 'I 空文本 -> 初值' ).
  ENDMETHOD.


  METHOD dirty_values_rejected.
    " 防御性拒绝：超长 CHAR / 脏 NUMC / 奇数 hex / 非整数，全部必须抛异常。
    " 结构要点（E3 实证）：fail() 必须放在 TRY 外——CATCH cx_root 会把 TRY 内
    " fail() 抛出的 CX_ASSERT_FAILED 一并捕获，掩盖"未拒绝"缺陷。
    " 断言策略：捕获后沿 previous 链校验异常文本（运行时可能包装异常对象）。
    DATA: lv_c2      TYPE c LENGTH 5,
          lv_n2      TYPE n LENGTH 5,
          lv_x2      TYPE x LENGTH 2,
          lv_i2      TYPE i,
          lv_raised  TYPE abap_bool,
          lo_ex      TYPE REF TO cx_root.

    " C 超长
    lv_raised = abap_false.
    TRY.
        zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'C' iv_decimals = 0 iv_text = 'ABCDEF' iv_max_len = 5 CHANGING cg_value = lv_c2 ).
      CATCH cx_root INTO lo_ex.
        lv_raised = abap_true.
        assert_error_text( io_ex = lo_ex iv_pattern = '超过字段位长' ).
    ENDTRY.
    IF lv_raised = abap_false.
      cl_abap_unit_assert=>fail( msg = 'C 超长必须拒绝' ).
    ENDIF.

    " N 脏值（前缀穿透回归点：正则必须有 $ 锚）
    lv_raised = abap_false.
    TRY.
        zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'N' iv_decimals = 0 iv_text = '12a4' iv_max_len = 5 CHANGING cg_value = lv_n2 ).
      CATCH cx_root INTO lo_ex.
        lv_raised = abap_true.
        assert_error_text( io_ex = lo_ex iv_pattern = '纯数字' ).
    ENDTRY.
    IF lv_raised = abap_false.
      cl_abap_unit_assert=>fail( msg = 'N 脏值必须拒绝' ).
    ENDIF.

    " hex 奇数长度
    lv_raised = abap_false.
    TRY.
        zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'x' iv_decimals = 0 iv_text = 'ABC' CHANGING cg_value = lv_x2 ).
      CATCH cx_root INTO lo_ex.
        lv_raised = abap_true.
        assert_error_text( io_ex = lo_ex iv_pattern = 'hex' ).
    ENDTRY.
    IF lv_raised = abap_false.
      cl_abap_unit_assert=>fail( msg = 'hex 奇数长度必须拒绝' ).
    ENDIF.

    " 整数列浮点形态
    lv_raised = abap_false.
    TRY.
        zcl_tabdata_type_conv=>from_text( EXPORTING iv_kind = 'I' iv_decimals = 0 iv_text = '1.0' CHANGING cg_value = lv_i2 ).
      CATCH cx_root INTO lo_ex.
        lv_raised = abap_true.
        assert_error_text( io_ex = lo_ex iv_pattern = '不是整数' ).
    ENDTRY.
    IF lv_raised = abap_false.
      cl_abap_unit_assert=>fail( msg = '整数列浮点形态必须拒绝（提示转文本格式）' ).
    ENDIF.
  ENDMETHOD.


  METHOD assert_error_text.
    " 沿 previous 链拼接异常文本（运行时可能把原始 ZCX_TABDATA_ERROR 包装进
    " CX_SY_NO_HANDLER，previous=原始异常），匹配到预期片段即视为抛出了正确异常。
    DATA: lv_text   TYPE string,
          lv_chain  TYPE string,
          lo_cursor TYPE REF TO cx_root.
    IF io_ex IS NOT BOUND.
      cl_abap_unit_assert=>fail( msg = '未捕获到任何异常' ).
      RETURN.
    ENDIF.
    lo_cursor = io_ex.
    WHILE lo_cursor IS BOUND.
      lv_text = lo_cursor->get_text( ).
      lv_chain = lv_chain && ' | ' && lv_text.
      IF lv_text CS iv_pattern.
        EXIT.
      ENDIF.
      lo_cursor = lo_cursor->previous.
    ENDWHILE.
    cl_abap_unit_assert=>assert_equals(
      exp = abap_true
      act = xsdbool( lv_chain CS iv_pattern )
      msg = |异常链中未找到 "{ iv_pattern }"，实际链: { lv_chain }| ).
  ENDMETHOD.

ENDCLASS.
