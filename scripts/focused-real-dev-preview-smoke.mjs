import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const objectName = String(process.argv[3] || 'ZCODEX_MCP_TEST').trim().toUpperCase();
const transportRequest = String(process.argv[4] || 'S4HK900009').trim().toUpperCase();
if (!environmentFile) throw new Error('Pass the explicit sap-dev.env path.');
const auditPath = await mkdtemp(resolve('.tmp-focused-preview-audit-'));

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => key !== 'SAP_MCP_ENV_FILE' && typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_TOOL_PROFILE: 'focused',
  SAP_MCP_SYSTEM_ROLE: 'DEV',
  SAP_MCP_MAX_CONCURRENT_TOOLS: '1',
  SAP_MCP_AUDIT_PATH: auditPath,
  SAP_MCP_LOG_LEVEL: 'warn'
});

const client = new Client({ name: 'focused-real-dev-preview-smoke', version: '1.0.0' });
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
  const payload = parsedPayload(result);
  if (result.isError === true) throw new Error(`${name} returned an MCP error: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  await client.connect(transport);
  const read = await call('sap', { action: 'read', params: { objectType: 'PROGRAM', objectName } });
  const originalSource = read.result?.result?.source;
  assert(typeof originalSource === 'string' && originalSource.length > 0, `read ${objectName} source for preview baseline`);

  const marker = `\n* focused preview smoke ${new Date().toISOString()}\n`;
  const preview = await call('sap', {
    action: 'edit',
    params: {
      objectType: 'PROGRAM',
      objectName,
      newSource: `${originalSource.replace(/\s*$/, '')}${marker}`,
      transportRequest
    }
  });
  const previewResult = preview.result?.result;
  const plan = previewResult?.plan;
  assert(preview.result?.delegatedTool === 'previewAbapChange', 'sap(edit) delegated to previewAbapChange');
  assert(previewResult?.status === 'preview' && plan?.status === 'PREVIEWED', `preview created a PREVIEWED server plan (resultKeys=${Object.keys(previewResult || {}).join(',')}, planKeys=${Object.keys(plan || {}).join(',')})`);
  assert(previewResult?.confirmationRequired === true, 'preview requires confirmation without applying');
  assert(typeof previewResult?.diff === 'string' && previewResult.diff.includes('focused preview smoke'), 'preview returned the requested comment diff');
  assert(typeof plan?.changePlanId === 'string' && plan.changePlanId.length > 0, 'preview returned a server changePlanId');
  process.stdout.write(`INFO previewPlan=${plan.changePlanId}; no apply/lock/write/activate was requested\n`);
} finally {
  await transport.close();
  await rm(auditPath, { recursive: true, force: true });
}
