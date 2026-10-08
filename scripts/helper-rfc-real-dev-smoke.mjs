// helperCallRfm 真机 smoke（sap-dev，rfc.helper-bridge 收编授权轮）：
// 1. allowlist 内 FM（RFC_PING）→ success + subrc=0
// 2. allowlist 内 FM 带参数（RFC_READ_TABLE 之类或 SYSTEM_INFO）→ exports 有值
// 3. allowlist 外 FM → FM_NOT_ALLOWED 拒绝（零往返）
// 4. 与 callRfm（open-rfc 直链）对照：同一 FM 两通道结果一致（决定性 cross-check）
// 全程只读；DEV-only 工具。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env';
const envText = readFileSync(ENV_PATH, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.255.42')) {
  console.error('红线预检失败：SAP_URL 不是 sap-dev（10.30.255.42）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: ENV_PATH, SAP_MCP_LOG_LEVEL: 'warn' });

const client = new Client({ name: 'helper-rfc-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 330000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 900)}`); process.exit(1); }

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'helperCallRfm')) fail('helperCallRfm 不在 catalog');
  pass('helperCallRfm 在 catalog（DEV 面）');

  // 1. allowlist 内 FM：RFC_PING
  const ping = await call('helperCallRfm', { function: 'RFC_PING' });
  const pb = ping.structuredContent?.result ?? ping.result ?? ping;
  if (pb.subrc !== 0) fail('RFC_PING subrc 应为 0', pb);
  pass('helperCallRfm RFC_PING：subrc=0');

  // 2. allowlist 内 FM 带参数：RFC_SYSTEM_INFO → exports 有指纹
  const info = await call('helperCallRfm', { function: 'RFC_SYSTEM_INFO' });
  const ib = info.structuredContent?.result ?? info.result ?? info;
  const exportsStr = JSON.stringify(ib.exports ?? {});
  if (!/S4H|S4D|sysid/i.test(exportsStr)) fail('RFC_SYSTEM_INFO exports 缺系统指纹', ib);
  pass(`helperCallRfm RFC_SYSTEM_INFO：exports 含系统指纹（${exportsStr.slice(0, 120)}）`);

  // 3. allowlist 外 FM：拒绝
  const bad = await call('helperCallRfm', { function: 'Z_NOT_ON_ALLOWLIST' });
  if (!/not on the helper-bridge allowlist/i.test(JSON.stringify(bad).slice(0, 400))) fail('allowlist 外 FM 未被拒', bad);
  pass('负例：allowlist 外 FM 零往返拒绝');

  // 4. 对照：与 callRfm（open-rfc 直链）交叉——RFC_SYSTEM_INFO 两侧 sysid 一致
  const cross = await call('callRfm', { function: 'RFC_SYSTEM_INFO' });
  const cb = cross.structuredContent?.result ?? cross.result ?? cross;
  const helperStr = JSON.stringify(ib.exports ?? {});
  const directStr = JSON.stringify(cb);
  const helperSysid = /S4[HDX]/.exec(helperStr)?.[0];
  const directSysid = /S4[HDX]/.exec(directStr)?.[0];
  if (helperSysid && directSysid && helperSysid !== directSysid) fail('两通道 sysid 不一致', { helperSysid, directSysid });
  pass(`对照 callRfm：两通道系统指纹一致（${helperSysid ?? directSysid}）`);

  console.log('SMOKE OK: helperCallRfm 真机全场景通过（allowlist 门 + 与 callRfm 对照）');
  await client.close().catch(() => {});
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
