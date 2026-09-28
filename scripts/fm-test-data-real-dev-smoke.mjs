// getFmTestDataSets 真机 smoke（sap-demo，只读 SQL）：EUFUNC 目录层子集。
// 决定性正例：标准 FM C162_SPEC_GET_BY_ID（裸 SQL 取证有 999 目录行 + 数据行）。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'warn' });

const client = new Client({ name: 'fmtest-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 500)}`); process.exit(1); }

await client.connect(transport);

// 0. catalog
const tools = await client.listTools();
if (!tools.tools.some(t => t.name === 'getFmTestDataSets')) fail('getFmTestDataSets 不在 catalog');
pass('getFmTestDataSets 在 focused catalog');

// 1. 决定性正例：C162_SPEC_GET_BY_ID（裸 SQL 取证有 999 目录行 + 数据行）
const probe = await call('getFmTestDataSets', { function: 'C162_SPEC_GET_BY_ID' });
const pv = probe?.result?.result || probe?.result || probe;
if (!pv || !Array.isArray(pv.sets)) fail('正例结构不完整', probe);
console.log(`INFO ${pv.function}: group=${pv.group || '(无)'} sets=${pv.sets.length}`
  + ` directory=${pv.directory ? pv.directory.number : '(无)'} author=${pv.directory?.author || '-'}`);
if (pv.sets.length === 0) fail('已知有测试数据的 FM 返回空目录', pv);
if (!pv.directory || pv.directory.number !== '999') fail('999 目录行未识别', pv.directory);
if (!pv.notes.some(n => n.includes('Directory view only'))) fail('payload 未解码声明缺失', pv.notes);
pass(`决定性正例：${pv.function} 目录=${pv.directory.number}（author=${pv.directory.author}）+ ${pv.sets.length} 个测试集`);

// 2. 自有函数组 FM：无测试数据 → 空目录 + notes（非失败的正常回答）
const mine = await call('getFmTestDataSets', { function: 'Z_MCP_SM21_READ' });
const mv = mine?.result?.result || mine?.result || mine;
if (!mv || !Array.isArray(mv.sets)) fail('自有 FM 结构不完整', mine);
if (mv.sets.length !== 0) console.log(`INFO 自有 FM 有 ${mv.sets.length} 个测试集（非空也合法）`);
pass(`自有 FM：空目录为正常回答（sets=${mv.sets.length}，notes=${mv.notes.length} 条）`);

// 3. 负例：非法 FM 名 → InvalidParams
const bad = await call('getFmTestDataSets', { function: 'BAD NAME!' });
if (!String(JSON.stringify(bad)).match(/-32602|InvalidParams|invalid/i)) fail('非法名未拒', bad);
pass('负例：非法 FM 名 → InvalidParams');

console.log('SMOKE OK: getFmTestDataSets（EUFUNC 目录层）在真实 DEV 端到端验证通过');
await client.close();
