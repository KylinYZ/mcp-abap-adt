// F1 最小方案真机 smoke（sap-demo）：原子 setTextElements 纳入 focused profile
// 的运行时可用性验证。写链：直连 ADT 创建自有验证程序 + 激活 → 直连拿锁 →
// MCP focused 面 setTextElements 写文本符号 → MCP getTextElements 读回断言
// → 直连解锁删除 + 缺席。写操作均为授权范围（自建 Z* 验证对象源码与文本池写），
// 前后只读复查，串行。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

const PROG = `ZWTXT${String(Date.now()).slice(-4)}`;
const PROG_URL = `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`;
const SOURCE = [
  `REPORT ${PROG.toLowerCase()}.`,
  'WRITE / TEXT-001.',
  'WRITE / TEXT-002.',
  ''
].join('\n');
const SYMBOL_001 = 'F1 冒烟文本一';
const SYMBOL_002 = 'F1 冒烟文本二';

const client = new Client({ name: 'f1-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'inherit' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
let expectKeywords = [];
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 600)}`); process.exit(1); }

async function main() {
  await client.connect(transport);

  // 1. focused 面运行时可见性（F1 核心验收：声明 profile 必须真机验证）
  const tools = await client.listTools();
  const tool = tools.tools.find(t => t.name === 'setTextElements');
  if (!tool) fail('focused 面未暴露 setTextElements（F1 纳入失败）');
  if (tool.annotations.readOnlyHint !== false) fail('setTextElements 应为写工具标注', tool.annotations);
  pass('focused 面运行时暴露 setTextElements（写工具标注正确）');

  // 2. 直连 ADT：创建靶程序 + 源码 + 激活（自建 Z* 对象）
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  await createObject(raw.h, {
    objtype: 'PROG/P', name: PROG, parentName: 'Z001',
    description: 'F1 textpool smoke target', transport: 'S4HK900009',
    contentType: 'application/*'
  });
  raw.stateful = 'stateful';
  await raw.h.login();
  const lockHandle = String((await lock(raw.h, PROG_URL, 'MODIFY')).LOCK_HANDLE || '');
  if (!lockHandle) fail('直连加锁失败');
  await setObjectSource(raw.h, `${PROG_URL}/source/main`, SOURCE, lockHandle, 'S4HK900009');
  await unLock(raw.h, PROG_URL, lockHandle);
  const activation = await activateObject(raw.h, PROG, PROG_URL);
  if (activation?.success === false) fail('直连激活失败', activation);
  pass(`靶程序直连创建+激活：${PROG}`);

  // 3. MCP focused：lock → setTextElements（锁句柄与写调用同 server 会话）
  expectKeywords = [PROG];
  const lk = await call('lock', { objectUrl: PROG_URL, accessMode: 'MODIFY' });
  const lkv = lk?.result?.result || lk?.result || lk;
  const lockMcp = String(lkv?.LOCK_HANDLE || lkv?.lockHandle || '');
  if (!lockMcp) fail('MCP lock 失败', lk);
  expectKeywords = [];
  const w = await call('setTextElements', {
    url: PROG_URL, category: 'symbols',
    elements: [
      { id: '001', text: SYMBOL_001 },
      { id: '002', text: SYMBOL_002 }
    ],
    lockHandle: lockMcp, transport: 'S4HK900009'
  });
  const wText = JSON.stringify(w);
  if (/error/i.test(wText) && !/success/i.test(wText)) fail('setTextElements 写入', wText.slice(0, 400));
  pass('setTextElements 写入 2 条文本符号（focused 面，同会话锁）');

  // 4. 读回断言（写后只读复查）
  const readback = await call('getTextElements', { url: PROG_URL, category: 'symbols' });
  const rv = readback?.result?.result || readback?.result || readback;
  const elements = rv?.textElements || rv?.elements || [];
  const found = (elements || []).filter(e => e.id === '001' || e.id === '002');
  console.log(`INFO 读回：${JSON.stringify(elements).slice(0, 300)}`);
  if (found.length < 2) fail('读回未含写入的两条符号', elements);
  const f1 = found.find(e => e.id === '001');
  const f2 = found.find(e => e.id === '002');
  if ((f1?.text || '').trim() !== SYMBOL_001 || (f2?.text || '').trim() !== SYMBOL_002) {
    fail('读回文本与写入不一致', found);
  }
  pass('读回断言：两条符号文本一致');

  // 5. 收尾：MCP unLock 释放写锁 → 直连删除 + 缺席
  const raw2 = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw2.stateful = 'stateful';
  await raw2.h.login();
  expectKeywords = [];
  const ul = await call('unLock', { objectUrl: PROG_URL, lockHandle: lockMcp });
  await raw2.h.request(PROG_URL, { method: 'DELETE', qs: { lockHandle: '', corrNr: 'S4HK900009' } }).catch(async () => {
    const lh = String((await lock(raw2.h, PROG_URL, 'MODIFY')).LOCK_HANDLE || '');
    if (lh) await raw2.h.request(PROG_URL, { method: 'DELETE', qs: { lockHandle: lh, corrNr: 'S4HK900009' } });
  });
  await raw2.h.logout().catch(() => {});
  await raw.h.logout().catch(() => {});
  const gone = await call('searchObject', { query: PROG, objType: 'PROG', max: 5 });
  if ((gone.results || []).length !== 0) fail('缺席复核失败', gone);
  pass('收尾：靶对象删除 + 缺席复核通过');

  console.log('SMOKE OK: setTextElements 纳入 focused profile 真机可用性验证通过');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
