# SAP ABAP ADT Workbench hardening design

## Scope

Harden the source-built MCP baseline and the sibling `sap-abap-adt-workbench` plugin without connecting to SAP or changing the existing safe source/debug state machines.

## Environment isolation

- Add `SAP_MCP_ENV_FILE` as an explicit per-process dotenv path.
- Resolve a relative path from the process working directory and keep the existing adjacent `.env` only as the backward-compatible default.
- Require each documented DEV/QAS/PRD process to set a distinct absolute env-file path.
- Expose only non-secret configured identity in the local health response: target host, client, tool profile, and system role.

## Connectivity semantics

- Keep `healthcheck` local and label it as MCP process/configuration identity, not SAP connectivity.
- Use the existing read-only `adtCoreDiscovery` tool for the smallest SAP/ADT connectivity check.
- Require callers to compare returned/configured identity with the requested instance before SAP work.

## Skill contracts

- Remove unsupported Skill frontmatter fields.
- Require explicit user intent before DEV source apply; review, diagnosis, and proposed fixes remain read-only.
- Keep native form confirmation as the plugin baseline and do not permit text fallback in plugin workflows.
- Limit operations claims to capabilities present in `diagnostic-readonly`; describe locks, sessions, and jobs as indirect evidence unless a direct read-only tool exists.

## Evaluation and release

- Mark live and mutating DEV evaluations explicitly and exclude them from the default offline set.
- Add real trigger-classification data for the three overlapping Skills.
- Record the required MCP capability contract and block public release until a source commit or release tag containing that contract is available.

## Validation

- Run MCP Jest tests, TypeScript no-emit compilation, plugin validation, all Skill quick validators, JSON parsing, Markdown-link checks, and stale wording searches.
- Do not run live SAP evaluations in this change.
