import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js';
import { collectTransportScope, TransportScopeInputError } from './TransportScope.js';
import { getLoadGraph } from './LoadGraphApi.js';
import { buildLoadDependencyGraph, type LoadDependencyInput } from './LoadDependencyGraph.js';
import { transportBoundaries } from '../lib/TransportBoundaries.js';
import { dependencyGraphStats, type DependencySnapshot } from '../lib/DependencyGraph.js';

export interface TransportLoadBoundaryInput {
  transports: string[];
  maxDependencyQueries?: number;
  maxEntries?: number;
}

function limit(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new TransportScopeInputError(`Budgets must be integers from 1 to ${max}.`);
  }
  return value;
}

/** One outgoing read per supported member; global budgets, not per-member budgets.
 * Boundary analysis requires only member-origin edges, not expansion of external targets.
 */
export async function collectTransportLoadBoundaries(runQuery: TransportHistoryQueryRunner, input: TransportLoadBoundaryInput) {
  const maxDependencyQueries = limit(input?.maxDependencyQueries, 5, 10);
  const maxEntries = limit(input?.maxEntries, 200, 500);
  const membership = await collectTransportScope(runQuery, input);
  const nodes = new Map(membership.graph.nodes.map(node => [node.id, node]));
  const graph: DependencySnapshot = { nodes: [], edges: [...membership.graph.edges] };
  const issues: { nodeId: string; reason: string }[] = [];
  const skipped: { nodeId: string; reason: string }[] = [];
  const reads: { nodeId: string; status: string; rowCount?: number }[] = [];
  let queryCount = 0;
  for (const nodeId of membership.boundaryScope.objectIds) {
    const node = nodes.get(nodeId)!;
    if (!['CLAS', 'INTF', 'PROG', 'FUGR'].includes(node.type) || !/^[A-Z0-9_/]{1,40}$/.test(node.name)) {
      skipped.push({ nodeId, reason: 'unsupported-load-identity' }); continue;
    }
    if (queryCount >= maxDependencyQueries) { skipped.push({ nodeId, reason: 'dependency-query-limit' }); continue; }
    if (graph.edges.length >= 2000) { skipped.push({ nodeId, reason: 'graph-edge-limit' }); continue; }
    const result = await buildLoadDependencyGraph({ getLoadGraph: args => getLoadGraph(runQuery, args) }, {
      objectType: node.type as LoadDependencyInput['objectType'], objectName: node.name,
      direction: 'loads', maxDepth: 1, maxQueries: 1, maxNodes: 500, maxEdges: 2000
    });
    queryCount += result.collection.queryCount;
    reads.push(...result.collection.reads);
    issues.push(...result.collection.issues);
    if (result.collection.nodeLimitReached) issues.push({ nodeId, reason: 'reader-node-limit' });
    if (result.collection.edgeLimitReached) issues.push({ nodeId, reason: 'reader-edge-limit' });
    // External targets intentionally are not expanded; they do not originate
    // dependencies considered by this boundary query. Other members get their own read.
    for (const frontier of result.collection.unexpanded) {
      if (frontier.reason !== 'depth-limit') issues.push(frontier);
    }
    const fetchedNodes = new Map(result.graph.nodes.map(n => [n.id, n]));
    for (const edge of result.graph.edges) {
      if (graph.edges.length >= 2000) { issues.push({ nodeId, reason: 'graph-edge-limit' }); break; }
      const target = fetchedNodes.get(edge.to)!;
      if (!nodes.has(target.id) && nodes.size >= 500) { issues.push({ nodeId, reason: 'graph-node-limit' }); continue; }
      if (!nodes.has(target.id)) nodes.set(target.id, target);
      graph.edges.push(edge);
    }
  }
  graph.nodes = [...nodes.values()];
  const uniqueIssues = [...new Map(issues.map(i => [`${i.nodeId}:${i.reason}`, i])).values()];
  const analysis = membership.boundaryScope.objectIds.length
    ? transportBoundaries(graph, membership.boundaryScope, maxEntries) : null;
  const partial = membership.collection.status === 'partial' || skipped.length > 0 || uniqueIssues.length > 0;
  return {
    scope: 'explicit-transport-outgoing-loads', graph, boundaryScope: membership.boundaryScope,
    stats: dependencyGraphStats(graph), analysis,
    membership: { requested: membership.requested, requests: membership.requests, transports: membership.transports,
      collection: membership.collection },
    collection: {
      status: partial ? 'partial' : 'complete-within-r3tr-load-reader-scope',
      queryCount: membership.collection.queryCount + queryCount, dependencyQueryCount: queryCount,
      reads, skipped, issues: uniqueIssues,
      limits: { maxDependencyQueries, maxTotalQueries: maxDependencyQueries + 4, maxNodes: 500, maxEdges: 2000, maxEntries }
    },
    systemWideComplete: false, deploymentReadinessVerified: false,
    notes: [
      ...membership.notes,
      'Only direct outgoing D010INC LOADS from observed R3TR members are collected. LOADS are not CALLS or all structural dependencies.',
      'Unsupported member types, partial membership and failed/truncated reads prevent complete reader-scope coverage.',
      'External targets are not expanded. Missing custom classifications are provisional when membership is partial.',
      'No package lookup, E070A CR discovery, dynamic-call parsing or release-readiness verification is performed.',
      'A null analysis means no observed R3TR members; an empty report does not prove no dependencies.'
    ]
  };
}
