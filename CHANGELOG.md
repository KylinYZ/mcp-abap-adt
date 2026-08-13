# Changelog

## [Unreleased]
- This modified version is source-only and has not been published to npm or the MCP Registry.
- Default to a four-tool safe ABAP source-change workflow with explicit preview and confirmation.
- Return complete allow-listed ABAP source from `inspectAbapObject` so clients can prepare full-source previews.
- Add DEV host/client/namespace allowlists, transport and `$TMP` checks, source-drift detection, rollback, unlock handling, and sanitized JSONL audit logs.
- Prefer native MCP form elicitation for apply confirmation, with an opt-in one-time text challenge fallback for incompatible clients.
- Keep the original low-level tools available only with `SAP_MCP_TOOL_PROFILE=legacy-full`.
- Add bounded runtime guardrails for ADT timeout, FIFO tool execution, query/search limits, response size, source cache, plan retention, logging, and serialized audit writes.
- Accept SAP-only line-ending and trailing-newline normalization while retaining exact hashes and rejecting all other source differences.
- Add isolated read-only SAP DEV smoke commands for argument limits, response size, source-cache TTL/LRU behavior, FIFO queueing, and local end-to-end ADT timeout cancellation.

## [0.1.0] - Initial Commit
- Initial project setup.

## [0.1.1] - Better unified response structure
- Improved and unified the response structure.
