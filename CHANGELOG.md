# Changelog

## [Unreleased]
- Default to a four-tool safe ABAP source-change workflow with explicit preview and confirmation.
- Return complete allow-listed ABAP source from `inspectAbapObject` so clients can prepare full-source previews.
- Add DEV host/client/namespace allowlists, transport and `$TMP` checks, source-drift detection, rollback, unlock handling, and sanitized JSONL audit logs.
- Prefer native MCP form elicitation for apply confirmation, with an opt-in one-time text challenge fallback for incompatible clients.
- Keep the original low-level tools available only with `SAP_MCP_TOOL_PROFILE=legacy-full`.

## [0.1.0] - Initial Commit
- Initial project setup.

## [0.1.1] - Better unified response structure
- Improved and unified the response structure.
