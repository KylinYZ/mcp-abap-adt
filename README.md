DISCLAIMER: This server is still in experimental status! Use it with caution!

# ABAP-ADT-API MCP-Server

## Description

The MCP-Server `mcp-abap-abap-adt-api` is a Model Context Protocol (MCP) server designed to facilitate seamless communication between ABAP systems and MCP clients. It is a wrapper for [abap-adt-api](https://github.com/marcellourbani/abap-adt-api/) and provides a suite of tools and resources for managing ABAP objects, handling transport requests, performing code analysis, and more, enhancing the efficiency and effectiveness of ABAP development workflows.

The server is published on npm as [`mcp-abap-abap-adt-api`](https://www.npmjs.com/package/mcp-abap-abap-adt-api) and listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.mario-andreschak/mcp-abap-abap-adt-api`, so most MCP clients can install it with a single command (or a single click — see [FLUJO](#integrating-with-flujo-recommended) below).

> **Related project:** For higher-level, read-oriented ABAP tools (`GetProgram`, `GetClass`, `GetTable`, …) see the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) server. **This** server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API (lock/unlock, edit source, transports, activation, syntax checks, DDIC access, …) for full read/write development workflows.

## Features

- **Safe by default**: Exposes four high-level tools for inspected, previewed, explicitly confirmed ABAP source changes.
- **Cross-client confirmation**: Uses native MCP form elicitation when supported, with an explicitly enabled text challenge fallback for incompatible clients.
- **Guardrails**: Enforces DEV host/client/namespace allowlists, existing unreleased transports, and rejects `$TMP`.
- **Recovery and audit**: Detects source drift, checks syntax, activates, verifies, attempts rollback on failure, and writes sanitized JSONL audit events.
- **Authentication**: Securely authenticate with ABAP systems using the `login` tool.
- **Object Management**: Create, read, update, and delete ABAP objects seamlessly.
- **Transport Handling**: Manage transport requests with tools like `createTransport` and `transportInfo`.
- **Code Analysis**: Perform syntax checks and retrieve code completion suggestions.
- **Extensibility**: Easily extend the server with additional tools and resources as needed.
- **Session Management**: Handle session caching and termination using `dropSession` and `logout`.

## Safe ABAP change profile

`SAP_MCP_TOOL_PROFILE=safe` is the default and exposes only these tools:

- `inspectAbapObject`: returns the complete source and metadata for one exact, allow-listed `PROGRAM`, `INCLUDE`, `CLASS`, or `FUNCTION_MODULE`.
- `previewAbapChange`: validates the target, existing transport, proposed complete source, and syntax; then returns a complete diff and short-lived plan.
- `applyAbapChange`: applies only the previously previewed plan after explicit user confirmation, with drift detection, activation, verification, rollback, and unlock handling.
- `getAbapChangeStatus`: returns local plan status without complete source, credentials, cookies, or lock handles.

Set `SAP_MCP_TOOL_PROFILE=legacy-full` only for explicit compatibility needs. It additionally exposes all original low-level tools, including raw mutation and deletion operations that do not pass through the safe workflow.

## Prerequisites

- **An SAP ABAP System** reachable via ADT (ABAP Development Tools). You'll need the system URL, a username and password, and the client number. Ensure the `/sap/bc/adt` service is active in transaction `SICF` (your basis administrator can help).
- **Node.js and npm** — download the LTS version from [nodejs.org](https://nodejs.org/). Verify with `node -v` and `npm -v`.

## Installation

There are three ways to use this server, from easiest to most manual:

### Integrating with FLUJO (recommended)

[FLUJO](https://github.com/mario-andreschak/FLUJO) is the easiest way to use this server — no cloning, building, or hand-editing JSON config:

1. In FLUJO, navigate to **MCP**.
2. Click **Add Server**.
3. On the **Marketplace** tab, search for **`mcp-abap-abap-adt-api`** and select it.
4. FLUJO fetches the npm package automatically and opens the **Local Server** tab. Enter your SAP **URL**, **User**, **Password** (and optionally client/language), then click **Save**.

That's it — FLUJO downloads and runs the npm package for you and keeps your SAP credentials with the installed server.

#### Streamable HTTP transport (via FLUJO)

`mcp-abap-abap-adt-api` runs over **stdio**. If you need to reach it over **streamable HTTP** — for example from another app on your machine or a client that only speaks HTTP — let FLUJO re-host it: install the server in FLUJO as above, then toggle **"Expose to external apps"** on the server. FLUJO's built-in mcp-proxy then serves it over HTTP at `http://localhost:4200/mcp-proxy/mcp-abap-abap-adt-api`, and any HTTP-capable MCP client can connect with a config like:

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "type": "http",
      "url": "http://localhost:4200/mcp-proxy/mcp-abap-abap-adt-api"
    }
  }
}
```

FLUJO keeps your SAP credentials with the installed server, so the HTTP config itself carries none.

### Quick start with npx (any MCP client)

The server is published on npm, so you don't need to clone or build anything — most MCP clients can launch it directly via `npx`. Add it to your MCP client configuration (e.g. Cline, Claude Desktop, Claude Code):

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "command": "npx",
      "args": ["-y", "mcp-abap-abap-adt-api"],
      "env": {
        "SAP_URL": "https://your-sap-server.com:44300",
        "SAP_USER": "YOUR_SAP_USERNAME",
        "SAP_PASSWORD": "YOUR_SAP_PASSWORD",
        "SAP_CLIENT": "100",
        "SAP_LANGUAGE": "EN",
        "SAP_MCP_TOOL_PROFILE": "safe",
        "SAP_MCP_SYSTEM_ROLE": "DEV",
        "SAP_MCP_ALLOWED_HOSTS": "your-sap-server.com",
        "SAP_MCP_ALLOWED_CLIENTS": "100",
        "SAP_MCP_ALLOWED_NAMESPACES": "Z,Y",
        "SAP_MCP_CHANGE_PLAN_TTL_SECONDS": "900",
        "SAP_MCP_AUDIT_PATH": "C:\\sap-mcp-audit",
        "SAP_MCP_ALLOW_TEXT_CONFIRMATION": "false"
      }
    }
  }
}
```

If your SAP system uses a self-signed certificate, add `"NODE_TLS_REJECT_UNAUTHORIZED": "0"` to the `env` block (development only).

> **Windows tip:** if `npx` isn't found, set `"command": "npx.cmd"`, or use the full path to `node` with the absolute path to `dist/index.js` from a source install (see below).

### Build from source

1. **Clone the Repository**

   ```cmd
   git clone https://github.com/mario-andreschak/mcp-abap-abap-adt-api.git
   cd mcp-abap-abap-adt-api
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
      ```

   `SAP_CLIENT` and `SAP_LANGUAGE` are optional for legacy read operations. Source changes in the safe profile fail closed unless every `SAP_MCP_*` boundary is configured. The audit path must be writable by the MCP process.

   Native MCP `elicitation.form` confirmation is always preferred. Keep `SAP_MCP_ALLOW_TEXT_CONFIRMATION=false` unless the client lacks form elicitation and you explicitly accept the weaker chat-based challenge. When enabled, the first apply call returns a one-time phrase bound to the plan; the client must submit that exact phrase as `textConfirmation` in a second call.

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

   When integrating a source build into an MCP client, point `command` at `node` with an absolute path to the build output:

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

## Efficient Database Access

SAP systems contain vast amounts of data.  It's crucial to write ABAP code that accesses the database efficiently to minimize performance impact and network traffic.  Avoid selecting entire tables or using broad `WHERE` clauses when you only need specific data.

*   **Use `WHERE` clauses:** Always use `WHERE` clauses in your `SELECT` statements to filter the data retrieved from the database.  Select only the specific rows you need.
*   **`UP TO 1 ROWS`:** If you only need a single record, use the `SELECT SINGLE` statement, if you can guarantee that you can provide ALL the key fields for the `SELECT SINGLE` statement. Otherwise, use the `SELECT` statement with the `UP TO 1 ROWS` addition. This tells the database to stop searching after finding the first matching record, improving performance. Example:

    ```abap
    SELECT vgbel FROM vbrp WHERE vbeln = @me->lv_vbeln INTO @DATA(lv_vgbel) UP TO 1 ROWS.
      EXIT. " Exit any loop after this.
    ENDSELECT.
    ```
## Checking Table and Structure Definitions

When working with ABAP objects, you may encounter errors related to unknown field names or incorrect table usage. Use the following tools to inspect DDIC (Data Dictionary) objects:

*   **`objectStructure`:** Retrieves the structure/metadata of an ABAP object (including DDIC tables and structures) from its object URI. Use `searchObject` first to resolve the object name to a URI.
*   **`ddicElement`:** Retrieves details of a DDIC element (e.g. a data element or domain).
*   **`ddicRepositoryAccess`:** Reads DDIC repository information for a given path.
*   **`tableContents`:** Retrieves the *contents* (rows) of a table, not its definition. Use `runQuery` for ad-hoc `SELECT`s.

> **Note:** Earlier versions of this README listed `GetTable`, `GetStructure`, and `GetTypeInfo`. Those tools are **not** part of this server — they belong to the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) project. This server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API tools listed above instead.

## Troubleshooting

*   **`npx` can't find the package / client won't start it:** ensure Node.js is installed and on your PATH (`node -v`, `npm -v`). On Windows try `"command": "npx.cmd"`, or use a source build with an absolute path to `node dist/index.js`.
*   **SAP connection errors:** verify your credentials (`SAP_URL`, `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`), confirm the system is reachable, that your user has ADT authorizations, and that `/sap/bc/adt` is active in `SICF`.
*   **TLS / self-signed certificate errors:** for development only, set `NODE_TLS_REJECT_UNAUTHORIZED=0` (env var or in the client `env` block).

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
