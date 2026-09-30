// 完整工作流测试·诊断探针：复现 description smoke 的门禁拒绝并输出完整错误 JSON
// （含 transportAttempts 端点级诊断），只读、零写入（preview 被拒不生成 plan）。
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const environmentFile = resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env');
const envText = readFileSync(environmentFile, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]] = m[2];
}
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：仅允许 sap-demo。');
  process.exit(1);
}

const client = new Client({ name: 'gate-probe', version: '1.0.0' }, { capabilities: { elicitation: {} } });
// 诊断探针零写入：任何确认弹窗一律 cancel
client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'cancel' }));
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: environmentFile,
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});
const transport = new StdioClientTransport({
  command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(),
  env: childEnvironment, stderr: 'pipe'
});
await client.connect(transport);
const result = await client.callTool({
  name: 'previewRepositoryObjectCreation',
  arguments: {
    objectKind: 'PROGRAM',
    name: 'ZPRGGATEPROBE',
    description: 'Gate diagnostics probe',
    packageName: 'Z001',
    transportRequest: 'S4HK900009',
    source: "REPORT zprggateprobe.\nWRITE / 'probe'."
  }
}, undefined, { timeout: 120_000 });
const text = (result.content || []).filter(i => i.type === 'text').map(i => i.text).join('');
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
await client.close();
