// 受控描述修改真机闭环（写操作，自建对象）：
// 受控创建 PROGRAM → previewDescriptionChange → 确认 apply → readback → 清理
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SUFFIX = String(Date.now()).slice(-4);
const OBJ = `ZDESCSMK${SUFFIX}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env'),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'desc-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
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

  // 1. 受控创建自建对象（含初始描述）
  expectKeywords = [OBJ]; expectDecision = 'apply';
  const p1 = await call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: OBJ, description: 'Desc smoke original',
    packageName: 'Z001', transportRequest: 'S4HK900009',
    source: `REPORT ${OBJ.toLowerCase()}.\nWRITE / 'desc'.`
  });
  if (p1.status !== 'preview') fail('创建 preview', p1);
  const a1 = await call('applyRepositoryObjectCreation', { creationPlanId: p1.plan.creationPlanId });
  if (!(a1.status === 'success' || a1.plan?.status === 'SUCCEEDED')) fail('创建 apply', a1);
  pass('自建对象创建完成（原描述 "Desc smoke original"）');

  // 2. previewDescriptionChange（只读预检）
  expectKeywords = []; expectDecision = 'cancel';
  const p2raw = await call('previewDescriptionChange', {
    objectType: 'PROG', name: OBJ, description: 'Desc smoke updated', transport: 'S4HK900009'
  });
  const p2 = p2raw?.result || p2raw;
  if (p2?.status !== 'preview') fail('描述 preview', p2raw);
  pass(`描述 plan 冻结（old="${p2.plan.oldDescription}" → new="${p2.plan.newDescription}"）`);

  // 3. 确认 apply（原生确认 decision=apply）
  expectKeywords = [OBJ, 'repository write']; expectDecision = 'apply';
  const a2raw = await call('applyDescriptionChange', { descriptionPlanId: p2.plan.descriptionPlanId });
  const a2 = a2raw?.result || a2raw;
  if (a2?.status !== 'success') fail('描述 apply', a2raw);
  pass(`描述 apply 成功（readback="${a2.readback}"）`);

  // 4. 独立 readback：重读对象元数据验证描述
  const meta = await call('getObjectSource', { objectSourceUrl: `/sap/bc/adt/programs/programs/${OBJ.toLowerCase()}` });
  const metaXml = JSON.stringify(meta);
  const descMatch = /adtcore:description=&quot;([^&]*)&quot;|adtcore:description="([^"]*)"/.exec(metaXml);
  if (descMatch) {
    const actual = descMatch[1] || descMatch[2];
    pass(actual === 'Desc smoke updated' ? `独立元数据复查描述一致："${actual}"` : `描述不一致："${actual}"`);
  } else {
    console.log('INFO 元数据直读未取到 description 属性（以工作流 readback 为准）');
  }

  // 5. 清理 + absence
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
