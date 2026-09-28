// getTransportScope 真机 smoke（sap-demo）：传输成员采集 + includeLoadBoundaries 组合链。
// 只读 SQL（E070/E071/D010INC），无写操作。目标：历史验证传输 S4HK900010（父请求 S4HK900009）。
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

const client = new Client({ name: 'tscope-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 600)}`); process.exit(1); }

await client.connect(transport);

// 0. catalog
const tools = await client.listTools();
if (!tools.tools.some(t => t.name === 'getTransportScope')) fail('getTransportScope 不在 catalog');
pass('getTransportScope 在 focused catalog');

// 1. 成员采集模式：任务 S4HK900010 → 父请求 S4HK900009 + 兄弟任务 + R3TR 成员
const mem = await call('getTransportScope', { transports: ['S4HK900010'] });
// collectTransportScope 返回无顶层 status 字段——直接用结果对象
const m = mem?.result?.result || mem?.result || mem;
if (!(m.requests || []).includes('S4HK900009')) fail('父请求未解析', m.requests);
if (!(m.transports || []).includes('S4HK900010')) fail('任务自身不在传输清单', m.transports);
const memberCount = (m.boundaryScope?.objectIds || []).length;
if (memberCount === 0) fail('成员为空', m.boundaryScope);
const memberSample = (m.boundaryScope?.objectIds || []).slice(0, 6);
console.log(`INFO requests=${JSON.stringify(m.requests)} transports=${m.transports.length} members=${memberCount}`);
console.log(`INFO 成员样例: ${memberSample.join(', ')}`);
if (m.collection?.status !== 'complete-within-r3tr-reader-scope' && m.collection?.status !== 'partial') {
  fail('异常的 collection.status', m.collection);
}
pass(`成员采集：父请求归并正确、${memberCount} 个 R3TR 成员、status=${m.collection.status}`);

// 2. 组合边界模式：成员 + 每成员一跳 D010INC 出边 + 边界分类
const combo = await call('getTransportScope', {
  transports: ['S4HK900010'], includeLoadBoundaries: true, maxDependencyQueries: 5, maxEntries: 100
});
const c = combo?.result?.result || combo?.result || combo;
if (!c.analysis || typeof c.analysis !== 'object') fail('analysis 为 null（有成员时不应为空）', c.analysis);
const a = c.analysis;
if (!a.summary || typeof a.summary.totalDependencies !== 'number') fail('analysis.summary 缺失', a.summary);
const loadEdges = (c.graph?.edges || []).filter(e => e.kind === 'LOADS');
console.log(`INFO graph: nodes=${c.graph.nodes.length} edges=${c.graph.edges.length} (LOADS=${loadEdges.length})`);
console.log(`INFO analysis: totalDeps=${a.summary.totalDependencies} inScope=${a.summary.inScope}`
  + ` missingCustom=${a.summary.missingCustom} standard=${a.summary.standardCandidates}`
  + ` crossPackage=${a.summary.inScopeCrossPackage} deploymentReady=${a.deploymentReadinessVerified}`);
// partial 传播：maxDependencyQueries=5 必然小于支持类型成员数（该传输含多个 CLAS/PROG）
const depSkipped = (c.collection.skipped || []).filter(s => s.reason === 'dependency-query-limit');
const partialExpected = c.collection.status === 'partial';
if (!partialExpected) fail('预期 partial（查询预算 < 成员数）未出现', c.collection);
console.log(`INFO skipped=${(c.collection.skipped || []).length} (dependency-query-limit: ${depSkipped.length})`
  + ` dependencyQueryCount=${c.collection.dependencyQueryCount} status=${c.collection.status}`);
if (a.deploymentReadinessVerified !== false || c.systemWideComplete !== false) {
  fail('安全常量被违反（不得声称可释放/系统级完整）', { a: a.deploymentReadinessVerified, s: c.systemWideComplete });
}
// 恒等关系（文档声明）：totalDependencies = inScope + missingCustom + unknownNamespace + dynamic + standardCandidates
const sum = a.summary.inScope + a.summary.missingCustom + (a.summary.unknownNamespace || 0) + (a.summary.dynamic || 0) + a.summary.standardCandidates;
if (sum !== a.summary.totalDependencies) fail('summary 恒等关系不成立', { sum, total: a.summary.totalDependencies });
pass(`组合边界：成员+LOADS 出边+分类闭环（partial 正确传播，恒等关系成立）`);

// 3. 负例：未知传输 → 不抛错，reported partial（unresolved 记入 issues）
const unknown = await call('getTransportScope', { transports: ['DEVK900000'] });
const unknownV = unknown?.result?.result || unknown?.result || unknown;
const hasUnresolved = (unknownV.collection?.issues || []).some(i => String(i.reason).includes('unresolved'));
if (!hasUnresolved) fail('未知传输未记 unresolved', unknownV.result.collection);
pass('负例 A：未知传输 → partial + unresolved 记录（不抛错）');

// 4. 负例：非法输入 → InvalidParams
const bad = await call('getTransportScope', { transports: ['无效!ID'] });
if (!String(JSON.stringify(bad)).match(/-32602|InvalidParams/i)) fail('非法 ID 未拒', bad);
pass('负例 B：非法传输 ID → InvalidParams');

console.log('SMOKE OK: getTransportScope 成员采集与组合边界链在真实 DEV 端到端验证通过');
await client.close();
