" =====================================================================
" ZCX_TABDATA_ERROR - 表数据工具统一异常类
" ---------------------------------------------------------------------
" 用途：ZTABDATA_TOOL 表数据导出/导入/备份/恢复工具的统一异常。
"       所有工具类（类型转换/xlsx/备份/表访问）的错误都抛本异常，
"       消息文本由抛出方负责带上定位信息（Excel 行列 / 备份文件行号 /
"       表名字段名等），报表壳统一 CATCH 后输出给用户。
" 设计说明：
"   - 继承 CX_STATIC_CHECK：强制调用方显式处理，防止错误被静默吞掉；
"   - 不走 T100 消息类：本工具错误文本动态拼接（含行列定位），用纯
"     字符串消息更直接，避免维护消息号；
"   - MSGTXT 为只读属性，GET_TEXT 重定义保证任何渠道（弹窗/日志/SALV）
"     都能看到完整定位文本。
" =====================================================================
CLASS zcx_tabdata_error DEFINITION
  PUBLIC
  INHERITING FROM cx_static_check
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    " MSGTXT：完整错误描述，含定位信息（如"第 123 行 字段 MATNR:..."）
    DATA msgtxt TYPE string READ-ONLY.

    METHODS constructor
      IMPORTING
        !text_message TYPE string OPTIONAL        " 错误文本（含定位）
        !previous     LIKE previous OPTIONAL.     " 被包装的原始异常

    " get_text：重定义使异常链路中始终返回我们拼接的中文定位文本；
    " MSGTXT 为空时退回父类实现（TEXTID 默认场景）
    METHODS get_text REDEFINITION.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS zcx_tabdata_error IMPLEMENTATION.

  METHOD constructor.
    " 先初始化父类（异常链 previous），再记录业务错误文本
    CALL METHOD super->constructor
      EXPORTING
        previous = previous.
    me->msgtxt = text_message.
  ENDMETHOD.

  METHOD get_text.
    " MSGTXT 有值时优先返回业务文本；否则退回父类默认文本
    IF msgtxt IS NOT INITIAL.
      result = msgtxt.
    ELSE.
      result = super->get_text( ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
