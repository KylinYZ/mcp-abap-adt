import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => key !== 'SAP_MCP_ENV_FILE' && typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_URL: 'https://focused-smoke.invalid:44300',
  SAP_USER: 'focused-smoke',
  SAP_PASSWORD: 'focused-smoke',
  SAP_CLIENT: '100',
  SAP_LANGUAGE: 'EN',
  SAP_MCP_TOOL_PROFILE: 'focused',
  SAP_MCP_SYSTEM_ROLE: 'DEV',
  SAP_MCP_ALLOWED_HOSTS: 'focused-smoke.invalid',
  SAP_MCP_ALLOWED_CLIENTS: '100',
  SAP_MCP_ALLOWED_NAMESPACES: 'Z,Y',
  SAP_MCP_LOG_LEVEL: 'error'
});

const client = new Client({ name: 'focused-entrypoint-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  const helpResponse = await client.callTool({ name: 'sap', arguments: { action: 'help' } });
  const text = helpResponse.content?.find(item => item.type === 'text')?.text || '';
  const payload = JSON.parse(text);
  const actions = payload?.result?.actions || [];
  const passed = names.length === 90
    && names.includes('sap')
    && names.includes('sapDoctor')
    && actions.some(action => action.action === 'read')
    && actions.some(action => action.action === 'diagnose');
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} focused MCP entrypoint: tools=${names.length}, sap=${names.includes('sap')}, sapDoctor=${names.includes('sapDoctor')}, helpActions=${actions.length}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await transport.close();
}
