// AMDP 断点命中真机 smoke（debug.amdp-adt 命中路径：ON_BREAK/step/变量读取）。
// 模式：受控链（MCP）管全部调试操作；触发器走独立 ADTClient（HTTP 会话 B）跑单元测试——
//   会话 B 执行 AMDP 时命中会话 A 注册的调试器（VSP "run the AMDP method from
//   elsewhere" 模式）。若把单元测试也放在会话 A（受控质量链），测试挂起在断点会
//   楔死会话 A 与 await 串行死锁——触发器必须在另一会话。
// 运行：node scripts/amdp-debugger-hit-real-dev-smoke.mjs
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ADTClient } from '../dist/adt/index.js';

// 用法：node scripts/amdp-debugger-hit-real-dev-smoke.mjs [env路径]（缺省 sap-demo.env）
const ENV_PATH = process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
// 红线预检：只允许打 sap-demo 专用 DEV 地址
if (!/^http:\/\//.test(String(envVars.SAP_URL || ''))) { console.error('红线预检失败：SAP_URL 缺失'); process.exit(1); }
console.log('INFO 目标:', envVars.SAP_URL, 'client', envVars.SAP_CLIENT, 'user', envVars.SAP_USER);

const client = new Client({ name: 'amdp-hit-smoke', version: '1.0.0' }, { capabilities: {} });
const injectedEnv = { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'warn' };
if (!envVars.SAP_MCP_CONFIRMATION_MODE) injectedEnv.SAP_MCP_CONFIRMATION_MODE = 'auto'; // 部署级自动确认（仅 DEV）
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')), ...injectedEnv }, stderr: 'pipe' });
function parse(r) {
  const structured = r?.structuredContent;
  if (structured && typeof structured === 'object') return { ...structured, _structured: structured };
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return { ...JSON.parse(t), _structured: structured }; } catch { return { raw: r, _structured: structured }; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 900)}`); process.exit(1); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await client.connect(transport);

// 唯一类名（传输锁残留防御，同主 smoke）
const PREFIX = String(envVars.SAP_MCP_REAL_DEV_VALIDATION_PREFIX || 'Z').trim().toUpperCase();
const CLASS_NAME = `${PREFIX}CL_AMDP_DBG_HS${Date.now().toString(16).slice(-6).toUpperCase()}`;
const TRANSPORT = String(process.env.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT || envVars.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT || '').trim();
const SAP_USER = envVars.SAP_USER;
if (!/^[A-Z0-9]{10}$/.test(TRANSPORT)) { console.error('红线预检失败：env 未配置 SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT'); process.exit(1); }

// 主源码：AMDP 方法 + if_oo_adt_classrun 入口（classrun 触发器的执行体，iv_max=5）
const lowerName = CLASS_NAME.toLowerCase();
const AMDP_SOURCE = [
  `CLASS ${lowerName} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
  '  PUBLIC SECTION.',
  '    INTERFACES if_amdp_marker_hdb.',
  '    INTERFACES if_oo_adt_classrun.',
  '    TYPES: tt_t000 TYPE STANDARD TABLE OF t000 WITH DEFAULT KEY.',
  '    METHODS get_mandts',
  '      IMPORTING VALUE(iv_max) TYPE i',
  '      EXPORTING VALUE(et_data) TYPE tt_t000.',
  'ENDCLASS.',
  `CLASS ${lowerName} IMPLEMENTATION.`,
  '  METHOD get_mandts',
  '    BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT',
  '    OPTIONS READ-ONLY',
  '    USING t000.',
  '    et_data = SELECT TOP :iv_max * FROM t000 ORDER BY mandt;',
  '  ENDMETHOD.',
  '  METHOD if_oo_adt_classrun~main.',
  '    DATA lt_data TYPE tt_t000.',
  '    me->get_mandts( EXPORTING iv_max = 5 IMPORTING et_data = lt_data ).',
  '    out->write( |rows={ lines( lt_data ) }| ).',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');
// 断点行 = et_data = SELECT 行（动态定位，防类定义行数变化）
const BREAKPOINT_LINE = AMDP_SOURCE.split('\n').findIndex(l => l.includes('et_data = SELECT')) + 1;

// 受控链快捷通道
async function applyOp(toolName, args, kindLabel, applyTool = 'applyDebugOperation') {
  const preview = await call(toolName, args);
  if (preview?.status !== 'preview') fail(`${kindLabel || toolName} preview 失败`, preview);
  const idKey = applyTool === 'applyDebugOperation' ? 'debugOperationPlanId'
    : applyTool === 'applyRepositoryObjectCreation' ? 'creationPlanId' : 'cleanupPlanId';
  const planId = preview.plan?.[idKey] || preview[idKey] || preview._structured?.plan?.[idKey];
  if (!planId) fail(`${kindLabel || toolName} 未返回 planId`, preview);
  return call(applyTool, { [idKey]: planId });
}

// 兜底清理：失败路径尽量不留残留
async function bestEffortCleanup() {
  try {
    const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: CLASS_NAME });
    const id = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId;
    if (id) { await call('applyRepositoryObjectCleanup', { cleanupPlanId: id }); console.log('INFO 兜底：类已清理'); }
  } catch { console.log('INFO 兜底清理类失败（需人工复核 ' + CLASS_NAME + '）'); }
}

try {
  // 1. 受控创建 AMDP 类（含 classrun 入口）
  const created = await applyOp('previewRepositoryObjectCreation', {
    objectKind: 'ABAP_CLASS', name: CLASS_NAME,
    description: 'AMDP hit-path smoke (temporary)',
    packageName: 'Z001', transportRequest: TRANSPORT,
    source: AMDP_SOURCE
  }, '创建 AMDP 类', 'applyRepositoryObjectCreation');
  if (created?.status !== 'success') fail('类创建 apply 未成功', created);
  pass(`受控创建 ${CLASS_NAME}（SQLScript 过程 + classrun 入口）`);

  // 2. AMDP_START + SYNC_BREAKPOINTS（会话 A = 写域 stateful 主会话）
  const startOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_START', targetUser: SAP_USER, stopExisting: true } }, 'AMDP_START');
  const mainId = (startOp?.result || startOp?._structured?.result)?.mainId;
  if (!mainId) fail('AMDP_START 未返回 mainId', startOp);
  pass(`AMDP_START（mainId=${mainId.slice(-12)}）`);
  const syncOp = await applyOp('previewDebugOperation', {
    operation: {
      kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: SAP_USER,
      breakpoints: [{ class: CLASS_NAME, line: BREAKPOINT_LINE }], syncMode: 'FULL'
    }
  }, 'AMDP_SYNC_BREAKPOINTS');
  if (!JSON.stringify(syncOp).includes('"synced":1')) fail('断点同步异常', syncOp);
  pass(`SYNC_BREAKPOINTS：${CLASS_NAME}:${BREAKPOINT_LINE}`);

  // 3. 触发器：会话 B 直连 POST classrun（ADT 类运行器，独立会话；将挂起在断点）。
  //    两轮发射：首跑可能执行非 debug 编译的旧过程二进制（不命中），二跑命中。
  const trigger = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN');
  const fireClassrun = (tag) => {
    const p = (async () => {
      try {
        const r = await trigger.h.request(`/sap/bc/adt/oo/classrun/${lowerName}`, { method: 'POST' });
        return { tag, ok: true, body: String(r.body ?? '').slice(0, 200) };
      } catch (e) {
        return { tag, ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    })();
    console.log(`INFO 会话 B classrun #${tag} 已发射`);
    return p;
  };
  const outcomes = [];
  let unit1 = fireClassrun(1);
  await sleep(8000); // 类加载 + 过程生成时间

  // 4. await 多轮重试：空队列 poll 被客户端放弃后服务端楔 1-2 分钟，楔解后再 poll；
  //    事件在无 poller 时也排队（SYNC/TOGGLE 先例已证），命中事件同理——轮询终能捞到。
  let awaitBody = null;
  for (let round = 1; round <= 5 && !awaitBody?.stopped; round++) {
    const awaitOp = await applyOp('previewDebugOperation',
      { operation: { kind: 'AMDP_AWAIT_STOP', targetUser: SAP_USER, maxEvents: 12 } }, `AMDP_AWAIT_STOP #${round}`);
    awaitBody = awaitOp?.result || awaitOp?._structured?.result;
    if (awaitBody?.stopped) break;
    console.log(`INFO await #${round} 未命中：events=${JSON.stringify(awaitBody?.events?.map(e => e.kind))} verdict=${JSON.stringify(awaitBody?.breakpointVerdict)}`);
    // 二跑发射：首轮 classrun 若未命中会快速完成（旧二进制无调试信息）；二跑命中已带调试信息的过程
    if (round === 1) {
      outcomes.push(await Promise.race([unit1, sleep(30000).then(() => ({ tag: 1, ok: false, error: '30s 未返回（可能挂起在断点）' }))]));
      console.log('INFO 会话 B classrun #1 结局:', JSON.stringify(outcomes[0]).slice(0, 200));
      unit1 = fireClassrun(2);
    }
    // 服务端空 poll 的 wait 超时可达数分钟；间隔必须盖过它，否则新 poll 只在会话队列里干等
    await sleep(180_000);
  }
  if (!awaitBody?.stopped) {
    outcomes.push(await Promise.race([unit1, sleep(30000).then(() => ({ tag: 2, ok: false, error: '30s 未返回' }))]));
    fail('未命中：多轮 await 均未拿到 ON_BREAK', { outcomes, lastNote: awaitBody?.note, lastEvents: awaitBody?.events });
  }
  pass(`命中！位置 = ${awaitBody.stop?.procedure || '?'} 行 ${awaitBody.stop?.line}（debuggeeId 尾 ${String(awaitBody.stop?.debuggeeId || '').slice(-10)}）`);
  console.log('INFO stop 事件自带变量数 =', (awaitBody.variables || []).length, '| 调用栈帧数 =', (awaitBody.callStack || []).length,
    '| debugCompiled =', JSON.stringify((awaitBody.callStack || [])[0]?.debugCompiled));
  if (!awaitBody.stop?.debuggeeId) fail('ON_BREAK 缺 debuggeeId');
  const firstLine = awaitBody.stop.line;
  if (firstLine !== BREAKPOINT_LINE) console.log(`INFO 命中行 ${firstLine} ≠ 设断行 ${BREAKPOINT_LINE}（SAP 定位到可调试语句，如实记录）`);

  // 5. 变量读取：入参 IV_MAX 应为 5（classrun main 传入）
  const readOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_READ_VARIABLE', targetUser: SAP_USER, variableName: 'IV_MAX' } }, 'AMDP_READ_VARIABLE');
  const readBody = readOp?.result || readOp?._structured?.result;
  const ivMax = (readBody?.scalars || []).find(s => s.name === 'IV_MAX');
  if (!ivMax) fail('变量读取未返回 IV_MAX', readBody);
  pass(`变量读取：IV_MAX = ${JSON.stringify(ivMax.value)}（type=${ivMax.type}，期望 "5"）`);
  if (String(ivMax.value).trim() !== '5') console.log('INFO IV_MAX 值与预期不符（如实记录）');

  // 6. step over：前进到下一条 SQLScript 语句
  const stepOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_STEP', targetUser: SAP_USER, stepType: 'over', maxEvents: 6 } }, 'AMDP_STEP');
  const stepBody = stepOp?.result || stepOp?._structured?.result;
  if (!stepBody?.stopped) fail('step 后未再次停止', stepBody);
  pass(`step over：新位置 = 行 ${stepBody.stop?.line}（原行 ${firstLine}）`);

  // 7. continue 放行 → 会话 B classrun 应完成；随后 terminate 收尾
  const contOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_STEP', targetUser: SAP_USER, stepType: 'continue', maxEvents: 12 } }, 'AMDP_STEP continue');
  const contBody = contOp?.result || contOp?._structured?.result;
  console.log('INFO continue 后 stopped =', contBody?.stopped, '（过程跑完则 false）');
  pass('continue 放行');
  const lastRun = await Promise.race([unit1, sleep(60000).then(() => ({ tag: '?', ok: false, error: 'classrun 未在 60s 内返回' }))]);
  outcomes.push(lastRun);
  console.log('INFO 会话 B classrun 结局汇总:', JSON.stringify(outcomes.map(o => ({ tag: o.tag, ok: o.ok, body: o.body, error: o.error }))).slice(0, 500));
  pass('触发器回收');

  const stopOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_TERMINATE', targetUser: SAP_USER } }, 'AMDP_TERMINATE');
  if (!JSON.stringify(stopOp).includes('"terminated":true')) {
    console.log('INFO terminate 楔住，等待 150s 自解楔后重试…');
    await sleep(150_000);
    const retry = await applyOp('previewDebugOperation',
      { operation: { kind: 'AMDP_TERMINATE', targetUser: SAP_USER } }, 'AMDP_TERMINATE 重试');
    if (!JSON.stringify(retry).includes('"terminated":true')) fail('terminate 重试仍失败', retry);
  }
  pass('AMDP_TERMINATE：会话结束');
} catch (error) {
  console.log('FAIL 链路异常：', String(error?.message || error).slice(0, 300));
  await bestEffortCleanup();
  process.exit(1);
}

// 8. 受控清理 + 缺席复核
try {
  const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: CLASS_NAME });
  const id = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId;
  if (!id) fail('清理 preview 失败', cp);
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: id });
  pass(`受控清理 + 缺席：${CLASS_NAME} 已删除`);
} catch (error) {
  console.log('FAIL 清理链异常：', String(error?.message || error).slice(0, 300));
  await bestEffortCleanup();
  process.exit(1);
}

console.log(`\nSMOKE OK：AMDP 命中路径真机全链通过（create→testinclude→start→sync→hit ON_BREAK→read var→step→continue→terminate→cleanup）`);
process.exit(0);
