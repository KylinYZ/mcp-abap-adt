# Changelog

## [Unreleased]

## [0.8.1] - 2026-09-22
- Rename the npm package from `@kylinyz/mcp-abap-abap-adt-api` to `abap-ai-workbench-mcp` (unscoped, shorter, MCP-explicit). The MCP server identity, bin name, `mcpName`, and `server.json` registry id move with it. Install with `npx -y abap-ai-workbench-mcp@0.8.1`; the old package name is deprecated and points to the new one.
- Keep the server-compatible MCP server name in client configs unchanged in behavior; update the config key to taste. Repository URL and upstream attribution are unchanged.

## [0.8.0] - 2026-09-22
- VSP capability alignment advances from 39/71 to 51/71 (`MCP_SUPERSET=10`, `EQUIVALENT=41`, `PARTIAL=8`, `GAP=2`, `INTENTIONAL_RESTRICTION=10`, `UNVERIFIED=0`), with every promotion backed by real-DEV evidence under `docs/evidence/`.
- Add the classic-RFC transport layer on `open-rfc` (no NW RFC SDK): read-only `probeRfcSystem`, `readRfcTable` (with S/4-enhanced `RFC_READ_TABLE` dual-path adaptation), `describeRfm`, and `callRfm` behind a read-only FM allowlist — closing both P0 RFC gaps.
- Add three controlled write workflows sharing one safety model (immutable plan, context-bound replay rejection, one native confirmation, single execution, readback/absence verification, defensive convergence): `set-description` (`MCP_SUPERSET`), one-shot object clone (`clone-object`), and one-shot object rename (`rename`, which delegates creation to the controlled creation chain and deletion to the controlled cleanup chain, and converges via an absence recheck when the delete landed but transport evidence is unavailable).
- Add the AMDP debugger discovery probe `checkAmdpDebugger` and the object-activation chain promotion to `EQUIVALENT`.
- Add read-only analysis and diagnostics tool families: transport history (`getCrHistory`, `getCoChange`), IMG activity detail, dump grouping/similarity, dependency context (4 tools), package boundary check, UI5 filestore reads, spool/job reads incl. content decoding, transaction metadata, message-class texts, i18n language reads (4 tools), revision source/compare, cross-object source compare, install prerequisite discovery, ABAP documentation and IMG search.
- Add the offline abapGit deployment engine stage 1 (zero-dependency ZIP reader, serialization grouping, deployment plan builder) as the local foundation for stage 2 controlled batch deployment.
- Hardening from real-DEV findings: datapreview per-session query budget discovery and doc updates, `readRuntimeDumps` server-side filter fix (time-window-only feed predicates, client-side matching), spool UTF-16LE decoding, `getImgActivity` recursive menu paths, and guardrail exemptions for confirmation-style tools to prevent single-slot self-deadlock.
- Real-DEV smoke tests now run against the dedicated `sap-demo.env` system by owner decision (transport `S4HK900009`); automation baseline grows to 159 suites / 1526 tests.

## [0.7.0] - 2026-09-04
- Verify the real DEV focused source-preview path end to end using a temporary local audit directory; `sap(edit)` now returns the delegated preview's `status`, `plan`, and `diff` without an extra MCP-result wrapper.
- Add a real DEV read-only focused-entrypoint smoke test covering MCP stdio startup, `sapDoctor`, `sap(read)`, `sap(search)`, and automatic table diagnosis routing without emitting source or business rows.
- Reposition the server as a developer-first AI-native ABAP workbench. Add `focused`/`developer`, `business`, `operations`, and `expert` role aliases, make `focused` the default profile, and retain all legacy profile names for compatibility.
- Derive the expected writable repository kinds in the verified domain-preview smoke test from the maturity evidence manifest instead of a hardcoded list.

## [0.6.0] - 2026-09-04
- Add validation-only repository cleanup preview/apply/status with a separately confirmed destructive action, frozen parent identity, child-first cleanup, and no replay after uncertain deletion.
- Enforce checked-in per-kind maturity evidence for creation, readback, transport, cleanup, and absence; block historical unknown identities and ship the evidence manifest with the npm package.
- Classify cleanup CTS evidence as either an exact propagated deletion entry or an exact neutral entry for objects created and removed in the same open transport; duplicates, released transports, and unknown creation outcomes still fail closed.
- Promote CDS Data Definition, DCL, Metadata Extension, Service Definition, Behavior Definition, and Service Binding to `REAL_DEV_VERIFIED`, raising the evidence-backed total to 22 kinds.
- Promote Change Document Object after fresh `ZVPCHDO05` `APPLIED` creation, active generated-Class verification, parent-only cleanup, cascade absence, and exact neutral `CHDO/CLAS` CTS evidence, raising the total to 23 kinds.
- Complete real DEV lifecycle evidence and `REAL_DEV_VERIFIED` promotion for all 11 Wave 1 repository-object kinds.
- Add bounded post-create ownership proof for source/type-group HTTP 200 responses, safe Table/Function mismatch metadata, authenticated-user package responsibility validation, and DDIC Structure prewrite checks.
- Fix a reentrant `ToolExecutionGate` deadlock by keeping repository-object confirmation and local status reads outside the outer SAP gate while retaining the confirmed workflow inside the single SAP slot.
- Add a Windows interactive confirmation provider with a Chinese SAP-style dialog, Explorer broker launch, one-time named-pipe response, bounded challenge binding, and no TCP listener or SAP credentials in the helper.
- Normalize SAP's empty default DDIC domain `valueInformation` during active verification without ignoring non-empty value tables, fixed values, or append flags.
- Add one-time campaign configuration for the explicit current 31 repository kinds, freeze package identity separately from business parents, and validate function-group Includes by their prefixed parent plus three-character suffix.
- Align repository preview validation with target discovery: SAP ASX for source/package/DESD validation, separate package constraint media types, bounded message-class `messages`, and successful empty validation acknowledgements.
- Verify the Windows cancel and apply confirmation paths in Codex Desktop. A scoped DEV run created and activated `DDIC_DOMAIN` `ZZMCP_VT_DOM`; active properties matched the plan, but cleanup and maturity promotion remain pending.
- Promote `ABAP_CLASS` to `REAL_DEV_VERIFIED` after Eclipse-contract correction (mandatory `class:include`/`class:superClassRef` children, stateless shell creation and readback with a frozen stateful lock/write/check/activate boundary) and the full `ZVPCL06` create, activate, and cleanup lifecycle.
- Promote `DDIC_STRUCTURE` to `REAL_DEV_VERIFIED` with a bounded `DDIC_STRUCTURE_FORMAT_NORMALIZED` rule that accepts exactly one whitespace-only line before the final `}` of a `define structure` source, proven by the full `ZVPSTR06` create, activate, and cleanup lifecycle.
- Capture `STAUTHTRACE` failed authorization checks for CDS Annotation Definition creation; the kind stays blocked on target authorization instead of reporting a generic failure.
- Raise the evidence-backed maturity to `REAL_DEV_VERIFIED=28` with an automation baseline of 109 suites / 793 tests.

## [0.5.0] - 2026-08-18
- Resolve exact `FUGR/I` function-group includes through the guarded inspect/preview/apply workflow without adding an invalid main-program context.
- Expose read-only `getObjectSource` in `development`, `diagnostic-readonly`, and `development-workbench` while keeping it out of `safe`, business, and operations profiles.

## [0.4.0] - 2026-08-18
- Publish the fork to npm as `@kylinyz/mcp-abap-abap-adt-api`, with repository/homepage/issues pointing to `KylinYZ/mcp-abap-adt` and registry id `io.github.kylinyz/mcp-abap-abap-adt-api`. The upstream author remains credited and MIT attribution is unchanged.
- Add bounded `readRuntimeDumps`, schema-first `describeClassicTable`, partial-capability `inspectSapSystem`, and focused `getAbapMemberSource` read tools.
- Add bounded, byte-preserving `inspectAbapObject` source pagination with stable full-source hashes and line-coverage metadata.
- Add DEV-only `development-workbench`, `business-readonly`, and `operations-readonly` task profiles while preserving broad compatibility profiles.
- Add controlled `previewQualityCheck`, `runQualityCheck`, and `getQualityCheckStatus` with explicit ATC variants, one native confirmation, and no replay after `UNKNOWN_OUTCOME`.
- Add uniform MCP annotations and `_meta` operation/approval metadata to every runtime tool, plus catalog integrity tests and dynamic runtime validation.
- Keep QAS, PRD, missing, and unknown roles local/read-only, including direct-dispatch rejection of hidden mutation tools.
- npm publication is verified for `0.4.0`; MCP Registry and Marketplace availability remain separate.

## [0.3.0] - 2026-08-14
- Embed the complete `abap-adt-api` 8.4.2 client source with preserved MIT attribution, a stable local import boundary, and cancellable debugger-listener behavior.
- Add 21 explicit raw MCP tools for structure, hierarchy, enhancements, DDIC/text, ATC documentation, package migration, and RAP generation/publication.
- Add six guarded DEV `development` tools for DDIC, package, and RAP preview/apply workflows with native confirmation, drift checks, single-write semantics, read-only verification, and explicit unknown outcomes.
- Enforce local/read-only operation policy for QAS, PRD, missing, and unknown roles across every profile and direct dispatch.
- Update DEV profile baselines to `safe=7`, `development=114`, `diagnostic-readonly=94`, and `legacy-full=157`.
- Add deployable read-only ADT HTTP SM21 service and optional `legacy-full` SM21/ST22 runtime analysis tools.
- This modified version is source-only and has not been published to npm or the MCP Registry.
- Default to seven high-level safe tools for ABAP source changes and controlled `PROGRAM`, `FUNCTION_GROUP`, and `FUNCTION_MODULE` creation with explicit preview and confirmation.
- Match the captured Eclipse ADT flow for function modules: keep parameters in `source/main`, skip standalone group activation during group-plus-module creation, activate the module by name and URI, and preserve unknown outcomes for read-only inspection.
- Return complete allow-listed ABAP source from `inspectAbapObject` so clients can prepare full-source previews.
- Add DEV host/client/namespace allowlists, transport and `$TMP` checks, source-drift detection, rollback, unlock handling, and sanitized JSONL audit logs.
- Prefer native MCP form elicitation for apply confirmation, with an opt-in one-time text challenge fallback for incompatible clients.
- Return ABAP change previews as directly renderable Markdown diff content plus structured plan data, and instruct form-capable clients to open the single native confirmation without a preceding chat confirmation.
- Keep the original low-level tools available only with `SAP_MCP_TOOL_PROFILE=legacy-full`.
- Add bounded runtime guardrails for ADT timeout, FIFO tool execution, query/search limits, response size, source cache, plan retention, logging, and serialized audit writes.
- Accept SAP-only line-ending and trailing-newline normalization while retaining exact hashes and rejecting all other source differences.
- Add isolated read-only SAP DEV smoke commands for argument limits, response size, source-cache TTL/LRU behavior, FIFO queueing, and local end-to-end ADT timeout cancellation.

## [0.1.0] - Initial Commit
- Initial project setup.

## [0.1.1] - Better unified response structure
- Improved and unified the response structure.
