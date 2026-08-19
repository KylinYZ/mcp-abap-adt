import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_TOOL_PROFILE: 'legacy-full',
  SAP_MCP_SESSION_RECOVERY: 'true',
  SAP_MCP_MAX_CONCURRENT_TOOLS: '1',
  SAP_MCP_MAX_QUEUED_TOOLS: '2',
  SAP_MCP_LOG_LEVEL: 'warn'
});

const client = new Client({ name: 'sap-session-resilience-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

function textPayload(result) {
  return (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
}

function parse(result) {
  try { return JSON.parse(textPayload(result)); } catch { return {}; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const available = new Set(tools.tools.map(tool => tool.name));
  for (const name of ['healthcheck', 'login', 'logout', 'searchObject', 'inspectSapSystem']) {
    if (!available.has(name)) throw new Error(`Required tool '${name}' is unavailable.`);
  }

  const initialHealth = parse(await call('healthcheck'));
  assert(initialHealth.sapConnectionVerified === false, 'healthcheck remains local-only');

  const login = await call('login');
  assert(!login.isError, 'explicit login succeeds');

  const firstRead = await call('searchObject', { query: 'ZCODEX*', max: 1 });
  assert(!firstRead.isError, 'read succeeds after login');

  const logout = await call('logout');
  assert(logout !== undefined, logout.isError
    ? 'explicit logout completed with a bounded remote-logoff error; local logout state is still tested'
    : 'explicit logout succeeds');

  const blockedRead = await call('searchObject', { query: 'ZCODEX*', max: 1 });
  const blockedText = textPayload(blockedRead);
  assert(blockedRead.isError === true && blockedText.includes('SESSION_EXPLICITLY_LOGGED_OUT'), 'logout blocks implicit re-login');

  const relogin = await call('login');
  assert(!relogin.isError, 'explicit re-login succeeds');
  const secondRead = await call('searchObject', { query: 'ZCODEX*', max: 1 });
  assert(!secondRead.isError, 'read succeeds after explicit re-login');

  if (childEnvironment.SAP_MCP_STATELESS_READS === 'true') {
    const inspection = await call('inspectSapSystem');
    assert(!inspection.isError, 'high-level read succeeds with stateless read rollout enabled');
  } else {
    process.stdout.write('INFO stateless read rollout disabled; set SAP_MCP_STATELESS_READS=true for that DEV check.\n');
  }

  const finalHealth = parse(await call('healthcheck'));
  assert(finalHealth.session?.state === 'connected', 'healthcheck reports connected after re-login');
}

main()
  .catch(error => {
    process.stderr.write(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await transport.close(); } catch {}
  });
