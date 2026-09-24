import type { DependencySnapshot } from '../lib/DependencyGraph.js';
import type { TransportHistoryQueryRunner } from './TransportHistoryApi.js';

/** Read-only E070/E071 composition, aligned with VSP builder_transport.go.
 * LIMU entries are reported, never guessed into repository objects.
 */
export class TransportScopeInputError extends Error {}
const transportPattern = /^[A-Z0-9_]{1,20}$/;
const objectPattern = /^[A-Z0-9_/=$%<>~.-]{1,80}$/;
const list = (values: string[]) => values.map(value => `'${value}'`).join(', ');
function cell(row: Record<string, unknown>, name: string): string | undefined {
  const keys = Object.keys(row).filter(key => key.toUpperCase() === name || key.toUpperCase().endsWith(`~${name}`) || key.toUpperCase().endsWith(`.${name}`));
  if (keys.length !== 1 || typeof row[keys[0]] !== 'string') return undefined;
  return (row[keys[0]] as string).trim().toUpperCase();
}

export async function collectTransportScope(runQuery: TransportHistoryQueryRunner, input: { transports: string[] }) {
  if (!input || !Array.isArray(input.transports) || input.transports.length < 1 || input.transports.length > 10
    || input.transports.some(id => typeof id !== 'string' || !transportPattern.test(id.trim().toUpperCase()))) {
    throw new TransportScopeInputError('transports requires 1 to 10 transport IDs matching [A-Z0-9_], at most 20 characters each.');
  }
  const requested = [...new Set(input.transports.map(id => id.trim().toUpperCase()))].sort();
  const issues: { stage: string; reason: string }[] = [];
  const reads: { stage: string; status: 'ok' | 'failed' | 'truncated'; rowCount: number; rowLimit: number }[] = [];
  async function read(stage: string, sql: string, limit: number): Promise<Record<string, unknown>[]> {
    try {
      const result = await runQuery(sql, limit);
      if (!Array.isArray(result?.values)) throw new Error('Malformed query result');
      const rows = result.values;
      const status = rows.length >= limit ? 'truncated' : 'ok';
      reads.push({ stage, status, rowCount: rows.length, rowLimit: limit });
      if (status === 'truncated') issues.push({ stage, reason: 'row-limit' });
      return rows.slice(0, limit).filter(row => {
        if (row && typeof row === 'object' && !Array.isArray(row)) return true;
        issues.push({ stage, reason: 'invalid-row' }); return false;
      });
    } catch {
      reads.push({ stage, status: 'failed', rowCount: 0, rowLimit: limit });
      issues.push({ stage, reason: 'read-failed' }); return [];
    }
  }
  const headers = new Map<string, string>();
  const conflicted = new Set<string>();
  function acceptHeaders(rows: Record<string, unknown>[], stage: string, accept: (id: string, parent: string) => boolean) {
    for (const row of rows) {
      const id = cell(row, 'TRKORR'), parent = cell(row, 'STRKORR');
      if (!id || !transportPattern.test(id) || parent === undefined || (parent !== '' && !transportPattern.test(parent))
        || id === parent || !accept(id, parent)) {
        issues.push({ stage, reason: 'invalid-or-out-of-scope-header' }); continue;
      }
      if (conflicted.has(id)) continue;
      if (headers.has(id) && headers.get(id) !== parent) {
        headers.delete(id); conflicted.add(id); issues.push({ stage, reason: 'conflicting-header' }); continue;
      }
      headers.set(id, parent);
    }
  }
  const initial = await read('requested-headers', `SELECT trkorr, strkorr FROM e070 WHERE trkorr IN (${list(requested)})`, 500);
  acceptHeaders(initial, 'requested-headers', id => requested.includes(id));
  for (const id of requested) if (!headers.has(id)) issues.push({ stage: 'requested-headers', reason: `unresolved:${id}` });
  const parents = [...new Set([...headers.values()].filter(Boolean))].sort();
  if (parents.length) {
    const rows = await read('parent-headers', `SELECT trkorr, strkorr FROM e070 WHERE trkorr IN (${list(parents)})`, 500);
    acceptHeaders(rows, 'parent-headers', (id, parent) => parents.includes(id) && parent === '');
    for (const id of parents) if (headers.get(id) !== '') issues.push({ stage: 'parent-headers', reason: `unresolved:${id}` });
  }
  const requests = [...headers].filter(([id, parent]) => parent === '' && (requested.includes(id) || parents.includes(id))).map(([id]) => id).sort();
  if (requests.length) {
    const rows = await read('sibling-tasks', `SELECT trkorr, strkorr FROM e070 WHERE strkorr IN (${list(requests)})`, 500);
    acceptHeaders(rows, 'sibling-tasks', (_id, parent) => requests.includes(parent));
  }
  // A conflicting parent invalidates its entire scope, not just its header row.
  const validRequests = requests.filter(id => headers.get(id) === '');
  const allTransports = [...headers].filter(([id, parent]) => validRequests.includes(parent || id)).map(([id]) => id).sort();
  const transports = allTransports.slice(0, 100);
  if (allTransports.length > transports.length) issues.push({ stage: 'members', reason: 'transport-limit' });
  const graph: DependencySnapshot = { nodes: validRequests.map(name => ({ id: `TR:${name}`, name, type: 'TR' })), edges: [] };
  const objects = new Map<string, { id: string; name: string; type: string }>();
  const edges = new Set<string>();
  let excludedNonR3trRows = 0;
  if (transports.length) {
    const rows = await read('members', `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN (${list(transports)})`, 2000);
    for (const row of rows) {
      const tr = cell(row, 'TRKORR'), pgmid = cell(row, 'PGMID');
      if (!tr || !transports.includes(tr) || !pgmid) { issues.push({ stage: 'members', reason: 'invalid-or-out-of-scope-member' }); continue; }
      if (pgmid !== 'R3TR') { excludedNonR3trRows++; continue; }
      const type = cell(row, 'OBJECT'), name = cell(row, 'OBJ_NAME');
      if (!type || !/^[A-Z0-9_]{1,4}$/.test(type) || ['TR', 'DYNAMIC', 'TVARVC'].includes(type) || !name || !objectPattern.test(name)) {
        issues.push({ stage: 'members', reason: 'unsupported-object-identity' }); continue;
      }
      const id = `${type}:${name}`, request = headers.get(tr) || tr;
      if (!objects.has(id) && objects.size >= 450) { issues.push({ stage: 'members', reason: 'object-limit' }); continue; }
      objects.set(id, { id, name, type });
      const key = `${id}|${request}`;
      if (!edges.has(key)) { edges.add(key); graph.edges.push({ from: id, to: `TR:${request}`, kind: 'IN_TRANSPORT', source: 'E071' }); }
    }
  }
  graph.nodes.push(...[...objects.values()].sort((a, b) => a.id.localeCompare(b.id)));
  graph.edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  if (excludedNonR3trRows) issues.push({ stage: 'members', reason: 'non-r3tr-unresolved' });
  const uniqueIssues = [...new Map(issues.map(issue => [`${issue.stage}:${issue.reason}`, issue])).values()];
  return {
    requested, requests: validRequests, transports, graph,
    boundaryScope: { label: 'Explicit transport R3TR union', objectIds: [...objects.keys()].sort() },
    collection: { status: uniqueIssues.length ? 'partial' : 'complete-within-r3tr-reader-scope', reads, issues: uniqueIssues,
      excludedNonR3trRows, queryCount: reads.length, limits: { transports: 100, objects: 450, rowsPerMemberRead: 2000 } },
    systemWideComplete: false, deploymentReadinessVerified: false,
    notes: ['Explicit transport union only; no E070A CR grouping.', 'Task selection expands to its parent request and sibling tasks.',
      'Only observed R3TR rows are members. LIMU and other entries are not mapped.',
      'Reads are not an atomic snapshot; membership can change between queries.',
      'Empty member scope cannot be passed to boundary analysis. Membership edges alone are not structural dependencies.']
  };
}
