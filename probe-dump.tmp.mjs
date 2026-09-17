// dump 增值分析真机 smoke：groupRuntimeDumps + findSimilarDumps（全部只读）
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const env = Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env'), SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false' });
const client = new Client({ name:'dump-smoke', version:'1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args:['./dist/index.js'], cwd: process.cwd(), env });
function parse(r){const t=(r.content||[]).filter(i=>i.type==='text').map(i=>i.text).join('');try{return JSON.parse(t)}catch{return r}}
await client.connect(transport);
// 7 天窗口（reader 上限）
const to = new Date(), from = new Date(to.getTime() - 7*24*3600*1000);
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
let t = Date.now();
const grouped = parse(await client.callTool({ name:'groupRuntimeDumps', arguments:{ from: iso(from), to: iso(to), limit: 50 } }, undefined, { timeout: 300000 }));
console.log('groupRuntimeDumps ms:', Date.now()-t);
const gb = grouped?.result || grouped;
console.log('totalDumps:', gb?.totalDumps, '| groups:', gb?.groups?.length);
console.log('top 分组:', JSON.stringify((gb?.groups||[]).slice(0,3).map(g=>({e:g.runtimeError,p:g.program,count:g.count,last:g.last,users:g.users}))));
// 若有 dump，对第一个分组跑同类检索
if ((gb?.groups||[]).length > 0) {
  const g0 = gb.groups[0];
  t = Date.now();
  const similar = parse(await client.callTool({ name:'findSimilarDumps', arguments:{ runtimeError: g0.runtimeError, from: iso(from), to: iso(to), limit: 50 } }, undefined, { timeout: 300000 }));
  const sb = similar?.result || similar;
  console.log('findSimilarDumps ms:', Date.now()-t, '| count:', sb?.count, '| users:', JSON.stringify(sb?.users));
  console.log('occurrence 样例:', JSON.stringify((sb?.occurrences||[]).slice(0,2)));
} else {
  console.log('INFO: 窗口内无 dump，同类检索跳过（空窗口为合法答案）');
}
await client.close();
