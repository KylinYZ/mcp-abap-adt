// recover-failed-create 真机 smoke（sap-demo）：
// ① 冻结 PROGRAM 创建计划（目标尚不存在）→ ② 直连 ADT 预造同名残留（模拟
//    "另一会话创建到一半崩溃"的真实残局）→ ③ apply 必然 FAILED（目标已存在）
//    → ④ 恢复绑定清理（plan 绑定 + inactive 容错解析 + 受控删除 + absence）
//    → ⑤ 负例：APPLIED 计划拒绝绑定、未知计划 PLAN_NOT_FOUND、普通清理不受影响。
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient } from '../dist/adt/index.js';
import { createObject } from '../dist/adt/api/objectcreator.js';

const SUFFIX = String(Date.now()).slice(-4);
const PROG_LEFT = `ZPRGSMK${SUFFIX}`;      // 残留程序（直连预造）
const PROG_OK = `ZPRGSOK${SUFFIX}`;        // 正常创建成功的程序（负例用）
const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false' });

const client = new Client({ name: 'recover-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
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
    console.log('WARN 确认未匹配，已取消:', message.slice(0, 140));
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: expectDecision } };
});
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 400)}`); process.exit(1); }
async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}

async function main() {
  await client.connect(transport);

  // 1. 冻结创建计划（此刻目标不存在，preview/名字校验通过）
  expectKeywords = [PROG_LEFT]; expectDecision = 'cancel';
  const p1 = await call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: PROG_LEFT, description: 'recover smoke leftover',
    packageName: 'Z001', transportRequest: 'S4HK900009', source: `REPORT ${PROG_LEFT.toLowerCase()}.\n`
  });
  const p1v = p1?.result || p1;
  if (p1v?.status !== 'preview') fail('残留目标创建 preview', p1);
  pass(`创建计划冻结：${p1v.plan.creationPlanId.slice(0, 8)}…`);

  // 2. 直连 ADT（stateless）预造同名残留：模拟崩溃创建（inactive、登记传输）
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  await createObject(raw.h, {
    objtype: 'PROG/P', name: PROG_LEFT, parentName: 'Z001',
    description: 'recover smoke leftover (simulated crashed creation)',
    transport: 'S4HK900009', contentType: 'application/*'
  });
  try { await raw.h.logout(); } catch {}
  pass(`残留程序已直连预造（inactive，登记 S4HK900009）：${PROG_LEFT}`);

  // 3. apply 该计划：目标已存在 → 创建前置校验失败 → FAILED（无补偿资源）
  expectKeywords = [PROG_LEFT]; expectDecision = 'apply';
  const a1raw = await call('applyRepositoryObjectCreation', { creationPlanId: p1v.plan.creationPlanId });
  const a1 = a1raw?.result || a1raw;
  const s1 = await call('getRepositoryObjectCreationStatus', { creationPlanId: p1v.plan.creationPlanId });
  const s1v = s1?.result || s1;
  const status1 = s1v?.plan?.status;
  if (!['FAILED', 'OUTCOME_UNKNOWN', 'COMPENSATION_FAILED'].includes(status1)) {
    fail('失败创建计划状态不符合预期', { apply: a1, status: status1 });
  }
  pass(`apply 失败（残留目标已存在）：plan status=${status1}`);

  // 4. 恢复绑定清理：preview 校验绑定 + 溯源，确认后 apply 删除 + absence
  expectKeywords = [PROG_LEFT]; expectDecision = 'cancel';
  const cp1 = await call('previewRepositoryObjectCleanup', {
    objectKind: 'PROGRAM', name: PROG_LEFT, creationPlanId: p1v.plan.creationPlanId
  });
  const cp1v = cp1?.result || cp1;
  if (cp1v?.status !== 'preview') fail('恢复清理 preview', cp1);
  if (cp1v.plan.recoveryOf?.creationPlanId !== p1v.plan.creationPlanId) fail('恢复溯源缺失', cp1v.plan.recoveryOf);
  const usedInactive = cp1v.plan.target?.recoveryVersion === 'inactive';
  pass(`恢复清理 preview：绑定 ${cp1v.plan.recoveryOf.creationPlanStatus}${usedInactive ? '（inactive 容错解析生效）' : ''}`);

  expectKeywords = [PROG_LEFT]; expectDecision = 'apply';
  const ca1 = await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp1v.plan.cleanupPlanId });
  const ca1v = ca1?.result || ca1;
  if (!(ca1v?.status === 'success' && ['COMPLETED', 'COMPLETED_LOCAL_ABSENCE'].includes(ca1v.plan?.status))) {
    fail('恢复清理 apply', ca1);
  }
  const gone1 = await call('searchObject', { query: PROG_LEFT, objType: 'PROG/P', max: 5 });
  if ((gone1.results || []).length !== 0) fail('残留程序缺席复核', gone1);
  pass(`恢复清理成功 + 缺席复核通过：${PROG_LEFT}（status=${ca1v.plan.status}）`);

  // 5. 负例 A：APPLIED 计划不可作为恢复依据；普通清理不受影响
  expectKeywords = [PROG_OK]; expectDecision = 'cancel';
  const p2 = await call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: PROG_OK, description: 'recover smoke normal creation',
    packageName: 'Z001', transportRequest: 'S4HK900009', source: `REPORT ${PROG_OK.toLowerCase()}.\n`
  });
  const p2v = p2?.result || p2;
  if (p2v?.status !== 'preview') fail('正常创建 preview', p2);
  expectKeywords = [PROG_OK]; expectDecision = 'apply';
  const a2raw = await call('applyRepositoryObjectCreation', { creationPlanId: p2v.plan.creationPlanId });
  const a2 = a2raw?.result || a2raw;
  if (a2?.status !== 'success') fail('正常创建 apply', a2);
  expectKeywords = [PROG_OK]; expectDecision = 'cancel';
  const negA = await call('previewRepositoryObjectCleanup', {
    objectKind: 'PROGRAM', name: PROG_OK, creationPlanId: p2v.plan.creationPlanId
  });
  if (!((negA.error || {}).code === 'POLICY_DENIED' || String(negA.error?.message || negA).includes('POLICY_DENIED'))) {
    fail('APPLIED 计划应拒绝恢复绑定', negA);
  }
  pass('负例 A：APPLIED 计划拒绝恢复绑定（POLICY_DENIED）');
  // 普通清理（无绑定）删除成功创建的对象——回归验证
  const cp2 = await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name: PROG_OK });
  const cp2v = cp2?.result || cp2;
  if (cp2v?.status !== 'preview') fail('普通清理 preview', cp2);
  expectKeywords = [PROG_OK]; expectDecision = 'apply';
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp2v.plan.cleanupPlanId });
  const gone2 = await call('searchObject', { query: PROG_OK, objType: 'PROG/P', max: 5 });
  if ((gone2.results || []).length !== 0) fail('普通清理缺席复核', gone2);
  pass('普通清理（无绑定）回归验证通过');

  // 6. 负例 B：未知计划 id → PLAN_NOT_FOUND
  const negB = await call('previewRepositoryObjectCleanup', {
    objectKind: 'PROGRAM', name: PROG_OK, creationPlanId: 'ffffffff-6666-4666-8666-0000000000f6'
  });
  if (!String(JSON.stringify(negB)).includes('PLAN_NOT_FOUND')) fail('未知计划应报 PLAN_NOT_FOUND', negB);
  pass('负例 B：未知计划 PLAN_NOT_FOUND');

  console.log('SMOKE OK: recover-failed-create 受控恢复链在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
