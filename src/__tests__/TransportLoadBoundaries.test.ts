import { collectTransportLoadBoundaries } from '../adt/TransportLoadBoundaries';
import { TransportScopeHandlers } from '../handlers/TransportScopeHandlers';
import { DependencyGraphHandlers } from '../handlers/DependencyGraphHandlers';

const tr = 'DEVK900001';
const member = (name: string, type = 'CLAS', pgmid = 'R3TR') => ({ TRKORR: tr, PGMID: pgmid, OBJECT: type, OBJ_NAME: name });
const load = (from: string, to: string) => ({ MASTER: `${from}===CP`, INCLUDE: `${to}===CP`, OBSOLETE_IN_VERSION: 0 });
function fixture(members: Record<string, unknown>[], loads: Record<string, unknown>[] | Error | undefined = []) {
  let active = 0, peak = 0;
  const run = jest.fn(async (sql: string, limit: number) => {
    active++; peak = Math.max(peak, active); await Promise.resolve();
    try {
      if (sql.includes('FROM e070 WHERE trkorr IN')) return { values: [{ TRKORR: tr, STRKORR: '' }] };
      if (sql.includes('FROM e070 WHERE strkorr IN')) return { values: [] };
      if (sql.includes('FROM e071')) return { values: members };
      expect(sql).toContain('FROM D010INC WHERE MASTER LIKE'); expect(limit).toBe(2000);
      if (loads instanceof Error) throw loads;
      return { values: loads };
    } finally { active--; }
  });
  return { run, peak: () => peak };
}
const input = { transports: [tr] };

describe('transport member and outgoing-load boundary composition', () => {
  it('collects every supported member once, classifies internal/external dependencies and never follows external targets', async () => {
    const f = fixture([member('ZA'), member('ZB')], [load('ZA', 'ZB'), load('ZB', 'ZOUT'), load('ZOUT', 'ZFAR')]);
    const result = await collectTransportLoadBoundaries(f.run, input);
    expect(result.collection).toMatchObject({ status: 'complete-within-r3tr-load-reader-scope', queryCount: 5, dependencyQueryCount: 2, skipped: [], issues: [] });
    expect(result.analysis?.summary).toMatchObject({ inScope: 1, inScopeUnknownPackage: 1, missingCustom: 1 });
    expect(result.graph.nodes.map(n => n.id)).not.toContain('CLAS:ZFAR');
    expect(result.graph.edges.filter(e => e.kind === 'IN_TRANSPORT')).toHaveLength(2);
    expect(f.peak()).toBe(1);
    expect(result.systemWideComplete).toBe(false); expect(result.deploymentReadinessVerified).toBe(false);
    const answer = await new DependencyGraphHandlers().handle('analyzeDependencyGraph', {
      operation: 'boundaries', graph: result.graph, boundaryScope: result.boundaryScope
    });
    expect(answer.structuredContent).toMatchObject({ result: { analysis: result.analysis } });
  });

  it('uses one global dependency budget, retaining skipped members in the scope', async () => {
    const f = fixture([member('ZA'), member('ZB'), member('ZC')], [load('ZA', 'ZB')]);
    const result = await collectTransportLoadBoundaries(f.run, { ...input, maxDependencyQueries: 1 });
    expect(result.collection.queryCount).toBe(4); expect(result.boundaryScope.objectIds).toHaveLength(3);
    expect(result.collection.skipped).toEqual([
      { nodeId: 'CLAS:ZB', reason: 'dependency-query-limit' }, { nodeId: 'CLAS:ZC', reason: 'dependency-query-limit' }
    ]);
    expect(result.analysis?.summary.inScope).toBe(1); expect(result.collection.status).toBe('partial');
  });

  it('reports unsupported objects without spending their dependency budget', async () => {
    const f = fixture([member('ZT', 'TABL'), member('Z'.repeat(41)), member('Z-A'), member('ZA')]);
    const result = await collectTransportLoadBoundaries(f.run, input);
    expect(result.collection.dependencyQueryCount).toBe(1);
    expect(result.collection.skipped).toHaveLength(3); expect(result.collection.status).toBe('partial');
    expect(result.analysis?.objectCount).toBe(4);
  });

  it('propagates membership partial state even when all load reads succeed', async () => {
    const result = await collectTransportLoadBoundaries(fixture([member('ZA'), member('ZA', 'METH', 'LIMU')]).run, input);
    expect(result.membership.collection.status).toBe('partial'); expect(result.collection.status).toBe('partial');
    expect(result.membership.collection.excludedNonR3trRows).toBe(1);
  });

  it('returns null analysis for empty membership without querying D010INC', async () => {
    const result = await collectTransportLoadBoundaries(fixture([]).run, input);
    expect(result.analysis).toBeNull(); expect(result.collection.dependencyQueryCount).toBe(0);
    expect(result.collection.queryCount).toBe(3);
  });

  it('unresolved transport is partial, not an empty successful dependency check', async () => {
    const result = await collectTransportLoadBoundaries(async () => ({ values: [] }), input);
    expect(result.analysis).toBeNull(); expect(result.collection.status).toBe('partial');
    expect(result.collection.queryCount).toBe(1);
  });

  it('redacts failed load reads and does not retry them', async () => {
    const f = fixture([member('ZA')], new Error('secret-password'));
    const result = await collectTransportLoadBoundaries(f.run, input);
    expect(result.collection.status).toBe('partial'); expect(result.collection.dependencyQueryCount).toBe(1);
    expect(result.collection.issues).toContainEqual({ nodeId: 'CLAS:ZA', reason: 'read-failed' });
    expect(JSON.stringify(result)).not.toContain('secret-password');
  });

  it('propagates raw reader row truncation despite duplicate edges', async () => {
    const result = await collectTransportLoadBoundaries(fixture([member('ZA')], Array(2000).fill(load('ZA', 'ZB'))).run, input);
    expect(result.collection.issues).toContainEqual({ nodeId: 'CLAS:ZA', reason: 'read-truncated' });
    expect(result.analysis?.summary.missingCustom).toBe(1);
  });

  it('enforces a global node cap while retaining all observed membership nodes', async () => {
    const members = Array.from({ length: 450 }, (_, i) => member(`Z${String(i).padStart(3, '0')}`));
    const loads = Array.from({ length: 100 }, (_, i) => load('Z000', `Y${i}`));
    const result = await collectTransportLoadBoundaries(fixture(members, loads).run, { ...input, maxDependencyQueries: 1 });
    expect(result.graph.nodes).toHaveLength(500); expect(result.boundaryScope.objectIds).toHaveLength(450);
    expect(result.collection.issues).toContainEqual({ nodeId: 'CLAS:Z000', reason: 'graph-node-limit' });
    expect(result.graph.edges.every(e => result.graph.nodes.some(n => n.id === e.from) && result.graph.nodes.some(n => n.id === e.to))).toBe(true);
  });

  it('enforces shared detail limits without reducing summary counts', async () => {
    const result = await collectTransportLoadBoundaries(fixture([member('ZA')], [load('ZA', 'ZB'), load('ZA', 'ZC')]).run, { ...input, maxEntries: 1 });
    expect(result.analysis).toMatchObject({ truncated: true, returnedEntries: 1, totalEntries: 2 });
    expect(result.analysis?.summary.missingCustom).toBe(2);
  });

  it('caps total graph edges across reads, then skips additional member reads', async () => {
    const members = Array.from({ length: 6 }, (_, i) => member(`ZA${i}`));
    const f = fixture(members);
    const run = async (sql: string, limit: number) => {
      if (sql.includes('FROM D010INC')) {
        const name = /MASTER LIKE '([^%]+)%'/.exec(sql)![1];
        return { values: Array.from({ length: 450 }, (_, i) => load(name, `ZB${i}`)) };
      }
      return f.run(sql, limit);
    };
    const result = await collectTransportLoadBoundaries(run, { ...input, maxDependencyQueries: 10 });
    expect(result.graph.edges).toHaveLength(2000);
    expect(result.collection.dependencyQueryCount).toBe(5);
    expect(result.collection.issues).toContainEqual({ nodeId: 'CLAS:ZA4', reason: 'graph-edge-limit' });
    expect(result.collection.skipped).toContainEqual({ nodeId: 'CLAS:ZA5', reason: 'graph-edge-limit' });
  });

  it('keeps valid load evidence but reports malformed rows as partial', async () => {
    const rows = [load('ZA', 'ZB'), {}, null, { MASTER: 5, INCLUDE: 'ZB' }, { ...load('ZA', 'ZC'), OBSOLETE_IN_VERSION: 'invalid' }];
    const result = await collectTransportLoadBoundaries(fixture([member('ZA')], rows as any).run, input);
    expect(result.collection.status).toBe('partial');
    expect(result.collection.issues).toContainEqual({ nodeId: 'CLAS:ZA', reason: 'read-partial' });
    expect(result.analysis?.summary.missingCustom).toBe(1);
  });

  it('does not collapse a same-name different-type load into the member identity', async () => {
    const result = await collectTransportLoadBoundaries(fixture([member('ZA', 'PROG')], [load('ZA', 'ZB')]).run, input);
    expect(result.graph.edges.filter(e => e.kind === 'LOADS')).toEqual([]);
    expect(result.boundaryScope.objectIds).toEqual(['PROG:ZA']);
  });

  it('supports outgoing function-group and interface loads without reverse lookup', async () => {
    const rows = [{ MASTER: 'SAPLZFG', INCLUDE: 'ZB===CP' }, { MASTER: 'ZIF===IP', INCLUDE: 'ZB===CP' }];
    const result = await collectTransportLoadBoundaries(fixture([member('ZFG', 'FUGR'), member('ZIF', 'INTF')], rows).run, input);
    expect(result.analysis?.summary.missingCustom).toBe(2);
    expect(result.collection.skipped).toEqual([]);
  });

  it.each([0, 11, 1.5, '1', null, Infinity])('rejects dependency budget %p before membership reads', async maxDependencyQueries => {
    const f = fixture([]);
    await expect(collectTransportLoadBoundaries(f.run, { ...input, maxDependencyQueries } as any)).rejects.toThrow(/Budgets/);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([0, 501, NaN])('rejects invalid maxEntries %p before reads', async maxEntries => {
    const f = fixture([]);
    await expect(collectTransportLoadBoundaries(f.run, { ...input, maxEntries })).rejects.toThrow(/Budgets/);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('handler makes composition opt-in and preserves plain scope output', async () => {
    const f = fixture([member('ZA')], [load('ZA', 'ZB')]);
    const handler = new TransportScopeHandlers(f.run);
    const basic = await handler.handle('getTransportScope', input);
    expect(basic.structuredContent.result).not.toHaveProperty('analysis');
    expect(f.run).toHaveBeenCalledTimes(3);
    const composed = await handler.handle('getTransportScope', { ...input, includeLoadBoundaries: true });
    expect(composed.structuredContent.result).toMatchObject({ scope: 'explicit-transport-outgoing-loads', analysis: { summary: { missingCustom: 1 } } });
  });

  it.each([{ includeLoadBoundaries: 'true' }, { includeLoadBoundaries: null }, { maxEntries: 1 },
    { includeLoadBoundaries: false, maxDependencyQueries: 1 }, { includeLoadBoundaries: true, maxDependencyQueries: 11 }])('handler rejects invalid options %j without reads', async options => {
    const f = fixture([]); const handler = new TransportScopeHandlers(f.run);
    await expect(handler.handle('getTransportScope', { ...input, ...options })).rejects.toMatchObject({ code: -32602 });
    expect(f.run).not.toHaveBeenCalled();
  });
});
