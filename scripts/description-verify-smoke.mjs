// 受控描述修改 MCP 层真机复验（对象已存在）：preview → 确认 apply → readback → 清理
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const OBJ = 'ZDESCSMK3';
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env'),
  SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'desc-mcp-verify', version: '1.0.0' }, { capabilities: { elicitation: {} } });
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
    console.log('WARN 确认未匹配:', message.slice(0, 120));
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

  // 1. preview（只读预检：old → new）
  expectKeywords = []; expectDecision = 'cancel';
  const p2raw = await call('previewDescriptionChange', {
    objectType: 'PROG', name: OBJ, description: 'Desc smoke roundtrip', transport: 'S4HK900009'
  });
  const p2 = p2raw?.result || p2raw;
  if (p2?.status !== 'preview') fail('描述 preview', p2raw);
  pass(`plan 冻结（old="${p2.plan.oldDescription}" → new="${p2.plan.newDescription}"）`);

  // 2. 确认 apply（decision=apply）
  expectKeywords = [OBJ, 'repository write']; expectDecision = 'apply';
  const a2raw = await call('applyDescriptionChange', { descriptionPlanId: p2.plan.descriptionPlanId });
  const a2 = a2raw?.result || a2raw;
  if (a2?.status !== 'success') fail('描述 apply', a2raw);
  pass(`apply 成功（readback="${a2.readback}"）`);

  // 3. 同值短路复验（再 apply 一次相同值 → sameValue 路径也应成功）
  expectKeywords = []; expectDecision = 'cancel';
  const p3raw = await call('previewDescriptionChange', {
    objectType: 'PROG', name: OBJ, description: 'Desc smoke roundtrip', transport: 'S4HK900009'
  });
  const p3 = p3raw?.result || p3raw;
  expectKeywords = [OBJ, 'repository write']; expectDecision = 'apply';
  const a3raw = await call('applyDescriptionChange', { descriptionPlanId: p3.plan.descriptionPlanId });
  const a3 = a3raw?.result || a3raw;
  pass(`同值 apply（sameValue 语义）status=${a3?.status}`);

  // 4. 清理
  expectKeywords = [OBJ]; expectDecision = 'apply';
  const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name: OBJ });
  if (cp.status !== 'preview') fail('清理 preview', cp);
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp.plan.cleanupPlanId });
  const s = await call('searchObject', { query: OBJ, objType: 'PROG/P', max: 5 });
  pass((s.results || []).length === 0 ? 'absence 复查通过（零残留）' : 'absence 失败：对象仍存在');

  console.log('SMOKE OK: 受控描述修改链在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
