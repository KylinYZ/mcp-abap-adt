# Embedded `abap-adt-api` baseline

The production sources under `src/adt/` are derived from
[`marcellourbani/abap-adt-api`](https://github.com/marcellourbani/abap-adt-api),
which is distributed under the MIT License. The upstream license text is kept
in this directory as `LICENSE`.

## Imported revision

- Released version: `8.4.2`
- Version commit: `43f6dc7994dc402c3914a302a1c0c471dc45ec2c`
- Imported commit: `3cd8c17b18ed414aaa294755819e75ff83d15f8c`
- Source directory: upstream `src/`
- Local directory: `src/adt/`
- Stable local entry point: `src/adt/index.ts`

Commit `3cd8c17` adds cancellable debugger listeners. It passes an optional
`AbortSignal` and timeout from `ADTClient.debuggerListen` through the ADT HTTP
layer to Axios, and maps cancellation to the stable
`ADT_REQUEST_CANCELLED` code. Its deterministic Axios and debugger tests are
ported into the MCP repository separately from the production source tree.

## Local differences

The import keeps the upstream production file and module layout. Local changes
are limited to module-resolution and test compatibility needed by this MCP
repository. Upstream `*.test.ts` files and SAP-connected integration tests are
not copied into `src/adt/`.

The MCP server imports the embedded client only through `src/adt/index.ts`.
Handlers and workflows must not depend on individual embedded implementation
modules.

## Updating the baseline

1. Compare the next upstream revision with the imported commit above.
2. Review every changed production file and retain required local differences.
3. Update the reviewed public-surface fixture deliberately.
4. Run `npm run check:adt-imports`, the ADT client tests, the complete MCP test
   suite, and `npm run build`.
5. Record the new version and exact commit hashes in this file.
