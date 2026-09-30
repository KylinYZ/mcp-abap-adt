// 空传输请求受控清理脚本（sap-demo）：对显式列出的请求号逐个走
// previewTransportCleanup（三条红线核验）→ 原生确认 → applyTransportCleanup
// （删除 + 缺席验证）。任一请求红线不满足（非空/已释放/非本人）即跳过并报告，
// 绝不绕过受控链。同时充当清理链的真机验证。
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient } from '../dist/adt/index.js';
import { transportDetails } from '../dist/adt/api/transports.js';

const environmentFile = resolve(process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env');
const requestNumbers = process.argv.slice(3).map(v => String(v).trim().toUpperCase()).filter(Boolean);
if (requestNumbers.length === 0) {
  console.error('用法：node scripts/transport-cleanup-real-dev.mjs [env] S4HK900017 [S4HK900019 ...]');
  process.exit(1);
}
for (const number of requestNumbers) {
  if (!/^[A-Z][A-Z0-9]{2}K[0-9]{6}$/.test(number)) {
    console.error(`非法请求号：${number}`);
    process.exit(1);
  }
}
const envText = readFileSync(environmentFile, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]] = m[2];
}
// 红线：本脚本仅授权 sap-demo（10.30.254.48）
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）。');
  process.exit(1);
}

// 阶段化 elicitation 应答：消息必须包含当前目标请求号 + 删除语义关键词
let currentTarget = '';
const client = new Client(
  { name: 'transport-cleanup-real-dev', version: '1.0.0' },
  { capabilities: { elicitation: {} } }
);
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: Object.assign(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    { SAP_MCP_ENV_FILE: environmentFile, SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false' }
  ),
  stderr: 'pipe'
});
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  if (currentTarget && message.includes('Delete empty transport request') && message.includes(currentTarget)) {
    return { action: 'accept', content: { decision: 'delete_transport' } };
  }
  process.stdout.write(`WARN 确认消息未匹配目标 ${currentTarget}，已取消：${message.slice(0, 140)}\n`);
  return { action: 'cancel' };
});

function parse(result) {
  const text = (result.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(text); } catch { return { __unparsed: text.slice(0, 400), __isError: Boolean(result.isError) }; }
}
async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}
function pass(m) { console.log('PASS', m); }
function info(m) { console.log('INFO', m); }

/** 直连只读缺席复核（不经 MCP 链）。 */
async function directAbsence(number) {
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD,
    envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  try {
    await transportDetails(raw.h, number);
    return false;
  } catch {
    return true;
  } finally {
    await raw.h.logout().catch(() => {});
  }
}

let deleted = 0;
let skipped = 0;
await client.connect(stdioTransport);
for (const number of requestNumbers) {
  currentTarget = number;
  const preview = await call('previewTransportCleanup', { transportNumber: number });
  if (preview.status !== 'preview') {
    info(`跳过 ${number}：红线核验未通过 → ${JSON.stringify(preview).slice(0, 200)}`);
    skipped++;
    continue;
  }
  const target = preview.plan?.target || {};
  info(`红线核验通过：${number}（status=${target.requestStatus}, objects=${target.objectCount}, owner=${target.owner}）`);
  const applied = await call('applyTransportCleanup', { transportCleanupPlanId: preview.plan.transportCleanupPlanId });
  if (applied.status !== 'success' || applied.plan?.result?.absenceVerified !== true) {
    console.error(`FAIL ${number} 清理未达成：${JSON.stringify(applied).slice(0, 300)}`);
    process.exit(1);
  }
  pass(`${number} 已经受控链删除且缺席验证通过`);
  if (!(await directAbsence(number))) {
    console.error(`FAIL ${number} 直连复核仍可读`);
    process.exit(1);
  }
  pass(`${number} 直连只读缺席复核通过`);
  deleted++;
}
console.log(`SUMMARY 删除 ${deleted} 个，跳过 ${skipped} 个（红线不满足）`);
console.log('CLEANUP OK');
process.exit(0);
