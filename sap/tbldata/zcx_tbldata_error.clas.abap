" =====================================================================
" ZCX_TABLDATA_ERROR - 表数据工具统一异常类
" ---------------------------------------------------------------------
" 用途：ZTABLDATA_TOOL 表数据导出/导入/备份/恢复工具的统一异常。
"       所有工具类（类型转换/xlsx/备份/表访问）的错误都通过静态方法
"       raise() 抛出，调用方一行 zcx_tbldata_error=>raise( 文本 ) 即可。
"
" 设计说明：
"   - 继承 CX_STATIC_CHECK：强制调用方显式处理，防止错误被静默吞掉；
"   - 不走 T100 消息类：本工具错误文本动态拼接（含行列定位），用纯
"     字符串消息更直接，避免维护消息号；
"   - MSGTXT 为只读属性，GET_TEXT 重定义保证任何渠道（弹窗/日志/SALV）
"     都能看到完整定位文本；
"   - 【重要】不覆盖 CONSTRUCTOR：CX 子类的 CONSTRUCTOR 声明在类池
"     激活时会被 SEO 引擎重写签名，导致受控创建链"激活后源码比对"
"     验收失败（真机 MIN5 实验实证）。改用静态工厂 raise() 填充
"     MSGTXT 并抛出，语义等价且绕开 SEO 重写面。
" =====================================================================
CLASS zcx_tbldata_error DEFINITION
  PUBLIC
  INHERITING FROM cx_static_check
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    " MSGTXT：完整错误描述，含定位信息（如"第 123 行 字段 MATNR:..."）
    DATA msgtxt TYPE string READ-ONLY.

    " 抛出工厂：创建实例、填充 MSGTXT 并立即 RAISE。
    " previous 传入被包装的底层异常（转换类错误保留原始异常链）。
    CLASS-METHODS raise
      IMPORTING
        text_message TYPE string
        previous     TYPE REF TO cx_root OPTIONAL.

    " get_text：重定义使异常链路中始终返回我们拼接的中文定位文本；
    " MSGTXT 为空时退回父类实现（TEXTID 默认场景）
    METHODS get_text REDEFINITION.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS zcx_tbldata_error IMPLEMENTATION.

  METHOD raise.
    " 经由继承的 CX_ROOT 构造器创建（不声明 CONSTRUCTOR，见类注释），
    " 填入业务文本后原地抛出
    DATA lo_ex TYPE REF TO zcx_tbldata_error.
    CREATE OBJECT lo_ex EXPORTING previous = previous.
    lo_ex->msgtxt = text_message.
    RAISE EXCEPTION lo_ex.
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
