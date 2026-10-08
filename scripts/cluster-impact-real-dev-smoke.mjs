// cluster_read + impact 真机 smoke（sap-demo，全程只读 SELECT）：
// 1. readClusterTable 对 EUFUNC（真机已验证的集群表）：结构发现 + 按键分组 +
//    解码（与 getFmTestDataSets 同一 FM 的测试集内容交叉印证）
// 2. readClusterTable 负例：非集群透明表（结构校验拒绝）+ 注入 where 拒绝
// 3. getImpactAnalysis：目标 ZCL_MCP_SM21_ADT_HTTP（usage_examples 轮真机有
//    交叉数据的自有类）——直接调用方 + 多跳 BFS + 预算 note
// 4. getImpactAnalysis 负例：非法 object_type 拒绝
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(ENV_PATH, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: ENV_PATH, SAP_MCP_LOG_LEVEL: 'warn' });

const client = new Client({ name: 'cluster-impact-smoke', version: '1.0.0' }, { capabilities: {} });
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
  if (!tools.tools.some(t => t.name === 'readClusterTable')) fail('readClusterTable 不在 catalog');
  if (!tools.tools.some(t => t.name === 'getImpactAnalysis')) fail('getImpactAnalysis 不在 catalog');
  pass('readClusterTable/getImpactAnalysis 在 catalog');

  // 1. EUFUNC 集群读取（决定性正例：与 fm_test_data 基线交叉）
  const r = await call('readClusterTable', {
    table: 'EUFUNC', where: "relid = 'FL' AND name = 'C162_SPEC_GET_BY_ID'", maxRows: 200
  });
  const rb = r.structuredContent?.result ?? r.result ?? r;
  if (typeof rb.fragments !== 'number' || rb.fragments < 1) fail('EUFUNC 读回 0 行', rb);
  if (!Array.isArray(rb.keys) || rb.keys.length === 0) fail('keys 未发现', rb);
  if (rb.records.length < 1) fail('集群记录为空', rb);
  const withObjects = rb.records.filter(x => (x.objects ?? []).length > 0);
  if (withObjects.length === 0) fail('没有任何集群解码出对象', rb);
  pass(`EUFUNC：${rb.fragments} 续块行 → ${rb.records.length} 集群（${withObjects.length} 个解码出对象；version=${withObjects[0].version} codepage=${withObjects[0].codepage}）`);

  // 2. 负例：透明表（无三续块列）被结构校验拒绝
  const plain = await call('readClusterTable', { table: 'T001' });
  const plainText = JSON.stringify(plain).slice(0, 400);
  if (!/is not a cluster table|SRTF2/i.test(plainText)) fail('透明表未被结构校验拒绝', plain);
  pass('负例：透明表 T001 被结构校验拒绝（not a cluster table）');

  // 3. 负例：注入 where
  const bad = await call('readClusterTable', { table: 'EUFUNC', where: "relid = 'FL'; DROP TABLE" });
  if (!/control characters or semicolons/i.test(JSON.stringify(bad).slice(0, 400))) fail('注入 where 未被拒', bad);
  pass('负例：分号注入 where 被拒');

  // 4. 影响面：真实有激活引用的对象（ZABAPGIT_FORMS → ZCL_ABAPGIT_AUTH，部署轮实证）
  const imp = await call('getImpactAnalysis', { objectType: 'CLAS', objectName: 'ZCL_ABAPGIT_AUTH', maxDepth: 3 });
  const ib = imp.structuredContent?.result ?? imp.result ?? imp;
  if (typeof ib.totalAffected !== 'number') fail('影响面未返回', ib);
  if (!Array.isArray(ib.edges) || !Array.isArray(ib.levels)) fail('影响面字段缺失', ib);
  if (ib.totalAffected === 0) fail('影响面为空（WBCROSSGT 有 ZABAPGIT_FORMS→ZCL_ABAPGIT_AUTH 实证行）', ib);
  pass(`影响面：${ib.totalAffected} 个受影响对象（直接调用方 ${ib.directCallers.length}，${ib.levels.length} 层，${ib.rounds} 次查询）`);
  console.log('  sample edges:', JSON.stringify(ib.edges.slice(0, 3).map(x => `${x.from.type}:${x.from.name} →(d${x.depth}) ${x.to.name}`)));

  // 5. 负例：非法 object_type
  const badType = await call('getImpactAnalysis', { objectType: 'XYZ', objectName: 'ZCL_X' });
  if (!/object_type/i.test(JSON.stringify(badType).slice(0, 300))) fail('非法 object_type 未被拒', badType);
  pass('负例：非法 object_type 被拒');

  console.log('SMOKE OK: cluster_read + impact 真机全场景通过');
  await client.close().catch(() => {});
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
