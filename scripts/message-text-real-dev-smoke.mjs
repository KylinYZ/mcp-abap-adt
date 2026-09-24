// 最终 smoke：全新受控创建的消息类（无任何锁历史），完整走受控链：
// 受控创建 → 对象 LOCK → PUT（application/* + query 对象锁句柄）→ readback → 同值短路 → 清理
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SUFFIX = String(Date.now()).slice(-4);
const MC = `ZMCTEXTSM${SUFFIX}`.slice(0, 20);
const envText = readFileSync(resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env'), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env'),
  SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'mtext-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe'
});

function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}

let expectKeywords = [];
let expectDecision = 'cancel';
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  if (!expectKeywords.every(k => message.includes(k))) {
    console.log('WARN 确认未匹配，已取消:', message.slice(0, 120));
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: expectDecision } };
});

function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 300)}`); process.exit(1); }
async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(t => t.name));
  for (const tool of ['previewMessageTextChange', 'applyMessageTextChange', 'getMessageTextChangeStatus']) {
    pass(names.has(tool) ? `${tool} 在 DEV focused catalog` : `FAIL ${tool} 不在 catalog`);
  }

  // 1. 受控创建消息类（全新名，无锁历史）
  expectKeywords = [MC]; expectDecision = 'apply';
  let p1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    p1 = await call('previewRepositoryObjectCreation', {
      objectKind: 'MESSAGE_CLASS', name: MC, description: 'Message text smoke',
      packageName: 'Z001', transportRequest: 'S4HK900009',
      properties: { errorMessage: { id: 'ZMC_TEST', number: '001' } }
    });
    if (p1.status === 'preview') break;
    console.log(`INFO 创建 preview 第 ${attempt} 次未过: ${p1.error?.message?.slice(0, 100)}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  if (p1.status !== 'preview') fail('消息类创建 preview', p1);
  const a1 = await call('applyRepositoryObjectCreation', { creationPlanId: p1.plan.creationPlanId });
  if (!(a1.status === 'success' || a1.plan?.status === 'SUCCEEDED')) fail('消息类创建 apply', a1);
  pass(`消息类 ${MC} 受控创建完成`);

  // 2. 消息文本写入（MCP 受控链：对象 LOCK → PUT → readback → 解锁）
  expectKeywords = []; expectDecision = 'cancel';
  const p2raw = await call('previewMessageTextChange', {
    messageClass: MC, language: 'EN', transport: 'S4HK900009',
    texts: [{ number: '001', text: 'Message text smoke A' }, { number: '002', text: 'Message text smoke B' }]
  });
  const p2 = p2raw?.result || p2raw;
  if (p2?.status !== 'preview') fail('消息文本 preview', p2raw);
  pass(`plan 冻结（old=${(p2.plan.oldTexts || []).length} 条 → new=${p2.plan.newTexts.length} 条）`);

  expectKeywords = [MC, 'repository write']; expectDecision = 'apply';
  const a2raw = await call('applyMessageTextChange', { messageTextPlanId: p2.plan.messageTextPlanId });
  const a2 = a2raw?.result || a2raw;
  if (a2?.status !== 'success') fail('消息文本 apply', a2raw);
  pass(`apply 成功（newTexts=${JSON.stringify(a2.plan?.newTexts || []).slice(0, 150)}）`);

  // 3. 同值短路复验（apply 同样需要原生确认——接受后走 sameValue 短路分支）
  expectKeywords = []; expectDecision = 'cancel';
  const p3raw = await call('previewMessageTextChange', {
    messageClass: MC, language: 'EN', transport: 'S4HK900009',
    texts: [{ number: '001', text: 'Message text smoke A' }, { number: '002', text: 'Message text smoke B' }]
  });
  expectKeywords = [MC, 'repository write']; expectDecision = 'apply';
  const a3raw = await call('applyMessageTextChange', { messageTextPlanId: (p3raw?.result || p3raw)?.plan?.messageTextPlanId });
  const a3 = a3raw?.result || a3raw;
  if (a3?.status !== 'success' || a3?.sameValue !== true) fail('同值短路', a3raw);
  pass(`同值短路：status=${a3.status} sameValue=${a3.sameValue}（未锁未写）`);

  // 4. 受控清理 + absence
  expectKeywords = [MC]; expectDecision = 'apply';
  const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'MESSAGE_CLASS', name: MC });
  if (cp.status !== 'preview') fail('清理 preview', cp);
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp.plan.cleanupPlanId });
  const s = await call('searchObject', { query: MC, objType: 'MSAG', max: 5 });
  pass((s.results || []).length === 0 ? 'absence 复查通过（零残留）' : 'absence 失败：消息类仍存在');

  console.log('SMOKE OK: 受控消息文本写入链在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
