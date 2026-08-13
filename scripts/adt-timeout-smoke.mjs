import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const stalledServer = http.createServer(() => {
  // Intentionally leave the response open so the real ADT HTTP client must cancel it.
});

await new Promise((resolve, reject) => {
  stalledServer.once('error', reject);
  stalledServer.listen(0, '127.0.0.1', resolve);
});

const address = stalledServer.address();
if (!address || typeof address === 'string') throw new Error('Failed to allocate a local timeout-test port.');

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_URL: `http://127.0.0.1:${address.port}`,
  SAP_USER: 'timeout-test',
  SAP_PASSWORD: 'timeout-test',
  SAP_CLIENT: '300',
  SAP_LANGUAGE: 'EN',
  SAP_MCP_TOOL_PROFILE: 'legacy-full',
  SAP_MCP_ADT_TIMEOUT_MS: '5000',
  SAP_MCP_MAX_CONCURRENT_TOOLS: '1',
  SAP_MCP_MAX_QUEUED_TOOLS: '0',
  SAP_MCP_LOG_LEVEL: 'error'
});

const client = new Client({ name: 'adt-timeout-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

try {
  await client.connect(transport);
  const startedAt = Date.now();
  const result = await client.callTool({
    name: 'searchObject',
    arguments: { query: 'ZCODEX*', max: 1 }
  });
  const elapsedMs = Date.now() - startedAt;
  const passed = result.isError === true && elapsedMs >= 4_500 && elapsedMs <= 8_000;
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ADT HTTP timeout: isError=${result.isError === true}, elapsedMs=${elapsedMs}, configuredMs=5000\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await transport.close();
  await new Promise(resolve => stalledServer.close(resolve));
}
