import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
if (!environmentFile) throw new Error('Pass the explicit sap-dev.env path.');

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => key !== 'SAP_MCP_ENV_FILE' && typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_TOOL_PROFILE: 'focused',
  SAP_MCP_MAX_CONCURRENT_TOOLS: '1',
  SAP_MCP_LOG_LEVEL: 'warn'
});

const client = new Client({ name: 'focused-real-dev-readonly-smoke', version: '1.0.0' });
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

function parsedPayload(result) {
  try { return JSON.parse(textPayload(result)); } catch { return {}; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError === true) throw new Error(`${name} returned an MCP error.`);
  return parsedPayload(result);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  assert(names.size >= 90 && names.has('sap') && names.has('sapDoctor'), `focused catalog is available (${names.size} tools, validation extras accepted)`);

  const doctor = await call('sapDoctor', {});
  const doctorResult = doctor.result || {};
  const checkCount = Array.isArray(doctorResult.checks) ? doctorResult.checks.length : 0;
  assert(checkCount >= 5, `sapDoctor returned ${checkCount} bounded checks with status=${doctorResult.status || 'unknown'}`);

  const read = await call('sap', { action: 'read', params: { objectType: 'PROGRAM', objectName: 'ZCODEX_MCP_TEST' } });
  assert(read.result?.delegatedTool === 'inspectAbapObject', 'sap(read) delegated to inspectAbapObject without exposing source');

  const search = await call('sap', { action: 'search', params: { query: 'ZCODEX*', max: 5 } });
  const searchResult = search.result?.result;
  const searchRows = Array.isArray(searchResult?.results) ? searchResult.results.length : Array.isArray(searchResult) ? searchResult.length : 0;
  assert(search.result?.delegatedTool === 'searchObject', `sap(search) returned ${searchRows} bounded matches`);

  const diagnose = await call('sap', { action: 'diagnose', params: { tableName: 'T000' } });
  assert(diagnose.result?.delegatedTool === 'describeClassicTable', 'sap(diagnose) routed table evidence to describeClassicTable');
} finally {
  await transport.close();
}
