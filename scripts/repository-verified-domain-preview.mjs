import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const objectName = String(process.argv[3] || 'ZVPV001').trim().toUpperCase();
if (!environmentFile) throw new Error('Pass the explicit sap-dev.env path.');
if (!/^Z[A-Z0-9_]{1,29}$/.test(objectName)) throw new Error('Preview identity must be a bounded Z repository name.');

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_REAL_DEV_VALIDATION: 'false',
  SAP_MCP_LOG_LEVEL: 'warn'
});

const client = new Client({ name: 'repository-verified-domain-preview', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

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

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  assert(!names.has('previewRepositoryObjectCleanup'), 'cleanup tools are hidden when validation is disabled');

  const capabilities = parse(await call('listRepositoryObjectCreationCapabilities')).capabilities || [];
  const writable = capabilities.filter(capability => capability.writable).map(capability => capability.objectKind);
  assert(
    JSON.stringify(writable) === JSON.stringify([
      'ABAP_INTERFACE', 'BEHAVIOR_DEFINITION', 'CDS_ACCESS_CONTROL', 'CDS_ASPECT',
      'CDS_DATA_DEFINITION', 'CDS_METADATA_EXTENSION', 'CDS_TYPE', 'CHANGE_DOCUMENT_OBJECT',
      'DATA_ELEMENT', 'DATABASE_TABLE', 'DDIC_DOMAIN', 'DDIC_TABLE_TYPE', 'DDIC_TYPE_GROUP',
      'LOGICAL_EXTERNAL_SCHEMA', 'MESSAGE_CLASS', 'NUMBER_RANGE_OBJECT', 'PACKAGE', 'PROGRAM',
      'PROGRAM_INCLUDE', 'SAP_OBJECT_NODE_TYPE', 'SAP_OBJECT_TYPE', 'SERVICE_BINDING',
      'SERVICE_DEFINITION'
    ]),
    'all twenty-three evidence-backed repository kinds are writable'
  );

  const search = parse(await call('searchObject', { query: objectName, objType: 'DOMA/DD', max: 10 }));
  assert(Array.isArray(search.results) && search.results.length === 0, `${objectName} is absent before read-only preview`);

  const preview = parse(await call('previewRepositoryObjectCreation', {
    objectKind: 'DDIC_DOMAIN',
    name: objectName,
    description: 'Verified DDIC domain preview only',
    packageName: 'Z001',
    transportRequest: 'S4HK900009',
    properties: {
      typeInformation: { datatype: 'CHAR', length: 10, decimals: 0 },
      outputInformation: { length: 10, signExists: false, lowercase: false, ampmFormat: false }
    }
  }));
  assert(preview.status === 'preview' && preview.plan?.status === 'PREVIEWED', 'verified DDIC_DOMAIN creates a normal preview with validation disabled');
  assert(preview.plan?.target?.objectName === objectName, 'preview freezes the requested identity');
  assert(preview.plan?.toolProfile === 'development', 'preview remains inside the approved DEV development profile');
  process.stdout.write('PASS no apply or SAP mutation was invoked\n');
}

try {
  await main();
} finally {
  await client.close();
}
