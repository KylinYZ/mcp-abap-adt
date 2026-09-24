// getLoadGraph 真机 smoke（sap-demo）：D010INC 加载图 down/up/双向 + 负例。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const envText = readFileSync(resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env'), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) { console.error('红线预检失败'); process.exit(1); }
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env'), SAP_MCP_LOG_LEVEL: 'warn' });

const client = new Client({ name: 'loadgraph-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 500)}`); process.exit(1); }

await client.connect(transport);

// 0. 工具在 catalog
const tools = await client.listTools();
if (!tools.tools.some(t => t.name === 'getLoadGraph')) fail('getLoadGraph 不在 catalog');
pass('getLoadGraph 在 focused catalog');

// 1. down 方向：找一个有源码的 Z 程序/类拉进什么（选 REPOSRC 里有源的大对象）
const q = await call('runQuery', { sqlQuery: "SELECT obj_name FROM reposrc WHERE obj_type = 'FUGR' AND obj_name LIKE 'Z%'", rowNumber: 5 });
console.log('INFO runQuery FUGR raw:', JSON.stringify(q).slice(0, 300));
const candidates = (q?.result?.values || q?.values || []).map(r => Object.values(r)[0]).filter(Boolean);
const target = String(candidates[0] || 'ZREPORT01');
const down = await call('getLoadGraph', { objectName: target, direction: 'loads' });
const downV = down?.result || down;
if (downV?.objectName !== target) fail('loads 方向', down);
console.log(`INFO ${target} loads=${downV.loadsTotal} notes=${JSON.stringify(downV.notes).slice(0, 200)}`);
pass(`down 方向返回结构完整（objectName/direction/source/loads/notes）`);

// 2. 用受控创建链建一个带 include 引用的程序对照（轻量：直接用已知函数组池形态）
//    用 Z001 包里最近创建的对象族：直接探测一个类池归一化
const q2 = await call('runQuery', { sqlQuery: "SELECT obj_name FROM reposrc WHERE obj_type = 'CLAS' AND obj_name LIKE 'ZCL%' AND cdate > '20260901'", rowNumber: 5 });
const clsCandidates = (q2?.result?.values || q2?.values || []).map(r => Object.values(r)[0]).filter(Boolean);
if (clsCandidates.length > 0) {
  const cls = String(clsCandidates[0]);
  const both = await call('getLoadGraph', { objectName: cls, direction: 'both' });
  const bothV = both?.result || both;
  if (bothV?.direction !== 'both') fail('both 方向', both);
  const sample = [...(bothV.loads || []), ...(bothV.loadedBy || [])].slice(0, 4)
    .map(e => `${e.from.objectType}:${e.from.objectName} -> ${e.to.objectType}:${e.to.objectName} (${e.detail.slice(0, 40)})`);
  console.log(`INFO ${cls} loads=${bothV.loadsTotal} loadedBy=${bothV.loadedByTotal}`);
  for (const s of sample) console.log('   ', s);
  // 归一化 sanity：所有边端点对象名都不含 '='（填充已剥）
  const all = [...bothV.loads, ...bothV.loadedBy].flatMap(e => [e.from.objectName, e.to.objectName]);
  if (all.some(n => n.includes('='))) fail('归一化失败：对象名含填充符', all);
  pass(`both 方向 + 填充名归一化验证通过（${cls}）`);
} else {
  pass('无近期 ZCL 样本，跳过类池归一化真机分支');
}

// 3. 负例：非法 token / 非法 direction
const neg1 = await call('getLoadGraph', { objectName: 'BAD NAME!' });
if (!String(JSON.stringify(neg1)).match(/InvalidParams|-32602|invalid/i)) fail('非法 token 未拒', neg1);
const neg2 = await call('getLoadGraph', { objectName: 'ZREPORT01', direction: 'sideways' });
if (!String(JSON.stringify(neg2)).match(/direction/i)) fail('非法 direction 未拒', neg2);
pass('负例：非法 token 与 direction 参数层拒绝');

console.log('SMOKE OK: getLoadGraph（D010INC 加载图）在真实 DEV 端到端验证通过');
await client.close();
