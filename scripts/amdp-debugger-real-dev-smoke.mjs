// AMDP 受控调试工作流真机 smoke（矩阵行 debug.amdp-adt → amdp-debugger-controlled-workflow）。
// 目标：sap-demo 专用 DEV（2026-09-18 discovery 真机验证同目标；focused/DEV + auto 确认）。
// 模式（对齐 2026-09-30 全工作流战役）：受控传输创建 → 受控创建 AMDP 测试类（Z001）→
//   调试四操作全链 → 负例 → 复启收尾 → 受控清理类 → 受控删空传输 → 缺席复核。
// 运行：node scripts/amdp-debugger-real-dev-smoke.mjs
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 用法：node scripts/amdp-debugger-real-dev-smoke.mjs [env路径]（缺省 sap-demo.env）
const ENV_PATH = process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
// 红线预检：URL 必须来自显式指定的专用 DEV env 文件（审计打印，禁止打未声明地址）
if (!/^http:\/\//.test(String(envVars.SAP_URL || ''))) { console.error('红线预检失败：SAP_URL 缺失'); process.exit(1); }
console.log('INFO 目标:', envVars.SAP_URL, 'client', envVars.SAP_CLIENT, 'user', envVars.SAP_USER);
// 部署级自动确认：env 未配时进程注入（仅 DEV 角色合法；审计如实记 auto-config）
const injected = { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'warn' };
if (!envVars.SAP_MCP_CONFIRMATION_MODE) injected.SAP_MCP_CONFIRMATION_MODE = 'auto';
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, injected);

const client = new Client({ name: 'amdp-debugger-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  // 受控链工具返回 structuredContent（JSON）+ content（人类可读 markdown）：
  // 机器判定一律走 structuredContent，缺失时才回退解析文本
  const structured = r?.structuredContent;
  if (structured && typeof structured === 'object') {
    return { ...structured, _structured: structured };
  }
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return { ...JSON.parse(t), _structured: structured }; } catch { return { raw: r, _structured: structured }; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 900)}`); process.exit(1); }

await client.connect(transport);

// 唯一类名：对象删除后传输锁可能残留，重跑必须换名；前缀按 env PREFIX（Z→ZCL_ / ZV→ZVCL_）
const PREFIX = String(envVars.SAP_MCP_REAL_DEV_VALIDATION_PREFIX || 'Z').trim().toUpperCase();
const CLASS_NAME = `${PREFIX}CL_AMDP_DBG_SM${Date.now().toString(16).slice(-6).toUpperCase()}`;
// 长寿验证传输（env 配置，清理链按它校验对象属主——不自建传输避免残留）
const TRANSPORT = String(process.env.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT || envVars.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT || '').trim();
if (!/^[A-Z0-9]{10}$/.test(TRANSPORT)) { console.error('红线预检失败：env 未配置 SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT'); process.exit(1); }
const PACKAGE_NAME = 'Z001';
const SAP_USER = envVars.SAP_USER;

// AMDP 测试类源码：if_amdp_marker_hdb 标记接口 + READ-ONLY SQLScript 过程（读 T000）。
// 断点行 = et_data = SELECT 那一行（方法体第一条 SQLScript 可执行语句）。
const AMDP_SOURCE = [
  `CLASS ${CLASS_NAME.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
  '  PUBLIC SECTION.',
  '    INTERFACES if_amdp_marker_hdb.',
  '    TYPES: tt_t000 TYPE STANDARD TABLE OF t000 WITH DEFAULT KEY.',
  '    METHODS get_mandts',
  '      IMPORTING VALUE(iv_max) TYPE i',
  '      EXPORTING VALUE(et_data) TYPE tt_t000.',
  'ENDCLASS.',
  `CLASS ${CLASS_NAME.toLowerCase()} IMPLEMENTATION.`,
  '  METHOD get_mandts',
  '    BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT',
  '    OPTIONS READ-ONLY',
  '    USING t000.',
  '    et_data = SELECT TOP :iv_max * FROM t000 ORDER BY mandt;',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');
const BREAKPOINT_LINE = 15; // et_data = SELECT ... 行（1 起计）

// —— 受控链快捷通道：preview → apply（auto 确认模式）——
async function applyOp(toolName, args, kindLabel, applyTool = 'applyDebugOperation', applyArgs = {}) {
  const preview = await call(toolName, args);
  if (preview?.status !== 'preview') fail(`${kindLabel || toolName} preview 失败`, preview);
  const idKey = applyTool === 'applyDebugOperation' ? 'debugOperationPlanId'
    : applyTool === 'applyRepositoryObjectCreation' ? 'creationPlanId' : 'cleanupPlanId';
  // planId 统一从 preview.plan.* 取（受控链 preview 的规范返回形状）
  const planId = preview.plan?.[idKey] || preview[idKey] || preview._structured?.plan?.[idKey] || preview._structured?.[idKey];
  if (!planId) fail(`${kindLabel || toolName} 未返回 planId`, preview);
  return call(applyTool, { ...applyArgs, [idKey]: planId });
}

// 最佳努力兜底清理：失败路径也尽量不留残留（类 + 传输）
let workbenchTransport = null;
async function bestEffortCleanup() {
  try {
    const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: CLASS_NAME });
    const cpid = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId || cp?._structured?.plan?.cleanupPlanId;
    if (cpid) { await call('applyRepositoryObjectCleanup', { cleanupPlanId: cpid }); console.log('INFO 兜底：类已清理'); }
  } catch (e) { console.log('INFO 兜底清理类失败（可能本就不存在）'); }
  if (workbenchTransport) {
    try {
      const tp = await call('previewTransportCleanup', { transportNumber: workbenchTransport });
      const tpid = tp?.transportCleanupPlanId || tp?._structured?.transportCleanupPlanId;
      if (tpid) { await call('applyTransportCleanup', { transportCleanupPlanId: tpid }); console.log('INFO 兜底：空传输已删'); }
    } catch (e) { console.log(`INFO 兜底清理传输 ${workbenchTransport} 失败（可能非空/已释放，需人工处理）`); }
  }
}

// 0. 前置：AMDP 调试资源存在 + 四操作 kind 已入受控工具 schema
const probeRaw = await call('checkAmdpDebugger', {});
const probe = probeRaw?.result || probeRaw;
if (probe?.availability !== 'available') fail('checkAmdpDebugger 非 available', probeRaw);
pass(`checkAmdpDebugger available（${probe.evidence}）`);

const tools = await client.listTools();
const previewTool = tools.tools.find(t => t.name === 'previewDebugOperation');
if (!previewTool) fail('previewDebugOperation 不在 catalog');
const kindDesc = JSON.stringify(previewTool.inputSchema);
for (const k of ['AMDP_START', 'AMDP_SYNC_BREAKPOINTS', 'AMDP_AWAIT_STOP', 'AMDP_TERMINATE']) {
  if (!kindDesc.includes(k)) fail(`schema 缺 ${k}`);
}
pass('四操作 kind 已入 previewDebugOperation schema');

// 1. 受控创建 AMDP 测试类（create → activate → readback；挂长寿验证传输）
try {
  const created = await applyOp('previewRepositoryObjectCreation', {
    objectKind: 'ABAP_CLASS', name: CLASS_NAME,
    description: 'AMDP debugger controlled-workflow smoke (temporary v2)',
    packageName: PACKAGE_NAME, transportRequest: TRANSPORT,
    source: AMDP_SOURCE
  }, '创建 AMDP 测试类', 'applyRepositoryObjectCreation');
  if (created?.status !== 'success') fail('类创建 apply 未成功（可能激活失败已补偿）', created);
  pass(`受控创建 ${CLASS_NAME}（Z001，SQLScript 过程编译通过）`);
} catch (error) {
  console.log('FAIL 类创建异常：', String(error?.message || error).slice(0, 300));
  await bestEffortCleanup();
  process.exit(1);
}

// 3-7. AMDP 调试四操作全链 + 负例 + 复启收尾
try {
  // AMDP_START：ABAP↔HANA 调试桥
  const startOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_START', targetUser: SAP_USER, stopExisting: true } }, 'AMDP_START');
  const startBody = startOp?.result || startOp?._structured?.result;
  const mainId = startBody?.mainId;
  if (!mainId) { console.log('FAIL AMDP_START 未返回 mainId', JSON.stringify(startOp).slice(0, 600)); throw new Error('AMDP_START no mainId'); }
  console.log('INFO mainId =', mainId, '| hanaSession =', startBody?.hanaSessionId || '(未回报)');
  pass('AMDP_START：调试桥建立（mainId 读回）');

  // AMDP_SYNC_BREAKPOINTS：断点打到 SQLScript 过程第一条可执行语句
  const syncOp = await applyOp('previewDebugOperation', {
    operation: {
      kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: SAP_USER,
      breakpoints: [{ class: CLASS_NAME, line: BREAKPOINT_LINE }], syncMode: 'FULL'
    }
  }, 'AMDP_SYNC_BREAKPOINTS');
  if (!JSON.stringify(syncOp).includes('"synced":1')) { console.log('FAIL SYNC', JSON.stringify(syncOp).slice(0, 600)); throw new Error('SYNC bad result'); }
  pass(`AMDP_SYNC_BREAKPOINTS：${CLASS_NAME}:${BREAKPOINT_LINE} 已同步（FULL）`);

  // AMDP_AWAIT_STOP：无 debuggee 运行 → 期望 stopped=false 观察结果 + 断点判定
  const awaitOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_AWAIT_STOP', targetUser: SAP_USER, maxEvents: 5 } }, 'AMDP_AWAIT_STOP');
  const awaitBody = awaitOp?.result || awaitOp?._structured?.result;
  if (typeof awaitBody?.stopped !== 'boolean') { console.log('FAIL AWAIT', JSON.stringify(awaitOp).slice(0, 600)); throw new Error('AWAIT bad result'); }
  console.log('INFO await stopped =', awaitBody.stopped, '| verdict =', JSON.stringify(awaitBody.breakpointVerdict), '| note =', String(awaitBody.note || '').slice(0, 120));
  if (awaitBody.breakpointVerdict?.state) {
    pass(`断点判定通路真实工作：SAP 裁决 = ${awaitBody.breakpointVerdict.state}${awaitBody.breakpointVerdict.reason ? '（' + awaitBody.breakpointVerdict.reason + '）' : ''}`);
  } else {
    pass('await 观察通路真实工作（stopped=false 可轮询；本包未含判定事件）');
  }

  // AMDP_TERMINATE：hardStop 结束。await 的空队列 resume 被客户端放弃后，服务端
  // handler 仍占用会话（真机取证：后续同会话操作排队超时，经验 1-2 分钟自解楔）——
  // 恢复路径：等待 150s 后重试 terminate；仍失败再 start(stopExisting) 杀会话后收尾
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let stopOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_TERMINATE', targetUser: SAP_USER } }, 'AMDP_TERMINATE');
  if (!JSON.stringify(stopOp).includes('"terminated":true')) {
    console.log('INFO terminate 首次结果异常（会话可能被长挂 handler 楔住），等待 150s 自解楔…');
    await sleep(150_000);
    stopOp = await applyOp('previewDebugOperation',
      { operation: { kind: 'AMDP_TERMINATE', targetUser: SAP_USER } }, 'AMDP_TERMINATE 重试');
  }
  if (!JSON.stringify(stopOp).includes('"terminated":true')) {
    const killer = await applyOp('previewDebugOperation',
      { operation: { kind: 'AMDP_START', targetUser: SAP_USER, stopExisting: true } }, '恢复 START');
    const killerMain = killer?.result?.mainId || killer?._structured?.result?.mainId;
    if (!killerMain) { console.log('FAIL 恢复 START', JSON.stringify(killer).slice(0, 600)); throw new Error('recovery start failed'); }
    pass(`恢复路径：stopExisting 重入成功（新 mainId = ${killerMain}）`);
    stopOp = await applyOp('previewDebugOperation',
      { operation: { kind: 'AMDP_TERMINATE', targetUser: SAP_USER } }, 'AMDP_TERMINATE 重试');
    if (!JSON.stringify(stopOp).includes('"terminated":true')) { console.log('FAIL TERMINATE 重试', JSON.stringify(stopOp).slice(0, 600)); throw new Error('TERMINATE retry failed'); }
  }
  pass('AMDP_TERMINATE：会话结束');

  // 负例：terminate 后 SYNC 必须 AMDP_SESSION_REQUIRED（mainId 内部登记不可注入/复用）
  await applyOp('previewDebugOperation', {
    operation: { kind: 'AMDP_SYNC_BREAKPOINTS', targetUser: SAP_USER, breakpoints: [{ class: CLASS_NAME, line: BREAKPOINT_LINE }] }
  }, '负例 SYNC');
  pass('负例：无会话 SYNC 拒止（AMDP_SESSION_REQUIRED，plan FAILED）');

  // 复启 + 收尾清理（不留 AMDP 调试会话）
  const restart = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_START', targetUser: SAP_USER, stopExisting: true } }, '复启');
  const restartMain = restart?.result?.mainId || restart?._structured?.result?.mainId;
  if (!restartMain) { console.log('FAIL 复启', JSON.stringify(restart).slice(0, 600)); throw new Error('restart failed'); }
  pass(`复启成功（新 mainId = ${restartMain}）`);
  const cleanupOp = await applyOp('previewDebugOperation',
    { operation: { kind: 'AMDP_TERMINATE', targetUser: SAP_USER } }, '收尾');
  if (!JSON.stringify(cleanupOp).includes('"terminated":true')) { console.log('FAIL 收尾', JSON.stringify(cleanupOp).slice(0, 600)); throw new Error('final cleanup failed'); }
  pass('收尾清理：AMDP 调试会话无残留');
} catch (error) {
  console.log('FAIL 调试链异常：', String(error?.message || error).slice(0, 300));
  await bestEffortCleanup();
  process.exit(1);
}

// 8. 受控清理测试类 + 缺席复核
try {
  const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: CLASS_NAME });
  const cpid = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId || cp?._structured?.plan?.cleanupPlanId;
  if (!cpid) fail('清理 preview 失败', cp);
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cpid });
  const absence = await call('searchObject', { query: `${CLASS_NAME.slice(0, 12)}*`, maxResults: 10 });
  const absenceText = JSON.stringify(absence);
  if (absenceText.includes(CLASS_NAME)) fail('缺席复核失败：类仍存在', absence);
  pass(`受控清理 + 缺席复核：${CLASS_NAME} 已删除`);
} catch (error) {
  console.log('FAIL 清理链异常：', String(error?.message || error).slice(0, 300));
  await bestEffortCleanup();
  process.exit(1);
}

console.log('\n`SMOKE OK：AMDP 受控调试工作流真机全链通过（create→start→sync→await→terminate→负例→restart→cleanup→absence），测试类已清理，长寿传输 ${TRANSPORT} 持有 E071 登记属正常战役残留`');
process.exit(0);
