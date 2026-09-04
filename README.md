[English](README.md) | [简体中文](README.zh-CN.md)

DISCLAIMER: This server is still experimental. The default `safe` profile adds a guarded source-change workflow, but SAP authorization design, transport governance, backups, and operator review remain your responsibility.

# ABAP-ADT-API MCP-Server

## Description

The MCP-Server `@kylinyz/mcp-abap-abap-adt-api` connects MCP clients to SAP ABAP Development Tools (ADT). It is a modified fork of [`mario-andreschak/mcp-abap-abap-adt-api`](https://github.com/mario-andreschak/mcp-abap-abap-adt-api) published under a distinct scoped npm name. The complete ADT client is embedded under `src/adt/`; installation and runtime do not depend on the external `abap-adt-api` npm package. The embedded baseline is derived from upstream `abap-adt-api` 8.4.2 under the MIT License, with exact revisions and update instructions recorded in [`third-party/abap-adt-api/BASELINE.md`](third-party/abap-adt-api/BASELINE.md).

> **Distribution status (2026-08-18):** version `0.5.0` is published on npm as `@kylinyz/mcp-abap-abap-adt-api`. Use the scoped package name and pin the version for reproducible MCP configuration. The unscoped upstream package `mcp-abap-abap-adt-api` (0.1.1) by mario-andreschak is a separate, older release.

For a complete Windows setup and operating walkthrough, see the [Chinese Usage Guide](docs/使用指南.md).

> **Related project:** For higher-level, read-oriented ABAP tools (`GetProgram`, `GetClass`, `GetTable`, …) see the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) server. **This** server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API (lock/unlock, edit source, transports, activation, syntax checks, DDIC access, …) for full read/write development workflows.

## Features

The current code registers seven profile-specific tool surfaces:

| Profile | Tool count | Scope | Recommended use |
| --- | ---: | --- | --- |
| `safe` (default) | 7 | Guarded read/change workflows for `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE`, plus guarded creation of `PROGRAM`, `FUNCTION_GROUP`, and `FUNCTION_MODULE` | Normal AI-assisted ABAP development |
| `development` | 124 | Backward-compatible broad DEV surface plus the five controlled repository-creation platform tools | Existing development clients |
| `diagnostic-readonly` | 99 | Backward-compatible broad read-only diagnosis surface | Existing diagnostic clients |
| `legacy-full` | 161 | 7 safe tools + 6 high-level runtime tools + 148 raw low-level ADT tools | Compatibility and expert direct control on DEV only |
| `development-workbench` | 87 | Focused development, safe debug, controlled operations, quality checks, and repository-creation capabilities | ABAP development Skill |
| `business-readonly` | 17 | Schema-first bounded business-data evidence | Business-data Skill on DEV/QAS/PRD |
| `operations-readonly` | 40 | Runtime, transport/version, trace, and existing debug-state evidence | Operations Skill on DEV/QAS/PRD |

These are normal-profile counts. Explicit `SAP_MCP_REAL_DEV_VALIDATION=true` adds three validation-only cleanup tools to DEV `development` (127 total) and `development-workbench` (90 total); all other profiles and non-DEV roles keep them hidden.

The embedded surface adds 21 explicit raw tools for object structure elements, type hierarchy, enhancements, DDIC properties and text elements, ATC documentation, package migration, and RAP generation/publication. Version `0.4.0` also adds four high-level read tools: bounded `readRuntimeDumps`, schema-first `describeClassicTable`, partial-capability `inspectSapSystem`, and focused `getAbapMemberSource`. Direct URL source reading through `getObjectSource` is available in `development`, `diagnostic-readonly`, `legacy-full`, and `development-workbench`, but remains outside `safe`, business, and operations profiles. The development Workbench adds `previewQualityCheck`, `runQualityCheck`, and `getQualityCheckStatus` for controlled ATC/ABAP Unit execution. The [Chinese Usage Guide](docs/使用指南.md#4-mcp-功能与工具清单) contains the exhaustive catalog and workflow reference.

DEV `development` and `development-workbench` also expose the stable repository-creation `list/describe/preview/apply/status` surface. This first platform slice provides the capability registry, immutable plan lifecycle, native confirmation, unknown-outcome stop semantics, and role/profile gates. All five initial object kinds now have automated adapters: program/function creation reuses the existing controlled workflow, while package and database-table creation use typed Eclipse ADT contracts. Non-mutating preview returns complete review material even while `writable=false`; apply remains blocked until the specific adapter passes a separately confirmed real DEV end-to-end verification.

Validation-only cleanup uses `previewRepositoryObjectCleanup`, `applyRepositoryObjectCleanup`, and `getRepositoryObjectCleanupStatus`. The server freezes object identity, package, transport, generated dependencies, and deletion order; cleanup has its own destructive native confirmation and never replays an uncertain delete. Cleanup transport evidence has two modes: an existing or downstream-visible object requires one exact `OBJFUNC=D` deletion entry, while an object proven absent before creation and removed again in the same open transport may retain one exact neutral CTS entry. The checked-in [maturity evidence manifest](docs/evidence/repository-creation-maturity-evidence.json) cross-checks creation, active/final readback, transport mode, cleanup, and post-cleanup absence before a kind becomes `REAL_DEV_VERIFIED`; historical unknown identities remain immutable.

Repository-creation confirmation is fixed per Server session by `SAP_MCP_CONFIRMATION_PROVIDER`, which defaults to `auto`. `auto` prefers MCP form elicitation when the client supports it; on Windows, unsupported form clients fall back to Explorer launching the native Apply/Cancel dialog in the interactive desktop over a one-time Windows named pipe. The dialog displays its expiry in China Standard Time (`UTC+08:00`) and waits for at most 15 minutes without outliving the remaining plan lifetime. It opens no TCP listener and passes no SAP credentials to the helper. Explicit `windows-native` and `mcp-form` modes are supported; `mcp-app` fails closed until App-only isolation is verified and never falls back to chat text or caller booleans.

The Windows path was verified end to end in Codex Desktop on 2026-08-24: cancel returned to the original `tools/call`, the same session remained responsive, and apply no longer self-deadlocks. The deadlock was caused by `applyRepositoryObjectCreation` reserving the single outer SAP gate and then waiting for its confirmed workflow to reserve that same gate; repository apply/status now stay outside the outer gate, while the confirmed SAP workflow still runs inside it exactly once.

A separately authorized scoped DEV run created and activated `DDIC_DOMAIN` `ZZMCP_VT_DOM` in package `Z001` on transport `S4HK900009`. Independent active readback confirmed `CHAR(10)` and the planned output flags. The historical plan remains `OUTCOME_UNKNOWN` because the pre-fix verifier treated SAP's materialized empty `valueInformation` block as different from an omitted optional block; comparison now normalizes only that empty default. Cleanup was not authorized or performed, so `DDIC_DOMAIN` remains `CONTROLLED_IMPLEMENTED` and the catalog remains `writable=false`. The next validation campaign is configured once for the explicit current 31-kind list, prefix `ZV`, package `Z001`, and transport `S4HK900009`; it becomes active only after the next Server restart and still requires one confirmation per object.

Phase 2 tracks thirteen additional source/service kinds in the same capability catalog. Ten now have complete real DEV evidence: interface, include, CDS data definition, DCL, metadata extension, service definition, behavior definition, CDS type, CDS aspect, and service binding. Class, annotation definition, and CDS entity buffer remain non-writable. DCL, metadata-extension, service-definition, behavior-definition, and entity-buffer plans bind active CDS references and revalidate them at apply time; service bindings bind an active service definition, activate explicitly, and verify OData version/category plus publication state.

The complete target is measured from installed Eclipse ADT 3.60.2 ABAP New Wizards. The current catalog controls 31 candidates, leaves 111 for protocol extraction, and has 26 kinds at `REAL_DEV_VERIFIED`; 5 remain non-writable. See the lifecycle evidence under `docs/evidence/` and the [ADT wizard manifest](docs/evidence/eclipse-adt-3.60.2-creation-wizard-manifest.json).

`LOGICAL_EXTERNAL_SCHEMA` (`DESD/TYP`) now has a complete controlled server-driven slice at `CONTROLLED_IMPLEMENTED`, `available=true`, and `writable=false`. It freezes the target `$schema`, creates the Blue v1 shell, writes reviewed objectTypes.v1 JSON through the object source link, activates and rereads the object, and rejects SAP-owned `usesRouting=true`. No real SAP write was performed for this slice.

`NUMBER_RANGE_OBJECT` (`NROB/NRO`) now has the same controlled server-driven lifecycle at `CONTROLLED_IMPLEMENTED`, `available=true`, and `writable=false`. Preview freezes the target objectTypes.v1 `$schema`, Blue v1 shell media type, package/transport identity, and active Domain/Data Element/Transaction dependencies. Apply can write only the reviewed `application/json` interval and buffering fields, rereads working and active content, and never accepts caller URLs, JSON, media types, or lock handles. ADT 3.60.2 JAR evidence and target DEV read-only discovery were verified; no real SAP create, activation, or cleanup was performed.

`SAP_OBJECT_TYPE` (`RONT/ROT`) is the 24th registered object kind and is implemented at `CONTROLLED_IMPLEMENTED`, `available=true`, and `writable=false`. Preview freezes the target Blue v2 discovery contract and all three `newObjectTypes.v1` `$new` resources, maps six reviewed categories to Eclipse's `bo`/`to`/`ao`/`co`/`do`/`ho` codes, and derives the uppercase repository identity and embedded base64 JSON internally. Apply performs one shell POST, verifies inactive JSON, activates once, and rereads active metadata; callers cannot provide repository metadata, XML, JSON, URLs, media types, or generated codes. `ZVOBJECTTYPE7` completed real DEV creation, activation, and active JSON readback. Cleanup and transport-closeout evidence remain pending, so write enablement is still blocked.

`SAP_OBJECT_NODE_TYPE` (`NONT/NOT`) is the 26th registered object kind with the same `CONTROLLED_IMPLEMENTED`, `available=true`, and `writable=false` boundary. Public input is limited to a PascalCase node name, description, package, transport, an uppercase existing RONT repository name, and the explicit `rootNode` choice. Preview freezes the active RONT URI and CamelCase semantic identity together with Blue v2 discovery and all three `newObjectTypes.v1` contracts. Apply revalidates the reference and contract, performs one shell POST and one activation, and verifies inactive plus active JSON; active `sapObjectType` must equal the frozen RONT semantic name, while SAP remains authoritative for the one-root-node constraint. The root `NONT/NOT ZVOBJECTTYPE7` completed real DEV creation, activation, and active JSON readback. Cleanup remains pending.

The 31-kind creation-side DEV campaign now has an explicit result for every kind. The next milestone is per-kind productionization: complete cleanup and transport evidence, promote to `REAL_DEV_VERIFIED`, and make verified kinds usable with the temporary validation switch disabled. See the [productionization handoff](docs/evidence/repository-creation-productionization-handoff.md) and [implementation plan](docs/superpowers/plans/2026-08-25-repository-creation-productionization-plan.md).

`MESSAGE_CLASS` (`MSAG/N`) is one of 31 registered object kinds and has a controlled source-based slice at `CONTROLLED_IMPLEMENTED`, `available=true`, and `writable=false`. Public input is limited to the message-class name, description, package/transport, and optional messages numbered `001`–`999` with printable text up to 72 characters. Preview freezes the ADT source contract; apply creates one shell, locks, writes only the reviewed `mc:messages` source, unlocks, activates once, and verifies inactive/active source and object identity. Long texts and message documentation are intentionally outside this first slice; activation or post-activation uncertainty enters no-retry `OUTCOME_UNKNOWN` and never auto-deletes. No real MSAG creation, activation, deletion, or cleanup was performed.

`DDIC_TABLE_TYPE` (`TTYP/DA`) is one of 31 registered object kinds and uses the captured ADT 3.60.2 structured XML lifecycle at `CONTROLLED_IMPLEMENTED`, `available=true`, and `writable=false`. Public input is limited to a row-type kind, server-advertised predefined type, bounded length/decimals, table access type, and the captured primary/secondary-key defaults. The adapter creates the shell, locks, writes the structured property document while preserving server-provided value helps, verifies the working area, unlocks, activates, and verifies the active document. `CURR` and `QUAN` are accepted when the target completion response advertises their ranges; arbitrary XML, URLs, media types, links, and lock handles remain unavailable. Advanced key-component payloads await a separate Eclipse capture.

`CHANGE_DOCUMENT_OBJECT` (`CHDO/CHD`) is `REAL_DEV_VERIFIED`, `available=true`, and `writable=true` on writable DEV profiles. Public input excludes SAP's hidden `CD/600` error-message default. Fresh identity `ZVPCHDO05` completed an `APPLIED` JSON write, working and active readback, activation, SAP-assigned active `CLAS/OC` verification, parent-only cleanup, generated-Class cascade absence, and exact neutral `CHDO/CLAS` CTS verification in the same open transport. The historical `ZVPCHDO04` unknown plan remains frozen and was not reused.

### Default `safe` profile

- **Four supported source objects**: `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE`.
- **Controlled object creation**: Adds previewed and confirmed creation for `PROGRAM`, a `FUNCTION_MODULE` in an existing group, or a new group with its first module. Function-module parameters are maintained in the complete `source/main`; standalone empty-group creation remains disabled pending captured Eclipse activation evidence.
- **Review before mutation**: Reads the exact current source, validates the complete proposed source, performs a syntax check, and returns a complete diff before any SAP lock or write.
- **Cross-client confirmation**: Uses native MCP `elicitation.form` when supported, with an explicitly enabled one-time text challenge fallback for incompatible clients.
- **Policy boundaries**: Requires a DEV role, allow-listed host/client/namespace, a transportable package, and an existing unreleased transport reported by SAP for the object.
- **Apply-time protection**: Revalidates the transport and source hash, obtains a stateful MODIFY lock, writes only the confirmed plan, checks syntax again, unlocks, activates, and rereads the source hash.
- **Failure recovery**: Restores the original source after a post-write failure, reacquiring a recovery lock when necessary, then unlocks, reactivates, and verifies the original hash.
- **Sanitized audit trail**: Writes JSONL stage events without passwords, authorization headers, cookies, lock handles, complete source, diffs, confirmation phrases, or verification codes.

### Compatibility `legacy-full` profile

Use `development` only for a DEV instance. Use `diagnostic-readonly` for instances that expose only read-only evidence. System role overrides profile: QAS, PRD, a missing role, or an unknown role permits only local and read-only operations even if configured as `development` or `legacy-full`; hidden mutation tools are also rejected at dispatch before an ADT client call.

Set `SAP_MCP_TOOL_PROFILE=legacy-full` only when the raw ADT surface is explicitly required. On DEV it registers 161 tools, including six raw DDIC/package/RAP mutation tools. Raw mutation, generation, publication, and deletion bypass guarded preview/apply workflows and are not the recommended AI-assisted path. They still require explicit user authority for each real write.

### Controlled advanced DEV operations

The `development` profile provides `previewDdicPropertyChange`/`applyDdicPropertyChange`, `previewPackageChange`/`applyPackageChange`, and `previewRapOperation`/`applyRapOperation`. Preview performs no remote mutation and returns a server-managed `operationPlanId`. Apply accepts only that plan ID and opens one native MCP form confirmation; no chat confirmation is added. After confirmation, the server rechecks policy and drift, executes the mutation at most once, and performs read-only verification. A timeout or lost response can produce `UNKNOWN_OUTCOME`; inspect current SAP state before any new plan and never replay the mutation blindly.

### DEV-only safe debugging

The `development` profile adds `previewDebugOperation`, `applyDebugOperation`, `getDebugOperationStatus`, `authorizeDebugSession`, `executeDebugCommand`, `previewDebugVariableChange`, `applyDebugVariableChange`, and `revokeDebugSession`. Listener, breakpoint, Attach, settings, jump-to-line, terminate, and variable changes use server-managed native form confirmation at the required granularity; safe debug never supports text-confirmation fallback. A session authorization is bound to one SAP user and Attach context for 15 minutes by default. Step/Continue/run-to-line/stack navigation accept one explicit command per call. Variable apply rereads the stack and old value and rejects drift. Timeout or connection uncertainty triggers read-only state inspection and never an automatic replay.

`SAP_MCP_ALLOWED_DEBUG_USERS` accepts a comma-separated allow-list; when omitted, only the current `SAP_USER` is allowed. `SAP_MCP_DEBUG_AUTH_TTL_SECONDS` defaults to `900` and accepts 60–3600. Host, client, DEV role, `development` profile, and writable audit path are checked before any debug-control ADT call.

### Controlled DEV quality checks

`previewQualityCheck`, `runQualityCheck`, and `getQualityCheckStatus` are available only in the DEV `development-workbench` profile. Preview freezes an explicit ABAP Unit or ATC scope; ATC requires an explicit variant and never guesses one. Run accepts only the server-managed plan and opens one native MCP confirmation. A timeout or lost response becomes `UNKNOWN_OUTCOME`; inspect status and SAP evidence read-only and never replay the run blindly.

The member-level source returned by `getAbapMemberSource` is for focused reading only. Any source mutation must first obtain the complete object source from `inspectAbapObject` and use that complete source as the preview baseline. Large objects may be read with optional `startLine`/`maxLines` pages; every page returns the full-source hash and line coverage metadata, and callers must reject gaps or hash drift.

### Optional SM21 runtime-log analysis

With `development`, `diagnostic-readonly`, `legacy-full`, or `operations-readonly`, the server exposes read-only `sm21Read` and `analyzeRuntimeErrors`. They reuse the existing ADT HTTP login session and require the SAP-side [`ZCL_MCP_SM21_ADT_HTTP`](sap/adt-http/ZCL_MCP_SM21_ADT_HTTP.abap) SICF handler and its [deployment instructions](sap/adt-http/ZCL_MCP_SM21_ADT_HTTP-deployment.md); they are not part of the default seven-tool `safe` profile. Bounded ST22 summaries use `readRuntimeDumps` independently and never fall back to the raw `dumps` query surface.

No `node-rfc`, SAP NW RFC SDK, JCo, NCo, RFC destination, or extra client credentials are required. The existing ADT user needs `S_ADMI_FCD=SM21`; MCP tools never accept credentials as arguments.

### Performance and resource guardrails

Central argument and response limits protect every tool in all seven profiles. The FIFO execution gate protects operations that use the shared stateful ADT client; native confirmation waiting, local status tools, and `healthcheck` do not occupy a SAP slot. After confirmation succeeds, the complete source-change, creation, debug-control, advanced, or quality workflow runs inside that same gate. The default concurrency is `1` because ADT operations share cookies, CSRF token, session type, and lock lifecycle. Increase it only after controlled SAP DEV validation.

| Environment variable | Default | Accepted range | Purpose |
| --- | ---: | --- | --- |
| `SAP_MCP_ENV_FILE` | adjacent `.env` | existing file path | Process-level selector for a distinct dotenv file; relative paths resolve from the process working directory. Do not define it inside the selected file. |
| `SAP_MCP_ADT_TIMEOUT_MS` | `60000` | 5000–600000 | Real HTTP timeout passed to the ADT client. |
| `SAP_MCP_MAX_CONCURRENT_TOOLS` | `1` | 1–8 | Maximum active tool calls; production recommendation is `1`. |
| `SAP_MCP_MAX_QUEUED_TOOLS` | `50` | 0–1000 | FIFO waiting capacity before a busy error. |
| `SAP_MCP_QUERY_DEFAULT_ROWS` | `200` | 1–query maximum | Default for `tableContents` and `runQuery`. |
| `SAP_MCP_QUERY_MAX_ROWS` | `5000` | 1–100000 | Hard query row limit. |
| `SAP_MCP_SEARCH_DEFAULT_RESULTS` | `50` | 1–search maximum | Default for `searchObject`. |
| `SAP_MCP_SEARCH_MAX_RESULTS` | `500` | 1–10000 | Hard search result limit. |
| `SAP_MCP_MAX_ARGUMENT_BYTES` | `5242880` | 64 KiB–50 MiB | UTF-8 JSON argument limit per tool call, including complete source. |
| `SAP_MCP_MAX_RESPONSE_BYTES` | `10485760` | 1–100 MiB | Total UTF-8 text bytes allowed in one tool response. |
| `SAP_MCP_SOURCE_CACHE_MAX_ENTRIES` | `20` | 0–1000 | Session source-cache entries; `0` disables caching. |
| `SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES` | `2097152` | 64 KiB–20 MiB | Largest source retained in cache. |
| `SAP_MCP_SOURCE_CACHE_TTL_SECONDS` | `900` | 60–3600 | Source-cache lifetime. |
| `SAP_MCP_CHANGE_PLAN_MAX_ENTRIES` | `100` | 1–1000 | Maximum in-memory change-plan records. |
| `SAP_MCP_ALLOWED_DEBUG_USERS` | current `SAP_USER` | comma-separated SAP users | DEV debug-control user allow-list. |
| `SAP_MCP_DEBUG_AUTH_TTL_SECONDS` | `900` | 60–3600 | Lifetime of one Attach-bound debug authorization. |
| `SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS` | `86400` | 3600–604800 | Recovery-source retention after rollback failure. |
| `SAP_MCP_LOG_LEVEL` | `warn` | `error`, `warn`, `info`, `debug` | Minimum ordinary stderr log level. |
| `SAP_MCP_SESSION_RECOVERY` | `true` | `true`/`false` | Recover an expired stateful session and replay one read-only call. Mutations are never replayed. |
| `SAP_MCP_STATELESS_READS` | `false` | `true`/`false` | Route high-level and SM21 reads through a separate stateless client. Enable after DEV validation. |
| `SAP_MCP_CREDENTIAL_COMMAND` | unset | absolute path | External credential helper; receives `SAP_MCP_CREDENTIAL_TARGET` as one argv value and returns one password line. |
| `SAP_MCP_CREDENTIAL_TARGET` | unset | non-empty | Target name passed to the external credential helper. |
| `SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL` | `false` | `true`/`false` | Refuse the legacy `SAP_PASSWORD` fallback when enabled. |
| `SAP_MCP_SM21_TIMEZONE` | `UTC` | IANA time-zone name | Converts tool ISO timestamps to SAP timestamps. |
| `SAP_MCP_SM21_MAX_WINDOW_HOURS` | `24` | 1–24 | SM21 time-window hard limit. |
| `SAP_MCP_SM21_DEFAULT_PAGE_SIZE` | `100` | 1–500 | Default SM21 result rows. |
| `SAP_MCP_SM21_MAX_PAGE_SIZE` | `500` | 1–500 | SM21 result-row hard limit. |

Invalid values fail startup. Explicit query or search limits above the configured maximum are rejected before SAP is called; results are never silently truncated and SQL is never rewritten. `getObjectSource` pagination uses a bounded in-process session cache after the first full SAP read, not SAP server-side pagination. A write timeout means the remote result is unknown: inspect the object or change-plan state before deciding whether to retry, and never blindly replay a mutation.

The stateful ADT session is independent from SAP GUI. When a read-only call receives a confirmed session-expiry response, the server clears local cookies/CSRF state, performs one mutually-exclusive login, and replays that read once. A write, lock, debug, quality, transport, or activation call returns an unknown-remote-result error instead of replaying. Production deployments should use the external credential helper and remove `SAP_PASSWORD`; the compatibility fallback emits one redacted warning.

In every profile that exposes it, `healthcheck` proves only that the local MCP process is responsive and reports its configured non-secret host, client, profile, and role. It does not contact SAP and returns `sapConnectionVerified: false`. Use `inspectSapSystem` to report configured identity separately from independently probed ADT capabilities and preserve partial success; do not infer a product release or authorization from configuration alone. The seven-tool `safe` profile does not expose either general diagnostic tool.

Audit JSONL writes remain awaited and serialized. The server does not rotate or delete audit logs; the deployment environment must provide retention, archival, disk-capacity alerts, and access control.

## Safe ABAP change profile

`SAP_MCP_TOOL_PROFILE=safe` is the default and exposes only these tools:

- `inspectAbapObject`: returns the complete source and metadata for one exact, allow-listed `PROGRAM`, `INCLUDE`, `CLASS`, or `FUNCTION_MODULE`; optional `startLine`/`maxLines` pages preserve source bytes and carry the complete-source hash.
- `previewAbapChange`: validates the target, existing transport, proposed complete source, and syntax; then returns a complete diff and short-lived plan.
- `applyAbapChange`: applies only the previously previewed plan after explicit user confirmation, with drift detection, activation, verification, rollback, and unlock handling.
- `getAbapChangeStatus`: returns local plan status without complete source, credentials, cookies, or lock handles.
- `previewAbapObjectCreation`: validates and freezes a non-mutating creation plan for `PROGRAM`, `FUNCTION_GROUP`, or `FUNCTION_MODULE`.
- `applyAbapObjectCreation`: creates only a confirmed plan, verifies source and activation, and attempts bounded reverse compensation after failure.
- `getAbapObjectCreationStatus`: returns local creation and compensation status without complete source or confirmation secrets.

Set `SAP_MCP_TOOL_PROFILE=legacy-full` only for explicit compatibility needs. It additionally exposes all original low-level tools, including raw mutation and deletion operations that do not pass through the safe workflow.

### Required workflow

1. Call `inspectAbapObject` for the exact object and use the returned complete source as the edit baseline. For large source, page with a stable `sourceHash`, contiguous ranges, accumulated `totalLines`, and final `hasMore=false` before editing.
2. Call `previewAbapChange` with the complete replacement source and an existing unreleased transport request.
3. Show the complete Markdown diff returned in the tool content. Preview performs no lock, write, or activation.
4. Call `applyAbapChange` directly with the returned `changePlanId`; do not ask for a separate chat confirmation. The server, not the model, obtains the single confirmation through the MCP client.
5. Call `getAbapChangeStatus` when stage, error, unlock, or rollback details are needed.

Change plans are in-memory, short-lived, and single-use. They are lost when the MCP process restarts. The default lifetime is 900 seconds; accepted values are 60–3600 seconds. An expired, missing, already consumed, or source-drifted plan cannot write SAP and requires a new preview.

### Confirmation behavior

- Clients declaring MCP form elicitation receive one compact dialog with `应用变更` and `取消` choices after the diff is displayed. No prior chat confirmation is required. Only an accepted form with `应用变更` can start mutation; selecting `取消`, skipping, closing the dialog, or omitting the decision does not consume the plan.
- The form waits for at most 15 minutes and never beyond the plan's remaining lifetime. Timeout is treated as cancellation, leaves the plan `PREVIEWED`, and allows the user to reopen confirmation while the plan remains valid.
- Clients without form elicitation can apply only when `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true`. The first apply call returns a plan-bound one-time phrase; the exact phrase must be submitted in a second call before the plan expires.
- Form-capable clients always use the stronger native dialog and ignore a supplied text phrase. If neither mechanism is available, apply fails closed with `CONFIRMATION_UNSUPPORTED`.

### Plan and recovery states

| State | Meaning |
| --- | --- |
| `PREVIEWED` | Valid plan waiting for confirmation. No SAP mutation has started. |
| `APPLYING` | Confirmation succeeded and the guarded apply workflow has started. |
| `APPLIED` | Activation and final target-source hash verification succeeded. |
| `FAILED` | Apply stopped before a source write, so no rollback was necessary. |
| `ROLLED_BACK` | A post-write failure occurred and the original source was restored, reactivated, and hash-verified. |
| `ROLLBACK_FAILED` | Automatic restoration did not complete; inspect the object, lock, inactive version, and transport manually. |
| `EXPIRED` | The plan lifetime ended before apply began. Create a new preview. |

### Verification status

As of 2026-08-20, the current automated baseline covers the embedded ADT client, all registered tools, profile/role policy, and guarded workflows:

- Automated verification: 109 Jest suites and 771 tests cover the embedded ADTClient surface, high-level read tools, controlled quality and repository-creation workflows, dual-mode validation cleanup, maturity evidence gates, safe mismatch diagnostics, confirmation, profile/role dispatch, bounded state, logging, and audit serialization.
- Real SAP DEV verification: successful inspect, preview, lock, write, syntax check, unlock, activation, reread, and audit flows for `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE` test objects.
- Real protection verification: preview syntax rejection, user-held lock rejection, source drift rejection before lock, plan invalidation after MCP restart, natural plan expiry, single-use enforcement, native confirmation apply/cancel behavior, and confirmation timeout behavior.
- Real rollback verification: a controlled one-time activation failure after the source write triggered a new recovery lock, original-source restoration, unlock, real reactivation, original-hash verification, and `ROLLED_BACK`; no residual lock or matching inactive object remained.
- Real SAP DEV guardrail verification: query/search limits, search defaults, response replacement with `413`, paged-source cache hits, LRU eviction, 60-second TTL expiry, and same-process FIFO/queue-full `429` behavior passed the isolated read-only smoke test. SAP ADT table preview consistently returned one lookahead row beyond `rowNumber` on this system.
- Real normalization verification: `ZCODEX_MCP_TEST` completed as `APPLIED` with `LINE_ENDING_NORMALIZED`, successful activation/unlock, and a matching reread hash.
- HTTP timeout verification: a local stalled HTTP endpoint confirmed that the underlying ADT client cancels at approximately five seconds when configured for `5000 ms`, without intentionally running a slow SAP query.
- Runtime-catalog verification: the dynamic validator launched the real built server for 35 profile/role sessions and 14 direct-dispatch rejection cases, checked schemas, annotations, operation classes, approval metadata, role filtering, and catalog sizes, and made no SAP network calls.
- Real SAP read-only verification: `inspectSapSystem`, bounded `readRuntimeDumps`, `describeClassicTable` for `T000`, and `getAbapMemberSource` for a standard function module passed on the configured DEV/QAS/PRD systems without retaining business rows, dump text, or source.
- Pending dedicated verification: cleanup and maturity promotion for the real `DDIC_DOMAIN` validation object; real SAP creation of the remaining repository kinds; real ATC or ABAP Unit execution; controlled DDIC-property/package/RAP mutations; all safe debug control actions against a real SAP DEV debuggee; shared-session behavior above one concurrent tool; other SAP releases and authorization models; and production deployment behavior. Fake-client tests do not establish real quality execution or write success.

This does not claim exhaustive testing of every SAP release, authorization model, network failure, or cascading recovery failure. `ROLLBACK_FAILED` and `UNLOCK_FAILED` deliberately require manual ADT/SAP inspection rather than unsafe repeated mutation.

## Prerequisites

- **An SAP ABAP System** reachable via ADT (ABAP Development Tools). You'll need the system URL, a username and password, and the client number. Ensure the `/sap/bc/adt` service is active in transaction `SICF` (your basis administrator can help).
- **Node.js and npm** — download the LTS version from [nodejs.org](https://nodejs.org/). Verify with `node -v` and `npm -v`.

## Install from npm (recommended)

Keep credentials in a private environment file and point `SAP_MCP_ENV_FILE` at its absolute path. A single server process has one fixed tool profile, so multi-profile or multi-system setups must start one process per alias.

```cmd
npx -y @kylinyz/mcp-abap-abap-adt-api@0.5.0
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "command": "npx",
      "args": ["-y", "@kylinyz/mcp-abap-abap-adt-api@0.5.0"],
      "env": {
        "SAP_MCP_ENV_FILE": "C:\\path\\to\\sap-dev.env"
      }
    }
  }
}
```

Restart the MCP client after changing the environment file or MCP configuration.

## Install from source (local development)

Use a source checkout when developing, validating a local change, or testing an unreleased build.

1. **Obtain the Current Source Checkout**

   Use this fork's checkout or an archive that contains the intended revision. Do not assume a fresh clone of the upstream repository contains this fork's changes.

   ```cmd
   cd PATH_TO_CURRENT_SOURCE\mcp-abap-abap-adt-api
   ```

2. **Install Dependencies**

   ```cmd
   npm install
   ```

3. **Configure Environment Variables**

   An `.env.example` file is provided in the root directory as a template for the required environment variables. A single-instance deployment may keep the adjacent `.env`; multi-instance deployments must set a distinct absolute `SAP_MCP_ENV_FILE` in each server process. To set up your environment:

   a. Copy the `.env.example` file and rename it to `.env`:
      ```bash
      cp .env.example .env
      ```

   b. Open the `.env` file and replace the placeholder values with your actual SAP connection details:

      ```env
      SAP_URL=https://your-sap-server.com:44300
      SAP_USER=YOUR_SAP_USERNAME
      SAP_PASSWORD=YOUR_SAP_PASSWORD
      SAP_CLIENT=YOUR_SAP_CLIENT
      SAP_LANGUAGE=YOUR_SAP_LANGUAGE
      SAP_MCP_TOOL_PROFILE=safe
      SAP_MCP_SYSTEM_ROLE=DEV
      SAP_MCP_ALLOWED_HOSTS=your-sap-server.com
      SAP_MCP_ALLOWED_CLIENTS=100
      SAP_MCP_ALLOWED_NAMESPACES=Z,Y
      SAP_MCP_CHANGE_PLAN_TTL_SECONDS=900
      SAP_MCP_ALLOWED_DEBUG_USERS=
      SAP_MCP_DEBUG_AUTH_TTL_SECONDS=900
      SAP_MCP_AUDIT_PATH=C:\sap-mcp-audit
      SAP_MCP_ALLOW_TEXT_CONFIRMATION=false
      SAP_MCP_CONFIRMATION_PROVIDER=auto
      SAP_MCP_ADT_TIMEOUT_MS=60000
      SAP_MCP_MAX_CONCURRENT_TOOLS=1
      SAP_MCP_MAX_QUEUED_TOOLS=50
      SAP_MCP_QUERY_DEFAULT_ROWS=200
      SAP_MCP_QUERY_MAX_ROWS=5000
      SAP_MCP_SEARCH_DEFAULT_RESULTS=50
      SAP_MCP_SEARCH_MAX_RESULTS=500
      SAP_MCP_MAX_RESPONSE_BYTES=10485760
      SAP_MCP_SOURCE_CACHE_MAX_ENTRIES=20
      SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES=2097152
      SAP_MCP_SOURCE_CACHE_TTL_SECONDS=900
      SAP_MCP_CHANGE_PLAN_MAX_ENTRIES=100
      SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS=86400
      SAP_MCP_LOG_LEVEL=warn
      SAP_MCP_SM21_TIMEZONE=UTC
      SAP_MCP_SM21_MAX_WINDOW_HOURS=24
      SAP_MCP_SM21_DEFAULT_PAGE_SIZE=100
      SAP_MCP_SM21_MAX_PAGE_SIZE=500
      ```

   `SAP_CLIENT` and `SAP_LANGUAGE` are optional for some legacy read operations. Safe source mutation requires `SAP_MCP_SYSTEM_ROLE=DEV`, non-empty host/client/namespace allowlists matching the target, and a writable `SAP_MCP_AUDIT_PATH`. The profile and plan TTL have safe defaults, but explicit values are recommended for auditable deployments.

   Native MCP `elicitation.form` confirmation is always preferred. The native dialog waits for at most fifteen minutes and never beyond the remaining change-plan lifetime. A timeout is treated as cancellation: the plan stays previewed and the user can call apply again to reopen confirmation. Keep `SAP_MCP_ALLOW_TEXT_CONFIRMATION=false` unless the client lacks form elicitation and you explicitly accept the weaker chat-based challenge. When enabled, the first apply call returns a one-time phrase bound to the plan; the client must submit that exact phrase as `textConfirmation` in a second call.

   If you're using self-signed certificates, you can also set:

   ```env
   NODE_TLS_REJECT_UNAUTHORIZED="0"
   ```

   IMPORTANT: Never commit your `.env` file to version control. It's already included in `.gitignore` to prevent accidental commits.

4. **Build the Project**

   ```cmd
   npm run build
   ```

5. **Run the Server**

   ```cmd
   npm run start
   ```

   Point the MCP client at `node` and the absolute path to the build output:

   ```json
   {
     "mcpServers": {
       "mcp-abap-abap-adt-api": {
         "command": "node",
         "args": ["PATH_TO_YOUR/mcp-abap-abap-adt-api/dist/index.js"],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

Restart the MCP client after changing `.env`, rebuilding `dist`, or changing its MCP configuration. See [docs/使用指南.md](docs/使用指南.md) for the authoritative environment-variable reference, the exhaustive tool catalog, Codex/Claude examples, verification steps, safe workflows, confirmation behavior, and troubleshooting.

## Custom Instruction
Use this Custom Instruction to explain the tool to your model:
```
## mcp-abap-abap-adt-api Server

The default `safe` profile supports controlled source changes for `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE` objects.

**Required workflow:**

1. Use `inspectAbapObject` to read the complete current source and metadata of the exact allow-listed object.
2. Call `previewAbapChange` with the exact object, complete proposed source, and an existing unreleased transport request.
3. Show the complete Markdown diff returned in the tool content.
4. Call `applyAbapChange` directly with only the returned `changePlanId`; do not request a separate chat confirmation. If the client supports MCP form elicitation, present the server's single native confirmation form and submit the user's decision.
5. If form elicitation is unavailable and `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true`, show the returned one-time confirmation phrase to the user, then call `applyAbapChange` again with the same `changePlanId` and the exact phrase as `textConfirmation`.
6. Use `getAbapChangeStatus` to inspect plan stages and recovery results without exposing complete source.

Never pass or trust a model-supplied `confirmedByUser` flag. Do not claim success unless the apply result reports successful syntax checking, activation, source-hash verification, and unlock handling. If the source changed after preview, create a new preview. If rollback or unlock fails, tell the user to inspect the inactive object, lock, and transport in ADT/SAP.

The `legacy-full` profile also exposes the original low-level ADT tools. Treat those tools as compatibility-only because raw mutation and deletion operations bypass the safe workflow.

For DDIC, package, or RAP mutations, use the controlled `development` preview/apply pair. Show the preview, pass only its `operationPlanId` to apply, and let the server open one native confirmation. Never fall back to a raw `legacy-full` setter, execute, generate, or publish tool. QAS/PRD are read-only regardless of profile. After `UNKNOWN_OUTCOME`, stop mutation and inspect current SAP state before deciding on a new plan.
```

## Efficient Database Access (`development`, `diagnostic-readonly`, and `legacy-full`)

The database/query tools described below are exposed by the diagnostic profiles and by compatibility `legacy-full`; they are not available in the default seven-tool `safe` profile. `runQuery` accepts one read-only `SELECT` or `WITH` statement. DML, DDL, dynamic execution, and multi-statement input are rejected before SAP is called.

SAP systems contain vast amounts of data.  It's crucial to write ABAP code that accesses the database efficiently to minimize performance impact and network traffic.  Avoid selecting entire tables or using broad `WHERE` clauses when you only need specific data.

*   **Use `WHERE` clauses:** Always use `WHERE` clauses in your `SELECT` statements to filter the data retrieved from the database.  Select only the specific rows you need.
*   **`UP TO 1 ROWS`:** If you only need a single record, use the `SELECT SINGLE` statement, if you can guarantee that you can provide ALL the key fields for the `SELECT SINGLE` statement. Otherwise, use the `SELECT` statement with the `UP TO 1 ROWS` addition. This tells the database to stop searching after finding the first matching record, improving performance. Example:

    ```abap
    SELECT vgbel FROM vbrp WHERE vbeln = @me->lv_vbeln INTO @DATA(lv_vgbel) UP TO 1 ROWS.
      EXIT. " Exit any loop after this.
    ENDSELECT.
    ```
## Checking Table and Structure Definitions (diagnostic profiles)

When working with ABAP objects, you may encounter errors related to unknown field names or incorrect table usage. Use the following tools to inspect DDIC (Data Dictionary) objects:

*   **`objectStructure`:** Retrieves the structure/metadata of an ABAP object (including DDIC tables and structures) from its object URI. Use `searchObject` first to resolve the object name to a URI.
*   **`ddicElement`:** Retrieves details of a DDIC element (e.g. a data element or domain).
*   **`ddicRepositoryAccess`:** Reads DDIC repository information for a given path.
*   **`tableContents`:** Retrieves the *contents* (rows) of a table, not its definition. Use `runQuery` for ad-hoc `SELECT`s.

> **Note:** Earlier versions of this README listed `GetTable`, `GetStructure`, and `GetTypeInfo`. Those tools are **not** part of this server — they belong to the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) project. This server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API tools listed above instead.

## Troubleshooting

*   **Package resolution errors:** use the scoped, pinned command `npx -y @kylinyz/mcp-abap-abap-adt-api@0.5.0`. The unscoped package is a separate upstream release. If npm access is unavailable, build this fork from source and configure the client with `node` plus the absolute path to `dist/index.js`.
*   **SAP connection errors:** verify your credentials (`SAP_URL`, `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`), confirm the system is reachable, that your user has ADT authorizations, and that `/sap/bc/adt` is active in `SICF`.
*   **TLS / self-signed certificate errors:** for development only, set `NODE_TLS_REJECT_UNAUTHORIZED=0` (env var or in the client `env` block).
*   **`CONFIRMATION_UNSUPPORTED`:** use a client that supports MCP form elicitation, or explicitly enable the weaker text fallback.
*   **`PLAN_NOT_FOUND`:** plans are held in memory and disappear when the MCP process restarts; create a new preview.
*   **`PLAN_EXPIRED` / `PLAN_ALREADY_CONSUMED`:** create a new preview. A plan cannot be extended or applied twice.
*   **`SOURCE_DRIFT`:** reread the current SAP source and preview again; the server intentionally refuses to overwrite edits made after preview.
*   **`ROLLBACK_FAILED` / `UNLOCK_FAILED`:** stop automated retries and inspect the inactive object, lock owner, source version, and transport manually in ADT/SAP.

## Contributing

Contributions are welcome! Please follow these steps to contribute:

1. **Fork the Repository**
2. **Create a New Branch**

   ```cmd
   git checkout -b feature/your-feature-name
   ```

3. **Commit Your Changes**

   ```cmd
   git commit -m "Add some feature"
   ```

4. **Push to the Branch**

   ```cmd
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request**

## License

This project is licensed under the [MIT License](LICENSE).
