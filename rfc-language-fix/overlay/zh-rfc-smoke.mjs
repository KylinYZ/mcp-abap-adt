import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const env = { ...process.env };
Object.assign(env, {
  SAP_URL: process.env.SAP_URL,
  SAP_USER: process.env.SAP_USER,
  SAP_PASSWORD: process.env.SAP_PASSWORD,
  SAP_CLIENT: process.env.SAP_CLIENT,
  SAP_LANGUAGE: 'ZH',
  SAP_MODE: 'focused',
  SAP_READ_ONLY: 'true'
});
const client = new Client({ name: 'vsp-zh-rfc-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: 'D:/MyDev/SAP/mcp-abap-abap-adt-api/rfc-language-fix/vsp-language-fixed.exe',
  args: ['--transport', 'stdio', '--mode', 'focused', '--read-only'],
  cwd: 'D:/MyDev/SAP/mcp-abap-abap-adt-api',
  env,
  stderr: 'pipe'
});
try {
  await client.connect(transport);
  const r = await client.callTool({ name: 'SAP', arguments: { action: 'rfc', params: { op: 'info' } } });
  const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  console.log(text);
} finally {
  await transport.close();
}
