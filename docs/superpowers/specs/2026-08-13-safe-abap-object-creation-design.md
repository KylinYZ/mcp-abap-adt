# Safe ABAP Object Creation Design

## 1. Objective

Add a guarded object-creation workflow to the default `safe` profile so an operator can create ABAP programs, function groups, and function modules through ADT without first creating empty objects in SAP GUI.

The first phase covers repository object creation and complete source deployment. Function-module interface parameters are a separate second-phase capability because the target system's ADT interface-maintenance protocol has not yet been identified.

## 2. Confirmed Current State

- `abap-adt-api` 8.4.1 supports creating `PROG/P`, `FUGR/F`, and `FUGR/FF` objects through `createObject`.
- The MCP `legacy-full` profile exposes `objectRegistrationInfo`, `validateNewObject`, and `createObject` as low-level compatibility tools.
- The default `safe` profile supports controlled source changes only for objects that already exist.
- The target SAP DEV system advertises the function-module collection `/sap/bc/adt/functions/groups/{groupname}/fmodules` with media type `application/vnd.sap.adt.functions.fmodules.v3+xml`.
- The target system's Discovery result and a function-module object response do not advertise a separate interface or parameters resource.

## 3. Scope

### 3.1 Included

- Create one `PROGRAM` in an existing package.
- Create one `FUNCTION_GROUP` in an existing package.
- Create one `FUNCTION_MODULE` in an existing function group.
- Optionally create a function group and its first function module as one explicitly declared creation plan.
- Validate package, parent object, object names, namespace allowlist, transport, and absence of target objects before confirmation.
- Preview the exact object graph and complete proposed source before any SAP mutation.
- Require the same MCP native or configured text-fallback confirmation used by the existing safe workflow.
- Create objects, write source, activate, read back, verify, audit, and report compensation status.

`PROGRAM` and `FUNCTION_MODULE` require complete source. `FUNCTION_GROUP` does not accept source in this phase: SAP generates its function-pool source and standard includes, and the workflow must not overwrite that generated structure.

### 3.2 Excluded

- Function-module interface parameter maintenance.
- Creating or releasing transport requests.
- Package creation, DDIC objects, classes, interfaces, CDS, service definitions, or service bindings.
- Overwriting, adopting, or repairing an object that already exists.
- Production-system writes.
- Claiming database-style atomicity across SAP ADT requests.

## 4. Public MCP Contract

Add three tools to the default `safe` profile:

### `previewAbapObjectCreation`

Validates a complete creation request without locking, creating, writing, or activating SAP objects.

Input:

```jsonc
{
  "objects": [
    {
      "objectType": "PROGRAM",
      "objectName": "Z_SAMPLE_PROGRAM",
      "description": "Sample program",
      "packageName": "Z001",
      "source": "REPORT z_sample_program.\n"
    }
  ],
  "transportRequest": "DEVK900001"
}
```

`objects` must match one of these shapes:

- One `PROGRAM`.
- One `FUNCTION_GROUP`.
- One `FUNCTION_MODULE` with `parentFunctionGroup`.
- One `FUNCTION_GROUP` followed by one `FUNCTION_MODULE` whose `parentFunctionGroup` is that new group.

Required fields by type:

| Public type | Required parent field | Source |
| --- | --- | --- |
| `PROGRAM` | `packageName` | Required complete program source |
| `FUNCTION_GROUP` | `packageName` | Forbidden in phase one |
| `FUNCTION_MODULE` | `parentFunctionGroup` | Required complete function-module source |

The preview result contains:

- Short-lived `creationPlanId`.
- Normalized object graph in execution order.
- Object type, name, description, package or parent function group, and transport.
- Complete proposed source and source hash for every program and function module.
- Validation results and activation targets.
- Explicit warning that compensation is best effort rather than transactional rollback.
- Confirmation requirement bound to the plan identifier.

### `applyAbapObjectCreation`

Consumes one confirmed plan exactly once. The caller supplies only `creationPlanId` and the existing confirmation mechanism's response. The caller cannot replace names, source, package, parent, or transport during apply.

### `getAbapObjectCreationStatus`

Returns plan state, stage results, created-object inventory, activation results, verification results, compensation results, and manual follow-up guidance. It must not return complete source, confirmation text, credentials, cookies, CSRF tokens, lock handles, or raw authorization headers.

## 5. Internal Architecture

### 5.1 Typed ADT Adapter

Extend the safe client boundary with typed operations rather than invoking low-level handlers:

- `validateNewObject(options)`
- `createObject(options)`
- `deleteObject(objectUrl, lockHandle, transport)`
- Existing search, structure, source, lock, write, activate, and transport methods

Map public object types internally:

| Public type | ADT type | Parent | Creation target |
| --- | --- | --- | --- |
| `PROGRAM` | `PROG/P` | Package | `/sap/bc/adt/programs/programs` |
| `FUNCTION_GROUP` | `FUGR/F` | Package | `/sap/bc/adt/functions/groups` |
| `FUNCTION_MODULE` | `FUGR/FF` | Function group | `/sap/bc/adt/functions/groups/{group}/fmodules` |

The workflow constructs `parentPath`; models and callers do not provide arbitrary ADT URLs.

### 5.2 Creation Resolver

A dedicated resolver converts the request into immutable typed object descriptors. It must:

- Uppercase and validate object names.
- Reject unsupported object graphs, duplicates, empty sources, and arbitrary URLs.
- Resolve and verify an existing package.
- Resolve an existing parent function group, or bind the module to the preceding group in the same plan.
- Prove that every target object is absent using exact-name and expected-type matching.
- Derive expected object URL, source URL, parent URL, and activation reference.

An ambiguous search result is an error. Absence checks must be repeated immediately before the first create request.

### 5.3 Creation Plan Store

Use a dedicated `CreationPlanStore` with the same TTL, capacity, payload cleanup, one-time consumption, and status-query principles as `ChangePlanStore`.

Required states:

- `PREVIEWED`
- `APPLYING`
- `APPLIED`
- `COMPENSATED`
- `COMPENSATION_FAILED`
- `FAILED`
- `EXPIRED`

Each plan records the immutable request, normalized descriptors, transport, source hashes, completed stages, created-object inventory, and compensation results.

### 5.4 Creation Workflow

Create a separate `AbapObjectCreationWorkflow`. Do not add creation branches to `AbapChangeWorkflow`; creation has different preconditions and recovery semantics.

The workflow reuses `SafetyPolicy`, confirmation, execution gating, argument limits, response limits, audit logging, and source comparison helpers.

## 6. Preview Flow

1. Require DEV system role and matching host, client, and namespace allowlists.
2. Validate request shape and maximum object count of two.
3. Validate transport format without creating or releasing a request.
4. Resolve the package and any existing parent function group.
5. Prove all target objects are absent.
6. Call ADT name validation with typed option objects.
7. Verify the supplied unreleased transport is usable for the package or parent context.
8. Validate source locally for basic object framing:
   - Program starts with the expected `REPORT` or `PROGRAM` name.
   - Function module starts with the expected `FUNCTION` name and ends with `ENDFUNCTION`.
   - A function-group request does not contain source; SAP remains authoritative for its generated function-pool source and standard includes.
9. Store an immutable short-lived plan.
10. Return the complete source, hashes, object graph, validation evidence, and compensation warning for operator review.

Pre-creation ADT syntax checking may not be available because source URLs do not yet exist. Preview must disclose this instead of claiming syntax validation. Authoritative syntax and activation validation occur after creation.

## 7. Apply Flow

All SAP operations run serially inside the shared execution gate.

1. Consume the confirmed plan once.
2. Reapply policy checks and revalidate the transport.
3. Repeat exact absence checks for every target.
4. Create objects in dependency order.
5. After each create, resolve the actual object and record it in the created-object inventory.
6. Lock each created program and function module using its actual ADT URL. Do not overwrite the generated function-group source.
7. Write only the source stored in the confirmed plan.
8. Run authoritative syntax checks.
9. Unlock before activation, following the existing stateful ADT lock contract.
10. Activate in dependency order: function group before function module.
11. Read back every program and function-module source and compare it with the confirmed source, tolerating line-ending normalization only. For a function group, verify the active object identity, package, and generated source link without comparing generated source content.
12. Mark the plan `APPLIED` only when creation, activation, verification, and unlock all succeed.

The workflow must never silently switch to changing an existing object if an absence check fails.

## 8. Failure and Compensation

Creation cannot promise a database transaction. Once SAP accepts a create request, transport records or inactive repository state may remain even when later steps fail.

Compensation rules:

- Before the first successful create: mark `FAILED`; no compensation is needed.
- After at least one successful create: attempt compensation in reverse dependency order.
- Unlock any held object before reacquiring a deletion lock when required by ADT.
- Delete only objects recorded as created by this exact plan.
- Never delete an object that existed before the plan or whose identity cannot be proven.
- Verify deletion by exact search and object lookup.
- If all created objects are removed, mark `COMPENSATED`.
- If any delete, unlock, identity check, or deletion verification fails, stop automatic retries and mark `COMPENSATION_FAILED`.

For an uncertain network result after `createObject`, first resolve the exact expected object. If its ownership by the plan cannot be proven, do not delete it automatically. Report the object, transport, completed stages, and required manual ADT/SAP inspection.

## 9. Function-Module Interface Phase

Interface maintenance is a separate design and implementation cycle.

Before adding it:

1. Use an isolated test function module in SAP DEV.
2. Capture Eclipse ADT requests for adding, modifying, reordering, and deleting each parameter category.
3. Identify URL, HTTP method, media type, XML or JSON schema, ETag behavior, lock requirements, transport query parameters, activation behavior, and read-back representation.
4. Compare protocol behavior across the SAP releases that must be supported.
5. Add typed `abap-adt-api` methods and contract tests before exposing MCP tools.

The later interface model should cover `IMPORTING`, `EXPORTING`, `CHANGING`, `TABLES`, and `EXCEPTIONS`, including typing mode, type name, optional/default flags, pass-by-value or reference behavior, and description where the system supports them.

Interface and source deployment should then use one higher-level confirmed plan, but remain distinct stages with separate snapshots and recovery evidence.

## 10. Security and Audit Requirements

- The new tools are available in `safe`; low-level `legacy-full` behavior remains unchanged.
- Apply requires the existing MCP form elicitation or explicitly enabled one-time text fallback.
- Every mutation is restricted to configured DEV host, client, namespace, package, and transport policy.
- No arbitrary ADT URL is accepted from the public tool contract.
- The global timeout, argument limits, response limits, FIFO gate, and serialized audit writer apply to all new tools.
- Audit events record plan ID, object identities, parent, package, transport, hashes, stage, outcome, and compensation status.
- Audit events never record complete source, diffs, credentials, cookies, CSRF tokens, lock handles, or confirmation secrets.

## 11. Error Model

Add creation-specific error codes with actionable stages:

- `INVALID_CREATION_GRAPH`
- `OBJECT_ALREADY_EXISTS`
- `PARENT_NOT_FOUND`
- `OBJECT_VALIDATION_FAILED`
- `OBJECT_CREATION_FAILED`
- `SOURCE_WRITE_FAILED`
- `SYNTAX_CHECK_FAILED`
- `ACTIVATION_FAILED`
- `SOURCE_VERIFY_FAILED`
- `COMPENSATION_FAILED`
- Existing policy, transport, confirmation, capacity, expiry, lock, and unlock errors

Normal failure results preserve the existing MCP response contract. The status tool is authoritative for uncertain or compensated outcomes.

## 12. Verification Strategy

### Automated

- Schema tests for every allowed and rejected object graph.
- Resolver tests for exact absence, ambiguous matches, existing parent, new parent, namespace rejection, and URL derivation.
- Workflow tests for program creation, function-group creation, module creation in an existing group, and group-plus-module creation.
- Ordering tests for create, lock, write, syntax, unlock, activation, read-back, and reverse compensation.
- Failure injection at every remote stage, including uncertain create response, unlock failure, activation failure, source mismatch, delete failure, and verification failure.
- Confirmation, TTL, one-time consumption, capacity, audit redaction, argument/response limit, and shared execution-gate tests.
- Existing test suite, TypeScript build, and `git diff --check` remain required.

### Real SAP DEV

Use isolated allowlisted names and an existing unreleased transport:

1. Read-only Discovery and object-type validation.
2. Preview each supported graph and confirm zero mutation.
3. Create and verify one program.
4. Create and verify one function group.
5. Create and verify one function module in that group.
6. Inject a syntax or activation failure and verify reverse compensation.
7. Confirm no locks remain and inspect transport contents in ADT/SAP.

Real tests must report code validation, SAP DEV mutation, compensation, transport contents, locks, and cleanup separately. No production verification is included.

## 13. Acceptance Criteria

- A user can create and deploy the three supported object types without SAP GUI object pre-creation.
- Preview performs no lock, create, source write, activation, or deletion.
- Apply cannot alter the confirmed plan payload and cannot be consumed twice.
- Existing targets are rejected and never converted into source changes.
- Function group plus function module executes and compensates in deterministic dependency order.
- Successful results include activation, source read-back verification, and unlock evidence.
- Partial failures report whether compensation succeeded and exactly what requires manual inspection.
- Default safe-profile documentation clearly distinguishes object creation, source change, and the deferred function-interface capability.
