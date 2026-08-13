[English](README.md) | [简体中文](README.zh-CN.md)

DISCLAIMER: This server is still experimental. The default `safe` profile adds a guarded source-change workflow, but SAP authorization design, transport governance, backups, and operator review remain your responsibility.

# ABAP-ADT-API MCP-Server

## Description

The MCP-Server `mcp-abap-abap-adt-api` is a Model Context Protocol (MCP) server designed to facilitate seamless communication between ABAP systems and MCP clients. It is a wrapper for [abap-adt-api](https://github.com/marcellourbani/abap-adt-api/) and provides a suite of tools and resources for managing ABAP objects, handling transport requests, performing code analysis, and more, enhancing the efficiency and effectiveness of ABAP development workflows.

> **Distribution status (2026-08-12):** this modified version has **not** been published to npm or the MCP Registry. Install dependencies and build it from this source checkout, then configure your MCP client to run the absolute path to `dist/index.js`. The npm and registry fields in `package.json` and `server.json` are release metadata for a possible future publication, not proof of a live package.

For a complete Windows setup and operating walkthrough, see the [Chinese Usage Guide](docs/使用指南.md).

> **Related project:** For higher-level, read-oriented ABAP tools (`GetProgram`, `GetClass`, `GetTable`, …) see the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) server. **This** server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API (lock/unlock, edit source, transports, activation, syntax checks, DDIC access, …) for full read/write development workflows.

## Features

### Default `safe` profile

- **Four supported source objects**: `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE`.
- **Review before mutation**: Reads the exact current source, validates the complete proposed source, performs a syntax check, and returns a complete diff before any SAP lock or write.
- **Cross-client confirmation**: Uses native MCP `elicitation.form` when supported, with an explicitly enabled one-time text challenge fallback for incompatible clients.
- **Policy boundaries**: Requires a DEV role, allow-listed host/client/namespace, a transportable package, and an existing unreleased transport reported by SAP for the object.
- **Apply-time protection**: Revalidates the transport and source hash, obtains a stateful MODIFY lock, writes only the confirmed plan, checks syntax again, unlocks, activates, and rereads the source hash.
- **Failure recovery**: Restores the original source after a post-write failure, reacquiring a recovery lock when necessary, then unlocks, reactivates, and verifies the original hash.
- **Sanitized audit trail**: Writes JSONL stage events without passwords, authorization headers, cookies, lock handles, complete source, diffs, confirmation phrases, or verification codes.

### Compatibility `legacy-full` profile

Set `SAP_MCP_TOOL_PROFILE=legacy-full` only when the original low-level ADT surface is explicitly required. It adds authentication, object CRUD, transport, activation, DDIC, code-analysis, debugging, tracing, and other legacy tools. Those raw mutation and deletion tools bypass the safe source-change workflow.

### Performance and resource guardrails

Central argument and response limits protect every tool in both `safe` and `legacy-full`. The FIFO execution gate protects operations that use the shared stateful ADT client; native confirmation waiting, local `getAbapChangeStatus`, and `healthcheck` do not occupy a SAP slot. After confirmation succeeds, the complete apply, verification, and rollback workflow runs atomically inside that same gate. The default concurrency is `1` because ADT operations share cookies, CSRF token, session type, and lock lifecycle. Increase it only after controlled SAP DEV validation.

| Environment variable | Default | Accepted range | Purpose |
| --- | ---: | --- | --- |
| `SAP_MCP_ADT_TIMEOUT_MS` | `60000` | 5000–600000 | Real HTTP timeout passed to the ADT client. |
| `SAP_MCP_MAX_CONCURRENT_TOOLS` | `1` | 1–8 | Maximum active tool calls; production recommendation is `1`. |
| `SAP_MCP_MAX_QUEUED_TOOLS` | `50` | 0–1000 | FIFO waiting capacity before a busy error. |
| `SAP_MCP_QUERY_DEFAULT_ROWS` | `200` | 1–query maximum | Default for `tableContents` and `runQuery`. |
| `SAP_MCP_QUERY_MAX_ROWS` | `5000` | 1–100000 | Hard query row limit. |
| `SAP_MCP_SEARCH_DEFAULT_RESULTS` | `50` | 1–search maximum | Default for `searchObject`. |
| `SAP_MCP_SEARCH_MAX_RESULTS` | `500` | 1–10000 | Hard search result limit. |
| `SAP_MCP_MAX_RESPONSE_BYTES` | `10485760` | 1–100 MiB | Total UTF-8 text bytes allowed in one tool response. |
| `SAP_MCP_SOURCE_CACHE_MAX_ENTRIES` | `20` | 0–1000 | Session source-cache entries; `0` disables caching. |
| `SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES` | `2097152` | 64 KiB–20 MiB | Largest source retained in cache. |
| `SAP_MCP_SOURCE_CACHE_TTL_SECONDS` | `900` | 60–3600 | Source-cache lifetime. |
| `SAP_MCP_CHANGE_PLAN_MAX_ENTRIES` | `100` | 1–1000 | Maximum in-memory change-plan records. |
| `SAP_MCP_ROLLBACK_FAILED_RETENTION_SECONDS` | `86400` | 3600–604800 | Recovery-source retention after rollback failure. |
| `SAP_MCP_LOG_LEVEL` | `warn` | `error`, `warn`, `info`, `debug` | Minimum ordinary stderr log level. |

Invalid values fail startup. Explicit query or search limits above the configured maximum are rejected before SAP is called; results are never silently truncated and SQL is never rewritten. `getObjectSource` pagination uses a bounded in-process session cache after the first full SAP read, not SAP server-side pagination. A write timeout means the remote result is unknown: inspect the object or change-plan state before deciding whether to retry, and never blindly replay a mutation.

Audit JSONL writes remain awaited and serialized. The server does not rotate or delete audit logs; the deployment environment must provide retention, archival, disk-capacity alerts, and access control.

## Safe ABAP change profile

`SAP_MCP_TOOL_PROFILE=safe` is the default and exposes only these tools:

- `inspectAbapObject`: returns the complete source and metadata for one exact, allow-listed `PROGRAM`, `INCLUDE`, `CLASS`, or `FUNCTION_MODULE`.
- `previewAbapChange`: validates the target, existing transport, proposed complete source, and syntax; then returns a complete diff and short-lived plan.
- `applyAbapChange`: applies only the previously previewed plan after explicit user confirmation, with drift detection, activation, verification, rollback, and unlock handling.
- `getAbapChangeStatus`: returns local plan status without complete source, credentials, cookies, or lock handles.

Set `SAP_MCP_TOOL_PROFILE=legacy-full` only for explicit compatibility needs. It additionally exposes all original low-level tools, including raw mutation and deletion operations that do not pass through the safe workflow.

### Required workflow

1. Call `inspectAbapObject` for the exact object and use the returned complete source as the edit baseline.
2. Call `previewAbapChange` with the complete replacement source and an existing unreleased transport request.
3. Show the complete returned diff to the user. Preview performs no lock, write, or activation.
4. Call `applyAbapChange` with the returned `changePlanId`. The server, not the model, obtains the user's confirmation.
5. Call `getAbapChangeStatus` when stage, error, unlock, or rollback details are needed.

Change plans are in-memory, short-lived, and single-use. They are lost when the MCP process restarts. The default lifetime is 900 seconds; accepted values are 60–3600 seconds. An expired, missing, already consumed, or source-drifted plan cannot write SAP and requires a new preview.

### Confirmation behavior

- Clients declaring MCP form elicitation receive a compact dialog with `应用变更` and `取消` choices. Only an accepted form with `应用变更` can start mutation; selecting `取消`, skipping, closing the dialog, or omitting the decision does not consume the plan.
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

As of 2026-08-13, the first-phase safe workflow and the main read-only runtime guardrails are functionally complete for their stated scope:

- Automated verification: 18 Jest suites and 131 tests cover the safe workflow plus runtime configuration, FIFO execution gating, request/response limits, bounded source caching, plan retention, source normalization, logging, and serialized audit writes. TypeScript build and `git diff --check` pass.
- Real SAP DEV verification: successful inspect, preview, lock, write, syntax check, unlock, activation, reread, and audit flows for `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE` test objects.
- Real protection verification: preview syntax rejection, user-held lock rejection, source drift rejection before lock, plan invalidation after MCP restart, natural plan expiry, single-use enforcement, native confirmation apply/cancel behavior, and confirmation timeout behavior.
- Real rollback verification: a controlled one-time activation failure after the source write triggered a new recovery lock, original-source restoration, unlock, real reactivation, original-hash verification, and `ROLLED_BACK`; no residual lock or matching inactive object remained.
- Real SAP DEV guardrail verification: query/search limits, search defaults, response replacement with `413`, paged-source cache hits, LRU eviction, 60-second TTL expiry, and same-process FIFO/queue-full `429` behavior passed the isolated read-only smoke test. SAP ADT table preview consistently returned one lookahead row beyond `rowNumber` on this system.
- Real normalization verification: `ZCODEX_MCP_TEST` completed as `APPLIED` with `LINE_ENDING_NORMALIZED`, successful activation/unlock, and a matching reread hash.
- HTTP timeout verification: a local stalled HTTP endpoint confirmed that the underlying ADT client cancels at approximately five seconds when configured for `5000 ms`, without intentionally running a slow SAP query.
- Pending dedicated verification: debugger/ATC/trace long-task timeouts, shared-session behavior above one concurrent tool, other SAP releases and authorization models, and production deployment behavior.

This does not claim exhaustive testing of every SAP release, authorization model, network failure, or cascading recovery failure. `ROLLBACK_FAILED` and `UNLOCK_FAILED` deliberately require manual ADT/SAP inspection rather than unsafe repeated mutation.

## Prerequisites

- **An SAP ABAP System** reachable via ADT (ABAP Development Tools). You'll need the system URL, a username and password, and the client number. Ensure the `/sap/bc/adt` service is active in transaction `SICF` (your basis administrator can help).
- **Node.js and npm** — download the LTS version from [nodejs.org](https://nodejs.org/). Verify with `node -v` and `npm -v`.

## Install from source

This is currently the only supported installation path for the modified version.

1. **Obtain the Current Source Checkout**

   Use a local checkout or archive that actually contains the current modified files. The changes described here are not yet available from npm, the MCP Registry, or a published release. Do not assume a fresh clone of the upstream repository includes this local work.

   ```cmd
   cd PATH_TO_CURRENT_SOURCE\mcp-abap-abap-adt-api
   ```

2. **Install Dependencies**

   ```cmd
   npm install
   ```

3. **Configure Environment Variables**

   An `.env.example` file is provided in the root directory as a template for the required environment variables. To set up your environment:

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
      SAP_MCP_AUDIT_PATH=C:\sap-mcp-audit
      SAP_MCP_ALLOW_TEXT_CONFIRMATION=false
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

Restart the MCP client after changing `.env`, rebuilding `dist`, or changing its MCP configuration. See [docs/使用指南.md](docs/使用指南.md) for Codex/Claude examples, verification steps, the four-tool workflow, confirmation behavior, and troubleshooting.

## Custom Instruction
Use this Custom Instruction to explain the tool to your model:
```
## mcp-abap-abap-adt-api Server

The default `safe` profile supports controlled source changes for `PROGRAM`, `INCLUDE`, `CLASS`, and `FUNCTION_MODULE` objects.

**Required workflow:**

1. Use `inspectAbapObject` to read the complete current source and metadata of the exact allow-listed object.
2. Call `previewAbapChange` with the exact object, complete proposed source, and an existing unreleased transport request.
3. Show the complete returned diff to the user. Do not call the apply tool until the user explicitly confirms that plan.
4. Call `applyAbapChange` with only the returned `changePlanId`. If the client supports MCP form elicitation, present the server's native confirmation form and submit the user's decision.
5. If form elicitation is unavailable and `SAP_MCP_ALLOW_TEXT_CONFIRMATION=true`, show the returned one-time confirmation phrase to the user, then call `applyAbapChange` again with the same `changePlanId` and the exact phrase as `textConfirmation`.
6. Use `getAbapChangeStatus` to inspect plan stages and recovery results without exposing complete source.

Never pass or trust a model-supplied `confirmedByUser` flag. Do not claim success unless the apply result reports successful syntax checking, activation, source-hash verification, and unlock handling. If the source changed after preview, create a new preview. If rollback or unlock fails, tell the user to inspect the inactive object, lock, and transport in ADT/SAP.

The `legacy-full` profile also exposes the original low-level ADT tools. Treat those tools as compatibility-only because raw mutation and deletion operations bypass the safe workflow.
```

## Efficient Database Access (`legacy-full`)

The database/query tools described below are exposed only by the compatibility `legacy-full` profile. They are not available in the default four-tool `safe` profile.

SAP systems contain vast amounts of data.  It's crucial to write ABAP code that accesses the database efficiently to minimize performance impact and network traffic.  Avoid selecting entire tables or using broad `WHERE` clauses when you only need specific data.

*   **Use `WHERE` clauses:** Always use `WHERE` clauses in your `SELECT` statements to filter the data retrieved from the database.  Select only the specific rows you need.
*   **`UP TO 1 ROWS`:** If you only need a single record, use the `SELECT SINGLE` statement, if you can guarantee that you can provide ALL the key fields for the `SELECT SINGLE` statement. Otherwise, use the `SELECT` statement with the `UP TO 1 ROWS` addition. This tells the database to stop searching after finding the first matching record, improving performance. Example:

    ```abap
    SELECT vgbel FROM vbrp WHERE vbeln = @me->lv_vbeln INTO @DATA(lv_vgbel) UP TO 1 ROWS.
      EXIT. " Exit any loop after this.
    ENDSELECT.
    ```
## Checking Table and Structure Definitions (`legacy-full`)

When working with ABAP objects, you may encounter errors related to unknown field names or incorrect table usage. Use the following tools to inspect DDIC (Data Dictionary) objects:

*   **`objectStructure`:** Retrieves the structure/metadata of an ABAP object (including DDIC tables and structures) from its object URI. Use `searchObject` first to resolve the object name to a URI.
*   **`ddicElement`:** Retrieves details of a DDIC element (e.g. a data element or domain).
*   **`ddicRepositoryAccess`:** Reads DDIC repository information for a given path.
*   **`tableContents`:** Retrieves the *contents* (rows) of a table, not its definition. Use `runQuery` for ad-hoc `SELECT`s.

> **Note:** Earlier versions of this README listed `GetTable`, `GetStructure`, and `GetTypeInfo`. Those tools are **not** part of this server — they belong to the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) project. This server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API tools listed above instead.

## Troubleshooting

*   **Package not found through `npx` or a marketplace:** the modified version is not published. Build from source and configure the client with `node` plus the absolute path to `dist/index.js`.
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
