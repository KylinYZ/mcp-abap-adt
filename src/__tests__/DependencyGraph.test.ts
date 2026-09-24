import { dependencyGraphStats, dependencyImpact, type DependencySnapshot, type GraphEdgeKind } from '../lib/DependencyGraph';
import { DependencyGraphHandlers } from '../handlers/DependencyGraphHandlers';
import { toolOperationClass } from '../config/ToolOperationPolicy';
import { usesSapExecutionGate } from '../lib/serverGuardrails';

const node = (name: string, type = 'CLAS') => ({ id: `${type}:${name}`, name, type, package: '$ZDEV' });
const edge = (from: string, to: string, kind: GraphEdgeKind = 'CALLS', source = 'PARSER') => ({ from, to, kind, source });
const chain = (): DependencySnapshot => ({
  nodes: ['A', 'B', 'C', 'D'].map(name => node(name)),
  edges: [edge('CLAS:B', 'CLAS:A'), edge('CLAS:C', 'CLAS:B'), edge('CLAS:D', 'CLAS:C', 'REFERENCES', 'WBCROSSGT')]
});

describe('VSP-aligned offline dependency graph', () => {
  it('follows incoming edges, retains provenance and excludes the root', () => {
    const result = dependencyImpact(chain(), 'CLAS:A');
    expect(result.entries.map(n => [n.id, n.depth, n.viaFrom])).toEqual([
      ['CLAS:B', 1, 'CLAS:A'], ['CLAS:C', 2, 'CLAS:B'], ['CLAS:D', 3, 'CLAS:C']
    ]);
    expect(result.entries[2]).toMatchObject({ viaEdge: 'REFERENCES', viaSource: 'WBCROSSGT', package: '$ZDEV' });
    expect(result.completeWithinSnapshot).toBe(true);
    expect(dependencyImpact(chain(), 'CLAS:D').entries).toEqual([]);
  });

  it('reports a depth cutoff rather than claiming complete impact', () => {
    expect(dependencyImpact(chain(), 'CLAS:A', { maxDepth: 2 })).toMatchObject({
      entries: [{ id: 'CLAS:B' }, { id: 'CLAS:C' }], depthLimitReached: true, completeWithinSnapshot: false
    });
  });

  it('handles cycles, self edges and duplicate evidence without duplicate nodes', () => {
    const graph = chain();
    graph.edges.push(edge('CLAS:A', 'CLAS:D'), edge('CLAS:A', 'CLAS:A'), edge('CLAS:B', 'CLAS:A', 'REFERENCES'));
    const result = dependencyImpact(graph, 'CLAS:A', { maxDepth: 10 });
    expect(result.entries.map(n => n.id)).toEqual(['CLAS:B', 'CLAS:C', 'CLAS:D']);
    expect(result.completeWithinSnapshot).toBe(true);
  });

  it('chooses shortest paths in a diamond, stable by input edge order', () => {
    const graph = chain();
    graph.edges.push(edge('CLAS:D', 'CLAS:A'), edge('CLAS:C', 'CLAS:D'));
    expect(dependencyImpact(graph, 'CLAS:A').entries.map(n => [n.id, n.depth, n.viaFrom])).toEqual([
      ['CLAS:B', 1, 'CLAS:A'], ['CLAS:D', 1, 'CLAS:A'], ['CLAS:C', 2, 'CLAS:B']
    ]);
  });

  it('filters edge kinds without changing LOADS into CALLS', () => {
    const graph = chain();
    graph.edges.push(edge('CLAS:D', 'CLAS:A', 'LOADS', 'D010INC'));
    expect(dependencyImpact(graph, 'CLAS:A', { edgeKinds: ['LOADS'] }).entries)
      .toEqual([expect.objectContaining({ id: 'CLAS:D', depth: 1, viaEdge: 'LOADS', viaSource: 'D010INC' })]);
    expect(dependencyImpact(graph, 'CLAS:A', { edgeKinds: [] })).toEqual(dependencyImpact(graph, 'CLAS:A'));
  });

  it('crosses transport and code layers only when the edge filter permits it', () => {
    const graph = chain();
    graph.nodes.push(node('DEVK900001', 'TR'));
    graph.edges.push(edge('CLAS:A', 'TR:DEVK900001', 'IN_TRANSPORT', 'E071'));
    expect(dependencyImpact(graph, 'TR:DEVK900001', { maxDepth: 2 }).entries.map(n => n.id))
      .toEqual(['CLAS:A', 'CLAS:B']);
    expect(dependencyImpact(graph, 'TR:DEVK900001', { edgeKinds: ['IN_TRANSPORT'] }).entries.map(n => n.id))
      .toEqual(['CLAS:A']);
  });

  it('bounds fan-out and reports only actual truncation', () => {
    const graph = { nodes: [node('A'), ...Array.from({ length: 50 }, (_, i) => node(`B${i}`))],
      edges: Array.from({ length: 50 }, (_, i) => edge(`CLAS:B${i}`, 'CLAS:A')) };
    const limited = dependencyImpact(graph, 'CLAS:A', { maxEntries: 5 });
    expect(limited.entries).toHaveLength(5);
    expect(limited.entryLimitReached).toBe(true);
    expect(limited.completeWithinSnapshot).toBe(false);
    expect(dependencyImpact(graph, 'CLAS:A', { maxEntries: 50 }).entryLimitReached).toBe(false);
  });

  it('does not mistake back edges at the depth frontier for a cutoff', () => {
    const graph = chain();
    graph.edges.push(edge('CLAS:A', 'CLAS:D'), edge('CLAS:B', 'CLAS:D'));
    expect(dependencyImpact(graph, 'CLAS:A', { maxDepth: 3 }).depthLimitReached).toBe(false);
  });

  it('reports an isolated node as empty and rejects an unknown root', () => {
    expect(dependencyImpact({ nodes: [node('A')], edges: [] }, 'CLAS:A').entries).toEqual([]);
    expect(() => dependencyImpact(chain(), 'CLAS:MISSING')).toThrow(/root/);
  });

  it.each([0, -1, 1.5, Infinity, NaN, 11])('rejects invalid core depth %p', maxDepth => {
    expect(() => dependencyImpact(chain(), 'CLAS:A', { maxDepth })).toThrow(/bounds/);
  });

  it('counts duplicate edges as evidence and safely handles object-prototype labels', () => {
    const graph = chain();
    graph.edges.push(edge('CLAS:B', 'CLAS:A', 'CALLS', '__proto__'));
    graph.nodes[0].package = 'constructor';
    const stats = dependencyGraphStats(graph);
    expect(stats).toMatchObject({ nodeCount: 4, edgeCount: 4, byNodeType: { CLAS: 4 }, byEdgeKind: { CALLS: 3, REFERENCES: 1 } });
    expect(stats.bySource['__proto__']).toBe(1);
    expect(stats.byPackage.constructor).toBe(1);
    expect(JSON.parse(JSON.stringify(stats)).bySource['__proto__']).toBe(1);
    expect(dependencyGraphStats({ nodes: [], edges: [] })).toMatchObject({ nodeCount: 0, edgeCount: 0 });
  });

  it('does not mutate its snapshot', () => {
    const graph = chain();
    const before = JSON.stringify(graph);
    dependencyImpact(graph, 'CLAS:A'); dependencyGraphStats(graph);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe('offline graph MCP boundary', () => {
  const handlers = new DependencyGraphHandlers();
  const call = (args: Record<string, unknown>) => handlers.handle('analyzeDependencyGraph', args);

  it('is local-only, does not require the SAP execution gate, and carries explicit evidence limits', async () => {
    expect(toolOperationClass('analyzeDependencyGraph')).toBe('local');
    expect(usesSapExecutionGate('analyzeDependencyGraph')).toBe(false);
    expect(handlers.getTools()[0]).toMatchObject({
      annotations: { openWorldHint: false, readOnlyHint: true }, _meta: { operationClass: 'local-only' }
    });
    const result = await call({ operation: 'impact', graph: chain(), root: 'CLAS:A' });
    expect(result.structuredContent).toMatchObject({ result: {
      scope: 'caller-supplied-snapshot', sapConnectionVerified: false, evidenceVerified: false,
      analysis: { entries: expect.any(Array) }, notes: expect.arrayContaining([expect.stringMatching(/not proof/)] )
    } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(result.structuredContent);
  });

  it('accepts empty stats and namespaced nodes', async () => {
    await expect(call({ operation: 'stats', graph: { nodes: [], edges: [] } })).resolves.toMatchObject({
      structuredContent: { result: { analysis: { nodeCount: 0, edgeCount: 0 } } }
    });
    await expect(call({ operation: 'impact', graph: { nodes: [node('/ACME/ZCL')], edges: [] }, root: 'CLAS:/ACME/ZCL' }))
      .resolves.toBeDefined();
  });

  it.each([
    { operation: 'unknown' }, { operation: 'impact' }, { operation: 'impact', root: 'CLAS:MISSING' },
    { operation: 'stats', root: 'CLAS:A' }, { operation: 'stats', maxDepth: 2 },
    { operation: 'impact', root: 'CLAS:A', maxDepth: '3' },
    { operation: 'impact', root: 'CLAS:A', maxEntries: 0 },
    { operation: 'impact', root: 'CLAS:A', maxEntries: 501 },
    { operation: 'impact', root: 'CLAS:A', edgeKinds: ['BOGUS'] },
    { operation: 'stats', url: 'https://example.test' }
  ])('rejects invalid arguments %p', async args => {
    await expect(call({ graph: chain(), ...args })).rejects.toMatchObject({ code: -32602 });
  });

  it.each([
    null, [], {}, { nodes: null, edges: [] },
    { nodes: [node('A'), node('A')], edges: [] },
    { nodes: [{ ...node('A'), id: 'CLAS:B' }], edges: [] },
    { nodes: [node('lowercase')], edges: [] },
    { nodes: [node('A')], edges: [edge('CLAS:B', 'CLAS:A')] },
    { nodes: [node('A')], edges: [{ ...edge('CLAS:A', 'CLAS:A'), source: '' }] },
    { nodes: [node('A')], edges: [{ ...edge('CLAS:A', 'CLAS:A'), lockHandle: 'forged' }] },
    { nodes: Array.from({ length: 501 }, (_, i) => node(`N${i}`)), edges: [] },
    { nodes: [node('A')], edges: Array.from({ length: 2001 }, () => edge('CLAS:A', 'CLAS:A')) }
  ])('rejects malformed or unbounded snapshots %#', async graph => {
    await expect(call({ operation: 'stats', graph })).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects unsupported tool names', async () => {
    await expect(handlers.handle('other', {})).rejects.toMatchObject({ code: -32601 });
  });
});
