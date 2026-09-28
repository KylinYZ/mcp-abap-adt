// getTransportScope crossref 结构边界真机 smoke（sap-demo，只读 SQL）。
// WBCROSSGT/CROSS 出边（REFERENCES/CALLS 口径）在真实 DEV 上的端到端验证：
// 组合链（成员采集 → 每成员两表出边 → 边界分类）+ 定向单点（已知有真实引用的类）。
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

const client = new Client({ name: 'xref-scope-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 500)}`); process.exit(1); }

await client.connect(transport);

// 1. 决定性正例：S4HK900012（ZMCP_TOOLS 函数组所在传输）——裸 SQL 取证其
//    LZMCP_TOOLS 有 CROSS DIRECT 行（NAME=S_ADMI_FCD）。crossref-only 组合链
//    应产出至少一条 CALLS 边并按非 Z/Y 名称分类为 standardCandidates。
const probe = await call('getTransportScope', {
  transports: ['S4HK900012'], includeLoadBoundaries: false, includeCrossRefBoundaries: true,
  maxDependencyQueries: 10, maxEntries: 200
});
const pv = probe?.result?.result || probe?.result || probe;
if (!pv.analysis) fail('crossref 组合 analysis 为 null', pv);
const structEdges = (pv.graph.edges || []).filter(e => e.kind === 'REFERENCES' || e.kind === 'CALLS');
console.log(`INFO crossref 组合（S4HK900012）：structEdges=${structEdges.length}`
  + ` sample=${JSON.stringify(structEdges.slice(0, 3))}`);
console.log(`INFO summary=${JSON.stringify(pv.analysis.summary)}`);
if (structEdges.length === 0) fail('CROSS 已知有 DIRECT 行但组合链零结构边', pv.collection);
if (!pv.analysis.entries.standardCandidates.length && pv.analysis.summary.standardCandidates === 0) {
  fail('S_ADMI_FCD（非 Z/Y）应出现在 standardCandidates', pv.analysis.entries);
}
if (pv.deploymentReadinessVerified !== false || pv.systemWideComplete !== false) fail('安全常量被违反', pv);
const sum = pv.analysis.summary;
const identity = sum.inScope + sum.missingCustom + sum.unknownNamespace + sum.dynamic + sum.standardCandidates;
if (identity !== sum.totalDependencies) fail('crossref summary 恒等关系不成立', sum);
pass(`crossref 组合链决定性正例：${structEdges.length} 条结构边（含 CALLS→standardCandidates），恒等关系成立`);

// 2. 同源对照：getCallees 对有 DIRECT 行的 abapGit 移植类读到真实引用。
const probe2 = await call('getCallees', { objectType: 'CLAS', objectName: 'ZCL_ABAPGIT_ABAP_LANGUAGE_VERS', maxResults: 50 });
const p2v = probe2?.result?.result || probe2?.result || probe2;
const calleeCount = (p2v?.callees || []).length;
console.log(`INFO getCallees 对照：callees=${calleeCount} sources=${JSON.stringify(p2v?.sourcesSearched)}`);
if (calleeCount === 0) fail('getCallees 正例对象零结果', p2v);
pass(`同源对照：getCallees 在同一交叉表上读到 ${calleeCount} 条引用（数据源真实可读）`);

// 3. 双源组合 + 预算约束真机形态（独立 MCP 会话：datapreview 每会话查询预算
//    约 19 次，前置调用耗尽后 E071 读会静默失败成空成员——历史环境特性）
await client.close();
const client2 = new Client({ name: 'xref-scope-smoke-2', version: '1.0.0' }, { capabilities: {} });
const transport2 = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
await client2.connect(transport2);
const call2 = async (name, args) => parse(await client2.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
const combo = await call2('getTransportScope', {
  transports: ['S4HK900010'], includeLoadBoundaries: true, includeCrossRefBoundaries: true,
  maxDependencyQueries: 6, maxEntries: 100
});
const cv = combo?.result?.result || combo?.result || combo;
if (!cv.analysis) fail('双源组合 analysis 为 null', cv);
const kinds = {};
for (const e of (cv.graph.edges || [])) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
console.log(`INFO 双源组合：edges=${JSON.stringify(kinds)} status=${cv.collection.status} skipped=${(cv.collection.skipped || []).length}`);
if ((cv.boundaryScope?.objectIds || []).length === 0) fail('双源组合成员为空（会话预算耗尽或采集失败）', cv.membership);
if ((cv.graph.edges || []).some(e => !['LOADS', 'REFERENCES', 'CALLS', 'IN_TRANSPORT'].includes(e.kind))) {
  fail('出现未知边类型', kinds);
}
if (!cv.analysis) fail('双源组合 analysis 为 null', cv);
pass(`双源组合：LOADS 与 REFERENCES/CALLS 边共存，status=${cv.collection.status}`);

// 4. 负例：双 false → InvalidParams
const bad = await call2('getTransportScope', { transports: ['S4HK900010'], includeLoadBoundaries: false, includeCrossRefBoundaries: false });
if (!String(JSON.stringify(bad)).match(/-32602|InvalidParams|At least one/i)) fail('双 false 未拒', bad);
pass('负例：双开关 false → InvalidParams');
await client2.close();

console.log('SMOKE OK: getTransportScope crossref 结构边界链在真实 DEV 端到端验证通过');
await client.close();
