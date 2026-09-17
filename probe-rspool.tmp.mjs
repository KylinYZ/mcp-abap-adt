// spool 内容读取真机 smoke：listSpoolRequests 取真实号 → readSpoolContent
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const env = Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env'), SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false' });
const client = new Client({ name:'spool-smoke', version:'1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args:['./dist/index.js'], cwd: process.cwd(), env });
function parse(r){const t=(r.content||[]).filter(i=>i.type==='text').map(i=>i.text).join('');try{return JSON.parse(t)}catch{return r}}
await client.connect(transport);
let t = Date.now();
const list = parse(await client.callTool({ name:'listSpoolRequests', arguments:{ limit: 10 } }, undefined, { timeout: 300000 }));
const lb = list?.result || list;
console.log('listSpoolRequests ms:', Date.now()-t, '| count:', lb?.count);
const first = (lb?.requests||[])[0];
console.log('第一个请求:', JSON.stringify(first).slice(0,300));
if (first?.number) {
  t = Date.now();
  const content = parse(await client.callTool({ name:'readSpoolContent', arguments:{ requestNumber: first.number } }, undefined, { timeout: 300000 }));
  const cb = content?.result || content;
  console.log('readSpoolContent ms:', Date.now()-t);
  console.log('contentType:', cb?.contentType, '| text 长度:', (cb?.text||'').length, '| rawNote:', (cb?.rawNote||'-').slice(0,120));
  console.log('文本样例:', JSON.stringify((cb?.text||'').slice(0,200)));
} else {
  console.log('INFO: 系统当前无 spool 请求，内容读取无法取样（需制造 spool 后再验）');
}
await client.close();
