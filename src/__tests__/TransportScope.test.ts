import { collectTransportScope } from '../adt/TransportScope';
import { DependencyGraphHandlers } from '../handlers/DependencyGraphHandlers';
import { TransportScopeHandlers } from '../handlers/TransportScopeHandlers';
import { usesSapExecutionGate } from '../lib/serverGuardrails';

const header = (id: string, parent = '') => ({ TRKORR: id, STRKORR: parent });
const member = (tr = 'DEVK900001', type = 'CLAS', name = 'ZCL_A', pgmid = 'R3TR') => ({ TRKORR: tr, PGMID: pgmid, OBJECT: type, OBJ_NAME: name });
function reader(...rows: unknown[]) {
  let index = 0;
  return jest.fn(async () => {
    const value = rows[index++];
    if (value instanceof Error) throw value;
    return value === undefined ? {} : { values: value as Record<string, unknown>[] };
  });
}
const input = { transports: ['DEVK900001'] };

describe('read-only explicit transport scope collector', () => {
  it('registers as a gated read-only tool and dispatches the collector', async () => {
    const handler = new TransportScopeHandlers(reader([header('DEVK900001')], [], [member()]));
    expect(handler.getTools()[0]).toMatchObject({ name: 'getTransportScope', annotations: { readOnlyHint: true }, _meta: { approvalRequired: false } });
    expect(usesSapExecutionGate('getTransportScope')).toBe(true);
    expect((await handler.handle('getTransportScope', input)).structuredContent.result.boundaryScope.objectIds).toEqual(['CLAS:ZCL_A']);
    await expect(handler.handle('wrong', input)).rejects.toMatchObject({ code: -32601 });
  });

  it.each([{}, { transports: ['BAD;SQL'] }, { ...input, sql: 'SELECT *' }, null, []])('handler rejects invalid arguments before reads: %j', async args => {
    const run = reader(); const handler = new TransportScopeHandlers(run);
    await expect(handler.handle('getTransportScope', args as any)).rejects.toMatchObject({ code: -32602 });
    expect(run).not.toHaveBeenCalled();
  });

  it('normalizes task to parent and includes siblings, deduplicating R3TR edges', async () => {
    const run = reader([header('DEVK900002', 'DEVK900001')], [header('DEVK900001')],
      [header('DEVK900002', 'DEVK900001'), header('DEVK900003', 'DEVK900001')],
      [member('DEVK900002'), member('DEVK900003'), member()]);
    const result = await collectTransportScope(run, { transports: [' devk900002 '] });
    expect(result.requests).toEqual(['DEVK900001']);
    expect(result.transports).toEqual(['DEVK900001', 'DEVK900002', 'DEVK900003']);
    expect(result.graph.edges).toEqual([{ from: 'CLAS:ZCL_A', to: 'TR:DEVK900001', kind: 'IN_TRANSPORT', source: 'E071' }]);
    expect(result.collection.status).toBe('complete-within-r3tr-reader-scope');
    expect(result.collection.queryCount).toBe(4);
    expect(result.systemWideComplete).toBe(false);
    const analysis = await new DependencyGraphHandlers().handle('analyzeDependencyGraph', {
      operation: 'boundaries', graph: result.graph, boundaryScope: result.boundaryScope
    });
    expect(analysis.structuredContent).toMatchObject({ result: { analysis: { transportMembershipVerified: false } } });
  });

  it('queries serially, deduplicates requested IDs, and uses only fixed SELECTs', async () => {
    const fixture = reader([header('DEVK900001')], [], [member()]);
    let active = 0, peak = 0;
    const run = jest.fn(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); const r = await fixture(); active--; return r; });
    const result = await collectTransportScope(run, { transports: ['DEVK900001', 'devk900001'] });
    expect(peak).toBe(1); expect(result.requested).toEqual(['DEVK900001']);
    expect(run.mock.calls).toHaveLength(3);
    for (const call of run.mock.calls as unknown as [string, number][]) {
      expect(call[0]).toMatch(/^SELECT .* FROM e07[01] WHERE /);
      expect([500, 2000]).toContain(call[1]);
    }
  });

  it.each([null, {}, { transports: [] }, { transports: 'DEVK900001' }, { transports: [1] },
    { transports: ["X' OR 1=1"] }, { transports: ['X;DROP'] }, { transports: ['X'.repeat(21)] },
    { transports: Array(11).fill('DEVK900001') }])('rejects invalid input before I/O: %j', async value => {
    const run = reader(); await expect(collectTransportScope(run, value as any)).rejects.toThrow(/transports requires/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, new Error('secret bearer token')])('does not turn failed or malformed headers into empty success: %j', async value => {
    const result = await collectTransportScope(reader(value), input);
    expect(result.collection.status).toBe('partial');
    expect(result.collection.reads[0].status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.collection.queryCount).toBe(1);
  });

  it('reports missing requested IDs without fabricating transport nodes', async () => {
    const result = await collectTransportScope(reader([]), input);
    expect(result.graph.nodes).toEqual([]); expect(result.requests).toEqual([]);
    expect(result.collection.issues).toContainEqual({ stage: 'requested-headers', reason: 'unresolved:DEVK900001' });
  });

  it('does not use a task whose parent could not be verified', async () => {
    const result = await collectTransportScope(reader([header('DEVK900002', 'DEVK900001')], []), { transports: ['DEVK900002'] });
    expect(result.requests).toEqual([]); expect(result.collection.queryCount).toBe(2);
    expect(result.graph.edges).toEqual([]);
  });

  it('does not recursively invent task hierarchy', async () => {
    const result = await collectTransportScope(reader([header('DEVK900002', 'DEVK900001')], [header('DEVK900001', 'DEVK900000')]), { transports: ['DEVK900002'] });
    expect(result.requests).toEqual([]); expect(result.collection.status).toBe('partial');
  });

  it('reports excluded LIMU and non-R3TR rows without name-based mapping', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], [], [member(), member(undefined, 'METH', 'ZCL_A', 'LIMU'), member(undefined, 'TABU', 'ZT', 'OTHER')]), input);
    expect(result.boundaryScope.objectIds).toEqual(['CLAS:ZCL_A']);
    expect(result.collection.excludedNonR3trRows).toBe(2);
    expect(result.collection.status).toBe('partial');
  });

  it('reports exact raw row limit even when all rows deduplicate', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], [], Array(2000).fill(member())), input);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.collection.reads[2].status).toBe('truncated');
    expect(result.collection.status).toBe('partial');
  });

  it('caps objects with valid snapshot endpoints', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], [], Array.from({ length: 451 }, (_, i) => member(undefined, 'PROG', `Z${i}`))), input);
    expect(result.boundaryScope.objectIds).toHaveLength(450); expect(result.graph.nodes).toHaveLength(451);
    expect(result.collection.issues).toContainEqual({ stage: 'members', reason: 'object-limit' });
    expect(result.graph.edges.every(e => result.graph.nodes.some(n => n.id === e.from) && result.graph.nodes.some(n => n.id === e.to))).toBe(true);
  });

  it('caps transport scope before constructing member SQL', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], Array.from({ length: 100 }, (_, i) => header(`DEVK8${i}`, 'DEVK900001')), []), input);
    expect(result.transports).toHaveLength(100);
    expect(result.collection.issues).toContainEqual({ stage: 'members', reason: 'transport-limit' });
  });

  it('rejects conflicting headers rather than taking last row', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001'), header('DEVK900001', 'DEVK900099')]), input);
    expect(result.requests).toEqual([]); expect(result.collection.status).toBe('partial');
  });

  it('rejects unrelated headers, missing parent columns and invalid rows', async () => {
    const result = await collectTransportScope(reader([header('OTHER'), { TRKORR: 'DEVK900001' }, null, header('DEVK900001', 'DEVK900001')]), input);
    expect(result.requests).toEqual([]); expect(result.collection.status).toBe('partial');
  });

  it('preserves evidence from valid members while reporting invalid identities or scope', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], [], [member(), member('OTHER'), member(undefined, 'TR'), member(undefined, 'CLAS', 'BAD:NAME'), { ...member(), OBJ_NAME: 12 }, { ...member(), 'E071.OBJ_NAME': 'ZOTHER' }]), input);
    expect(result.boundaryScope.objectIds).toEqual(['CLAS:ZCL_A']); expect(result.collection.status).toBe('partial');
  });

  it('supports qualified column names and namespace object names', async () => {
    const result = await collectTransportScope(reader([{ 'E070.TRKORR': 'DEVK900001', 'E070.STRKORR': '' }], [],
      [{ 'E071~TRKORR': 'DEVK900001', 'E071~PGMID': 'R3TR', 'E071~OBJECT': 'CLAS', 'E071~OBJ_NAME': '/ABC/ZCL_A' }]), input);
    expect(result.boundaryScope.objectIds).toEqual(['CLAS:/ABC/ZCL_A']);
  });

  it('reports object names beyond the snapshot contract instead of returning an unusable graph', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], [], [member(undefined, 'CLAS', 'Z'.repeat(81))]), input);
    expect(result.boundaryScope.objectIds).toEqual([]);
    expect(result.collection.issues).toContainEqual({ stage: 'members', reason: 'unsupported-object-identity' });
  });

  it('retains multiple transport memberships for the same object', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001'), header('DEVK900002')], [], [member(), member('DEVK900002')]), { transports: ['DEVK900002', 'DEVK900001'] });
    expect(result.boundaryScope.objectIds).toHaveLength(1); expect(result.graph.edges).toHaveLength(2);
  });

  it.each([1, 2])('marks later read failure partial without exposing errors (stage %i)', async stage => {
    const result = await collectTransportScope(reader([header('DEVK900001')], ...(stage === 1 ? [new Error('secret'), [member()]] : [[], new Error('secret')])), input);
    expect(result.collection.status).toBe('partial'); expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('distinguishes an observed empty R3TR scope from an unresolved request', async () => {
    const result = await collectTransportScope(reader([header('DEVK900001')], [], []), input);
    expect(result.collection.status).toBe('complete-within-r3tr-reader-scope');
    expect(result.boundaryScope.objectIds).toEqual([]); expect(result.deploymentReadinessVerified).toBe(false);
  });
});
