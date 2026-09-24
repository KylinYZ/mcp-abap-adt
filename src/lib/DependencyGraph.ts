/**
 * Offline graph queries adapted from vibing-steampunk pkg/graph/graph.go and
 * queries_impact.go (MIT; see third-party/vibing-steampunk/).
 * Edges point from the dependent to its dependency. No SAP client or I/O here.
 */
export const GRAPH_EDGE_KINDS = [
  'CALLS', 'REFERENCES', 'LOADS', 'CONTAINS_INCLUDE', 'DEPENDS_ON_CDS',
  'IN_TRANSPORT', 'CO_TRANSPORTED', 'READS_CONFIG', 'DYNAMIC_CALL'
] as const;
export type GraphEdgeKind = typeof GRAPH_EDGE_KINDS[number];

export interface DependencyNode {
  id: string;
  name: string;
  type: string;
  package?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** Evidence label only; caller-supplied labels are not verified by this module. */
  source: string;
}

export interface DependencySnapshot {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface ImpactEntry extends DependencyNode {
  depth: number;
  viaEdge: GraphEdgeKind;
  viaFrom: string;
  viaSource: string;
}

/** Duplicate edges retain distinct evidence and count separately, as in VSP. */
export function dependencyGraphStats(graph: DependencySnapshot) {
  const count = (values: string[]): Record<string, number> => {
    // Null prototype prevents evidence/package labels such as __proto__ from
    // mutating Object.prototype or colliding with inherited properties.
    const result: Record<string, number> = Object.create(null);
    for (const value of values) result[value] = (result[value] ?? 0) + 1;
    return result;
  };
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    byNodeType: count(graph.nodes.map(n => n.type)),
    byPackage: count(graph.nodes.flatMap(n => n.package ? [n.package] : [])),
    byEdgeKind: count(graph.edges.map(e => e.kind)),
    bySource: count(graph.edges.map(e => e.source))
  };
}

/** Reverse BFS: each node occurs once, at its shortest distance from the root. */
export function dependencyImpact(
  graph: DependencySnapshot,
  root: string,
  options: { maxDepth?: number; maxEntries?: number; edgeKinds?: GraphEdgeKind[] } = {}
) {
  const maxDepth = options.maxDepth ?? 3;
  const maxEntries = options.maxEntries ?? 200;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 10
    || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 500) {
    throw new Error('Invalid graph traversal bounds.');
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (!nodes.has(root)) throw new Error('Graph root must exist in the snapshot.');
  const filter = options.edgeKinds?.length ? new Set(options.edgeKinds) : undefined;
  const incoming = new Map<string, DependencyEdge[]>();
  for (const edge of graph.edges) {
    if (filter && !filter.has(edge.kind)) continue;
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  const visited = new Set([root]);
  const queue = [{ id: root, depth: 0 }];
  const entries: ImpactEntry[] = [];
  const depthFrontier = new Set<string>();
  let entryLimitReached = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    for (const edge of incoming.get(current.id) ?? []) {
      if (visited.has(edge.from)) continue;
      if (current.depth >= maxDepth) {
        depthFrontier.add(edge.from);
        continue;
      }
      if (entries.length >= maxEntries) {
        entryLimitReached = true;
        continue;
      }
      const node = nodes.get(edge.from);
      if (!node) throw new Error('Graph edge endpoint is absent from the snapshot.');
      visited.add(edge.from);
      const depth = current.depth + 1;
      queue.push({ id: edge.from, depth });
      entries.push({ ...node, depth, viaEdge: edge.kind, viaFrom: current.id, viaSource: edge.source });
    }
  }
  const depthLimitReached = [...depthFrontier].some(id => !visited.has(id));
  return {
    root, maxDepth, maxEntries, entries, entryLimitReached, depthLimitReached,
    completeWithinSnapshot: !entryLimitReached && !depthLimitReached
  };
}
