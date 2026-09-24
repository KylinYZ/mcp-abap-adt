# vibing-steampunk graph query attribution

- Reference repository: https://github.com/oisee/vibing-steampunk
- Local reference commit: `9886d2727f47506368b0a3c2f1c1766f1200f747`
- License: MIT; copyright notice and full terms in `LICENSE` in this directory.
- Adapted sources: `pkg/graph/graph.go` (edge direction/kinds, statistics),
  `pkg/graph/queries_impact.go` (reverse breadth-first traversal), and behavioral
  cases from `pkg/graph/queries_impact_test.go`.
- TypeScript implementation: `src/lib/DependencyGraph.ts` with MCP validation in
  `src/handlers/DependencyGraphHandlers.ts`.
- Intentional differences: immutable caller snapshots rather than a mutable graph;
  reject missing roots, duplicate node ids and dangling endpoints; bounded input,
  depth and results; explicit truncation and unverified-evidence scope. No remote
  graph builder, transport mutation, ADT request or automatic data acquisition.

The Go project is a reference only, not a build/runtime dependency. This notice
describes this graph-query adaptation, not a claim of full VSP capability parity.

The follow-up `src/adt/LoadDependencyGraph.ts` composes the existing load reader
after reviewing `pkg/adt/loads.go` and `pkg/graph/builder_loads.go` at the same
commit. It preserves LOADS semantics, adds serial budgets and structured partial
acquisition reporting, and intentionally does not expand reverse FUGR nodes.

`src/lib/TransportBoundaries.ts` adapts `pkg/graph/queries_transport_boundaries.go`
and its test cases. The `DYNAMIC_CALL` edge literal is from `pkg/graph/builder_parser.go`.
Intentional changes: exact node-id membership, unknown namespace/package handling,
dynamic evidence preservation, bounded detail output and no deployment-readiness
or transport-membership verification claim. TR/CR scope is caller-supplied only.

`src/adt/TransportScope.ts` follows `pkg/graph/builder_transport.go` for R3TR
membership and task-to-request collapse, using this project's existing E070/E071
read-only query channel. Unlike silent skipping, non-R3TR entries, missing or
conflicting headers and collection limits explicitly make acquisition partial.
Explicit transport unions do not implement E070A CR discovery.
