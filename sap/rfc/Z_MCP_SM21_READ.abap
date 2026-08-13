" Z_MCP_SM21_READ - read-only SM21 system log adapter for MCP.
" Create the DDIC types described in Z_MCP_SM21_READ-deployment.md before activation.
" Keep the function module local-only in SE37. This function must never
" write, delete, archive, lock, or acknowledge system-log entries.
FUNCTION z_mcp_sm21_read.

  CONSTANTS: lc_max_window_seconds TYPE i VALUE 86400,
             lc_max_page_size       TYPE i VALUE 500.

  DATA: lo_filter         TYPE REF TO cl_syslog_filter,
        lo_syslog         TYPE REF TO cl_syslog,
        lt_entries        TYPE rslgentr_tab,
        lt_instances      TYPE cl_syslog_filter=>range_of_instances,
        lt_users          TYPE cl_syslog_filter=>range_of_user,
        lt_programs       TYPE cl_syslog_filter=>range_of_progids,
        lt_tcodes         TYPE cl_syslog_filter=>range_of_tcode,
        lt_message_ids    TYPE cl_syslog_filter=>range_of_msgid,
        lv_window_seconds TYPE tzntstmpl,
        lv_from_timestamp TYPE timestampl,
        lv_to_timestamp   TYPE timestampl,
        lv_seen           TYPE i.

  " SM21 display authority is required for the authenticated ADT HTTP user.
  AUTHORITY-CHECK OBJECT 'S_ADMI_FCD'
    ID 'S_ADMI_FCD' FIELD 'SM21'.
  IF sy-subrc <> 0.
    PERFORM append_return USING 'E' 'Z_MCP_SM21' '001' 'Missing SM21 display authorization'
                        CHANGING et_return[].
    RETURN.
  ENDIF.

  IF iv_from IS INITIAL OR iv_to IS INITIAL OR iv_from > iv_to.
    PERFORM append_return USING 'E' 'Z_MCP_SM21' '002' 'A valid start and end timestamp are required'
                        CHANGING et_return[].
    RETURN.
  ENDIF.

  " Convert the RSLGTIME DATS+TIMS values explicitly before calculating the window.
  CONVERT DATE iv_from(8) TIME iv_from+8(6) INTO TIME STAMP lv_from_timestamp TIME ZONE sy-zonlo.
  CONVERT DATE iv_to(8) TIME iv_to+8(6) INTO TIME STAMP lv_to_timestamp TIME ZONE sy-zonlo.
  lv_window_seconds = cl_abap_tstmp=>subtract( tstmp1 = lv_to_timestamp tstmp2 = lv_from_timestamp ).
  IF lv_window_seconds > lc_max_window_seconds.
    PERFORM append_return USING 'E' 'Z_MCP_SM21' '003' 'The SM21 query window cannot exceed 24 hours'
                        CHANGING et_return[].
    RETURN.
  ENDIF.

  IF iv_offset < 0 OR iv_page_size < 1 OR iv_page_size > lc_max_page_size.
    PERFORM append_return USING 'E' 'Z_MCP_SM21' '004' 'Offset or page size is outside the allowed range'
                        CHANGING et_return[].
    RETURN.
  ENDIF.

  CREATE OBJECT lo_filter.
  lo_filter->set_filter_datetime( im_datetime_from = iv_from im_datetime_to = iv_to ).

  PERFORM fill_instance_range USING iv_instances CHANGING lt_instances.
  PERFORM fill_user_range     USING iv_users CHANGING lt_users.
  PERFORM fill_program_range  USING iv_programs CHANGING lt_programs.
  PERFORM fill_tcode_range    USING iv_tcodes CHANGING lt_tcodes.
  PERFORM fill_message_range  USING iv_message_ids CHANGING lt_message_ids.
  IF lt_instances IS NOT INITIAL.   lo_filter->set_range_instance( lt_instances ). ENDIF.
  IF lt_users IS NOT INITIAL.       lo_filter->set_range_user( lt_users ). ENDIF.
  IF lt_programs IS NOT INITIAL.    lo_filter->set_range_program( lt_programs ). ENDIF.
  IF lt_tcodes IS NOT INITIAL.      lo_filter->set_range_tcode( lt_tcodes ). ENDIF.
  IF lt_message_ids IS NOT INITIAL. lo_filter->set_range_msgid( lt_message_ids ). ENDIF.
  PERFORM set_severity USING iv_severity CHANGING lo_filter et_return[].
  IF line_exists( et_return[ type = 'E' ] ). RETURN. ENDIF.

  TRY.
      lo_syslog = cl_syslog=>get_instance_by_filter( lo_filter ).
      lt_entries = lo_syslog->get_entries( ).
    CATCH cx_syslog_read_authorization.
      PERFORM append_return USING 'E' 'Z_MCP_SM21' '005' 'SM21 authorization was rejected while reading the log'
                          CHANGING et_return[].
      RETURN.
    CATCH cx_root INTO DATA(lx_error).
      " Do not return host, credential, or kernel details to HTTP callers.
      PERFORM append_return USING 'E' 'Z_MCP_SM21' '006' 'The system log could not be read'
                          CHANGING et_return[].
      RETURN.
  ENDTRY.

  ev_total = lines( lt_entries ).
  LOOP AT lt_entries INTO DATA(ls_entry).
    lv_seen = lv_seen + 1.
    IF lv_seen <= iv_offset. CONTINUE. ENDIF.
    IF lines( et_logs ) >= iv_page_size.
      ev_has_more = abap_true.
      EXIT.
    ENDIF.

    APPEND INITIAL LINE TO et_logs ASSIGNING FIELD-SYMBOL(<ls_log>).
    " RSLGENTRY is the normalized, display-ready entry returned by CL_SYSLOG.
    " These fields are verified against the target system's CL_SYSLOG implementation.
    <ls_log>-log_date     = ls_entry-zdate.
    <ls_log>-log_time     = ls_entry-ztime.
    <ls_log>-instance     = ls_entry-instance.
    <ls_log>-client       = ls_entry-client.
    <ls_log>-user_name    = ls_entry-zuser.
    <ls_log>-program      = ls_entry-repna.
    <ls_log>-tcode        = ls_entry-tcode.
    <ls_log>-message_id   = ls_entry-messageid.
    <ls_log>-severity     = ls_entry-severity.
    <ls_log>-process      = ls_entry-processid.
    <ls_log>-message_text = ls_entry-text.
  ENDLOOP.
ENDFUNCTION.

FORM append_return USING iv_type TYPE bapiret2-type iv_id TYPE symsgid iv_number TYPE symsgno iv_text TYPE string
                   CHANGING ct_return TYPE bapiret2_t.
  APPEND VALUE #( type = iv_type id = iv_id number = iv_number message = iv_text ) TO ct_return.
ENDFORM.

FORM fill_instance_range USING iv_values TYPE string CHANGING ct_range TYPE cl_syslog_filter=>range_of_instances.
  SPLIT iv_values AT ',' INTO TABLE DATA(lt_values).
  LOOP AT lt_values INTO DATA(lv_value). CONDENSE lv_value NO-GAPS.
    IF lv_value IS NOT INITIAL. APPEND VALUE #( sign = 'I' option = 'CP' low = lv_value ) TO ct_range. ENDIF.
  ENDLOOP.
ENDFORM.

FORM fill_user_range USING iv_values TYPE string CHANGING ct_range TYPE cl_syslog_filter=>range_of_user.
  SPLIT iv_values AT ',' INTO TABLE DATA(lt_values).
  LOOP AT lt_values INTO DATA(lv_value). CONDENSE lv_value NO-GAPS.
    IF lv_value IS NOT INITIAL. APPEND VALUE #( sign = 'I' option = 'CP' low = lv_value ) TO ct_range. ENDIF.
  ENDLOOP.
ENDFORM.

FORM fill_program_range USING iv_values TYPE string CHANGING ct_range TYPE cl_syslog_filter=>range_of_progids.
  SPLIT iv_values AT ',' INTO TABLE DATA(lt_values).
  LOOP AT lt_values INTO DATA(lv_value). CONDENSE lv_value NO-GAPS.
    IF lv_value IS NOT INITIAL. APPEND VALUE #( sign = 'I' option = 'CP' low = lv_value ) TO ct_range. ENDIF.
  ENDLOOP.
ENDFORM.

FORM fill_tcode_range USING iv_values TYPE string CHANGING ct_range TYPE cl_syslog_filter=>range_of_tcode.
  SPLIT iv_values AT ',' INTO TABLE DATA(lt_values).
  LOOP AT lt_values INTO DATA(lv_value). CONDENSE lv_value NO-GAPS.
    IF lv_value IS NOT INITIAL. APPEND VALUE #( sign = 'I' option = 'CP' low = lv_value ) TO ct_range. ENDIF.
  ENDLOOP.
ENDFORM.

FORM fill_message_range USING iv_values TYPE string CHANGING ct_range TYPE cl_syslog_filter=>range_of_msgid.
  SPLIT iv_values AT ',' INTO TABLE DATA(lt_values).
  LOOP AT lt_values INTO DATA(lv_value). CONDENSE lv_value NO-GAPS.
    IF lv_value IS NOT INITIAL. APPEND VALUE #( sign = 'I' option = 'CP' low = lv_value ) TO ct_range. ENDIF.
  ENDLOOP.
ENDFORM.

FORM set_severity USING iv_severity TYPE char15 CHANGING co_filter TYPE REF TO cl_syslog_filter ct_return TYPE bapiret2_t.
  DATA lv_filter_severity TYPE x.

  CASE to_upper( iv_severity ).
    WHEN '' OR 'ALL'.
    WHEN 'ERROR'. lv_filter_severity = cl_syslog_filter=>severity_red.
    WHEN 'WARNING'. lv_filter_severity = cl_syslog_filter=>severity_yellow.
    WHEN 'ERROR_WARNING'. lv_filter_severity = cl_syslog_filter=>severity_red BIT-OR cl_syslog_filter=>severity_yellow.
    WHEN OTHERS.
      PERFORM append_return USING 'E' 'Z_MCP_SM21' '007' 'Severity must be ALL, ERROR, WARNING, or ERROR_WARNING'
                          CHANGING ct_return.
      RETURN.
  ENDCASE.
  IF lv_filter_severity IS NOT INITIAL.
    co_filter->set_filter_severity( lv_filter_severity ).
  ENDIF.
ENDFORM.
