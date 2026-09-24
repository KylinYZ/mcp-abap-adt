// Offline only: two fresh MCP subprocesses, synthetic in-memory plan, no SAP I/O.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  typeof value === 'string' && !key.startsWith('SAP_') && !key.startsWith('RFC_')));
Object.assign(env, {
  SAP_URL: 'https://offline-graph.invalid', SAP_USER: 'offline', SAP_PASSWORD: 'not-a-credential',
  SAP_CLIENT: '100', SAP_LANGUAGE: 'EN', SAP_MCP_SYSTEM_ROLE: 'DEV',
  SAP_MCP_TOOL_PROFILE: 'focused', SAP_MCP_ALLOWED_HOSTS: 'offline-graph.invalid',
  SAP_MCP_ALLOWED_CLIENTS: '100', SAP_MCP_ALLOWED_NAMESPACES: 'Z,Y', SAP_MCP_LOG_LEVEL: 'error'
});
const planId = 'offline-graph-restart-fixture';
const bootstrap = seed => `
  require('node:net').Socket.prototype.connect = function () { throw new Error('Offline smoke forbids network'); };
  const { AbapAdtServer } = require('./dist/index.js');
  const server = new AbapAdtServer('not-a-credential');
  server.transportScopeHandlers.runQuery = async (sql, limit) => {
    if (sql === "SELECT trkorr, strkorr FROM e070 WHERE trkorr IN ('DEVK900001')" && limit === 500) {
      return { values: [{ TRKORR: 'DEVK900001', STRKORR: '' }] };
    }
    if (sql === "SELECT trkorr, strkorr FROM e070 WHERE strkorr IN ('DEVK900001')" && limit === 500) return { values: [] };
    if (sql === "SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN ('DEVK900001')" && limit === 2000) {
      return { values: [{ TRKORR: 'DEVK900001', PGMID: 'R3TR', OBJECT: 'CLAS', OBJ_NAME: 'B' }] };
    }
    throw new Error('Unexpected transport query');
  };
  // Fixture-only SQL adapter: exercise the real load reader/builder without SAP.
  const { createLoadGraphClient } = require('./dist/adt/LoadGraphApi.js');
  server.loadGraphHandlers.loadGraph = createLoadGraphClient({ runQuery: async (sql, limit, decode) => {
    if (limit !== 2000 || decode !== true || !sql.startsWith('SELECT MASTER, INCLUDE, OBSOLETE_IN_VERSION FROM D010INC')) {
      throw new Error('Unexpected offline query');
    }
    const anchor = sql.includes("INCLUDE LIKE 'A%'") ? 'A' : sql.includes("INCLUDE LIKE 'B%'") ? 'B' : undefined;
    return { values: anchor ? [{ MASTER: (anchor === 'A' ? 'B' : 'C') + '===CP', INCLUDE: anchor + '===CP', OBSOLETE_IN_VERSION: 0 }] : [] };
  } });
  if (${seed}) {
    // Test-only fixture injected into this child process, never a preview/apply RPC.
    const store = server.safeAbapHandlers.workflow.plans;
    store.createId = () => ${JSON.stringify(planId)};
    store.create({ systemHost: 'offline-graph.invalid', client: '100',
      object: { objectType: 'PROGRAM', objectName: 'ZOFFLINE_FIXTURE' },
      originalHash: 'fixture', targetHash: 'fixture',
      diffSummary: { addedLines: 0, removedLines: 0, unchangedPrefixLines: 0, unchangedSuffixLines: 0 },
      syntaxMessages: [] });
  }
  server.run().catch(error => { console.error(error); process.exit(1); });
`;
const payload = response => {
  const text = response.content?.find(item => item.type === 'text')?.text;
  assert.ok(text, 'MCP response must contain JSON text');
  return JSON.parse(text);
};
const nodes = ['A', 'B', 'C'].map(name => ({ id: 'CLAS:' + name, type: 'CLAS', name }));
const graph = { nodes, edges: [
  { from: 'CLAS:B', to: 'CLAS:A', kind: 'CALLS', source: 'PARSER' },
  { from: 'CLAS:C', to: 'CLAS:B', kind: 'LOADS', source: 'D010INC' }
] };
const pids = [];
for (const seed of [true, false]) {
  const client = new Client({ name: 'dependency-graph-offline-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['-e', bootstrap(seed)], cwd: process.cwd(), env, stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    assert.ok(transport.pid, 'Fresh MCP subprocess must have a PID');
    pids.push(transport.pid);
    const listed = await client.listTools();
    const tool = listed.tools.find(tool => tool.name === 'analyzeDependencyGraph');
    assert.ok(tool, 'focused catalog contains offline graph tool');
    assert.equal(tool.annotations.openWorldHint, false);
    const health = payload(await client.callTool({ name: 'healthcheck', arguments: {} }));
    assert.equal(health.sapConnectionVerified, false);
    assert.equal(health.session.state, 'disconnected');
    assert.equal(health.session.generation, 0);
    const response = payload(await client.callTool({ name: 'analyzeDependencyGraph', arguments: {
      operation: 'impact', graph, root: 'CLAS:A'
    } }));
    assert.equal(response.result.scope, 'caller-supplied-snapshot');
    assert.deepEqual(response.result.analysis.entries.map(entry => [entry.id, entry.depth]), [['CLAS:B', 1], ['CLAS:C', 2]]);
    const built = payload(await client.callTool({ name: 'buildLoadDependencyGraph', arguments: {
      objectType: 'CLAS', objectName: 'A', maxDepth: 3
    } }));
    assert.equal(built.result.collection.queryCount, 3);
    assert.equal(built.result.collection.status, 'complete-within-reader-scope');
    assert.equal(built.result.systemWideComplete, false);
    assert.deepEqual(built.result.impact.entries.map(entry => [entry.id, entry.depth]), [['CLAS:B', 1], ['CLAS:C', 2]]);
    const scope = payload(await client.callTool({ name: 'getTransportScope', arguments: { transports: ['DEVK900001'] } }));
    assert.equal(scope.result.collection.status, 'complete-within-r3tr-reader-scope');
    assert.equal(scope.result.collection.queryCount, 3);
    assert.deepEqual(scope.result.boundaryScope.objectIds, ['CLAS:B']);
    const boundaries = payload(await client.callTool({ name: 'analyzeDependencyGraph', arguments: {
      operation: 'boundaries', graph: built.result.graph,
      boundaryScope: scope.result.boundaryScope
    } }));
    assert.equal(boundaries.result.analysis.summary.totalDependencies, 1);
    assert.equal(boundaries.result.analysis.summary.standardCandidates, 1);
    assert.equal(boundaries.result.analysis.transportMembershipVerified, false);
    assert.equal(boundaries.result.analysis.deploymentReadinessVerified, false);
    const status = await client.callTool({ name: 'getAbapChangeStatus', arguments: { changePlanId: planId } });
    const statusPayload = payload(status);
    if (seed) {
      assert.equal(statusPayload.plan.changePlanId, planId);
      assert.equal(statusPayload.plan.status, 'PREVIEWED');
    } else {
      assert.equal(status.isError, true);
      assert.match(JSON.stringify(statusPayload), /PLAN_NOT_FOUND/);
    }
    assert.doesNotMatch(stderr, /Offline smoke forbids network/);
  } finally {
    // Closing stdio kills the child; the next iteration launches a new process.
    await transport.close();
  }
}
assert.notEqual(pids[0], pids[1]);
console.log('PASS offline graph MCP smoke: fresh processes, disconnected healthchecks, old fixture PLAN_NOT_FOUND; no SAP verification or user-client deployment claimed.');
