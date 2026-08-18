# Changelog

## [Unreleased]

- Rebrand the fork's release identity for npm publication: scoped package name `@kylinyz/mcp-abap-abap-adt-api`, repository/homepage/issues pointing to `KylinYZ/mcp-abap-adt`, and registry id `io.github.kylinyz/mcp-abap-abap-adt-api`. The upstream author is credited in `contributors`; MIT attribution in `LICENSE` and `third-party/abap-adt-api/BASELINE.md` is unchanged.

## [0.4.0] - 2026-08-17
- Add bounded `readRuntimeDumps`, schema-first `describeClassicTable`, partial-capability `inspectSapSystem`, and focused `getAbapMemberSource` read tools.
- Add DEV-only `development-workbench`, `business-readonly`, and `operations-readonly` task profiles while preserving broad compatibility profiles.
- Add controlled `previewQualityCheck`, `runQualityCheck`, and `getQualityCheckStatus` with explicit ATC variants, one native confirmation, and no replay after `UNKNOWN_OUTCOME`.
- Add uniform MCP annotations and `_meta` operation/approval metadata to every runtime tool, plus catalog integrity tests and dynamic runtime validation.
- Keep QAS, PRD, missing, and unknown roles local/read-only, including direct-dispatch rejection of hidden mutation tools.
- This modified version remains source-only and has not been published to npm or the MCP Registry.

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
