import { transportBoundaries } from '../lib/TransportBoundaries';
import { DependencyGraphHandlers } from '../handlers/DependencyGraphHandlers';
import type { DependencySnapshot, GraphEdgeKind } from '../lib/DependencyGraph';
import { applyToolArgumentLimits } from '../lib/requestLimits';
import { RuntimeGuardrails } from '../config/RuntimeGuardrails';

const node = (name: string, type = 'CLAS', packageName?: string) => ({ id: `${type}:${name}`, name, type, ...(packageName ? { package: packageName } : {}) });
const edge = (from: string, to: string, kind: GraphEdgeKind = 'CALLS', source = 'PARSER') => ({ from, to, kind, source });
function fixture(): DependencySnapshot {
  return { nodes: [node('ZORDER', 'CLAS', 'ZCORE'), node('ZITEM', 'CLAS', 'ZITEMS'),
    node('ZMAIN', 'PROG', 'ZCORE'), node('ZLOGGER', 'INTF'), node('CL_GUI_ALV_GRID')],
    edges: [edge('CLAS:ZORDER', 'CLAS:ZITEM'), edge('CLAS:ZORDER', 'INTF:ZLOGGER', 'REFERENCES', 'WBCROSSGT'),
      edge('CLAS:ZORDER', 'CLAS:CL_GUI_ALV_GRID', 'REFERENCES'), edge('PROG:ZMAIN', 'CLAS:ZORDER')] };
}
const scope = () => ({ label: 'DEVK900001', objectIds: ['CLAS:ZORDER', 'CLAS:ZITEM', 'PROG:ZMAIN'] });

describe('offline VSP-aligned TR/CR boundaries', () => {
  it('classifies the VSP basic fixture with full package accounting', () => {
    const report = transportBoundaries(fixture(), scope());
    expect(report.summary).toEqual({ totalDependencies: 4, inScope: 2, inScopeSamePackage: 1,
      inScopeCrossPackage: 1, inScopeUnknownPackage: 0, missingCustom: 1, standardCandidates: 1, unknownNamespace: 0, dynamic: 0 });
    expect(report.entries.missingCustom[0].to.id).toBe('INTF:ZLOGGER');
    expect(report.entries.standardCandidates[0].to.name).toBe('CL_GUI_ALV_GRID');
    expect(report.entries.crossPackage[0].to.package).toBe('ZITEMS');
    expect(report).toMatchObject({ transportMembershipVerified: false, deploymentReadinessVerified: false, systemWideComplete: false });
    expect(report.summary).not.toHaveProperty('selfConsistent');
  });

  it('allows the same explicit set to represent a CR union without interpreting its label', () => {
    const a = transportBoundaries(fixture(), scope());
    const b = transportBoundaries(fixture(), { ...scope(), label: 'CR-42 (two transports)' });
    expect(a.summary).toEqual(b.summary); expect(a.entries).toEqual(b.entries);
    expect(b.label).toBe('CR-42 (two transports)');
  });

  it('does not infer membership from IN_TRANSPORT edges', () => {
    const graph = fixture(); graph.nodes.push(node('DEVK900001', 'TR'));
    graph.edges.push(edge('INTF:ZLOGGER', 'TR:DEVK900001', 'IN_TRANSPORT', 'E071'));
    expect(transportBoundaries(graph, scope()).summary.missingCustom).toBe(1);
  });

  it('ignores non-structural edges, self references and edges originating outside the scope', () => {
    const graph = fixture();
    graph.edges.push(edge('CLAS:ZORDER', 'CLAS:ZORDER'), edge('INTF:ZLOGGER', 'CLAS:ZORDER'),
      edge('CLAS:ZORDER', 'INTF:ZLOGGER', 'IN_TRANSPORT'), edge('CLAS:ZORDER', 'INTF:ZLOGGER', 'CO_TRANSPORTED'),
      edge('CLAS:ZORDER', 'INTF:ZLOGGER', 'READS_CONFIG'));
    expect(transportBoundaries(graph, scope()).summary.totalDependencies).toBe(4);
  });

  it('never fuzzy-matches a same-named object of a different type', () => {
    const graph = fixture(); graph.nodes.push(node('ZITEM', 'TYPE'));
    graph.edges.push(edge('CLAS:ZORDER', 'TYPE:ZITEM', 'REFERENCES'));
    expect(transportBoundaries(graph, scope()).entries.missingCustom.map(e => e.to.id)).toEqual(['INTF:ZLOGGER', 'TYPE:ZITEM']);
  });

  it('keeps namespace ownership unknown rather than treating all slashed names as SAP standard', () => {
    const graph = fixture(); graph.nodes.push(node('/ACME/ZOBJ')); graph.nodes.push(node('/SAP/OBJ'));
    graph.edges.push(edge('CLAS:ZORDER', 'CLAS:/ACME/ZOBJ'), edge('CLAS:ZORDER', 'CLAS:/SAP/OBJ'));
    expect(transportBoundaries(graph, scope()).summary).toMatchObject({ unknownNamespace: 2, standardCandidates: 1 });
  });

  it('does not convert missing package metadata into same-package evidence', () => {
    const graph = fixture(); delete graph.nodes[1].package;
    expect(transportBoundaries(graph, scope()).summary).toMatchObject({ inScope: 2, inScopeSamePackage: 1, inScopeCrossPackage: 0, inScopeUnknownPackage: 1 });
  });

  it('keeps dynamic evidence unresolved even if its target is an in-scope node', () => {
    const graph = fixture(); graph.edges.push(edge('CLAS:ZORDER', 'CLAS:ZITEM', 'DYNAMIC_CALL'));
    const report = transportBoundaries(graph, scope());
    expect(report.summary.dynamic).toBe(1); expect(report.summary.inScope).toBe(2);
    expect(report.summary.totalDependencies).toBe(5);
  });

  it('retains dynamic self-references and handles explicitly marked dynamic placeholders', () => {
    const graph = fixture(); graph.nodes.push(node('LV_FM', 'DYNAMIC'));
    graph.edges.push(edge('CLAS:ZORDER', 'DYNAMIC:LV_FM', 'DYNAMIC_CALL'),
      edge('CLAS:ZORDER', 'DYNAMIC:LV_FM', 'REFERENCES'), edge('CLAS:ZORDER', 'CLAS:ZORDER', 'DYNAMIC_CALL'));
    expect(transportBoundaries(graph, scope()).summary.dynamic).toBe(2);
  });

  it('merges duplicate static pairs while preserving all sorted kinds and evidence sources', () => {
    const graph = fixture(); graph.edges.push(edge('CLAS:ZORDER', 'INTF:ZLOGGER', 'CALLS', 'CROSS'),
      edge('CLAS:ZORDER', 'INTF:ZLOGGER', 'REFERENCES', 'WBCROSSGT'));
    const report = transportBoundaries(graph, scope());
    expect(report.summary.totalDependencies).toBe(4);
    expect(report.entries.missingCustom[0]).toMatchObject({ edgeKinds: ['CALLS', 'REFERENCES'], sources: ['CROSS', 'WBCROSSGT'] });
  });

  it('is deterministic under input node, scope and edge reordering', () => {
    const graph = fixture(); const original = transportBoundaries(graph, scope());
    expect(transportBoundaries({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() },
      { ...scope(), objectIds: scope().objectIds.reverse() })).toEqual(original);
  });

  it('bounds total detail output while keeping the full summary and prioritizing missing custom objects', () => {
    const report = transportBoundaries(fixture(), scope(), 1);
    expect(report.summary.totalDependencies).toBe(4);
    expect(report).toMatchObject({ totalEntries: 3, returnedEntries: 1, truncated: true });
    expect(report.entries.missingCustom).toHaveLength(1);
    expect(Object.values(report.entries).flat()).toHaveLength(1);
    expect(transportBoundaries(fixture(), scope(), 3).truncated).toBe(false);
  });

  it('returns no deployment approval for an isolated in-scope object', () => {
    const report = transportBoundaries({ nodes: [node('ZEMPTY')], edges: [] }, { label: 'empty sample', objectIds: ['CLAS:ZEMPTY'] });
    expect(report.summary.totalDependencies).toBe(0);
    expect(report.deploymentReadinessVerified).toBe(false);
  });

  it('does not mutate graph or scope inputs', () => {
    const graph = fixture(), input = scope(), before = JSON.stringify([graph, input]);
    transportBoundaries(graph, input);
    expect(JSON.stringify([graph, input])).toBe(before);
  });

  it.each([0, 501, NaN, 1.5])('rejects invalid core output budget %p', limit => {
    expect(() => transportBoundaries(fixture(), scope(), limit)).toThrow(/limit/);
  });
});

describe('boundaries MCP arguments and safety metadata', () => {
  const handler = new DependencyGraphHandlers();
  const call = (args: Record<string, unknown>) => handler.handle('analyzeDependencyGraph', args);
  const input = () => ({ operation: 'boundaries', graph: fixture(), boundaryScope: scope() });

  it('passes through strict global field validation and preserves the local-only contract', async () => {
    const args = applyToolArgumentLimits('analyzeDependencyGraph', input(), RuntimeGuardrails.fromEnvironment({}));
    const result = await call(args);
    expect(result.structuredContent).toMatchObject({ result: { operation: 'boundaries', evidenceVerified: false,
      analysis: { objectCount: 3, transportMembershipVerified: false } } });
    expect(handler.getTools()[0]).toMatchObject({ annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { operationClass: 'local-only' } });
  });

  it('accepts an explicit DYNAMIC edge and reports it without changing stats/impact semantics', async () => {
    const graph = fixture(); graph.nodes.push(node('LV_METHOD', 'DYNAMIC'));
    graph.edges.push(edge('CLAS:ZORDER', 'DYNAMIC:LV_METHOD', 'DYNAMIC_CALL'));
    expect((await call({ ...input(), graph })).structuredContent).toMatchObject({ result: { analysis: { summary: { dynamic: 1 } } } });
    expect((await call({ operation: 'stats', graph })).structuredContent).toMatchObject({ result: { analysis: { byEdgeKind: { DYNAMIC_CALL: 1 } } } });
  });

  it.each([
    { boundaryScope: undefined }, { boundaryScope: null }, { boundaryScope: { label: 'TR', objectIds: [] } },
    { boundaryScope: { label: 'TR', objectIds: ['CLAS:MISSING'] } },
    { boundaryScope: { label: 'TR', objectIds: ['CLAS:ZORDER', 'CLAS:ZORDER'] } },
    { boundaryScope: { label: 'TR', objectIds: ['CLAS:ZORDER'], confirmed: true } },
    { boundaryScope: { label: '', objectIds: ['CLAS:ZORDER'] } },
    { boundaryScope: { label: 'TR', objectIds: ['CLAS:ZORDER'], transports: ['DEVK900001'] } },
    { operation: 'stats' }, { operation: 'impact', root: 'CLAS:ZORDER' }, { operation: ['boundaries'] },
    { root: 'CLAS:ZORDER' }, { edgeKinds: ['CALLS'] }, { maxDepth: 1 }, { maxEntries: '2' }
  ])('rejects invalid or irrelevant arguments %#', async overrides => {
    await expect(call({ ...input(), ...overrides })).rejects.toMatchObject({ code: -32602 });
  });

  it.each(['TR', 'DYNAMIC', 'TVARVC'])('rejects non-repository scope member %s', async type => {
    const graph = fixture(); graph.nodes.push(node('ZNOT_OBJECT', type));
    await expect(call({ ...input(), graph, boundaryScope: { label: 'TR', objectIds: [`${type}:ZNOT_OBJECT`] } })).rejects.toMatchObject({ code: -32602 });
  });
});
