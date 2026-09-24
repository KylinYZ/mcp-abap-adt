/** Offline adaptation of VSP pkg/graph/queries_transport_boundaries.go (MIT).
 * See third-party/vibing-steampunk. Membership is exact, never name-only fuzzy.
 */
import type { DependencySnapshot, DependencyNode, GraphEdgeKind } from './DependencyGraph.js';

export interface BoundaryScope {
  /** Display label only: a TR number, CR id, or another caller-defined set. */
  label: string;
  objectIds: string[];
}
type Category = 'missingCustom' | 'unknownNamespace' | 'dynamic' | 'crossPackage' | 'standardCandidates';
interface BoundaryEntry {
  from: DependencyNode;
  to: DependencyNode;
  edgeKinds: GraphEdgeKind[];
  sources: string[];
}
const ignored = new Set<GraphEdgeKind>(['IN_TRANSPORT', 'CO_TRANSPORTED', 'READS_CONFIG']);
const categories: Category[] = ['missingCustom', 'unknownNamespace', 'dynamic', 'crossPackage', 'standardCandidates'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Operates on the validated, bounded snapshot supplied by the MCP handler. */
export function transportBoundaries(graph: DependencySnapshot, scope: BoundaryScope, maxEntries = 200) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 500) throw new Error('Invalid boundary result limit.');
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const members = new Set(scope.objectIds);
  if (!members.size || members.size !== scope.objectIds.length || scope.objectIds.some(id => !nodes.has(id))) {
    throw new Error('Boundary members must be distinct existing nodes.');
  }
  // Preserve all evidence for static pairs; dynamic evidence is a separate
  // unresolved observation, never hidden by a static edge or scope membership.
  const pairs = new Map<string, BoundaryEntry>();
  for (const edge of graph.edges) {
    if (!members.has(edge.from) || ignored.has(edge.kind)) continue;
    if (edge.from === edge.to && edge.kind !== 'DYNAMIC_CALL') continue;
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (!from || !to) throw new Error('Boundary edge endpoint is missing.');
    const key = JSON.stringify([edge.from, edge.to, edge.kind === 'DYNAMIC_CALL' || to.type === 'DYNAMIC']);
    const pair = pairs.get(key) ?? { from: { ...from }, to: { ...to }, edgeKinds: [], sources: [] };
    if (!pair.edgeKinds.includes(edge.kind)) pair.edgeKinds.push(edge.kind);
    if (!pair.sources.includes(edge.source)) pair.sources.push(edge.source);
    pairs.set(key, pair);
  }
  const all: Record<Category, BoundaryEntry[]> = {
    missingCustom: [], unknownNamespace: [], dynamic: [], crossPackage: [], standardCandidates: []
  };
  const summary = {
    totalDependencies: pairs.size, inScope: 0, inScopeSamePackage: 0,
    inScopeCrossPackage: 0, inScopeUnknownPackage: 0,
    missingCustom: 0, unknownNamespace: 0, dynamic: 0, standardCandidates: 0
  };
  for (const pair of pairs.values()) {
    pair.edgeKinds.sort(compare); pair.sources.sort(compare);
    if (pair.edgeKinds.includes('DYNAMIC_CALL') || pair.to.type === 'DYNAMIC') {
      all.dynamic.push(pair); summary.dynamic++; continue;
    }
    if (members.has(pair.to.id)) {
      summary.inScope++;
      if (!pair.from.package || !pair.to.package) summary.inScopeUnknownPackage++;
      else if (pair.from.package !== pair.to.package) {
        summary.inScopeCrossPackage++; all.crossPackage.push(pair);
      } else summary.inScopeSamePackage++;
      continue;
    }
    // VSP uses a Z/Y heuristic. Namespaces cannot be safely classified as SAP
    // standard without ownership metadata, so keep them unresolved here.
    if (pair.to.name.startsWith('/')) { all.unknownNamespace.push(pair); summary.unknownNamespace++; }
    else if (/^[ZY]/.test(pair.to.name)) { all.missingCustom.push(pair); summary.missingCustom++; }
    else { all.standardCandidates.push(pair); summary.standardCandidates++; }
  }
  const entries: Record<Category, BoundaryEntry[]> = {
    missingCustom: [], unknownNamespace: [], dynamic: [], crossPackage: [], standardCandidates: []
  };
  let remaining = maxEntries;
  let totalEntries = 0;
  for (const category of categories) {
    const sorted = all[category].sort((a, b) =>
      (category === 'crossPackage' ? compare(a.to.package ?? '', b.to.package ?? '') || compare(a.from.package ?? '', b.from.package ?? '') : 0)
      || compare(a.from.id, b.from.id) || compare(a.to.id, b.to.id));
    totalEntries += sorted.length;
    entries[category] = sorted.slice(0, remaining);
    remaining -= entries[category].length;
  }
  return {
    label: scope.label, objectCount: members.size, scopeMembership: 'exact-node-id',
    summary, entries, totalEntries, returnedEntries: maxEntries - remaining,
    maxEntries, truncated: totalEntries > maxEntries,
    systemWideComplete: false, transportMembershipVerified: false, deploymentReadinessVerified: false,
    notes: [
      'Only outgoing structural dependencies from the explicit scope are inspected. TR/CR labels do not resolve transport contents or infer membership.',
      'Missing custom means absent from the supplied set, not absent from SAP or necessarily required in this transport; dependencies may already exist in the destination.',
      'Standard candidates use only the non-Z/Y naming heuristic, not verified SAP ownership. Namespaced targets remain unknown.',
      'Dynamic references are unresolved. Missing package metadata is unknown, not same-package. No release safety or self-consistency approval is issued.',
      'Static source/target pairs merge evidence; dynamic evidence stays separate. Counts cover the whole supplied snapshot even when detail entries are truncated.'
    ]
  };
}
