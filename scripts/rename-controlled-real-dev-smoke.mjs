// 受控对象重命名一站式工作流真机闭环（写操作，自建对象）：
// 受控创建源 PROGRAM → previewControlledRename（读源快照+声明改名冻结）→
// 确认 applyControlledRename（克隆新对象+受控删除旧对象）→ readback 比对 →
// absence（旧对象已删/新对象已随重命名清理）零残留
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// 对象名带时间戳后缀：SAP 端 ENQ 锁释放有延迟，清理后立即重建同名对象会撞
// "当前编辑"锁冲突（历史教训），全新名字从根上绕开
const SUFFIX = String(Date.now()).slice(-4);
const OLD = `ZVRENOLD${SUFFIX}`;
const NEW = `ZVRENNEW${SUFFIX}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env'),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'rename-controlled-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
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

const OLD_CODE = `REPORT ${OLD.toLowerCase()}.\nWRITE / 'rename controlled smoke source'.`;
const NEW_CODE = `REPORT ${NEW}.\nWRITE / 'rename controlled smoke source'.`;

async function cleanup(name) {
  expectKeywords = [name]; expectDecision = 'apply';
  const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name });
  if (cp.status !== 'preview') return false;
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp.plan.cleanupPlanId });
  return true;
}

async function search(name) {
  const s = await call('searchObject', { query: name, objType: 'PROG/P', max: 5 });
  return (s.results || []).filter(item => String(item['adtcore:name'] || '').toUpperCase() === name);
}

async function main() {
  await client.connect(transport);

  // 0. 残留清理（上次中断可能留下同名对象）
  for (const name of [OLD, NEW]) {
    if ((await search(name)).length > 0) {
      console.log(`INFO 清理残留 ${name}`);
      await cleanup(name);
    }
  }

  // 1. 受控创建旧对象
  expectKeywords = [OLD]; expectDecision = 'apply';
  const p1 = await call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: OLD, description: 'Rename controlled smoke original',
    packageName: 'Z001', transportRequest: 'S4HK900009', source: OLD_CODE
  });
  if (p1.status !== 'preview') fail('源创建 preview', p1);
  const a1 = await call('applyRepositoryObjectCreation', { creationPlanId: p1.plan.creationPlanId });
  if (!(a1.status === 'success' || a1.plan?.status === 'SUCCEEDED')) fail('源创建 apply', a1);
  pass(`旧对象受控创建完成（${OLD}）`);

  // 2. previewControlledRename（只读预检：读源快照 + 声明改名冻结）
  expectKeywords = []; expectDecision = 'cancel';
  const pr = await call('previewControlledRename', {
    objectType: 'PROGRAM', oldName: OLD, newName: NEW, packageName: 'Z001', transport: 'S4HK900009'
  });
  const prInner = pr.result ?? pr;
  if (prInner.status !== 'preview') fail('重命名 preview', pr);
  const plan = prInner.plan;
  if (plan.oldName !== OLD || plan.newName !== NEW) fail('重命名 plan 身份不符', plan);
  if (!/^[a-f0-9]{64}$/.test(String(plan.payloadHash))) fail('重命名 plan payloadHash 缺失', plan);
  if (plan.declarationChanges !== 1) fail('声明变更数应为 1（PROGRAM）', plan);
  if (plan.description !== `Renamed from ${OLD}`) fail('默认描述应为 Renamed from <old>', plan);
  pass(`重命名 preview 冻结：${plan.oldName} -> ${plan.newName}，源 hash ${String(plan.sourceHash).slice(0, 12)}…`);

  // 3. 确认 applyControlledRename（克隆新对象 + 受控删除旧对象，单确认两步）
  expectKeywords = [NEW]; expectDecision = 'apply';
  const ar = await call('applyControlledRename', { renamePlanId: plan.renamePlanId });
  const arInner = ar.result ?? ar;
  if (arInner.status !== 'success') fail('重命名 apply', ar);
  if (arInner.plan?.status !== 'SUCCEEDED') fail('重命名 plan 状态非 SUCCEEDED', arInner);
  pass('重命名 apply 完成（克隆落地 APPLIED + 旧对象受控删除）');

  // 4. readback：新对象源码直读比对（独立验证）
  expectKeywords = []; expectDecision = 'cancel';
  const newRead = await call('getObjectSource', { objectSourceUrl: `/sap/bc/adt/programs/programs/${NEW.toLowerCase()}/source/main` });
  const newText = newRead?.result?.source ?? newRead?.source ?? '';
  const norm = s => String(s).replace(/\r\n/g, '\n').trim();
  if (norm(newText) !== norm(NEW_CODE)) {
    fail('新对象 readback 不一致', { actual: norm(newText).slice(0, 150), expected: norm(NEW_CODE) });
  }
  pass('新对象 readback 比对一致（声明行为 REPORT ' + NEW + '）');

  // 5. absence：旧对象已删除；新对象属本次验证产物，受控清理
  if ((await search(OLD)).length !== 0) fail('旧对象未删除（absence 失败）', { old: OLD });
  pass('旧对象 absence 复查通过（已删除）');
  if ((await search(NEW)).length > 0) {
    await cleanup(NEW);
    if ((await search(NEW)).length !== 0) fail('新对象清理后仍存在', { new: NEW });
  }
  pass('新对象受控清理 + absence 复查通过（系统零残留）');

  // 6. 重命名 plan 状态复查（本地）
  const st = await call('getControlledRenameStatus', { renamePlanId: plan.renamePlanId });
  if ((st.result?.result ?? st.result)?.status !== 'SUCCEEDED') fail('重命名 plan 状态非 SUCCEEDED', st);
  pass('重命名 plan 状态 SUCCEEDED（本地复查）');

  console.log('SMOKE OK: 受控对象重命名一站式工作流在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
