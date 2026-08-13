# Changelog

## [Unreleased]
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
