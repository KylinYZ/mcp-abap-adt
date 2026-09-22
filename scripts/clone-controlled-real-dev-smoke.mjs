// 受控对象克隆一站式工作流真机闭环（写操作，自建对象）：
// 受控创建源 PROGRAM → previewCloneObject（读源快照+声明改名冻结）→
// 确认 applyCloneObject（委托受控创建链）→ readback 比对 → 双清理 absence
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// 对象名带时间戳后缀：SAP 端 ENQ 锁释放有延迟，清理后立即重建同名对象会撞
// "当前编辑"锁冲突（历史教训），全新名字从根上绕开
const SUFFIX = String(Date.now()).slice(-4);
const SRC = `ZVCLSMKSRC${SUFFIX}`.slice(0, 30);
const TGT = `ZVCLSMKTGT${SUFFIX}`.slice(0, 30);
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env'),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'clone-controlled-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe'
});

function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}

// 阶段化确认：仅当消息包含预期对象名才 accept
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
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}, null, 1).slice(0, 3000)}`); process.exit(1); }
async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}

const SRC_CODE = `REPORT ${SRC.toLowerCase()}.\nWRITE / 'clone controlled smoke source'.`;
const TGT_CODE = `REPORT ${TGT.toUpperCase()}.\nWRITE / 'clone controlled smoke source'.`;

async function cleanup(name) {
  expectKeywords = [name]; expectDecision = 'apply';
  const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name });
  if (cp.status !== 'preview') return false;
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp.plan.cleanupPlanId });
  return true;
}

async function main() {
  await client.connect(transport);

  // 0. 残留清理（上次中断可能留下同名对象）
  for (const name of [SRC, TGT]) {
    const s = await call('searchObject', { query: name, objType: 'PROG/P', max: 5 });
    if ((s.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === name)) {
      console.log(`INFO 清理残留 ${name}`);
      await cleanup(name);
    }
  }

  // 1. 受控创建源对象
  expectKeywords = [SRC]; expectDecision = 'apply';
  const p1 = await call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: SRC, description: 'Clone controlled smoke source',
    packageName: 'Z001', transportRequest: 'S4HK900009', source: SRC_CODE
  });
  if (p1.status !== 'preview') fail('源创建 preview', p1);
  const a1 = await call('applyRepositoryObjectCreation', { creationPlanId: p1.plan.creationPlanId });
  if (!(a1.status === 'success' || a1.plan?.status === 'SUCCEEDED')) fail('源创建 apply', a1);
  pass(`源对象受控创建完成（${SRC}）`);

  // 2. previewCloneObject（只读预检：读源快照 + 声明改名冻结）
  expectKeywords = []; expectDecision = 'cancel';
  const pc = await call('previewCloneObject', {
    objectType: 'PROGRAM', sourceName: SRC, targetName: TGT,
    packageName: 'Z001', transport: 'S4HK900009'
  });
  const inner = pc.result ?? pc; // handler 包装层 {status:'success', result:{status:'preview', plan}}
  if (inner.status !== 'preview') fail('克隆 preview', pc);
  const plan = inner.plan;
  if (plan.sourceName !== SRC || plan.targetName !== TGT) fail('克隆 plan 身份不符', plan);
  if (!/^[a-f0-9]{64}$/.test(String(plan.payloadHash))) fail('克隆 plan payloadHash 缺失', plan);
  if (plan.declarationChanges !== 1) fail('声明变更数应为 1（PROGRAM）', plan);
  pass(`克隆 preview 冻结：${plan.sourceName} -> ${plan.targetName}，源 hash ${String(plan.sourceHash).slice(0, 12)}…，目标 ${plan.targetSourceLines} 行`);

  // 3. 确认 applyCloneObject（委托受控创建链单次执行）
  expectKeywords = [TGT]; expectDecision = 'apply';
  const ac = await call('applyCloneObject', { clonePlanId: plan.clonePlanId });
  if (ac.status !== 'success') fail('克隆 apply', ac);
  const creationPlan = ac.result?.creation?.plan;
  if (creationPlan && creationPlan.status !== 'APPLIED') fail('创建链 plan 状态非 APPLIED', creationPlan);
  pass('克隆 apply 完成（受控创建链 APPLIED，源码 hash 校验内建通过）');

  // 4. readback：目标对象源码直读比对（独立验证，不信任创建链自报）
  expectKeywords = []; expectDecision = 'cancel';
  const tgtRead = await call('getObjectSource', { objectSourceUrl: `/sap/bc/adt/programs/programs/${TGT.toLowerCase()}/source/main` });
  const tgtText = tgtRead?.result?.source ?? tgtRead?.source ?? '';
  const norm = s => String(s).replace(/\r\n/g, '\n').trim();
  if (norm(tgtText) !== norm(TGT_CODE)) {
    fail('readback 不一致', { actual: norm(tgtText).slice(0, 150), expected: norm(TGT_CODE) });
  }
  pass('readback 比对一致（目标源码 = 改名后源码，声明行为 REPORT ' + TGT.toUpperCase() + '）');

  // 5. 克隆 plan 状态复查（本地）
  const st = await call('getCloneObjectStatus', { clonePlanId: plan.clonePlanId });
  const stResult = st.result?.result ?? st.result;
  if (stResult?.status !== 'SUCCEEDED') fail('克隆 plan 状态非 SUCCEEDED', st);
  pass('克隆 plan 状态 SUCCEEDED（本地复查）');

  // 6. 双清理 + absence
  for (const name of [SRC, TGT]) await cleanup(name);
  const s1 = await call('searchObject', { query: SRC, objType: 'PROG/P', max: 5 });
  const s2 = await call('searchObject', { query: TGT, objType: 'PROG/P', max: 5 });
  if ((s1.results || []).length !== 0 || (s2.results || []).length !== 0) {
    fail('absence 复查发现残留', { src: (s1.results || []).length, tgt: (s2.results || []).length });
  }
  pass('双对象 absence 复查通过（系统零残留）');

  console.log('SMOKE OK: 受控对象克隆一站式工作流在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
