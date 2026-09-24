import { buildLoadDependencyGraph } from '../adt/LoadDependencyGraph';
import { createLoadGraphClient, getLoadGraph, type GetLoadGraphResult, type LoadGraphClient, type LoadGraphEdge } from '../adt/LoadGraphApi';
import { LoadGraphHandlers } from '../handlers/LoadGraphHandlers';
import { DependencyGraphHandlers } from '../handlers/DependencyGraphHandlers';
import { toolOperationClass } from '../config/ToolOperationPolicy';
import { usesSapExecutionGate } from '../lib/serverGuardrails';

const edge = (from: string, to: string, fromType = 'CLAS', toType = 'CLAS'): LoadGraphEdge => ({
  from: { objectType: fromType, objectName: from }, to: { objectType: toType, objectName: to }, detail: `LOADS:${to}===CP`
});
function response(name: string, direction: 'loads' | 'loaded_by', edges: LoadGraphEdge[], status: 'ok' | 'failed' | 'truncated' = 'ok'): GetLoadGraphResult {
  return { objectName: name, direction, source: 'D010INC', loads: direction === 'loads' ? edges : [],
    loadedBy: direction === 'loaded_by' ? edges : [], loadsTotal: 0, loadedByTotal: 0, notes: [],
    collection: { [direction]: { status, rowCount: status === 'truncated' ? 2000 : edges.length, rowLimit: 2000 } } };
}
function fixture(edges: LoadGraphEdge[]) {
  const get = jest.fn(async ({ objectName, direction = 'loaded_by' }: { objectName: string; direction?: string }) =>
    response(objectName, direction as 'loads' | 'loaded_by', edges.filter(e =>
      (direction === 'loads' ? e.from.objectName : e.to.objectName) === objectName)));
  return { getLoadGraph: get };
}
const root = { objectType: 'CLAS' as const, objectName: 'A' };

describe('bounded load dependency graph composition', () => {
  it('collects reverse LOADS serially with shortest-path impact and directly reusable snapshot', async () => {
    const edges = [edge('B', 'A'), edge('C', 'B'), edge('D', 'A'), edge('C', 'D')];
    const reader = fixture(edges);
    let active = 0, peak = 0;
    const client: LoadGraphClient = { getLoadGraph: async input => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve(); const result = await reader.getLoadGraph(input); active--; return result;
    } };
    const result = await buildLoadDependencyGraph(client, { ...root, maxDepth: 3 });
    expect(peak).toBe(1);
    expect(reader.getLoadGraph.mock.calls.map(([i]) => i.objectName)).toEqual(['A', 'B', 'D', 'C']);
    expect(result.graph.edges).toHaveLength(4);
    expect(result.graph.edges.every(e => e.kind === 'LOADS' && e.source === 'D010INC')).toBe(true);
    expect(result.impact?.entries.map(n => [n.id, n.depth])).toEqual([['CLAS:B', 1], ['CLAS:D', 1], ['CLAS:C', 2]]);
    expect(result.collection.status).toBe('complete-within-reader-scope');
    expect(result.systemWideComplete).toBe(false);
    const answer = await new DependencyGraphHandlers().handle('analyzeDependencyGraph', {
      operation: 'impact', graph: result.graph, root: result.root
    });
    expect(answer.structuredContent).toMatchObject({ result: { analysis: { entries: result.impact?.entries } } });
  });

  it('loads direction follows dependencies but does not present downstream nodes as impact', async () => {
    const result = await buildLoadDependencyGraph(fixture([edge('A', 'B'), edge('B', 'C')]), { ...root, direction: 'loads', maxDepth: 3 });
    expect(result.graph.edges.map(e => [e.from, e.to])).toEqual([['CLAS:A', 'CLAS:B'], ['CLAS:B', 'CLAS:C']]);
    expect(result).not.toHaveProperty('impact');
    expect(result.collection.queryCount).toBe(3);
  });

  it('bounds depth conservatively without fetching frontier nodes', async () => {
    const client = fixture([edge('B', 'A'), edge('C', 'B')]);
    const result = await buildLoadDependencyGraph(client, { ...root, maxDepth: 1 });
    expect(client.getLoadGraph).toHaveBeenCalledTimes(1);
    expect(result.collection.unexpanded).toEqual([{ nodeId: 'CLAS:B', reason: 'depth-limit' }]);
    expect(result.collection.status).toBe('partial');
    // Snapshot traversal can finish while acquisition has not: both scopes are explicit.
    expect(result.impact?.completeWithinSnapshot).toBe(true);
  });

  it('enforces total query budget across breadth, not per branch', async () => {
    const client = fixture([edge('B', 'A'), edge('C', 'A'), edge('D', 'B')]);
    const result = await buildLoadDependencyGraph(client, { ...root, maxDepth: 3, maxQueries: 2 });
    expect(client.getLoadGraph).toHaveBeenCalledTimes(2);
    expect(result.collection.unexpanded).toEqual([
      { nodeId: 'CLAS:C', reason: 'query-limit' }, { nodeId: 'CLAS:D', reason: 'query-limit' }
    ]);
  });

  it.each([
    [{ maxNodes: 1 }, 'nodeLimitReached', 1, 0],
    [{ maxNodes: 2 }, 'nodeLimitReached', 2, 1],
    [{ maxEdges: 1 }, 'edgeLimitReached', 2, 1]
  ] as const)('enforces graph capacity %p with no dangling endpoints', async (limits, flag, nodes, edges) => {
    const result = await buildLoadDependencyGraph(fixture([edge('B', 'A'), edge('C', 'A')]), { ...root, ...limits });
    expect(result.collection[flag]).toBe(true);
    expect(result.graph.nodes).toHaveLength(nodes); expect(result.graph.edges).toHaveLength(edges);
    const ids = result.graph.nodes.map(n => n.id);
    expect(result.graph.edges.every(e => ids.includes(e.from) && ids.includes(e.to))).toBe(true);
  });

  it('deduplicates cycles/edges and never queries a node twice', async () => {
    const client = fixture([edge('B', 'A'), edge('A', 'B'), edge('B', 'A'), edge('A', 'A')]);
    const result = await buildLoadDependencyGraph(client, { ...root, maxDepth: 3 });
    expect(result.collection.queryCount).toBe(2);
    expect(result.graph.nodes).toHaveLength(2); expect(result.graph.edges).toHaveLength(2);
  });

  it('filters same-named different-type anchors instead of merging identities', async () => {
    const client = fixture([edge('B', 'A', 'CLAS', 'PROG'), edge('C', 'A')]);
    const result = await buildLoadDependencyGraph(client, root);
    expect(result.graph.nodes.map(n => n.id)).toEqual(['CLAS:A', 'CLAS:C']);
  });

  it('reports failed reads without retry or leaking remote errors', async () => {
    const client = { getLoadGraph: jest.fn().mockRejectedValue(new Error('SECRET_COOKIE=abc https://private.example')) };
    const result = await buildLoadDependencyGraph(client, root);
    expect(client.getLoadGraph).toHaveBeenCalledTimes(1);
    expect(result.collection.issues).toEqual([{ nodeId: 'CLAS:A', reason: 'read-failed' }]);
    expect(result.collection.status).toBe('partial');
    expect(JSON.stringify(result)).not.toMatch(/SECRET_COOKIE|private.example/);
  });

  it.each(['failed', 'truncated'] as const)('propagates structured reader %s status without inspecting prose', async status => {
    const client = { getLoadGraph: jest.fn(async () => ({ ...response('A', 'loaded_by', [], status), notes: ['all is fine'] })) };
    const result = await buildLoadDependencyGraph(client, root);
    expect(result.collection.issues[0].reason).toBe(`read-${status}`);
    expect(result.collection.status).toBe('partial');
  });

  it('fails closed for legacy readers without structured collection state', async () => {
    const r = response('A', 'loaded_by', [edge('B', 'A')]);
    delete (r as Partial<GetLoadGraphResult>).collection;
    const result = await buildLoadDependencyGraph({ getLoadGraph: async () => r }, root);
    expect(result.collection.issues[0].reason).toBe('missing-collection-status');
    expect(result.graph.edges).toEqual([]);
  });

  it('does not treat an empty successful read as proof of object existence', async () => {
    const result = await buildLoadDependencyGraph(fixture([]), root);
    expect(result.rootExistenceVerified).toBe(false);
    expect(result.systemWideComplete).toBe(false);
    expect(result.graph.nodes).toHaveLength(1);
  });

  it('stops at FUGR reverse nodes instead of silently using the wrong prefix query', async () => {
    const client = fixture([edge('ZFG', 'A', 'FUGR')]);
    const result = await buildLoadDependencyGraph(client, root);
    expect(result.collection.unexpanded).toContainEqual({ nodeId: 'FUGR:ZFG', reason: 'unsupported-fugr-reverse' });
    expect(client.getLoadGraph).toHaveBeenCalledTimes(1);
  });

  it('supports FUGR forward roots with the existing reader', async () => {
    const result = await buildLoadDependencyGraph(fixture([edge('ZFG', 'A', 'FUGR')]), {
      objectName: 'ZFG', objectType: 'FUGR', direction: 'loads'
    });
    expect(result.graph.edges[0].from).toBe('FUGR:ZFG');
  });

  it.each([
    { objectName: "A' OR 1=1" }, { objectType: 'TABL' }, { direction: 'both' },
    { objectType: 'FUGR' }, { maxDepth: 0 }, { maxDepth: 4 }, { maxDepth: 1.5 },
    { maxQueries: '2' }, { maxQueries: 11 }, { maxNodes: 501 }, { maxEdges: 2001 }, { maxQueries: null }
  ])('rejects invalid input %p before I/O', async input => {
    const client = fixture([]);
    await expect(buildLoadDependencyGraph(client, { ...root, ...input } as never)).rejects.toThrow();
    expect(client.getLoadGraph).not.toHaveBeenCalled();
  });

  it('uses the existing fixed SQL/read channel and structured status end to end', async () => {
    const runQuery = jest.fn(async () => ({ values: [] }));
    const client = createLoadGraphClient({ runQuery });
    const handlers = new LoadGraphHandlers(client);
    expect(handlers.supports('buildLoadDependencyGraph')).toBe(true);
    expect(toolOperationClass('buildLoadDependencyGraph')).toBe('read-only');
    expect(usesSapExecutionGate('buildLoadDependencyGraph')).toBe(true);
    const result = await handlers.handle('buildLoadDependencyGraph', root);
    expect(result.structuredContent.result.collection.queryCount).toBe(1);
    expect(runQuery).toHaveBeenCalledWith(expect.stringContaining("INCLUDE LIKE 'A%'"), 2000, true);
    await expect(handlers.handle('buildLoadDependencyGraph', { ...root, maxDepth: 4 })).rejects.toMatchObject({ code: -32602 });
    await expect(handlers.handle('buildLoadDependencyGraph', { ...root, url: 'https://forged' })).rejects.toMatchObject({ code: -32602 });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});

describe('load reader acquisition status', () => {
  it('distinguishes empty success, malformed data and failure and redacts remote errors', async () => {
    const empty = await getLoadGraph(async () => ({ values: [] }), { objectName: 'A' });
    expect(empty.collection.loads?.status).toBe('ok');
    const malformed = await getLoadGraph(async () => ({}), { objectName: 'A' });
    expect(malformed.collection.loads?.status).toBe('failed');
    const failed = await getLoadGraph(async () => { throw new Error('Authorization: SECRET'); }, { objectName: 'A' });
    expect(failed.collection.loads?.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('SECRET');
  });

  it('tracks both directions independently, including a successful empty response', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ values: [] });
    const result = await getLoadGraph(query, { objectName: 'A', direction: 'both' });
    expect(result.collection).toMatchObject({ loads: { status: 'failed' }, loaded_by: { status: 'ok', rowCount: 0 } });
  });

  it('marks exact row-limit hits as potentially truncated, even when all edges are filtered', async () => {
    const values = Array.from({ length: 2000 }, () => ({ MASTER: 'A', INCLUDE: 'A', OBSOLETE_IN_VERSION: 0 }));
    const result = await getLoadGraph(async () => ({ values }), { objectName: 'A' });
    expect(result.loads).toEqual([]);
    expect(result.collection.loads).toEqual({ status: 'truncated', rowCount: 2000, rowLimit: 2000 });
  });
});
