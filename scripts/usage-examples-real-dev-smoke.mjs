// getUsageExamples 真机 smoke（sap-demo）：
// 决定性正例 = 直连 ADT 写链自造数据：创建自有验证类 ZWUEXA####（方法内引用
// 另一个自有类 ZCL_MCP_SM21_ADT_HTTP——真机有真实交叉行）→ 激活 → MCP 组合链
// 候选含本对象、片段命中 METHOD_CALL → 收尾直连删除 + 缺席。只读 MCP 面 +
// 授权范围内的自建对象写链，前后只读复查，串行。
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
Object.assign(env, { SAP_MCP_ENV_FILE: ENV_PATH, SAP_MCP_LOG_LEVEL: 'warn' });

const TARGET = 'ZCL_MCP_SM21_ADT_HTTP'; // 真机已存在的自有类（有真实交叉行）
const CALLER = `ZWUEXA${String(Date.now()).slice(-4)}`;
const CALLER_URL = `/sap/bc/adt/oo/classes/${CALLER.toLowerCase()}`;
const SOURCE = [
  `CLASS ${CALLER.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
  '  PUBLIC SECTION.',
  '    INTERFACES if_oo_adt_classrun.',
  'ENDCLASS.',
  `CLASS ${CALLER.toLowerCase()} IMPLEMENTATION.`,
  '  METHOD if_oo_adt_classrun~main.',
  `    DATA lo_sm21 TYPE REF TO ${TARGET.toLowerCase()}.`,
  '    CREATE OBJECT lo_sm21.',
  '  ENDMETHOD.',
  'ENDCLASS.',
  ''
].join('\n');

const client = new Client({ name: 'uexa-smoke', version: '1.0.0' }, { capabilities: {} });
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
  if (!tools.tools.some(t => t.name === 'getUsageExamples')) fail('getUsageExamples 不在 catalog');
  pass('getUsageExamples 在 focused catalog');

  // 1. 直连 ADT：创建 caller 类（引用 TARGET）→ 写源码 → 激活
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  await createObject(raw.h, {
    objtype: 'CLAS/OC', name: CALLER, parentName: 'Z001',
    description: 'usage-examples smoke caller', transport: 'S4HK900009',
    contentType: 'application/*'
  });
  raw.stateful = 'stateful';
  await raw.h.login();
  const lockHandle = String((await lock(raw.h, CALLER_URL, 'MODIFY')).LOCK_HANDLE || '');
  if (!lockHandle) fail('直连加锁失败');
  await setObjectSource(raw.h, `${CALLER_URL}/source/main`, SOURCE, lockHandle, 'S4HK900009');
  await unLock(raw.h, CALLER_URL, lockHandle);
  const activation = await activateObject(raw.h, CALLER, CALLER_URL);
  if (activation?.success === false) fail('直连激活失败', activation);
  await raw.h.logout().catch(() => {});
  // WBCROSSGT/CROSS 行在激活时生成，但跨会话可见性与索引落库可能有秒级延迟——
  // 稳妥等待后再进入组合链（历史取证：行即时生成但跨会话立即可见性未证）
  await new Promise(r => setTimeout(r, 5000));
  pass(`直连自造数据完成：${CALLER}（创建+源码+激活，引用 ${TARGET}）`);

  // 2. MCP 组合链决定性验证：候选含本对象、片段命中 METHOD_CALL/CLASS_REFERENCE
  const post = await call('getUsageExamples', {
    objectType: 'CLAS', objectName: TARGET, maxExamples: 20
  });
  const postV = post?.result?.result || post?.result || post;
  const myExamples = (postV.examples || []).filter(e => e.callerObjectName === CALLER);
  console.log(`INFO totalCallers=${postV.totalCallers} examples=${(postV.examples || []).length}`
    + ` 本对象示例=${myExamples.length} unsearched=${postV.unsearched.length}`);
  if (myExamples.length === 0) {
    console.error(`取证保留：${CALLER} 未删除（直查 WBCROSSGT INCLUDE LIKE '${CALLER}%'）`);
    fail('组合链未给出刚激活 caller 的示例', postV.examples);
  }
  if (!myExamples.some(e => ['METHOD_CALL', 'CLASS_REFERENCE'].includes(e.matchType))) {
    fail('示例未命中结构形态', myExamples);
  }
  pass(`决定性正例：${CALLER} 的 ${myExamples.length} 条示例（${myExamples[0].matchType}，置信 ${myExamples[0].confidence}）`);

  // 3. 收尾：直连删除 + 缺席
  const raw2 = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw2.stateful = 'stateful';
  await raw2.h.login();
  const lock2 = String((await lock(raw2.h, CALLER_URL, 'MODIFY')).LOCK_HANDLE || '');
  if (!lock2) fail('收尾加锁失败');
  await raw2.h.request(CALLER_URL, { method: 'DELETE', qs: { lockHandle: lock2, corrNr: 'S4HK900009' } });
  await unLock(raw2.h, CALLER_URL, lock2);
  await raw2.h.logout().catch(() => {});
  const gone = await call('searchObject', { query: CALLER, objType: 'CLAS', max: 5 });
  if ((gone.results || []).length !== 0) fail('缺席复核失败', gone);
  pass('收尾：靶对象直连删除 + 缺席复核通过');

  console.log('SMOKE OK: getUsageExamples 组合链在真实 DEV 端到端验证通过（含直连自造数据）');
  await client.close();
}

main().catch(e => { console.error('SMOKE FAILED:', e?.message?.slice(0, 300)); process.exit(1); });
