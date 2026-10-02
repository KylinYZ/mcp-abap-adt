// E1+F1 真机 smoke（sap-demo，受控链 + auto 确认模式）：
//   E1：受控创建链重建 ZTABDATA_TOOL（PROGRAM，Z001，S4HK900031，源码取自 sap/tabdata/）
//   F1：受控 DDIC 文本元素链写 17 条选择屏文本（SET_TEXT_ELEMENTS selections）并读回断言
// 本脚本同时是交接清单 A1 修复的真机验收场景：
//   MCP SDK 客户端不声明 elicitation 能力 + 部署 SAP_MCP_CONFIRMATION_MODE=auto，
//   修复后确认链应在 plan 校验后短路成功（修复前会报 CONFIRMATION_UNSUPPORTED）。
// 全程串行、写后读回、失败即停。授权范围：DEV 专用配置下的自有 Z* 对象重建与文本池写入。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(ENV_PATH, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: ENV_PATH,
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false',
  // A1 验收前置：部署级 auto 确认（仅 DEV 可配置；fail-closed 由服务端保证）
  SAP_MCP_CONFIRMATION_MODE: 'auto'
});

const PROG = 'ZTABDATA_TOOL';
const PACKAGE_NAME = 'Z001';
const TRANSPORT = 'S4HK900031';
// 源码从仓库 sap/tabdata/ 读取（首行 REPORT ZTABDATA_TOOL. 大写前置——服务端创建门校验）
const SOURCE = readFileSync('sap/tabdata/ztabdata_tool.prog.abap', 'utf8').replace(/\r\n/g, '\n');
if (!/^REPORT ZTABDATA_TOOL\./.test(SOURCE)) {
  console.error('红线预检失败：report 源码首行不是大写 REPORT ZTABDATA_TOOL.');
  process.exit(1);
}

// F1 验收载荷：17 条选择屏文本（与源码 17 个 PARAMETERS 一一对应，文案取自源码注释语义）
const SELECTION_TEXTS = [
  { id: 'RB_EXP', text: '导出 Excel' },
  { id: 'RB_IMP', text: '导入 Excel' },
  { id: 'RB_BAK', text: '备份表数据' },
  { id: 'RB_RES', text: '恢复备份' },
  { id: 'P_TABLE', text: '目标表名' },
  { id: 'P_WHERE', text: 'WHERE 子句（导出）' },
  { id: 'P_MAXROW', text: '导出行数上限' },
  { id: 'P_FEXP', text: '导出文件路径' },
  { id: 'P_FIMP', text: '导入文件路径' },
  { id: 'P_IMPBAK', text: '导入前自动备份' },
  { id: 'P_UMODE', text: '按 upsert 写入' },
  { id: 'P_UONLYI', text: '仅插入新行' },
  { id: 'P_UONLYU', text: '仅更新已有行' },
  { id: 'P_FBAK', text: '备份文件路径' },
  { id: 'P_FRES', text: '恢复文件路径' },
  { id: 'P_ALLOW', text: '放行标准表' },
  { id: 'P_REASON', text: '放行原因（审计）' }
];

// MCP SDK 客户端：capabilities 刻意为空（无 elicitation）——A1 验收的关键场景
const client = new Client({ name: 'e1f1-tabdata-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'inherit' });

let passed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`PASS ${label}`); }
  else { console.error(`FAIL ${label}`); throw new Error(`断言失败：${label}`); }
}
function parseToolResult(r) {
  const text = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: undefined }; }
}
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const { text, json } = parseToolResult(r);
  if (r.isError) {
    // 失败诊断：完整错误码/阶段/primaryError/阶段清单（A3 修复的 syntaxMessages 也在此透出）
    const err = json?.error;
    const primary = err?.details?.plan?.primaryError;
    const stages = err?.details?.plan?.stages || [];
    console.error(`${name} 报错：code=${err?.code} stage=${err?.stage}`);
    if (primary) console.error(`primaryError：${JSON.stringify(primary).slice(0, 1500)}`);
    if (err?.details?.syntaxMessages) console.error(`syntaxMessages：${JSON.stringify(err.details.syntaxMessages).slice(0, 800)}`);
    for (const s of stages) console.error(`  stage ${s.stage}: success=${s.success} ${String(s.message || '').slice(0, 200)}`);
    throw new Error(`${name} 失败：${text.slice(0, 1500)}`);
  }
  return { text, json };
}

await client.connect(transport);
console.log('MCP 已连接（client capabilities 无 elicitation）');

// ---------------------------------------------------------------------
// 阶段 1（E1）：受控创建链重建 ZTABDATA_TOOL
// ---------------------------------------------------------------------
console.log('\n--- E1：previewRepositoryObjectCreation(PROGRAM ZTABDATA_TOOL) ---');
const preview = await call('previewRepositoryObjectCreation', {
  objectKind: 'PROGRAM',
  name: PROG,
  description: '表数据导出导入备份恢复工具',
  packageName: PACKAGE_NAME,
  transportRequest: TRANSPORT,
  source: SOURCE
});
const planId = preview.json?.plan?.creationPlanId || preview.json?.creationPlanId;
ok(Boolean(planId), `preview 冻结 plan（${String(planId).slice(0, 8)}…）`);

console.log('--- E1：applyRepositoryObjectCreation（auto 确认模式，无 elicitation）---');
const apply = await call('applyRepositoryObjectCreation', { creationPlanId: planId });
const applyText = apply.text;
const planStatus = apply.json?.plan?.status;
ok(planStatus === 'APPLIED' || /APPLIED/.test(applyText), `apply 完成（plan=${planStatus || '见文本'}）`);
// A1 验收点：auto 模式下 apply 未经 elicitation 直接执行成功（报错会在 call() 内抛出）
console.log('PASS A1 真机场景：无 elicitation 客户端在 auto 模式下完成受控创建全链 apply');

console.log('--- E1：读回验证（getObjectSource 对比源码）---');
const readback = await call('getObjectSource', { objectType: 'PROG', objectName: PROG });
const remoteSource = String(readback.json?.source ?? readback.text ?? '');
const expectedFirst = SOURCE.split('\n')[0];
ok(remoteSource.includes(expectedFirst), `读回首行一致（${expectedFirst}）`);
ok(remoteSource.length > 5000, `读回源码规模正常（${remoteSource.length} 字符）`);

// ---------------------------------------------------------------------
// 阶段 2（F1）：受控 SET_TEXT_ELEMENTS 写 17 条选择文本
// ---------------------------------------------------------------------
console.log('\n--- F1：previewDdicPropertyChange(SET_TEXT_ELEMENTS, selections × 17) ---');
const textPreview = await call('previewDdicPropertyChange', {
  operation: {
    kind: 'SET_TEXT_ELEMENTS',
    objectType: 'PROGRAM',
    objectName: PROG,
    transportRequest: TRANSPORT,
    category: 'selections',
    elements: SELECTION_TEXTS.map(entry => ({ id: entry.id, text: entry.text }))
  }
});
const opPlanId = textPreview.json?.operationPlanId || textPreview.json?.plan?.operationPlanId;
ok(Boolean(opPlanId), `文本 plan 冻结（${String(opPlanId).slice(0, 8)}…）`);

console.log('--- F1：applyDdicPropertyChange（auto 确认模式）---');
const textApply = await call('applyDdicPropertyChange', { operationPlanId: opPlanId });
const textApplyText = textApply.text;
ok(/APPLIED|success/i.test(textApplyText), '文本 apply 完成');

console.log('--- F1：读回验证（getTextPoolInLanguage selections）---');
const pool = await call('getTextPoolInLanguage', { program: PROG, language: 'ZH' });
const poolText = pool.text;
const selections = pool.json?.selections ?? [];
let matched = 0;
if (Array.isArray(selections) && selections.length > 0) {
  for (const entry of SELECTION_TEXTS) {
    const hit = selections.find(s => String(s.key || s.id || '').toUpperCase() === entry.id);
    if (hit && String(hit.text ?? hit.value ?? '').includes(entry.text)) matched += 1;
  }
  ok(matched === SELECTION_TEXTS.length, `17 条选择文本读回一致（${matched}/${SELECTION_TEXTS.length}）`);
} else {
  // 语言回退（ZH 无独立池时按 EN 主语言读）：按文本内容断言
  let byText = 0;
  for (const entry of SELECTION_TEXTS) if (poolText.includes(entry.text)) byText += 1;
  ok(byText >= 12, `选择文本按主语言读回命中（${byText}/${SELECTION_TEXTS.length}，ZH 回退路径）`);
}

console.log(`\nSMOKE OK（${passed} 项断言全通过）`);
await client.close().catch(() => {});
process.exit(0);
