import type { LoadGraphClient, LoadGraphNode } from './LoadGraphApi.js';
import { dependencyGraphStats, dependencyImpact, type DependencyNode, type DependencySnapshot } from '../lib/DependencyGraph.js';

export interface LoadDependencyInput {
  objectType: 'CLAS' | 'INTF' | 'PROG' | 'FUGR';
  objectName: string;
  direction?: 'loads' | 'loaded_by';
  maxDepth?: number;
  maxQueries?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export class LoadDependencyInputError extends Error {}
const types = ['CLAS', 'INTF', 'PROG', 'FUGR'];
const namePattern = /^[A-Z0-9_/]+$/;
function bound(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new LoadDependencyInputError(`Graph budgets must be integers between 1 and their declared maximum (${max}).`);
  }
  return value;
}

/** Serial, bounded composition of existing D010INC reads. No new SQL/ADT protocol. */
export async function buildLoadDependencyGraph(client: LoadGraphClient, input: LoadDependencyInput) {
  const name = typeof input?.objectName === 'string' ? input.objectName.trim().toUpperCase() : '';
  const type = typeof input?.objectType === 'string' ? input.objectType.trim().toUpperCase() : '';
  if (!name || name.length > 40 || !namePattern.test(name) || !types.includes(type)) {
    throw new LoadDependencyInputError('Require objectType CLAS/INTF/PROG/FUGR and objectName matching [A-Z0-9_/], length 1–40.');
  }
  const direction = input.direction === undefined ? 'loaded_by' : input.direction;
  if (direction !== 'loads' && direction !== 'loaded_by') throw new LoadDependencyInputError('direction must be loads or loaded_by.');
  // The existing upstream INCLUDE-prefix lookup does not cover a FUGR's
  // SAPL/L pool names in reverse. Do not silently claim a complete reverse read.
  if (type === 'FUGR' && direction === 'loaded_by') {
    throw new LoadDependencyInputError('FUGR reverse lookup is not covered by the existing reader; use direction loads.');
  }
  const maxDepth = bound(input.maxDepth, 2, 3);
  const maxQueries = bound(input.maxQueries, 5, 10);
  const maxNodes = bound(input.maxNodes, 100, 500);
  const maxEdges = bound(input.maxEdges, 200, 2000);
  const root = `${type}:${name}`;
  const nodes = new Map<string, DependencyNode>([[root, { id: root, name, type }]]);
  const edges = new Map<string, DependencySnapshot['edges'][number]>();
  const queue = [{ id: root, depth: 0 }];
  const scheduled = new Set([root]);
  const reads: Array<{ nodeId: string; status: string; rowCount?: number }> = [];
  const unexpanded: Array<{ nodeId: string; reason: string }> = [];
  const issues: Array<{ nodeId: string; reason: string }> = [];
  let queryCount = 0;
  let nodeLimitReached = false;
  let edgeLimitReached = false;
  const decodeNode = (raw: LoadGraphNode): DependencyNode | undefined => {
    if (!raw || typeof raw.objectName !== 'string' || typeof raw.objectType !== 'string') return;
    if (!types.includes(raw.objectType) || raw.objectName.length < 1 || raw.objectName.length > 40 || !namePattern.test(raw.objectName)) return;
    return { id: `${raw.objectType}:${raw.objectName}`, name: raw.objectName, type: raw.objectType };
  };

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const node = nodes.get(current.id)!;
    const stopReason = current.depth >= maxDepth ? 'depth-limit'
      : direction === 'loaded_by' && node.type === 'FUGR' ? 'unsupported-fugr-reverse'
      : queryCount >= maxQueries ? 'query-limit' : undefined;
    if (stopReason) { unexpanded.push({ nodeId: current.id, reason: stopReason }); continue; }
    queryCount++;
    let response;
    try {
      // Deliberately await each read; no Promise.all or retry on failure.
      response = await client.getLoadGraph({ objectName: node.name, direction });
    } catch {
      reads.push({ nodeId: current.id, status: 'failed' });
      issues.push({ nodeId: current.id, reason: 'read-failed' });
      continue;
    }
    const state = response?.collection?.[direction];
    if (!state || !['ok', 'failed', 'truncated', 'partial'].includes(state.status)
      || !Number.isInteger(state.rowCount) || state.rowCount < 0) {
      reads.push({ nodeId: current.id, status: 'unknown' });
      issues.push({ nodeId: current.id, reason: 'missing-collection-status' });
      continue;
    }
    reads.push({ nodeId: current.id, status: state.status, rowCount: state.rowCount });
    if (state.status !== 'ok') issues.push({ nodeId: current.id, reason: `read-${state.status}` });
    if (state.status === 'failed') continue;
    const candidates = direction === 'loads' ? response.loads : response.loadedBy;
    if (!Array.isArray(candidates)) { issues.push({ nodeId: current.id, reason: 'invalid-edges' }); continue; }
    let invalidEdges = false;
    // Reader is capped at 2000 rows; guard injected/legacy readers too.
    if (candidates.length > 2000) issues.push({ nodeId: current.id, reason: 'reader-edge-limit' });
    for (const edge of candidates.slice(0, 2000)) {
      const from = decodeNode(edge?.from);
      const to = decodeNode(edge?.to);
      if (!from || !to) { invalidEdges = true; continue; }
      // The old reader searches by name only. Never merge same-named objects
      // of different types or unrelated anchors into the requested graph.
      if ((direction === 'loads' ? from.id : to.id) !== current.id || from.id === to.id) continue;
      const key = `${from.id}->${to.id}`;
      if (edges.has(key)) continue;
      if (edges.size >= maxEdges) { edgeLimitReached = true; continue; }
      const missing = [from, to].filter(n => !nodes.has(n.id));
      if (nodes.size + missing.length > maxNodes) { nodeLimitReached = true; continue; }
      for (const n of missing) nodes.set(n.id, n);
      edges.set(key, { from: from.id, to: to.id, kind: 'LOADS', source: 'D010INC' });
      const next = direction === 'loads' ? to : from;
      if (!scheduled.has(next.id)) {
        scheduled.add(next.id);
        queue.push({ id: next.id, depth: current.depth + 1 });
      }
    }
    if (invalidEdges) issues.push({ nodeId: current.id, reason: 'invalid-edges' });
  }
  const graph: DependencySnapshot = { nodes: [...nodes.values()], edges: [...edges.values()] };
  const incomplete = issues.length > 0 || unexpanded.length > 0 || nodeLimitReached || edgeLimitReached;
  return {
    root, direction, scope: 'bounded-d010inc-load-graph', rootExistenceVerified: false,
    systemWideComplete: false,
    graph, stats: dependencyGraphStats(graph),
    ...(direction === 'loaded_by' ? { impact: dependencyImpact(graph, root, { maxDepth, maxEntries: maxNodes, edgeKinds: ['LOADS'] }) } : {}),
    collection: {
      status: incomplete ? 'partial' : 'complete-within-reader-scope', queryCount,
      limits: { maxDepth, maxQueries, maxNodes, maxEdges },
      nodeLimitReached, edgeLimitReached, reads, issues, unexpanded
    },
    notes: [
      'D010INC LOADS edges only, not CALLS or all dependency types. Sequential reads are not an atomic SAP snapshot.',
      'Root identity is caller-supplied and existence is not verified. Empty data does not prove no SAP impact.',
      'Impact completeness refers only to the collected graph. Always inspect collection status and unexpanded nodes.',
      'Reverse FUGR expansion is not supported by the existing INCLUDE-prefix reader and is reported as unexpanded.'
    ]
  };
}
