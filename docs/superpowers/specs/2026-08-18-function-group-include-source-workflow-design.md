# Function Group Include Source Workflow Design

## Context

`inspectAbapObject` resolves every supported object through an exact ADT `quickSearch` result before reading source. Function-group generated includes such as `LZFG_SAP2EAMTOP` are returned by search with an object URI under:

```text
/sap/bc/adt/functions/groups/<function-group>/includes/<include>
```

The resolver currently recognizes an `INCLUDE` only when its ADT type starts with `PROG/I` or its URI contains `/programs/includes/`. A function-group include is represented as `FUGR/I`, so the exact search result is incorrectly discarded before object metadata or source can be read.

The MCP also contains the read-only `getObjectSource` tool, which accepts an exact SAP-provided ADT source URL. It is currently exposed only by `legacy-full`, although direct URL source reading is required for normal development and diagnostic work.

## Goals

1. Let `inspectAbapObject` read exact function-group includes represented as `FUGR/I`.
2. Let the existing `previewAbapChange` and `applyAbapChange` workflow safely modify those includes without bypassing confirmation, drift checks, transport validation, rollback, or verification.
3. Expose `getObjectSource` in development and diagnostic profiles without adding it to the minimal `safe`, business, or operations profiles.
4. Preserve all existing behavior for ordinary `PROG/I` includes.

## Non-Goals

- Do not add guessed-URL fallback when ADT search returns no exact object.
- Do not add a new direct-URL mutation tool.
- Do not expose `setObjectSource`, raw lock, raw activation, or other low-level mutation tools outside their existing profiles.
- Do not change namespace policy, confirmation policy, transport policy, or real-write authorization.
- Do not publish a package, change runtime configuration, or perform a real SAP write as part of the code change.

## Resolver Design

### Accepted Include Shapes

The resolver will recognize two exact ADT include forms:

| Include kind | ADT type | Required URI shape |
| --- | --- | --- |
| Program include | `PROG/I` | `/sap/bc/adt/programs/includes/<include>` |
| Function-group include | `FUGR/I` | `/sap/bc/adt/functions/groups/<group>/includes/<include>` |

The type and URI checks remain narrow. A generic result containing an unrelated `/includes/` segment is not accepted.

URI-based exact-name extraction will support both include paths. This keeps exact resolution valid when SAP returns the include name only in the URI while preserving the single-match requirement.

### Main Program Context

Program includes keep the existing rule: `mainPrograms` must return exactly one main program. That URI is passed as the syntax-check and activation context.

Function-group includes do not call `mainPrograms`. ADT models them as independent `FUGR/I` resources within a function group, and the existing VS Code integration only requests main-program context for `PROG/I`. Their syntax check and activation therefore use no `context` parameter.

### Resolved URLs

For a function-group include, the resolver will continue to trust SAP metadata rather than constructing writable URLs:

- `objectUrl`: the validated object URI returned by `objectStructure` or exact search.
- `sourceUrl`: the validated `abapsource:sourceUri` returned by `objectStructure`.
- `lockUrl`: the include `objectUrl`.
- `activationUrl`: the include `objectUrl`.
- `activationName`: the exact include name.
- `mainProgram`: omitted.

Missing or invalid source metadata remains a hard resolution failure.

## Read and Change Flows

### Inspect

```text
exact quickSearch
  -> exact name/type/URI validation
  -> objectStructure
  -> SAP-provided sourceUri
  -> getObjectSource
  -> existing hash and paging response
```

### Preview

```text
resolve FUGR/I include
  -> validate namespace and transport
  -> read complete active source
  -> create diff and source hashes
  -> syntaxCheck(sourceUrl, objectUrl, candidate, no mainProgram)
  -> store existing confirmation-bound change plan
```

### Apply and Rollback

```text
revalidate transport and source hash
  -> lock objectUrl
  -> PUT candidate to sourceUrl
  -> post-write syntax check without main-program context
  -> unlock objectUrl
  -> activate exact include name and objectUrl without context
  -> read sourceUrl and verify content
```

If a post-write stage fails, the existing workflow reacquires the same include lock, restores the original source, unlocks, activates the include, and verifies the restored source. No function-group-specific bypass or blind retry is added.

## `getObjectSource` Profile Exposure

`getObjectSource` is a read-only tenant operation that accepts an exact ADT source URL. It will be exposed in:

- `development`
- `development-workbench`
- `diagnostic-readonly`
- `legacy-full` (already exposed)

It will remain unavailable in:

- `safe`
- `business-readonly`
- `operations-readonly`

This gives developers and technical diagnostics a required URL-level source reader without turning the minimal safe workflow or business/operations profiles into arbitrary source browsers. `setObjectSource` remains unchanged and unavailable in these read-only catalogs.

## Error Handling and Safety

- Zero or multiple exact matches continue to fail before source access.
- A `FUGR/I` result must have the exact function-group include URI form.
- A `PROG/I` include still requires exactly one main program.
- A `FUGR/I` include never guesses or fabricates a main-program context.
- SAP-provided object and source URLs must still pass `/sap/bc/adt/` validation.
- Preview remains read-only and apply still requires the existing explicit MCP confirmation.
- Source drift, syntax errors, lock/write/unlock/activation failures, verification mismatch, and rollback failure retain their existing terminal states and audit trail.
- `getObjectSource` remains read-only; profile exposure does not authorize mutation.

## Implementation Scope

Expected implementation files:

- `src/safe/AbapObjectResolver.ts`
- `src/config/ToolProfiles.ts`
- `src/__tests__/AbapObjectResolver.test.ts`
- Existing profile/catalog and workflow tests where assertions need coverage
- User-facing tool documentation only where the profile matrix is explicitly listed

No new abstraction is required unless tests show that a small include-kind helper removes duplicated path checks.

## Verification

### Automated

1. Resolver test for an exact `FUGR/I` result under `/functions/groups/.../includes/...`.
2. Resolver test proving URI-based exact-name extraction for that path.
3. Resolver assertion that `mainPrograms` is not called for `FUGR/I`.
4. Existing `PROG/I` test proving the unique-main-program rule is unchanged.
5. Workflow test proving preview passes no main-program context for a function-group include.
6. Workflow test proving apply uses the include object/source URLs for lock, write, syntax check, unlock, activation, read-back verification, and rollback.
7. Profile tests proving `getObjectSource` is present only in the four approved profiles.
8. Focused Jest tests with coverage disabled, followed by the full repository suite, ADT import check, TypeScript build, and `git diff --check`.

### Real SAP Follow-Up

Real SAP validation requires a separately authorized, disposable or explicitly approved function-group include and transport request:

1. `searchObject` returns exactly one `FUGR/I` include.
2. `inspectAbapObject` reads the complete source and stable hash.
3. `previewAbapChange` produces the expected diff without changing SAP.
4. After explicit native confirmation, `applyAbapChange` locks, writes, checks, unlocks, activates, and verifies the include.
5. A controlled failure case verifies rollback only if an approved test object and recovery procedure are available.

Automated tests and compilation do not count as real SAP verification.

## Acceptance Criteria

- `inspectAbapObject(INCLUDE, L...)` accepts an exact `FUGR/I` function-group include returned by SAP search.
- Ordinary `PROG/I` include behavior remains unchanged.
- Function-group include preview/apply uses no main-program context and retains all current safety gates.
- `getObjectSource` appears in `development`, `development-workbench`, `diagnostic-readonly`, and `legacy-full`, and remains absent from `safe`, `business-readonly`, and `operations-readonly`.
- All targeted and repository-wide automated validation passes.
- Final reporting separates code validation from unperformed real SAP mutation validation.
