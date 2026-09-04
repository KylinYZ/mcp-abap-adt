import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
if (!environmentFile) {
  throw new Error('Pass the explicit sap-dev.env path; this smoke test never guesses credentials or target configuration.');
}

const maturityManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/evidence/repository-creation-maturity-evidence.json'), 'utf8'));
if (!Array.isArray(maturityManifest.records)) {
  throw new Error('Maturity evidence manifest is missing records.');
}

function parse(result) {
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try { return JSON.parse(text); } catch { return {}; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

async function main() {
  const cleanupTools = [
    'previewRepositoryObjectCleanup',
    'applyRepositoryObjectCleanup',
    'getRepositoryObjectCleanupStatus'
  ];
  const validationRuntime = runtime('true');
  try {
    await validationRuntime.client.connect(validationRuntime.transport);
    const tools = await validationRuntime.client.listTools();
    const available = new Set(tools.tools.map(tool => tool.name));
    for (const name of cleanupTools) {
      assert(available.has(name), `${name} is loaded only in the explicit validation profile`);
    }

    const health = parse(await validationRuntime.call('healthcheck'));
    assert(health.configuredTarget?.systemRole === 'DEV', 'runtime target role is DEV');
    assert(health.configuredTarget?.client === '300', 'runtime target client is 300');
    assert(health.session?.state === 'disconnected' && health.session?.generation === 0, 'new process starts with a fresh SAP session');

    const oldCreationPlan = parse(await validationRuntime.call('getRepositoryObjectCreationStatus', {
      creationPlanId: 'be766b83-ed0a-46ed-943b-8ba18623d6f5'
    }));
    assert(oldCreationPlan.error?.code === 'PLAN_NOT_FOUND', 'historical creation plan is absent from the new process');

    const oldCleanupPlan = parse(await validationRuntime.call('getRepositoryObjectCleanupStatus', {
      cleanupPlanId: 'historical-cleanup-plan'
    }));
    assert(oldCleanupPlan.error?.code === 'PLAN_NOT_FOUND', 'historical cleanup plan is absent from the new process');
  } finally {
    await validationRuntime.client.close();
  }

  const productionRuntime = runtime('false');
  try {
    await productionRuntime.client.connect(productionRuntime.transport);
    const tools = await productionRuntime.client.listTools();
    const available = new Set(tools.tools.map(tool => tool.name));
    for (const name of cleanupTools) {
      assert(!available.has(name), `${name} is hidden when real DEV validation is disabled`);
    }
    const catalog = parse(await productionRuntime.call('listRepositoryObjectCreationCapabilities'));
    const verified = (catalog.capabilities || []).filter(capability => capability.maturity === 'REAL_DEV_VERIFIED');
    assert(verified.length === maturityManifest.records.length, `${maturityManifest.records.length} repository kinds remain REAL_DEV_VERIFIED with validation disabled`);
    assert(verified.every(capability => capability.writable === true), 'all REAL_DEV_VERIFIED kinds remain writable with validation disabled');
    assert(verified.some(capability => capability.objectKind === 'CHANGE_DOCUMENT_OBJECT'), 'Change Document Object remains writable with validation disabled');
  } finally {
    await productionRuntime.client.close();
  }
}

function runtime(realDevValidation) {
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string')
  );
  Object.assign(childEnvironment, {
    SAP_MCP_ENV_FILE: resolve(environmentFile),
    SAP_MCP_LOG_LEVEL: 'warn',
    SAP_MCP_REAL_DEV_VALIDATION: realDevValidation
  });
  const client = new Client({ name: 'repository-productionization-runtime-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['./dist/index.js'],
    cwd: process.cwd(),
    env: childEnvironment,
    stderr: 'pipe'
  });
  return {
    client,
    transport,
    call: (name, args = {}) => client.callTool({ name, arguments: args })
  };
}

await main();
