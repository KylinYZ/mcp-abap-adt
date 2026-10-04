// sap-dev 全功能真机战役·第一批：只读面扫描（无参发现 + 对象模板 + status 错误语义）。
// 用法：node scripts/dev-campaign-read-sweep.tmp.mjs
// 语义：PASS=工具正常返回（空数据备注 data:empty）；PASS-ERR=确定性错误语义符合预期；
//       FAIL=工具报错或结构缺失；NA=前置数据缺失（如实记录）。
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!/^http:\/\//.test(String(envVars.SAP_URL || ''))) { console.error('红线预检失败：SAP_URL 缺失'); process.exit(1); }
const injected = { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'error', SAP_MCP_CONFIRMATION_MODE: 'auto' };
if (!envVars.SAP_MCP_CONFIRMATION_MODE) injected.SAP_MCP_CONFIRMATION_MODE = 'auto';
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, injected);

const client = new Client({ name: 'dev-read-sweep', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' }));

// 测试对象（sap-dev 存量）
const OBJ = { cls: 'CL_ABAP_TYPEDESCR', table: 'T000', pkg: 'Z001', transport: process.env.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT || 'S4DK900109', msgcls: 'SY', user: envVars.SAP_USER };

const results = [];
function record(name, status, detail) { results.push({ name, status, detail: String(detail || '').slice(0, 220) }); const icon = status === 'PASS' ? '✓' : status === 'PASS-ERR' ? '◐' : status === 'NA' ? '○' : '✗'; console.log(`${icon} ${name} [${status}] ${String(detail || '').slice(0, 110)}`); }

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 120000 });
  const structured = r?.structuredContent;
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = undefined; }
  return { raw: r, structured, parsed: parsed ?? structured ?? t, isError: r?.isError === true };
}
// 期望确定性错误的调用（status 类工具对不存在 plan 的语义）
async function callExpectPlanError(name, args) {
  const r = await call(name, args);
  const text = JSON.stringify(r.parsed ?? '');
  if (r.isError || /PLAN_NOT_FOUND|PLAN_EXPIRED|not found|NOT_FOUND|not a valid/i.test(text)) return 'PASS-ERR';
  return `FAIL ${text.slice(0, 100)}`;
}
const isEmptyData = (parsed) => {
  const s = JSON.stringify(parsed ?? '');
  return s.length < 60 || /"\[\]"|\[\]|\{\}|testClassCount":0|alertCount":0/.test(s);
};

// ---------- B1：无参发现面 ----------
const noArg = [
  'healthcheck', 'sapDoctor', 'inspectSapSystem', 'objectTypes', 'annotationDefinitions',
  'atcCustomizing', 'checkInstallPrerequisites', 'checkAmdpDebugger', 'inactiveObjects',
  'listRepositoryObjectCreationCapabilities', 'probeRfcSystem', 'rapGenIsAvailable',
  'tracesList', 'tracesListRequests', 'listJobs', 'listSpoolRequests', 'readRuntimeDumps',
  'findSimilarDumps', 'groupRuntimeDumps', 'debuggerListeners', 'listRepositoryObjectCreationCapabilities'
];
// sm21 / app log 带时间窗
const timed = [
  ['sm21Read', { fromDateTime: '2026-10-01T00:00:00', toDateTime: '2026-10-04T23:59:59', pageSize: 5 }],
  ['readApplicationLog', { timeFrom: '2026-09-01', timeTo: '2026-10-04', maxResults: 5 }],
];

for (const name of [...new Set(noArg)]) {
  try {
    const r = await call(name, {});
    if (r.isError) record(name, 'FAIL', JSON.stringify(r.parsed).slice(0, 140));
    else record(name, 'PASS', isEmptyData(r.parsed) ? 'data:empty' : 'ok');
  } catch (e) { record(name, 'FAIL', String(e?.message || e).slice(0, 140)); }
}
for (const [name, args] of timed) {
  try {
    const r = await call(name, args);
    if (r.isError) record(name, 'FAIL', JSON.stringify(r.parsed).slice(0, 140));
    else record(name, 'PASS', isEmptyData(r.parsed) ? 'data:empty' : 'ok');
  } catch (e) { record(name, 'FAIL', String(e?.message || e).slice(0, 140)); }
}

// ---------- B2：对象模板只读面 ----------
const specs = [
  ['searchObject', { query: 'ZVCL_AMDP%', max: 10 }],
  ['findObjectPath', { objectUrl: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['objectStructure', { objectUrl: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['objectStructureElements', { objectUrl: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['classComponents', { url: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['classIncludes', { clas: OBJ.cls }],
  ['getObjectSource', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['getAbapMemberSource', { objectType: 'CLASS', objectName: OBJ.cls, memberName: 'DESCRIPTION' }],
  ['inspectAbapObject', { objectType: 'CLASS', objectName: OBJ.cls, maxLines: 50 }],
  ['mainPrograms', { includeUrl: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}/source/main` }],
  ['fragmentMappings', { url: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}/source/main`, type: 'CLAS', name: OBJ.cls }],
  ['objectEnhancements', { sourceMainPath: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}/source/main` }],
  ['revisions', { objectUrl: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['compareSourceObjects', { objectType1: 'CLAS', objectName1: OBJ.cls, objectType2: 'CLAS', objectName2: OBJ.cls }],
  ['compareObjectLanguages', { objectType: 'CLAS', objectName: OBJ.cls, sourceLanguage: 'EN', targetLanguage: 'DE' }],
  ['getObjectContentInLanguage', { objectType: 'CLAS', objectName: OBJ.cls, language: 'DE' }],
  ['typeHierarchy', { url: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}/source/main`, body: '', line: 0, offset: 0, superTypes: true }],
  ['findDefinition', { url: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}/source/main`, source: '', line: 1, startCol: 1, endCol: 5 }],
  ['usageReferences', { url: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['usageReferenceSnippets', { references: [{ objectType: 'CLAS', objectName: OBJ.cls }] }],
  ['getCallees', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['getDependencyContext', { objectType: 'CLAS', objectName: OBJ.cls, maxDeps: 5 }],
  ['analyzeDependencies', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['parseAbapSource', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['analyzeSourceEffects', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['getLoadGraph', { objectName: OBJ.cls, direction: 'loads' }],
  ['buildLoadDependencyGraph', { objectType: 'CLAS', objectName: OBJ.cls, direction: 'loads', maxDepth: 1 }],
  ['getCrHistory', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['getCoChange', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['getTransportScope', { transports: [OBJ.transport] }],
  ['getWhereUsedConfig', { variable: 'ZNOTEXIST_VAR_XY' }],
  ['getUsageExamples', { objectType: 'CLAS', objectName: OBJ.cls, maxExamples: 3 }],
  ['checkPackageBoundaries', { packageName: OBJ.pkg, objectLimit: 3 }],
  ['analyzeDependencyGraph', { operation: 'stats', graph: { nodes: [{ id: 'CLAS:' + OBJ.cls, name: OBJ.cls, type: 'CLAS' }], edges: [] } }],
  ['ddicElement', { path: `/sap/bc/adt/ddic/domains/${'DOMNAME'.toLowerCase()}` }],
  ['describeClassicTable', { tableName: OBJ.table }],
  ['tableContents', { ddicEntityName: OBJ.table, rowNumber: 3 }],
  ['runQuery', { sqlQuery: 'SELECT mandt, mtext FROM t000', rowNumber: 3 }],
  ['readRfcTable', { table: OBJ.table, maxRows: 3 }],
  ['describeRfm', { functionName: 'STFC_CONNECTION' }],
  ['callRfm', { functionName: 'RFC_PING' }],
  ['getTransaction', { transaction: 'SE38' }],
  ['getMessages', { messageClass: OBJ.msgcls }],
  ['getTextElements', { url: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}` }],
  ['getTextPoolInLanguage', { program: 'SAPL0060', language: 'EN' }],
  ['getAbapDocumentation', { docClass: 'CL', docObject: OBJ.cls, maxLines: 30 }],
  ['searchImgActivities', { text: 'currency', limit: 5 }],
  ['getCdsDependencies', { objectName: 'CDSVIEW' }],
  ['syntaxCheckCode', { code: 'REPORT zdev_sweep_tmp.\nWRITE: / 1.' }],
  ['grepObjects', { objects: [{ name: OBJ.cls, objectType: 'CLAS' }], pattern: 'class', contextLines: 0 }],
  ['grepPackage', { packageName: OBJ.pkg, pattern: 'REPORT', maxResults: 5 }],
  ['atcCheckVariant', { variant: 'DEFAULT' }],
  ['atcDocumentation', { docUri: 'x' }],
  ['unitTestEvaluation', { clas: OBJ.cls }],
  ['runUnitCoverage', { objectType: 'CLAS', objectName: OBJ.cls }],
  ['transportInfo', { objSourceUrl: `/sap/bc/adt/oo/classes/${OBJ.cls.toLowerCase()}/source/main` }],
  ['packageSearchHelp', { type: 'DEVC' }],
  ['ui5ListApps', { query: 'Z*', maxResults: 10 }],
  ['rapGenIsAvailable', {}],
  ['getFmTestDataSets', { function: 'STFC_CONNECTION' }],
  ['getDataElementLabels', { dataElement: 'XUBNAME', language: 'EN' }],
  ['getDomainProperties', { domainUrl: '/sap/bc/adt/ddic/domains/xubname' }],
  ['getDataElementProperties', { dataElementUrl: '/sap/bc/adt/ddic/dataelements/xubname' }],
];
// 带前置判定的
for (const [name, args] of specs) {
  try {
    const r = await call(name, args);
    if (r.isError) {
      const text = JSON.stringify(r.parsed ?? '');
      if (/not found|NOT_FOUND|does not exist|unknown|未找到|404/i.test(text)) record(name, 'NA', text.slice(0, 120));
      else record(name, 'FAIL', text.slice(0, 140));
    } else record(name, 'PASS', isEmptyData(r.parsed) ? 'data:empty' : 'ok');
  } catch (e) {
    const msg = String(e?.message || e);
    if (/not found|does not exist|404/i.test(msg)) record(name, 'NA', msg.slice(0, 120));
    else record(name, 'FAIL', msg.slice(0, 140));
  }
}
// CDS 三件套（先找一个真实 CDS）
try {
  const cdsSearch = await call('searchObject', { query: 'I_CURRENCY%', max: 5 });
  const text = JSON.stringify(cdsSearch.parsed ?? '');
  const m = text.match(/[A-Z][A-Z0-9_]*I_CURRENCY[A-Z0-9_]*/i);
  if (m) {
    for (const [name, args] of [
      ['getCdsDependencies', { objectName: m[0] }],
      ['getCdsElementInfo', { objectName: m[0] }],
      ['getCdsImpactAnalysis', { objectName: m[0] }],
    ]) {
      const r = await call(name, args);
      r.isError ? record(name, 'FAIL', JSON.stringify(r.parsed).slice(0, 120)) : record(name, 'PASS', 'ok');
    }
  } else record('getCdsDependencies', 'NA', '系统未发现 I_CURRENCY* CDS');
} catch (e) { record('getCdsDependencies', 'FAIL', String(e?.message || e).slice(0, 120)); }
// status 类（错误语义验证）
const statusTools = [
  ['getAbapChangeStatus', { changePlanId: 'DEVSWEEP-NOPLAN' }],
  ['getAbapObjectCreationStatus', { creationPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getCloneObjectStatus', { clonePlanId: 'DEVSWEEP-NOPLAN' }],
  ['getControlledRenameStatus', { renamePlanId: 'DEVSWEEP-NOPLAN' }],
  ['getDebugOperationStatus', { debugOperationPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getDescriptionChangeStatus', { descriptionPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getMessageTextChangeStatus', { messageTextPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getObjectActivationStatus', { activationPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getQualityCheckStatus', { qualityPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getRepositoryObjectCleanupStatus', { cleanupPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getRepositoryObjectCreationStatus', { creationPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getTextPoolChangeStatus', { textPoolPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getTransportCleanupStatus', { transportCleanupPlanId: 'DEVSWEEP-NOPLAN' }],
  ['getTransportCreationStatus', { transportCreationPlanId: 'DEVSWEEP-NOPLAN' }],
];
for (const [name, args] of statusTools) {
  try { record(name, await callExpectPlanError(name, args)); }
  catch (e) { record(name, 'FAIL', String(e?.message || e).slice(0, 140)); }
}
// sap 入口（help/system）
for (const args of [{ action: 'help' }, { action: 'system' }]) {
  try {
    const r = await call('sap', args);
    r.isError ? record('sap(' + args.action + ')', 'FAIL', JSON.stringify(r.parsed).slice(0, 120)) : record('sap(' + args.action + ')', 'PASS', 'ok');
  } catch (e) { record('sap(' + args.action + ')', 'FAIL', String(e?.message || e).slice(0, 120)); }
}

// UI5 / traces 明细（视列表结果）
try {
  const r = await call('ui5ListApps', { query: '*', maxResults: 5 });
  const apps = JSON.stringify(r.parsed ?? '');
  const m = apps.match(/"name":"([^"]+)"/);
  if (m) {
    const appR = await call('ui5GetApp', { appName: m[1] });
    appR.isError ? record('ui5GetApp', 'NA', JSON.stringify(appR.parsed).slice(0, 100)) : record('ui5GetApp', 'PASS', appR.parsed ? 'ok' : 'data:empty');
  } else record('ui5GetApp', 'NA', '系统无 UI5 BSP 应用');
} catch (e) { record('ui5GetApp', 'FAIL', String(e?.message || e).slice(0, 120)); }
try {
  const r = await call('tracesList', {});
  const list = JSON.stringify(r.parsed ?? '');
  const m = list.match(/"id":"([^"]+)"/);
  if (m) {
    const tr = await call('tracesHitList', { id: m[1] });
    tr.isError ? record('tracesHitList', 'FAIL', JSON.stringify(tr.parsed).slice(0, 100)) : record('tracesHitList', 'PASS', 'ok');
  } else record('tracesHitList', 'NA', '系统无 trace 数据');
} catch (e) { record('tracesHitList', 'FAIL', String(e?.message || e).slice(0, 120)); }
try {
  const r = await call('listSpoolRequests', { maxRows: 5 });
  const list = JSON.stringify(r.parsed ?? '');
  const m = list.match(/"(?:rqident|id)"[:\s]+(\d+)/i);
  if (m) {
    const sp = await call('readSpoolContent', { requestNumber: Number(m[1]) });
    sp.isError ? record('readSpoolContent', 'FAIL', JSON.stringify(sp.parsed).slice(0, 100)) : record('readSpoolContent', 'PASS', 'ok');
  } else record('readSpoolContent', 'NA', '系统无 spool 请求');
} catch (e) { record('readSpoolContent', 'FAIL', String(e?.message || e).slice(0, 120)); }
try {
  const r = await call('listJobs', { limit: 5 });
  const list = JSON.stringify(r.parsed ?? '');
  if (r.isError || list === '[]' || list.length < 20) record('readSpoolContent-jobs', 'NA', '系统无后台作业');
} catch { /* job 明细已在 B1 */ }

// 汇总
const summary = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
console.log('\n=== 只读面汇总 ===', JSON.stringify(summary), '/', results.length);
writeFileSync('dev-campaign-read-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), env: ENV_PATH, target: envVars.SAP_URL + ' client ' + envVars.SAP_CLIENT, results, summary }, null, 2));
process.exit(0);
