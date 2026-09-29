// getWhereUsedConfig 真机 smoke（sap-demo）：
// 决定性正例 = 直连 ADT 全链自造数据：创建自有验证程序（引用 TVARVC + 标记
// 变量）→ 激活（WBCROSSGT/CROSS 生成真实行）→ MCP 组合链读到候选且 grep 确认
// → 直连删除 + 缺席。写操作均为授权范围（自建 Z* 验证对象的创建/激活/删除），
// 前后只读复查，串行执行。
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

const PROG = `ZWUXREF${String(Date.now()).slice(-4)}`;
const VARIABLE = 'ZV_XREF_SMOKE';
const PROG_URL = `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`;
const SOURCE = [
  `REPORT ${PROG.toLowerCase()}.`,
  '" where-used-config smoke: reference the TVARVC table and the marker variable',
  'DATA lv_value TYPE tvarvc-low.',
  "SELECT SINGLE low FROM tvarvc INTO lv_value WHERE name = 'ZV_XREF_SMOKE' AND type = 'P'.",
  'IF sy-subrc = 0.',
  '  WRITE / lv_value.',
  'ENDIF.',
  ''
].join('\n');

const client = new Client({ name: 'wuconfig-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 600)}`); process.exit(1); }

async function main() {
  await client.connect(transport);

  // 0. catalog
  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'getWhereUsedConfig')) fail('getWhereUsedConfig 不在 catalog');
  pass('getWhereUsedConfig 在 focused catalog');

  // 1. 直连 ADT：创建 → 写源码 → 激活（自造有 TVARVC 引用的真实数据）
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  await createObject(raw.h, {
    objtype: 'PROG/P', name: PROG, parentName: 'Z001',
    description: 'where-used-config smoke target', transport: 'S4HK900009',
    contentType: 'application/*'
  });
  const rawS = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  rawS.stateful = 'stateful';
  await rawS.h.login();
  const lockHandle = String((await lock(rawS.h, PROG_URL, 'MODIFY')).LOCK_HANDLE || '');
  if (!lockHandle) fail('直连加锁失败');
  await setObjectSource(rawS.h, `${PROG_URL}/source/main`, SOURCE, lockHandle, 'S4HK900009');
  await unLock(rawS.h, PROG_URL, lockHandle);
  const activation = await activateObject(rawS.h, PROG, PROG_URL);
  const actOk = activation?.success !== false;
  if (!actOk) fail('直连激活失败', activation);
  await raw.h.logout().catch(() => {});
  await rawS.h.logout().catch(() => {});
  pass(`直连自造数据完成：${PROG}（创建+源码+激活，登记 S4HK900009）`);

  // 2. MCP 组合链决定性验证：readers 含本对象且 confirmed=true
  const post = await call('getWhereUsedConfig', { variable: VARIABLE, maxGrep: 10 });
  const postV = post?.result?.result || post?.result || post;
  const reader = (postV.readers || []).find(r => r.objectName === PROG);
  if (!reader) fail('组合链未读到刚激活的 TVARVC 引用对象', postV.readers);
  if (reader.confirmed !== true) fail('源码 grep 未确认标记变量', { reader, unsearched: postV.unsearched });
  console.log(`INFO readers=${postV.readers.length} confirmed=${postV.readers.filter(r => r.confirmed).length}`
    + ` grepped=${postV.greppedCount} unsearched=${postV.unsearched.length}`);
  pass(`决定性正例：${PROG} 触 TVARVC 且源码确认 confirmed=true`);

  // 3. 收尾：直连删除 + 缺席
  const raw2 = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw2.stateful = 'stateful';
  await raw2.h.login();
  const lock2 = String((await lock(raw2.h, PROG_URL, 'MODIFY')).LOCK_HANDLE || '');
  if (!lock2) fail('收尾加锁失败');
  await raw2.h.request(`${PROG_URL}`, { method: 'DELETE', qs: { lockHandle: lock2, corrNr: 'S4HK900009' } });
  await unLock(raw2.h, PROG_URL, lock2);
  await raw2.h.logout().catch(() => {});
  const gone = await call('searchObject', { query: PROG, objType: 'PROG', max: 5 });
  if ((gone.results || []).length !== 0) fail('缺席复核失败', gone);
  pass(`收尾：靶对象直连删除 + 缺席复核通过`);

  console.log('SMOKE OK: getWhereUsedConfig 组合链在真实 DEV 端到端验证通过（含直连自造数据）');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
