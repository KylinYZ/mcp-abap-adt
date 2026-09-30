" =====================================================================
" ZCL_TABDATA_TYPE_CONV - 字符串 <-> ABAP 动态类型双向转换
" ---------------------------------------------------------------------
" 用途：Excel 导出/导入与 JSONL 备份/恢复两个载体共用的类型保真层。
"       任何字段值离开 SAP 前（导出/备份）都转成文本，回到 SAP 时
"       （导入/恢复）按 DDIC 类型还原。两载体共用本类保证语义一致。
"
" 业务规则（无损往返的关键约定）：
"   C/N/D/T/g  原样字符串（NUMC/DATS/TIMS 保留前导零与 YYYYMMDD 格式）
"   P(DEC/CURR/QUAN)  无千分位小数字符串（string template NUMBER = RAW，
"               不受用户"数字格式设置"影响）
"   F(FLTP)    STYLE = fltp_string 输出全精度科学计数（double 无损往返
"              需要 17 位有效数字，普通 WRITE 会截断丢精度）
"   I/b/s/8    十进制整数字符串
"   x/y(RAW)   每字节两个大写 hex 字符（hex 编码规则记入字段目录，
"              导入侧按同一规则解码）
"   空文本      还原为类型初值（NULL 语义不适用本工具场景）
"
" 本类同时是工具的类型仓库：ty_field/ty_fields/ty_matrix 被
" 表访问类、备份类、报表壳共同引用，避免同构类型重复定义漂移。
" =====================================================================
CLASS zcl_tabdata_type_conv DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    " -------- 公共类型仓库（工具内统一引用） --------
    " 单字段目录条目：来自 DDIF_FIELDINFO_GET 的 DFIES + 本工具补充标记
    TYPES: BEGIN OF ty_field,
             name     TYPE fieldname,     " 字段名（大写）
             kind     TYPE abap_typekind, " RTTS 类型类别 C/N/D/T/P/F/I/b/s/8/x/y/g
             length   TYPE i,             " 字符位长（DFIES-LENG），hex 编码时为原始字节长
             decimals TYPE i,             " 小数位（P 类型有效）
             key      TYPE abap_bool,     " 是否主键字段（upsert/排序依据）
             hex      TYPE abap_bool,     " 值是否 hex 编码（x/y 类型）
             descr    TYPE scrtext_l,     " 字段长文本（写入元数据 sheet 供人工核对）
           END OF ty_field,
           ty_fields TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.

    " 字符串矩阵：一行 = 一组单元格文本（与 Excel 行/备份 JSONL 行一一对应）
    TYPES: ty_row    TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
           ty_matrix TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.

    CLASS-METHODS to_text
      IMPORTING
        !iv_kind     TYPE abap_typekind      " 目标类型类别
        !iv_decimals TYPE i                  " 小数位（P 有效）
        !iv_value    TYPE any                " ABAP 侧值（任意类型）
      RETURNING
        VALUE(rv_text) TYPE string
      RAISING
        zcx_tabdata_error.

    CLASS-METHODS from_text
      IMPORTING
        !iv_kind      TYPE abap_typekind     " 目标类型类别
        !iv_decimals  TYPE i                 " 小数位（P 有效）
        !iv_text      TYPE string            " 文本值
        !iv_max_len   TYPE i DEFAULT 0       " 目标字符位长（>0 时校验超长）
        !iv_context   TYPE string DEFAULT '' " 定位上下文（拼入错误消息）
      CHANGING
        !cg_value     TYPE any               " 还原目标（ASSIGN COMPONENT 得到的字段）
      RAISING
        zcx_tabdata_error.

  PROTECTED SECTION.
  PRIVATE SECTION.

    " hex 文本 -> xstring：每 2 字符解释为 1 字节（大写 hex，非法字符抛异常）
    CLASS-METHODS text_to_hex
      IMPORTING
        !iv_text    TYPE string
        !iv_context TYPE string
      RETURNING
        VALUE(rv_x) TYPE xstring
      RAISING
        zcx_tabdata_error.

ENDCLASS.


CLASS zcl_tabdata_type_conv IMPLEMENTATION.

  METHOD to_text.

    DATA: lv_byte TYPE x,       " 逐字节切片暂存
          lv_c2   TYPE c LENGTH 2, " 单字节 hex 表示（WRITE x TO c 输出大写）
          lv_off  TYPE i.          " 当前字节偏移

    CASE iv_kind.

      WHEN 'C' OR 'N' OR 'D' OR 'T' OR 'g'.
        " 字符/NUMC/日期/时间/长文本：内部表示本身就是文本，直接赋值
        "（c/n/d/t -> string 隐式转换保真，无格式化副作用）
        rv_text = iv_value.

      WHEN 'P'.
        " DEC/CURR/QUAN：NUMBER = RAW 输出无千分位分组的小数字符串，
        " 避免 WRITE 默认按用户格式加逗号导致还原失败
        rv_text = |{ iv_value NUMBER = RAW }|.

      WHEN 'F'.
        " FLTP：fltp_string 样式输出全精度（17 位有效数字），
        " 保证 double 无损往返；普通输出会按默认精度截断
        rv_text = |{ iv_value STYLE = fltp_string }|.

      WHEN 'I' OR 'b' OR 's' OR '8'.
        " 各类整数：模板直接输出十进制
        rv_text = |{ iv_value }|.

      WHEN 'x' OR 'y'.
        " RAW/LRAW/RAWSTRING：逐字节转大写 hex
        lv_off = 0.
        DO xstrlen( iv_value ) TIMES.
          lv_byte = iv_value+lv_off(1).
          WRITE lv_byte TO lv_c2.
          rv_text = rv_text && lv_c2.
          lv_off  = lv_off + 1.
        ENDDO.

      WHEN OTHERS.
        " 表字段中出现结构/引用等不受支持类别：防御性拒绝
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = |类型类别 { iv_kind } 不支持文本化（仅支持 C/N/D/T/P/F/I/b/s/8/x/y/g）|.

    ENDCASE.

  ENDMETHOD.


  METHOD from_text.

    DATA: lo_ex     TYPE REF TO cx_root,   " 转换异常统一包装
          lv_re     TYPE string,           " 正则校验结果
          lv_number TYPE p,                " P 转换探针（借隐式转换校验）
          lv_int    TYPE i,                " I 转换探针
          lv_float  TYPE f,                " F 转换探针
          lv_msg    TYPE string.           " 错误消息组装

    " 空文本统一还原为初值（Excel 空单元格 / 备份空字符串）
    IF iv_text IS INITIAL.
      CLEAR cg_value.
      RETURN.
    ENDIF.

    TRY.

        CASE iv_kind.

          WHEN 'C'.
            " CHAR：超长直接拒绝（string -> c 会静默右截断，必须先校验）
            IF iv_max_len > 0 AND strlen( iv_text ) > iv_max_len.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |{ iv_context }长度 { strlen( iv_text ) } 超过字段位长 { iv_max_len }|.
            ENDIF.
            cg_value = iv_text.

          WHEN 'N'.
            " NUMC：必须全数字且不超过位长（防 Excel 把前导零吃掉后的脏值混入）
            lv_re = |^([0-9]{{1,{ iv_max_len }}})$|.
            IF iv_max_len <= 0 OR find( val = iv_text regex = lv_re ) < 0.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |{ iv_context }值 "{ iv_text }" 不是 { iv_max_len } 位以内的纯数字（NUMC）；若该值曾在 Excel 中编辑过，可能已被转成数字格式丢失前导零|.
            ENDIF.
            cg_value = iv_text.

          WHEN 'D'.
            " DATS：固定 8 位数字 YYYYMMDD（00000000 为合法初值）
            FIND REGEX '^[0-9]{8}$' IN iv_text.
            IF sy-subrc <> 0.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |{ iv_context }值 "{ iv_text }" 不是 8 位 YYYYMMDD 日期（DATS）|.
            ENDIF.
            cg_value = iv_text.

          WHEN 'T'.
            " TIMS：固定 6 位数字 HHMMSS
            FIND REGEX '^[0-9]{6}$' IN iv_text.
            IF sy-subrc <> 0.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |{ iv_context }值 "{ iv_text }" 不是 6 位 HHMMSS 时间（TIMS）|.
            ENDIF.
            cg_value = iv_text.

          WHEN 'g'.
            " STRING：直接赋值
            cg_value = iv_text.

          WHEN 'P'.
            " DEC/CURR/QUAN：正则白名单后借隐式转换落地，
            " 溢出/非法由 CX_SY_CONVERSION_* 统一捕获
            FIND REGEX '^(-?[0-9]+(\.[0-9]+)?)$' IN iv_text.
            IF sy-subrc <> 0.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |{ iv_context }值 "{ iv_text }" 不是合法十进制数（P 类，{ iv_decimals } 位小数）|.
            ENDIF.
            lv_number = iv_text.
            cg_value = lv_number.

          WHEN 'F'.
            " FLTP：接受普通十进制与科学计数两种文本形态
            lv_float = iv_text.
            cg_value = lv_float.

          WHEN 'I' OR 'b' OR 's' OR '8'.
            " 整数族：先正则（拒绝 Excel 数字单元格可能出现的 1.0/科学计数形态，
            " 错误消息提示用户把该列设为文本格式）
            FIND REGEX '^(-?[0-9]+)$' IN iv_text.
            IF sy-subrc <> 0.
              RAISE EXCEPTION TYPE zcx_tabdata_error
                EXPORTING
                  text_message = |{ iv_context }值 "{ iv_text }" 不是整数；若来自 Excel，请将该列设为"文本"格式后重新填写|.
            ENDIF.
            lv_int = iv_text.
            cg_value = lv_int.

          WHEN 'x' OR 'y'.
            " RAW：hex 解码（本工具导出约定）
            cg_value = text_to_hex( iv_text = iv_text
                                    iv_context = iv_context ).

          WHEN OTHERS.
            RAISE EXCEPTION TYPE zcx_tabdata_error
              EXPORTING
                text_message = |{ iv_context }类型类别 { iv_kind } 不支持还原|.

        ENDCASE.

      CATCH cx_sy_conversion_overflow cx_sy_conversion_no_number
            cx_sy_conversion_bad_init INTO lo_ex.
        " 底层转换异常统一包装，保留上下文与原始异常链
        lv_msg = |{ iv_context }值 "{ iv_text }" 转换失败: { lo_ex->get_text( ) }|.
        RAISE EXCEPTION TYPE zcx_tabdata_error
          EXPORTING
            text_message = lv_msg
            previous     = lo_ex.

    ENDTRY.

  ENDMETHOD.


  METHOD text_to_hex.

    DATA: lv_c2   TYPE c LENGTH 2, " 2 字符 hex 片段
          lv_byte TYPE x,          " 片段对应的字节
          lv_off  TYPE i.          " 文本偏移

    " hex 文本必须偶数长度
    IF strlen( iv_text ) MOD 2 <> 0.
      RAISE EXCEPTION TYPE zcx_tabdata_error
        EXPORTING
          text_message = |{ iv_context }hex 编码值长度为奇数（{ strlen( iv_text ) }），不是合法字节序列|.
    ENDIF.

    CLEAR rv_x.
    lv_off = 0.
    WHILE lv_off < strlen( iv_text ).
      lv_c2 = iv_text+lv_off(2).
      " 逐片段转字节：非法 hex 字符在此触发转换异常并被捕获包装
      TRY.
          lv_byte = lv_c2.
        CATCH cx_sy_conversion_no_number INTO DATA(lo_ex).
          RAISE EXCEPTION TYPE zcx_tabdata_error
            EXPORTING
              text_message = |{ iv_context }值 "{ iv_text }" 含非 hex 字符片段 "{ lv_c2 }"|
              previous     = lo_ex.
      ENDTRY.
      CONCATENATE rv_x lv_byte INTO rv_x IN BYTE MODE.
      lv_off = lv_off + 2.
    ENDWHILE.

  ENDMETHOD.

ENDCLASS.
