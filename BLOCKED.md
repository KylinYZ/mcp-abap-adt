# Repository Validation Campaign Issues

## VERIFIER_MISMATCH-001 — DATA_ELEMENT SAP defaults

- Object: `ZVDE1`; plan: `8cdd9118-9f44-4511-b3eb-6072d363db65`.
- Remote stages through activation succeeded; independent active read confirmed the planned Domain, type, length, labels, package, and description.
- SAP materialized label lengths `10/20/40/55` and four omitted booleans as `false`; the old comparer marked `OUTCOME_UNKNOWN`.
- Local comparer and strict non-default regression test are fixed and pass; MCP restart deferred until the campaign’s batch-remediation point.
- Historical plan remains unchanged and must never be replayed.

## TARGET_UNAVAILABLE-002 — computer-use cannot enumerate WinForms confirmation

- Object attempt: `DDIC_TABLE_TYPE ZVTT1`; plan `40d4694a-b95d-4893-bc63-1f7b8b3fb7d9`.
- Preview succeeded and the user authorized computer-use confirmation, but two fresh `sky.list_windows/list_apps` observations returned no `SAP 受控创建确认` or PowerShell window.
- The current helper is a WinForms form hosted by hidden PowerShell through Explorer broker; it is visible to the human desktop but not targetable by the plugin.
- The call returned `confirmation_declined`; no SAP mutation occurred and the plan must not be reused.
- A separately compiled, uniquely titled WinForms EXE launched through Explorer was also absent from `sky.list_windows/list_apps`; the probe was stopped and deleted. This proves a computer-use/interactive-desktop session boundary rather than a PowerShell window-style defect.
- No helper-only fix can make this plugin instance click the human desktop. Continue requires human clicks or a different host confirmation capability that computer-use can actually target.

## LOCAL_VALIDATION-003 — MESSAGE_CLASS whitelist and empty validation response — RESOLVED

- The public `messages` field was missing from `src/lib/requestLimits.ts`; expanded authority was granted and the field is now accepted with bounded regression coverage.
- After a temporary candidate fix, SAP validation returned HTTP 200 with an empty body for both `ZVMSG` and `ZVMSG1`; generic `validateNewObject` incorrectly treats that successful empty response as `success=false`.
- Expanded authority granted. The field whitelist and HTTP-200 empty validation response are fixed with regression tests; independent real DEV preview now succeeds. No apply or SAP mutation occurred during remediation.

## LOCAL_VALIDATION-004 — LOGICAL_EXTERNAL_SCHEMA validation Accept — RESOLVED

- Exact public minimum input for `ZVSCHEMA` returns `{error:"Internal server error",code:-32603}` during preview.
- No plan ID and no apply were produced; no SAP mutation occurred.
- Validation now requests SAP ASX independently of the Blue shell media type; independent real DEV preview succeeds.

## LOCAL_VALIDATION-005 — PACKAGE validation and constraints negotiation — RESOLVED

- Basic and full validation return success. The failure is exactly `/packages/$constraints` content negotiation.
- Target discovery requires two separate reads: `application/softwareComponent.v1+json` and `application/packageConstraints.v1+json`; a temporary two-request candidate fix produced a successful independent preview.
- Package validation now requests ASX. Discovery constraints are read as two separate accepted media types; independent real DEV preview succeeds.

## LOCAL_VALIDATION-006 — Source-object validation media type — RESOLVED

- `CDS_TYPE ZVCDSTYPE`, `CDS_ASPECT ZVASPECT`, and `CDS_ANNOTATION_DEFINITION ZVANNO1` used the reviewed source frames from their contract tests.
- Root cause: source validation endpoints return SAP ASX, while the client incorrectly requested each object shell media type.
- A temporary change to request `application/vnd.sap.as+xml` produced successful independent real DEV previews for Program Include, CDS Type, CDS Aspect, and Annotation Definition.
- Source validation now requests SAP ASX while shell creation retains each object media type. Independent real DEV previews succeed for Program Include, CDS Type, CDS Aspect, and Annotation Definition.

## GOAL_BLOCKED-007 — required authority and confirmation channel — RESOLVED BY USER

- The same blocker persisted for three goal turns: `computer-use` cannot target the human interactive desktop, so it cannot click the trusted Windows confirmation dialog.
- Ten remaining kinds are preview-ready, seven have bounded issues with proven fix directions, and twelve wait on campaign dependencies; further real creation cannot proceed without confirmations.
- Required user decisions: (1) allow writes to `src/adt/api/**` and `src/lib/requestLimits.ts`; (2) accept human clicks on each native confirmation dialog.
- User expanded the code whitelist and agreed to manually click every native confirmation. The campaign may resume after one MCP restart.

## VERIFIER_MISMATCH-008 — FUNCTION_GROUP initial module source

- Plan `d7573d4e-d92d-46e7-802f-269a4bf3ac2e` created `ZVFG1` and `ZVFM0`, wrote, checked, unlocked, and activated the module.
- Active source comparison failed; the owned module and group were compensated in reverse order. Plan status is `COMPENSATED`, not unknown.
- Independent searches confirm both objects absent. Do not retry this object identity; `FUNCTION_GROUP_INCLUDE` and standalone `FUNCTION_MODULE` are dependency-blocked.

## REMOTE_UNKNOWN-009 — DDIC_STRUCTURE source write rejected after shell creation

- Plan `70063115-053d-4f81-862e-ef74581eef4e` created and resolved `ZVSTR1`, locked it, then SAP rejected the planned source with `Can't save due to errors in source; execute check for details`.
- `UNLOCK_RESOURCE` succeeded. Independent active/inactive/workingArea reads all return the SAP placeholder source with `component_to_be_changed : abap.string(0)`; the planned `ZVDE1` component was not written.
- State is bounded to an unlocked shell object; no retry or deletion is authorized. Independent types may continue, but `ZVSTR1` must not be reused.
- RESOLVED LOCALLY AND BY REAL DEV VERIFICATION: the structure comparer now accepts only SAP's observed single blank line before the final `}`. Fresh `ZVPSTR06` completed create, source write, check, activation, active readback, deletion, absence, and CTS deletion-entry verification; `DDIC_STRUCTURE` is now `REAL_DEV_VERIFIED`. Historical `ZVSTR1` and failed validation identities remain untouched.

## REMOTE_UNKNOWN-010 — DDIC_TYPE_GROUP shell response unknown

- Plan `07f19e53-b441-46a4-89ba-1e9a67e18ccf` passed absence and transport validation, then shell creation failed to confirm HTTP 201/canonical Location.
- Independent search and object reads prove `ZVTG1` exists in `Z001`; active, inactive, and workingArea are readable with no lock/session error.
- All three source reads contain only `TYPE-POOL zvtg1.`; the planned `TYPES zvtg1_value TYPE c LENGTH 10.` is absent.
- No replay or deletion. Function-group Include remains dependency-blocked on `ZVFG1`, not this type group.

## REMOTE_UNKNOWN-011 — SAP_OBJECT_TYPE Blue shell parse error

- Plan `6e2efc2e-b0fb-490c-a2af-7d91aa81a19c` passed contract and transport revalidation, then Blue shell creation failed parsing the returned XML stream.
- Independent search for `RONT/ROT ZVOBJECTTYPE` is empty; object structure import returns a sanitized database-import error. No shell identity was proven.
- No replay or deletion. `SAP_OBJECT_NODE_TYPE` remains dependency-blocked; unrelated kinds may continue.

## REMOTE_UNKNOWN-012 — ABAP_INTERFACE shell response unknown

- Plan `8a5e0707-caeb-479e-8585-33de6b2a974d` passed absence and transport validation, then shell creation did not return canonical HTTP 201/Location.
- Independent search and active object structure prove `ZVIF_CAMPAIGN` exists in `Z001`; no source/lock/activation stage was recorded.
- Do not replay or delete. Treat interface as active-shell-only and keep its downstream dependencies independent.

## REMOTE_UNKNOWN-013 — ABAP_CLASS shell response unknown

- Plan `4ec1b86d-2f75-48d5-a7a7-8c793bb84749` passed absence and transport validation, then shell creation did not return canonical HTTP 201/Location.
- Independent search proves `ZVCL_CAMPAIGN` exists in `Z001`; active structure import returns a sanitized wrong-input error. No source/lock/activation stage was recorded.
- Do not replay or delete. Continue independent types only.
- 2026-09-04 Eclipse ADT 3.60.2 capture identifies the missing class-shell contract: alongside the package reference, the v4 request must contain `class:include` for `CLAS/OC` with `class:includeType="testclasses"` and an empty `class:superClassRef`. The controlled builder had matched the outer attributes but omitted both children, reproducing the same unreadable shell for `ZVPCL02`.
- RESOLVED LOCALLY: the builder now emits exactly those two class-only children and a regression test freezes the captured shape. Build and targeted creation tests pass. A hard MCP restart and a fresh class identity are required before any new real DEV apply; all historical class identities remain untouched.
- Retest `ZVPCL03` after the XML-only fix reproduced the unreadable shell. The same Eclipse capture marks the class POST as `stateless`, while the controlled source-object shell used the primary stateful ADT client. Class shell creation now uses the existing stateless clone; lock, source write, activation, and verification remain on the primary stateful client. Targeted tests, build, and coverage pass; another hard restart is required before the fresh final retest.
- Full Eclipse lifecycle capture labels only LOCK/UNLOCK as stateful enqueue. The embedded client independently requires a stateful local session for `setObjectSource`, so the Class adapter uses a stateless clone only for shell creation and readback, retaining the primary stateful client for lock/write/check/activate/unlock. Dual-client regression, build, coverage, and diff checks pass. A hard restart and a fresh identity are still required for real DEV evidence.
- RESOLVED BY REAL DEV VERIFICATION: after a hard restart, fresh `ZVPCL06` completed create, ownership proof, source write, syntax check, activation, active readback, cleanup, absence, and unique neutral CTS verification. `ABAP_CLASS` is now `REAL_DEV_VERIFIED`; historical class identities remain consumed and untouched.

## REMOTE_UNKNOWN-014 — MESSAGE_CLASS compensation blocked by active editor

- Plan `3750756d-9247-4a83-bb44-77d5a6cef7ae` created and resolved `ZVMSG` shell, then stopped before source write; compensation failed because SAP reports `使用者 068157 当前编辑 ZVMSG`.
- Independent search, structure, and source reads prove the active shell exists in `Z001`; no message source content was written.
- This is a shared editor/lock risk, not an isolated verifier mismatch. Pause the entire campaign; do not start another apply, retry this plan, or delete the object.

## REMOTE_UNKNOWN-015 — PROGRAM_INCLUDE shell response unknown

- Plan `5842c164-66bf-4f20-aa0d-df04aeb76d60` passed absence and transport validation, then shell creation did not return canonical HTTP 201/Location.
- Independent search and active structure prove `ZVINCL` exists in `Z001`; source read contains only SAP-generated include header comments, not planned source.
- No replay or deletion. Treat as active-shell-only and continue independent types.

## TARGET_UNAVAILABLE-016 — CDS Annotation Definition authorization

- Plan `8e0a8cfa-6f68-4e37-986e-af788ffeefec` passed absence and transport validation, then SAP rejected shell creation with `You are not authorized to create Annotation Definitions`.
- No actual resource was recorded; independent search confirms `ZVANNO1` absent. No replay or deletion.
- Keep this type blocked until target authorization is corrected; unrelated types may continue.

## LOCAL_VALIDATION-017 — PACKAGE responsible user contract

- Plan `0a2d2213-a805-4e04-ae3a-833cf2427383` passed absence and transport validation, then SAP rejected package creation before shell with `输入有效用户（而非 SAP）作为负责人`.
- Independent search confirms `ZVPKG` absent; no replay or deletion.
- The package adapter must resolve the target’s accepted responsible-user identifier before a future attempt; current plan is terminal unknown and cannot be reused.

## TARGET_UNAVAILABLE-018 — automatic approval review timeout

- `LOGICAL_EXTERNAL_SCHEMA ZVSCHEMA` plan `0e365439-0ad7-4f9d-b7e2-64eae07debe5` and `CDS_TYPE ZVCDSTYPE` plan `915035d8-08df-4a6a-b55c-2640718e8c86` hit the host permission-review deadline before dispatch.
- Both plans remained `PREVIEWED` and independent searches were empty; no SAP mutation occurred. Neither plan may be reused.
- This is an external approval-service timing issue; continue only when the host review is responsive.

## LOCAL_VALIDATION-019 — compensation lock leak in MESSAGE_CLASS

- Root cause confirmed in `MessageClassCreationAdapter.compensate`: a compensation `MODIFY` lock was acquired, then a failed DELETE threw before any unlock attempt.
- This could leave the shared stateful MCP session holding the SAP editor lock, explaining `使用者 068157 当前编辑 ZVMSG` even when no editor window was open.
- Fixed with a failure-only unlock fallback; successful DELETE does not unlock the already-deleted URL. The original DELETE error remains authoritative.
- Regression coverage includes delete failure/unlock, successful deletion, and delete-plus-unlock failure. Historical `ZVMSG` plan remains terminal and must not be replayed.

## LOCAL_VALIDATION-020 — shell response body contract

- Several shell endpoints created the SAP object but returned `HTTP 201 + canonical Location + empty body`; adapters parsed the empty body before checking the creation evidence and classified the result as unknown.
- Fixed for source objects, DDIC type groups, DDIC structures, and SAP Object Type: strict status/location first, plan identity only for an empty body, strict identity validation for non-empty bodies.
- `AxiosHttpClient` now correctly preserves plain-object response headers, including `Location`.
- Regression coverage and full build/test gates pass. Real DEV confirmation is still required with new identities; historical shell-only plans remain non-replayable.

## LOCAL_VALIDATION-021 — PACKAGE responsible user

- Parent package discovery can expose `responsible=SAP`, which SAP rejects as a system value rather than a valid user.
- Preview now fails closed with an actionable validation error and does not create an apply plan. No fallback user is guessed.
- PACKAGE remains blocked until a target-supported responsible-user discovery/selection contract is independently established.

## LOCAL_VALIDATION-022 — Blue additional content attributes

- New SAP Object Type plan `fa176dd5-9fd7-4e7c-82d3-12af0190f68c` reached the shell POST after native confirmation, then SAP rejected the embedded payload with an XML value parse error at base64 prefix `eyJuYW1lIj...`.
- Independent `RONT/ROT ZVOBJECTTYPE2` search is empty and active structure import fails; no object identity or visible mutation was proven. The plan remains `OUTCOME_UNKNOWN` and must not be replayed.
- ADT 3.60.2 bytecode plus direct EMF serialization prove the canonical element is `<adtcore:content adtcore:encoding="base64" adtcore:type="application/vnd.sap.adt.serverdriven.content.v1+json">...`.
- RONT and NONT builders incorrectly emitted unqualified `encoding` and `type`; SAP therefore did not decode the base64 value. Both builders and regression tests are fixed.
- Full local gates pass. A second MCP restart and a third fresh object identity are required for real DEV confirmation.

## TARGET_UNAVAILABLE-023 — host retained the old MCP process

- After the requested restart, healthcheck reported a connected stateful session age of about 1207 seconds, spanning the previous SAP Object Type attempt.
- The checked-in `dist` contains the namespace fix and Codex config points at that exact `dist/index.js`, but the live `sap-dev` connection continued using the pre-fix process.
- Fresh plan `c235448a-ebc9-46cb-bb36-2f99364a246e` therefore reproduced the old base64 parse error. Independent search confirms `ZVOBJECTTYPE3` absent.
- No further apply is safe until the host actually terminates and recreates the `sap-dev` MCP child process; the next healthcheck must prove a reset before a fourth fresh identity is used.

## VERIFIER_MISMATCH-024 — RONT inactive generated code

- Hard restart succeeded and fresh plan `c500e56d-9c13-4cdc-86f4-7110f5a225a5` proved the fixed Blue v2 shell POST works in DEV.
- SAP created `ZVOBJECTTYPE4`, but the inactive JSON parser required the SAP-generated `objectTypeCode` before activation and rejected the response.
- Compensation locked and deleted the owned shell successfully; independent search confirms the object is absent and no residue remains.
- The verifier must allow a missing inactive generated code, require a bounded active code, and require equality only when inactive already exposes one. No historical plan or identity may be replayed.
- Fixed with explicit inactive/active phase rules and negative tests for missing active code and generated-code drift. Full local gates pass; real DEV confirmation still requires a hard restart and a fresh identity.

## VERIFIER_MISMATCH-025 — RONT active generated code is optional

- Fresh plan `63167202-a21b-40f6-84de-26b63692970e` passed shell creation, inactive object/content verification, and activation, then failed only at active content comparison.
- Compensation succeeded and independent search confirms `ZVOBJECTTYPE5` absent.
- Read-only DEV samples prove active `objectTypeCode` is optional: some active RONT objects contain a bounded code while others omit it entirely.
- The final verifier accepts absence in both phases, validates any present code, and freezes an inactive value when SAP already assigned one. Full local gates pass; one hard restart and one fresh identity remain for real confirmation.

## VERIFIER_MISMATCH-026 — DESD source media type

- Plan `ac26786c-5208-49b5-b70d-41ffdb273b54` created the `ZVSCHEMA2` shell, then rejected the returned source link as an unsupported JSON content type.
- Owned-shell compensation succeeded and independent search confirms no residue.
- The exact DESD source-link media type must be reconciled with target/Eclipse evidence without accepting arbitrary JSON.
- RESOLVED LOCALLY: Eclipse ADT 3.60.2 confirms DESD `/source/main` accepts strict `application/json`, separate from the `$schema` vendor type. API, adapter, and capability metadata now share one strict validator; real DEV retest requires restart and a fresh identity.
- Retest update: source media type passes in DEV, but `ZVSCHEMA3` JSON fails the controlled objectTypes.v1 shape check; compensation succeeded and no object remains.

## REMOTE_UNKNOWN-027 — source shell canonical Location

- `ABAP_INTERFACE ZVIF2` and `DDIC_TYPE_GROUP ZVTG2` both created active shells but failed strict canonical Location confirmation before recording ownership.
- Independent reads prove the expected canonical object URIs exist; sources contain only SAP-generated shells, not confirmed source bodies.
- No retry or deletion is allowed. The raw/normalized Location contract must be diagnosed before testing another source/type-group identity.
- RESOLVED LOCALLY: the old comparer treated an absolute Location as a raw path. A shared validator now extracts and strictly compares only the canonical HTTP(S) pathname while rejecting ambiguous or unsafe variants. Historical shells remain untouched; fresh identities require restart.
- Retest update: `ZVIF3` returned HTTP 200 without Location; active shell was independently proven. The helper correctly fails closed, so the 200/no-Location contract remains unresolved.

## REMOTE_UNKNOWN-028 — Message Class implicit editor lock

- Plan `d847ced9-1612-4b23-994e-0a966df7fc73` created and resolved `ZVMSG2`, then failed before the explicit `LOCK_RESOURCE` stage because SAP reported the current user was already editing it.
- Compensation could not acquire its own lock and failed with the same message. Active shell/source exists without message 001.
- This precedes the previously fixed compensation-lock leak and indicates shell creation itself retains or creates an editor lock without exposing the handle to the adapter.
- Pause all real apply until the exact create/lock lifecycle is corrected and the retained lock is independently cleared.
- RESOLVED LOCALLY: ADT 3.60.2 bytecode proves message-class shell creation uses a stateless REST resource, while the old adapter used the primary enqueue session. A dedicated stateless creation method is now used only by Message Class; uncertain create outcomes remain non-retryable. Existing `ZVMSG`/`ZVMSG2` locks and shells remain historical and must be cleared/handled outside old plans before fresh real validation.
- Retest update: fresh `ZVMSG3` completed `APPLIED` with message 001, proving the stateless creation and lock lifecycle fix in DEV.

## VERIFIER_MISMATCH-029 — DESD JSON response shape

- `ZVSCHEMA3` reached shell/source resolution after the media-type fix, then failed controlled JSON verification.
- Compensation succeeded and independent search is empty. The exact SAP JSON shape must be reconciled before another fresh attempt.
- RESOLVED LOCALLY: DEV samples prove `abapLanguageVersion` and `generalInformation` are optional. Parser and adapter now accept omission while preserving strict checks for returned fields; targeted tests and build pass.

## REMOTE_UNKNOWN-030 — SAP source shell HTTP 200

- Fresh `ZVIF3` returned HTTP 200 with no Location, while independent search and active reads prove an empty shell.
- The Location helper correctly refuses to invent ownership. No replay/delete is allowed until the Eclipse/target contract explains HTTP 200 creation semantics.
- Retest confirms the same behavior for `ZVIF3`; active empty shell exists with no planned source. Do not broaden HTTP 200 into success without a bounded identity/readback ownership contract.

## VERIFIER_MISMATCH-031 — Database Table DDL formatting

- Plan `237c63bd-9efa-44ed-810c-6f4de084314a` created, checked, wrote, unlocked, and activated `ZVTAB2`, then failed byte-level active source comparison.
- Owned-table compensation succeeded and independent search is empty.
- SAP active table DDL aligns field whitespace. The table verifier needs a conservative token comparison that ignores only non-semantic whitespace outside strings/comments; semantic tokens and order must remain exact.
- RESOLVED LOCALLY: Database Table now uses an adapter-local strict tokenizer after exact/CRLF comparison. Positive alignment cases and semantic negative cases pass; full 106/719 gates pass. Real DEV retest requires restart and a fresh table identity.
- Final retest: both `ZVTAB3` (`abap.clnt`) and `ZVTAB4` (`MANDT`) still fail strict semantic token comparison after successful activation; both compensate cleanly. Three consecutive failures reached the campaign stop threshold. Downstream table/CDS dependencies remain blocked until active-source evidence can be captured safely.
## VERIFIER_MISMATCH-032 — FUNCTION_GROUP CTS key mapping — RESOLVED

- Fresh plan `eeb6c118e157774c7bd7dea2874dc8f4` created and activated `ZVPFG8`/`ZVPFM8`; source verification passed with `FUNCTION_MODULE_FORMAT_NORMALIZED`.
- Cleanup plan `3c5e0679-e399-4956-9cbb-2681ef9ba96a` deleted the function group, SAP cascaded the function module, and independent searches confirmed both absent.
- Cleanup stopped at CTS evidence because no unique deletion or neutral key was accepted. Read-only `transportInfo` exposed `LIMU/REPS/SAPLZVPFG8` for the group and `LIMU/FUNC/ZVPFM8` for the module; the standard `R3TR/FUGR/ZVPFG8` mapping was not yet accepted by the verifier.
- Local fix adds only the standard `R3TR/FUGR/<business-name>` alias for Function Group matching, with regression coverage. After hard restart, new identity `ZVPFG9` completed cleanup plan `c7ffdbfe-8399-46f1-80d9-060c6ea691dd` with one neutral CTS entry and `COMPLETED_LOCAL_ABSENCE`; the failed `ZVPFG8` plan and identity remain consumed. No E071/E071K or database mutation occurred.
## VERIFIER_MISMATCH-033 — FUNCTION_MODULE shared parent CTS scope — RESOLVED

- `ZVPFM11B` 与 `ZVPFM11C` 均独立创建、激活、删除并确认缺失，但模块级 cleanup 在 CTS 阶段失败；SAP 返回的实际锁/CTS 键为父函数池 `LIMU/REPS/LZVPFG11UXX`，不是模块业务键。
- 这不是 SAP 拒绝删除或传输归属问题，而是旧 verifier 错误要求共享函数池键对单个模块唯一。maturity evidence 现在冻结父组与父组 cleanup，要求模块自身生命周期全部完成，并由成功的父组 `COMPLETED_LOCAL_ABSENCE` 计划提供同一开放传输 CTS 证据。
- 父组 cleanup `5e27bb27-7ce8-46aa-add5-8643db643eb7` 已成功，最终独立 search 无 `ZVPFG11`、`ZVPFM11A`、`ZVPFM11B` 或 `ZVPFM11C` 残留；未修改 E071/E071K，未执行数据库操作。
