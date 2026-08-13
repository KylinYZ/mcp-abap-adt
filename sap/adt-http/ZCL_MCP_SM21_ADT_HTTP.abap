" ZCL_MCP_SM21_ADT_HTTP - read-only ADT HTTP handler for SM21.
" Bind this class to SICF service /sap/bc/z-mcp/sm21 as an HTTP Handler.
" The handler reuses the authenticated ADT user and reads SM21 directly through
" CL_SYSLOG_FILTER and CL_SYSLOG. It does not call RFC destinations or custom FMs.
CLASS zcl_mcp_sm21_adt_http DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_mcp_sm21_adt_http IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    CONSTANTS: lc_max_window_seconds TYPE i VALUE 86400,
               lc_max_page_size       TYPE i VALUE 500.

    DATA: lv_from_raw       TYPE string,
          lv_to_raw         TYPE string,
          lv_offset_raw     TYPE string,
          lv_page_size_raw  TYPE string,
          lv_from           TYPE rslgtime,
          lv_to             TYPE rslgtime,
          lv_offset         TYPE i,
          lv_page_size      TYPE i VALUE 100,
          lv_from_timestamp TYPE timestampl,
          lv_to_timestamp   TYPE timestampl,
          lv_window_seconds TYPE tzntstmpl,
          lv_filter_severity TYPE x,
          lv_total          TYPE i,
          lv_seen           TYPE i,
          lv_returned       TYPE i,
          lv_has_more       TYPE abap_bool,
          lv_severity_text  TYPE c LENGTH 2,
          lv_json           TYPE string,
          lo_filter         TYPE REF TO cl_syslog_filter,
          lo_syslog         TYPE REF TO cl_syslog,
          lt_entries        TYPE rslgentr_tab,
          lt_instances      TYPE cl_syslog_filter=>range_of_instances,
          lt_users          TYPE cl_syslog_filter=>range_of_user,
          lt_programs       TYPE cl_syslog_filter=>range_of_progids,
          lt_tcodes         TYPE cl_syslog_filter=>range_of_tcode,
          lt_message_ids    TYPE cl_syslog_filter=>range_of_msgid.

    server->response->set_header_field( name = 'Content-Type' value = 'application/json; charset=utf-8' ).
    server->response->set_header_field( name = 'Cache-Control' value = 'no-store' ).

    " SM21 display authority is required for the authenticated ADT HTTP user.
    AUTHORITY-CHECK OBJECT 'S_ADMI_FCD'
      ID 'S_ADMI_FCD' FIELD 'SM21'.
    IF sy-subrc <> 0.
      server->response->set_status( code = 403 reason = 'Forbidden' ).
      server->response->set_cdata( '{"error":"Missing SM21 display authorization"}' ).
      RETURN.
    ENDIF.

    " get_form_field parses URL query parameters for a custom SICF service.
    lv_from_raw = server->request->get_form_field( 'from' ).
    lv_to_raw = server->request->get_form_field( 'to' ).
    IF strlen( lv_from_raw ) <> 14 OR strlen( lv_to_raw ) <> 14
       OR lv_from_raw NA '0123456789' OR lv_to_raw NA '0123456789'.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( '{"error":"from and to must use YYYYMMDDHHMMSS"}' ).
      RETURN.
    ENDIF.
    lv_from = lv_from_raw.
    lv_to = lv_to_raw.
    IF lv_from > lv_to.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( '{"error":"A valid start and end timestamp are required"}' ).
      RETURN.
    ENDIF.

    " Convert the RSLGTIME values explicitly before calculating the query window.
    CONVERT DATE lv_from(8) TIME lv_from+8(6) INTO TIME STAMP lv_from_timestamp TIME ZONE sy-zonlo.
    CONVERT DATE lv_to(8) TIME lv_to+8(6) INTO TIME STAMP lv_to_timestamp TIME ZONE sy-zonlo.
    lv_window_seconds = cl_abap_tstmp=>subtract( tstmp1 = lv_to_timestamp tstmp2 = lv_from_timestamp ).
    IF lv_window_seconds > lc_max_window_seconds.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( '{"error":"The SM21 query window cannot exceed 24 hours"}' ).
      RETURN.
    ENDIF.

    lv_offset_raw = server->request->get_form_field( 'offset' ).
    lv_page_size_raw = server->request->get_form_field( 'pageSize' ).
    IF lv_offset_raw IS NOT INITIAL.
      IF lv_offset_raw NA '0123456789'.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( '{"error":"Offset must be a non-negative integer"}' ).
        RETURN.
      ENDIF.
      lv_offset = lv_offset_raw.
    ENDIF.
    IF lv_page_size_raw IS NOT INITIAL.
      IF lv_page_size_raw NA '0123456789'.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( '{"error":"Page size must be an integer"}' ).
        RETURN.
      ENDIF.
      lv_page_size = lv_page_size_raw.
    ENDIF.
    IF lv_page_size < 1 OR lv_page_size > lc_max_page_size.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( '{"error":"Offset or page size is outside the allowed range"}' ).
      RETURN.
    ENDIF.

    CREATE OBJECT lo_filter.
    lo_filter->set_filter_datetime( im_datetime_from = lv_from im_datetime_to = lv_to ).

    SPLIT server->request->get_form_field( 'instances' ) AT ',' INTO TABLE DATA(lt_instance_values).
    LOOP AT lt_instance_values INTO DATA(lv_instance_value).
      CONDENSE lv_instance_value NO-GAPS.
      IF lv_instance_value IS NOT INITIAL.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_instance_value ) TO lt_instances.
      ENDIF.
    ENDLOOP.
    SPLIT server->request->get_form_field( 'users' ) AT ',' INTO TABLE DATA(lt_user_values).
    LOOP AT lt_user_values INTO DATA(lv_user_value).
      CONDENSE lv_user_value NO-GAPS.
      IF lv_user_value IS NOT INITIAL.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_user_value ) TO lt_users.
      ENDIF.
    ENDLOOP.
    SPLIT server->request->get_form_field( 'programs' ) AT ',' INTO TABLE DATA(lt_program_values).
    LOOP AT lt_program_values INTO DATA(lv_program_value).
      CONDENSE lv_program_value NO-GAPS.
      IF lv_program_value IS NOT INITIAL.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_program_value ) TO lt_programs.
      ENDIF.
    ENDLOOP.
    SPLIT server->request->get_form_field( 'tcodes' ) AT ',' INTO TABLE DATA(lt_tcode_values).
    LOOP AT lt_tcode_values INTO DATA(lv_tcode_value).
      CONDENSE lv_tcode_value NO-GAPS.
      IF lv_tcode_value IS NOT INITIAL.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_tcode_value ) TO lt_tcodes.
      ENDIF.
    ENDLOOP.
    SPLIT server->request->get_form_field( 'messageIds' ) AT ',' INTO TABLE DATA(lt_message_values).
    LOOP AT lt_message_values INTO DATA(lv_message_value).
      CONDENSE lv_message_value NO-GAPS.
      IF lv_message_value IS NOT INITIAL.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_message_value ) TO lt_message_ids.
      ENDIF.
    ENDLOOP.

    IF lt_instances IS NOT INITIAL.   lo_filter->set_range_instance( lt_instances ). ENDIF.
    IF lt_users IS NOT INITIAL.       lo_filter->set_range_user( lt_users ). ENDIF.
    IF lt_programs IS NOT INITIAL.    lo_filter->set_range_program( lt_programs ). ENDIF.
    IF lt_tcodes IS NOT INITIAL.      lo_filter->set_range_tcode( lt_tcodes ). ENDIF.
    IF lt_message_ids IS NOT INITIAL. lo_filter->set_range_msgid( lt_message_ids ). ENDIF.

    CASE to_upper( server->request->get_form_field( 'severity' ) ).
      WHEN '' OR 'ALL'.
      WHEN 'ERROR'. lv_filter_severity = cl_syslog_filter=>severity_red.
      WHEN 'WARNING'. lv_filter_severity = cl_syslog_filter=>severity_yellow.
      WHEN 'ERROR_WARNING'.
        lv_filter_severity = cl_syslog_filter=>severity_red BIT-OR cl_syslog_filter=>severity_yellow.
      WHEN OTHERS.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( '{"error":"Severity must be ALL, ERROR, WARNING, or ERROR_WARNING"}' ).
        RETURN.
    ENDCASE.
    IF lv_filter_severity IS NOT INITIAL.
      lo_filter->set_filter_severity( lv_filter_severity ).
    ENDIF.

    TRY.
        lo_syslog = cl_syslog=>get_instance_by_filter( lo_filter ).
        lt_entries = lo_syslog->get_entries( ).
      CATCH cx_syslog_read_authorization.
        server->response->set_status( code = 403 reason = 'Forbidden' ).
        server->response->set_cdata( '{"error":"SM21 authorization was rejected while reading the log"}' ).
        RETURN.
      CATCH cx_root.
        " Do not return host, credential, or kernel details to HTTP callers.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( '{"error":"The system log could not be read"}' ).
        RETURN.
    ENDTRY.

    lv_total = lines( lt_entries ).
    " Determine pagination before writing the JSON envelope.
    IF lv_total - lv_offset > lv_page_size.
      lv_has_more = abap_true.
    ENDIF.
    lv_json = '{"hasMore":' && COND string( WHEN lv_has_more = abap_true THEN 'true' ELSE 'false' )
      && ',"total":' && lv_total && ',"logs":['.
    LOOP AT lt_entries INTO DATA(ls_entry).
      lv_seen = lv_seen + 1.
      IF lv_seen <= lv_offset.
        CONTINUE.
      ENDIF.
      IF lv_returned >= lv_page_size.
        EXIT.
      ENDIF.
      lv_returned = lv_returned + 1.
      IF lv_returned > 1.
        lv_json = lv_json && ','.
      ENDIF.
      " RSLGENTRY-SEVERITY is byte-like; WRITE gives JSON a readable hex value.
      WRITE ls_entry-severity TO lv_severity_text.
      lv_json = lv_json && '{"timestamp":"' && ls_entry-zdate && ls_entry-ztime
        && '","instance":"' && escape( val = ls_entry-instance format = cl_abap_format=>e_json_string )
        && '","client":"' && ls_entry-client
        && '","user":"' && escape( val = ls_entry-zuser format = cl_abap_format=>e_json_string )
        && '","program":"' && escape( val = ls_entry-repna format = cl_abap_format=>e_json_string )
        && '","tcode":"' && escape( val = ls_entry-tcode format = cl_abap_format=>e_json_string )
        && '","messageId":"' && escape( val = ls_entry-messageid format = cl_abap_format=>e_json_string )
        && '","severity":"' && escape( val = lv_severity_text format = cl_abap_format=>e_json_string )
        && '","process":"' && escape( val = ls_entry-processid format = cl_abap_format=>e_json_string )
        && '","text":"' && escape( val = ls_entry-text format = cl_abap_format=>e_json_string ) && '"}'.
    ENDLOOP.
    server->response->set_cdata( lv_json && ']}' ).
  ENDMETHOD.
ENDCLASS.
