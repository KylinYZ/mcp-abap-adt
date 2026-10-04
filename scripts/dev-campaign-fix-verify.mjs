// 修复复验：F1-F6 真机 + F7 文本池原始 body 取证
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ADTClient } from '../dist/adt/index.js';

const ENV_PATH = process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'error', SAP_MCP_CONFIRMATION_MODE: 'auto', SAP_MCP_REAL_DEV_VALIDATION: 'false', SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT: 'S4DK900109', RFC_SYSNR: '00' });
const client = new Client({ name: 'dev-verify', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' }));
function parse(r) { const s = r?.structuredContent; if (s && typeof s === 'object') return s; const t = (r.content || []).filter(i => i.type === 'text').map(i => i.text).join(''); try { return JSON.parse(t); } catch { return r; } }
async function call(name, args) { return parse(await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 180000 })); }
const results = [];
const record = (n, s, d) => { results.push({ n, s, d: String(d).slice(0, 220) }); console.log(`${s.startsWith('PASS') ? '✓' : s === 'NA' ? '○' : '✗'} ${n} [${s}] ${String(d).slice(0, 110)}`); };

// F1: classIncludes 对 Z 类
try {
  const r = await call('classIncludes', { clas: 'ZVCL_DEV_SWEEP_T1' });
  record('F1 classIncludes(Z类)', r?.status === 'success' ? 'PASS' : 'FAIL', JSON.stringify(r?.result || r).slice(0, 130));
} catch (e) { record('F1 classIncludes(Z类)', 'FAIL', String(e.message).slice(0, 130)); }

// F2: unitTestEvaluation 对无测试类（应空数组+note）
try {
  const r = await call('unitTestEvaluation', { clas: 'ZVCL_DEV_SWEEP_T1' });
  const s = JSON.stringify(r);
  record('F2 unitTestEvaluation(无测试)', /No unit tests found/.test(s) ? 'PASS' : 'FAIL', s.slice(0, 130));
} catch (e) { record('F2 unitTestEvaluation(无测试)', 'FAIL', String(e.message).slice(0, 130)); }

// F3: getObjectSource 正确参数
try {
  const r = await call('getObjectSource', { objectSourceUrl: '/sap/bc/adt/oo/classes/zvcl_dev_sweep_t1/source/main' });
  record('F3 getObjectSource(正确形态)', r?.status === 'success' ? 'PASS' : 'FAIL', JSON.stringify(r).slice(0, 120));
} catch (e) { record('F3 getObjectSource(正确形态)', 'FAIL', String(e.message).slice(0, 130)); }
// F3b: ValidateObjectUrl 防御（缺 URL → 可读错误）
try {
  const r = await call('getObjectSource', {});
  const s = JSON.stringify(r);
  record('F3b getObjectSource(缺URL)', /required/i.test(s) ? 'PASS' : 'FAIL', s.slice(0, 130));
} catch (e) { record('F3b getObjectSource(缺URL)', /required/i.test(String(e.message)) ? 'PASS' : 'FAIL', String(e.message).slice(0, 130)); }

// F4: listJobs 无参数（空回退）
try {
  const r = await call('listJobs', { limit: 5 });
  record('F4 listJobs(空回退)', r?.status === 'success' ? 'PASS' : 'FAIL', JSON.stringify(r?.result || r).slice(0, 130));
} catch (e) { record('F4 listJobs(空回退)', 'FAIL', String(e.message).slice(0, 130)); }

// F5: previewDdicPropertyChange 对不存在对象（应 OBJECT_NOT_FOUND 可读错误）
try {
  const r = await call('previewDdicPropertyChange', { operation: { kind: 'SET_DATA_ELEMENT_PROPERTIES', objectName: 'ZV_DEV_WS_NOTEXIST', transportRequest: 'S4DK900109', properties: { fieldLabels: { shortFieldLabel: 'x', mediumFieldLabel: 'y', longFieldLabel: 'z', headingFieldLabel: 'w' } } } });
  const s = JSON.stringify(r);
  record('F5 DDIC(不存在对象)', /OBJECT_NOT_FOUND|does not exist/i.test(s) ? 'PASS' : 'FAIL', s.slice(0, 150));
} catch (e) { record('F5 DDIC(不存在对象)', /OBJECT_NOT_FOUND|does not exist/i.test(String(e.message)) ? 'PASS' : 'FAIL', String(e.message).slice(0, 150)); }

// F6: applyDescriptionChange（建临时类→改描述→观察 UNKNOWN 消息是否带原始错误类别）
try {
  const stamp = Date.now().toString(16).slice(-6).toUpperCase();
  const CLS = `ZVCL_DEV_WS_F6${stamp}`;
  const p = await call('previewRepositoryObjectCreation', { objectKind: 'ABAP_CLASS', name: CLS, description: 'f6 probe', packageName: 'Z001', transportRequest: 'S4DK900109', source: `CLASS ${CLS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS ${CLS.toLowerCase()} IMPLEMENTATION.\nENDCLASS.` });
  const pb = p?.result ?? p;
  if (pb?.status === 'preview') {
    await call('applyRepositoryObjectCreation', { creationPlanId: pb.plan.creationPlanId });
    const dp = await call('previewDescriptionChange', { objectType: 'CLAS', name: CLS, description: `f6 desc ${stamp}`, transportRequest: 'S4DK900109' });
    const dpb = dp?.result ?? dp;
    if (dpb?.status === 'preview') {
      const da = await call('applyDescriptionChange', { descriptionPlanId: dpb.plan.descriptionPlanId });
      const s = JSON.stringify(da ?? {});
      record('F6 描述链(诊断信息)', da?.status === 'success' ? 'PASS(直接成功)' : /unknown \((timeout|remote request timeout|unexpected failure)/i.test(s) ? 'PASS(诊断透传)' : 'FAIL', s.slice(0, 260));
      const st = await call('objectStructure', { objectUrl: `/sap/bc/adt/oo/classes/${CLS.toLowerCase()}` });
      console.log('INFO 描述读回:', JSON.stringify(st?.metaData?.description ?? st?.metaData ?? '(无)').slice(0, 140));
    } else record('F6 描述链(诊断信息)', 'FAIL', 'preview: ' + JSON.stringify(dp?.error || dp).slice(0, 120));
    const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: CLS });
    const cid = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId;
    if (cid) await call('applyRepositoryObjectCleanup', { cleanupPlanId: cid });
  } else record('F6 描述链(诊断信息)', 'FAIL', '创建失败');
} catch (e) { record('F6 描述链(诊断信息)', 'FAIL', String(e.message).slice(0, 150)); }

// F7: 文本池 symbols 原始 body 取证
try {
  const stamp = Date.now().toString(16).slice(-6).toUpperCase();
  const PROG = `ZV_DEV_WS_F7${stamp}`;
  const p = await call('previewRepositoryObjectCreation', { objectKind: 'PROGRAM', name: PROG, description: 'f7 probe', packageName: 'Z001', transportRequest: 'S4DK900109', source: `REPORT ${PROG.toLowerCase()}.\nWRITE: / |f7|.` });
  const pb = p?.result ?? p;
  if (pb?.status === 'preview') {
    await call('applyRepositoryObjectCreation', { creationPlanId: pb.plan.creationPlanId });
    const tw = await call('previewTextPoolChange', { program: PROG, category: 'symbols', elements: [{ id: '001', text: 'probe text one' }], transport: 'S4DK900109' });
    const twb = tw?.result ?? tw;
    if (twb?.status === 'preview') await call('applyTextPoolChange', { textPoolPlanId: twb.plan.textPoolPlanId });
    const direct = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN');
    const raw = await direct.h.request(`/sap/bc/adt/textelements/programs/${PROG.toLowerCase()}/source/symbols`, { method: 'GET', qs: { 'sap-language': 'EN' }, headers: { Accept: 'application/vnd.sap.adt.textelements.symbols.v1' } });
    console.log('INFO symbols 原始 body:', JSON.stringify(String(raw.body).slice(0, 300)));
    const toolR = await call('getTextPoolInLanguage', { program: PROG, language: 'EN' });
    const entries = toolR?.entries || [];
    record('F7 文本池写读对称', entries.some(e => e.id === 'I' && e.key === '001') ? 'PASS' : 'FAIL', `entries=${entries.length} symbols001=${entries.some(e => e.id === 'I' && e.key === '001')}`);
    const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name: PROG });
    const cid = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId;
    if (cid) await call('applyRepositoryObjectCleanup', { cleanupPlanId: cid });
  } else record('F7 文本池写读对称', 'FAIL', '创建失败');
} catch (e) { record('F7 文本池写读对称', 'FAIL', String(e.message).slice(0, 150)); }

const summary = results.reduce((a, r) => { a[r.s] = (a[r.s] || 0) + 1; return a; }, {});
console.log('\n=== 修复复验汇总 ===', JSON.stringify(summary));
process.exit(0);
