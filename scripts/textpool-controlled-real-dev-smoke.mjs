// 受控程序文本池写入（F1 完整方案）真机 smoke（sap-demo）：
// previewTextPoolChange（冻结 plan）→ applyTextPoolChange（原生确认 + 锁链单次
// 执行 + readback）→ status → 同值短路 → 收尾受控清理 + 缺席。写操作均为授权
// 范围（自建 Z* 验证程序），前后只读复查，串行。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient } from '../dist/adt/index.js';
import { createObject } from '../dist/adt/api/objectcreator.js';
import { lock, setObjectSource, unLock } from '../dist/adt/api/objectcontents.js';
import pkgActivate from '../dist/adt/api/activate.js';
const activateObject = pkgActivate.activate ?? pkgActivate.default ?? pkgActivate;

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(ENV_PATH, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: ENV_PATH, SAP_MCP_LOG_LEVEL: 'warn', SAP_MCP_REAL_DEV_VALIDATION: 'false' });

const PROG = `ZWTPOL${String(Date.now()).slice(-4)}`;
const ELEMENTS = [
  { id: '001', text: '受控文本池冒烟一' },
  { id: '002', text: '受控文本池冒烟二' }
];

const client = new Client({ name: 'tpool-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
let expectKeywords = [];
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  if (expectKeywords.length && !expectKeywords.every(k => message.includes(k))) {
    console.log('WARN 确认未匹配，已取消:', message.slice(0, 120));
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: 'apply' } };
});
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 600)}`); process.exit(1); }

async function main() {
  await client.connect(transport);

  // 0. catalog
  const tools = await client.listTools();
  for (const t of ['previewTextPoolChange', 'applyTextPoolChange', 'getTextPoolChangeStatus']) {
    if (!tools.tools.some(x => x.name === t)) fail(`${t} 不在 catalog`);
  }
  pass('受控文本池三件套在 focused catalog');

  // 1. 直连 ADT：创建靶程序（引用 TEXT-001/002）+ 源码 + 激活
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  await createObject(raw.h, {
    objtype: 'PROG/P', name: PROG, parentName: 'Z001',
    description: 'controlled textpool smoke target', transport: 'S4HK900009',
    contentType: 'application/*'
  });
  raw.stateful = 'stateful';
  await raw.h.login();
  const source = `REPORT ${PROG.toLowerCase()}.\nWRITE / TEXT-001.\nWRITE / TEXT-002.\n`;
  const lh = String((await lock(raw.h, `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`, 'MODIFY')).LOCK_HANDLE || '');
  if (!lh) fail('直连加锁失败');
  await setObjectSource(raw.h, `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}/source/main`, source, lh, 'S4HK900009');
  await unLock(raw.h, `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`, lh);
  const act = await activateObject(raw.h, PROG, `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`);
  if (act?.success === false) fail('直连激活失败', act);
  await raw.h.logout().catch(() => {});
  pass(`靶程序直连创建+激活：${PROG}`);

  // 2. preview：冻结受控 plan（写入 2 条文本符号）
  expectKeywords = [PROG];
  const prev = await call('previewTextPoolChange', {
    program: PROG, category: 'symbols', elements: ELEMENTS, transport: 'S4HK900009'
  });
  const prevV = prev?.result?.result || prev?.result || prev;
  if (prevV?.status !== 'preview') fail('preview', prev);
  const planId = prevV.plan.textPoolPlanId;
  console.log(`INFO plan=${planId.slice(0, 8)}… old=${prevV.plan.oldElements.length} new=${prevV.plan.newElements.length}`);
  pass('preview 冻结受控 plan');

  // 3. apply：原生确认后单次执行（锁 → PUT → 解锁 → readback）
  expectKeywords = [PROG];
  const apply = await call('applyTextPoolChange', { textPoolPlanId: planId });
  const applyV = apply?.result?.result || apply?.result || apply;
  if (applyV?.status !== 'success') fail('apply', apply);
  if (applyV.sameValue === true) fail('不应触发同值短路', applyV);
  pass(`apply 执行成功（readback 核验通过，sameValue=${applyV.sameValue}）`);

  // 4. status：本地 plan 状态
  const st = await call('getTextPoolChangeStatus', { textPoolPlanId: planId });
  const stV = st?.result?.result || st?.result || st;
  if (stV?.status !== 'SUCCEEDED') fail('status', st);
  pass(`status=SUCCEEDED`);

  // 5. 同值短路：同清单再 preview + apply → sameValue=true（不锁不写）
  expectKeywords = [PROG];
  const prev2 = await call('previewTextPoolChange', {
    program: PROG, category: 'symbols', elements: ELEMENTS, transport: 'S4HK900009'
  });
  const prev2V = prev2?.result?.result || prev2?.result || prev2;
  expectKeywords = [];
  const apply2 = await call('applyTextPoolChange', { textPoolPlanId: prev2V.plan.textPoolPlanId });
  const apply2V = apply2?.result?.result || apply2?.result || apply2;
  if (apply2V?.sameValue !== true) fail('同值短路', apply2);
  pass('同值短路：sameValue=true（不锁不写）');

  // 6. 收尾：直连删除（靶对象为直连创建，无锁条目登记，受控清理的传输所有权
  // 校验不适用）+ absence
  expectKeywords = [];
  const raw3 = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw3.stateful = 'stateful';
  await raw3.h.login();
  const progUrl = `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`;
  const lh3 = String((await lock(raw3.h, progUrl, 'MODIFY')).LOCK_HANDLE || '');
  if (lh3) {
    await raw3.h.request(progUrl, { method: 'DELETE', qs: { lockHandle: lh3, corrNr: 'S4HK900009' } });
    await unLock(raw3.h, progUrl, lh3);
  }
  await raw3.h.logout().catch(() => {});
  const gone = await call('searchObject', { query: PROG, objType: 'PROG', max: 5 });
  if ((gone.results || []).length !== 0) fail('缺席复核', gone);
  pass('收尾：靶对象直连删除 + 缺席复核通过');

  console.log('SMOKE OK: 受控程序文本池写入链在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
