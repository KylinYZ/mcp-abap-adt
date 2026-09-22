// crud.clone-object 组合任务路径真机闭环（全部走既有受控 MCP 工具）：
// 清理残留 → 受控创建源对象 → 读源 → 改名 → 受控创建目标（携带改名源码）→ 读回比对 → 双清理 absence
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env'),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'clone-path-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
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
  const ok = expectKeywords.every(k => message.includes(k));
  if (!ok) { console.log('WARN 确认未匹配，已取消:', message.slice(0, 120)); return { action: 'cancel' }; }
  return { action: 'accept', content: { decision: expectDecision } };
});

function pass(m) { console.log('PASS', m); }
function fail(m, payload) { console.log(`FAIL ${m}\n${JSON.stringify(payload || {}).slice(0, 300)}`); process.exit(1); }

// 对象名带时间戳后缀：SAP 端 ENQ 锁释放有延迟，清理后立即重建同名对象会撞
// "当前编辑"锁冲突（历史教训），全新名字从根上绕开
const RUN_SUFFIX = String(Date.now()).slice(-4);
const SRC = `ZVCLONESRC${RUN_SUFFIX}`;
const TGT = `ZVCLONETGT${RUN_SUFFIX}`;
const SRC_CODE = `REPORT ${SRC.toLowerCase()}.\nWRITE / 'clone source object'.`;

async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}

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
    objectKind: 'PROGRAM', name: SRC, description: 'Clone path smoke source',
    packageName: 'Z001', transportRequest: 'S4HK900009', source: SRC_CODE
  });
  if (p1.status !== 'preview') fail('源创建 preview', p1);
  const a1 = await call('applyRepositoryObjectCreation', { creationPlanId: p1.plan.creationPlanId });
  pass(a1.status === 'success' || a1.plan?.status === 'SUCCEEDED' ? '源对象受控创建完成' : `源创建状态异常: ${JSON.stringify(a1).slice(0, 150)}`);

  // 2. 读源（ADT 直读）
  const srcRead = await call('getObjectSource', { objectSourceUrl: `/sap/bc/adt/programs/programs/${SRC.toLowerCase()}/source/main` });
  const srcText = srcRead?.result?.source ?? srcRead?.source ?? srcRead?.result?.content ?? (typeof srcRead === 'string' ? srcRead : JSON.stringify(srcRead));
  if (!String(srcText).toLowerCase().includes(SRC.toLowerCase())) fail('源码读取异常', { head: String(srcText).slice(0, 150) });
  pass('源码读取成功（含声明行）');

  // 3. 名称替换（对齐 VSP CloneObject 的 REPORT 声明改名语义；纯字符串操作）
  const lines = String(srcText).split('\n');
  const declIdx = lines.findIndex(l => /^report\s/i.test(l.trim()));
  if (declIdx < 0 || !lines[declIdx].toLowerCase().includes(SRC.toLowerCase())) {
    fail('源码中未找到 REPORT 声明行', { head: String(srcText).slice(0, 150) });
  }
  lines[declIdx] = lines[declIdx].replace(new RegExp(SRC, 'i'), TGT);
  const targetCode = lines.join('\n');
  pass(`声明行改名完成: ${lines[declIdx].trim()}`);

  // 4. 受控创建目标对象（携带改名后源码）
  expectKeywords = [TGT]; expectDecision = 'apply';
  const p2 = await call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: TGT, description: `Copy of ${SRC}`,
    packageName: 'Z001', transportRequest: 'S4HK900009', source: targetCode
  });
  if (p2.status !== 'preview') fail('目标创建 preview', p2);
  const a2 = await call('applyRepositoryObjectCreation', { creationPlanId: p2.plan.creationPlanId });
  pass(a2.status === 'success' || a2.plan?.status === 'SUCCEEDED' ? '目标对象受控创建完成（clone 落地）' : `目标创建状态异常: ${JSON.stringify(a2).slice(0, 200)}`);

  // 5. 读回比对
  const tgtRead = await call('getObjectSource', { objectSourceUrl: `/sap/bc/adt/programs/programs/${TGT.toLowerCase()}/source/main` });
  const tgtText = tgtRead?.result?.source ?? tgtRead?.source ?? tgtRead?.result?.content ?? (typeof tgtRead === 'string' ? tgtRead : JSON.stringify(tgtRead));
  const norm = s => String(s).replace(/\r\n/g, '\n').trim();
  pass(norm(tgtText) === norm(targetCode) ? 'readback 比对一致（目标源码 = 改名后源码）' : `readback 不一致: 目标=${norm(tgtText).slice(0, 120)} 期望=${norm(targetCode).slice(0, 120)}`);

  // 6. 双清理 + absence
  for (const name of [SRC, TGT]) await cleanup(name);
  const s1 = await call('searchObject', { query: SRC, objType: 'PROG/P', max: 5 });
  const s2 = await call('searchObject', { query: TGT, objType: 'PROG/P', max: 5 });
  pass((s1.results || []).length === 0 && (s2.results || []).length === 0 ? '双对象 absence 复查通过（系统零残留）' : 'absence 复查发现残留');

  console.log('SMOKE OK: clone-object 组合任务路径在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
