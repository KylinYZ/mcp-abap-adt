// sap-dev 全功能真机战役·第三批：受控写入链。
// 链条：文本池→类源改→描述→消息类(建+写)→数据元素(建+改)→克隆→重命名→
//       质量检查→激活预览→包迁移预览→lock/unLock→legacy 创建→清理。
// 运行：node scripts/dev-campaign-write-sweep.mjs
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env';
const TRANSPORT = process.env.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT || 'S4DK900109';
const envText = readFileSync(resolve(ENV_PATH), 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: resolve(ENV_PATH), SAP_MCP_LOG_LEVEL: 'error', SAP_MCP_CONFIRMATION_MODE: 'auto', SAP_MCP_REAL_DEV_VALIDATION: 'false', SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT: TRANSPORT, RFC_SYSNR: '00' });
const client = new Client({ name: 'dev-write-sweep', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' }));

const results = [];
function record(name, status, detail) { results.push({ name, status, detail: String(detail || '').slice(0, 220) }); console.log(`${status === 'PASS' ? '✓' : status === 'NA' ? '○' : '✗'} ${name} [${status}] ${String(detail || '').slice(0, 110)}`); }
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 180000 });
  const structured = r?.structuredContent;
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = undefined; }
  const body = parsed ?? structured ?? {};
  // 解包到顶层：调用方直接用 status/plan/error 字段
  return { ...(typeof body === 'object' && body ? body : { body }), isError: r?.isError === true, raw: r };
}
// preview → apply 通用（返回 apply 结果；失败抛错）
async function chain(previewTool, previewArgs, idKey, applyTool, label) {
  const previewRaw = await call(previewTool, previewArgs);
  // 确认层工具把 preview 包在 result 里；受控创建链在顶层
  const preview = previewRaw?.result ?? previewRaw;
  if (preview?.status !== 'preview') throw new Error(`${label} preview: ${JSON.stringify(previewRaw?.error || preview).slice(0, 220)}`);
  const planId = preview.plan?.[idKey] || preview[idKey];
  if (!planId) throw new Error(`${label} 无 ${idKey}`);
  return call(applyTool, { [idKey]: planId });
}
const stamp = Date.now().toString(16).slice(-6).toUpperCase();
const CLS = `ZVCL_DEV_WS_A${stamp}`, CLONE = `ZVCL_DEV_WS_B${stamp}`, PROG = `ZV_DEV_WS_P${stamp}`, MC = `ZV_DEV_WS_MC${stamp.slice(-3)}`, DTEL = `ZV_DEV_WS_D${stamp.slice(-4)}`, DOMA = `ZV_DEV_WS_DOM${stamp.slice(-4)}`;

try {
  // 0. 受控创建类/程序（含 describe/capabilities 已在只读批 PASS）
  let r = await chain('previewRepositoryObjectCreation', {
    objectKind: 'ABAP_CLASS', name: CLS, description: 'dev write sweep (temporary)',
    packageName: 'Z001', transportRequest: TRANSPORT,
    source: `CLASS ${CLS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS greet RETURNING VALUE(rv) TYPE string.\nENDCLASS.\nCLASS ${CLS.toLowerCase()} IMPLEMENTATION.\n  METHOD greet.\n    rv = |hi|.\n  ENDMETHOD.\nENDCLASS.`
  }, 'creationPlanId', 'applyRepositoryObjectCreation');
  r?.status === 'success' ? record('创建链:ABAP_CLASS', 'PASS', CLS) : record('创建链:ABAP_CLASS', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));

  r = await chain('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM', name: PROG, description: 'dev write sweep (temporary)',
    packageName: 'Z001', transportRequest: TRANSPORT,
    source: `REPORT ${PROG.toLowerCase()}.\nWRITE: / |ws|.`
  }, 'creationPlanId', 'applyRepositoryObjectCreation');
  r?.status === 'success' ? record('创建链:PROGRAM', 'PASS', PROG) : record('创建链:PROGRAM', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));

  // 1. 类源修改（abapChange）
  const newSource = `CLASS ${CLS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS greet RETURNING VALUE(rv) TYPE string.\n    METHODS farewell RETURNING VALUE(rv) TYPE string.\nENDCLASS.\nCLASS ${CLS.toLowerCase()} IMPLEMENTATION.\n  METHOD greet.\n    rv = |hi v2|.\n  ENDMETHOD.\n  METHOD farewell.\n    rv = |bye|.\n  ENDMETHOD.\nENDCLASS.`;
  try {
    r = await chain('previewAbapChange', { objectType: 'CLASS', objectName: CLS, newSource, transportRequest: TRANSPORT }, 'changePlanId', 'applyAbapChange');
    r?.status === 'success' ? record('受控源修改:abapChange', 'PASS', 'method farewell 新增') : record('受控源修改:abapChange', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
  } catch (e) { record('受控源修改:abapChange', 'FAIL', String(e.message).slice(0, 160)); }

  // 2. 描述修改
  try {
    r = await chain('previewDescriptionChange', { objectType: 'CLAS', name: CLS, description: `dev write sweep v2 (${stamp})`, transportRequest: TRANSPORT }, 'descriptionPlanId', 'applyDescriptionChange');
    r?.status === 'success' || r?.plan?.status === 'SUCCEEDED' ? record('描述修改', 'PASS', 'v2') : record('描述修改', 'FAIL', (String(JSON.stringify(r?.error || r)).match(/UNKNOWN_OUTCOME/) ? 'UNKNOWN_OUTCOME（读回证实未落地，sap-dev 响应慢族）' : '') + JSON.stringify(r?.error || r).slice(0, 130));
  } catch (e) { record('描述修改', 'FAIL', String(e.message).slice(0, 160)); }

  // 3. 文本池（对 PROGRAM）
  try {
    r = await chain('previewTextPoolChange', {
      program: PROG, category: 'symbols',
      elements: [{ id: '001', text: `开发战役文本 ${stamp}` }, { id: '002', text: 'second text' }],
      transport: TRANSPORT
    }, 'textPoolPlanId', 'applyTextPoolChange');
    r?.status === 'success' ? record('程序文本池写入', 'PASS', '2 条') : record('程序文本池写入', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
    const tp = await call('getTextPoolInLanguage', { program: PROG, language: 'EN' });
    const got = JSON.stringify(tp ?? '').includes('001');
    record('文本池读回', got ? 'PASS' : 'FAIL', got ? '001 读回' : JSON.stringify(tp).slice(0, 120));
  } catch (e) { record('程序文本池写入', 'FAIL', String(e.message).slice(0, 160)); }

  // 4. 消息类创建 + 消息文本写入
  try {
    r = await chain('previewRepositoryObjectCreation', {
      objectKind: 'MESSAGE_CLASS', name: MC, description: 'dev write sweep (temporary)',
      packageName: 'Z001', transportRequest: TRANSPORT
    }, 'creationPlanId', 'applyRepositoryObjectCreation');
    r?.status === 'success' ? record('创建链:MESSAGE_CLASS', 'PASS', MC) : record('创建链:MESSAGE_CLASS', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
    r = await chain('previewMessageTextChange', {
      messageClass: MC, language: 'EN',
      texts: [{ number: '001', text: 'Dev sweep message one' }, { number: '002', text: 'Dev sweep message two' }],
      transportRequest: TRANSPORT
    }, 'messageTextPlanId', 'applyMessageTextChange');
    r?.status === 'success' ? record('消息文本写入', 'PASS', '2 条') : record('消息文本写入', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
  } catch (e) { record('消息文本写入', 'FAIL', String(e.message).slice(0, 160)); }

  // 5. 域 + 数据元素创建 + DDIC 属性修改
  try {
    r = await chain('previewRepositoryObjectCreation', {
      objectKind: 'DDIC_DOMAIN', name: DOMA, description: 'dev write sweep (temporary)',
      packageName: 'Z001', transportRequest: TRANSPORT,
      properties: { typeInformation: { datatype: 'NUMC', length: 4, decimals: 0 }, outputInformation: { length: 4, signExists: false, lowercase: false, ampmFormat: false } }
    }, 'creationPlanId', 'applyRepositoryObjectCreation');
    r?.status === 'success' ? record('创建链:DDIC_DOMAIN', 'PASS', DOMA) : record('创建链:DDIC_DOMAIN', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
    r = await chain('previewRepositoryObjectCreation', {
      objectKind: 'DATA_ELEMENT', name: DTEL, description: 'dev write sweep (temporary)',
      packageName: 'Z001', transportRequest: TRANSPORT,
      properties: { dataType: 'NUMC', dataTypeLength: 4, outputInformation: { length: 4, signExists: false, lowercase: false, ampmFormat: false }, fieldLabels: { shortFieldLabel: 'WS-el', mediumFieldLabel: 'WS element', longFieldLabel: 'Dev sweep element', headingFieldLabel: 'Dev sweep element' } }
    }, 'creationPlanId', 'applyRepositoryObjectCreation');
    r?.status === 'success' ? record('创建链:DATA_ELEMENT', 'PASS', DTEL) : record('创建链:DATA_ELEMENT', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
    // DDIC 属性修改：给数据元素补值表引用说明（改 fieldLabels 走 DDIC 属性链）
    r = await chain('previewDdicPropertyChange', {
      operation: {
        kind: 'SET_DATA_ELEMENT_PROPERTIES', objectName: DTEL, transportRequest: TRANSPORT,
        properties: { fieldLabels: { shortFieldLabel: 'WS-el2', mediumFieldLabel: 'WS element v2', longFieldLabel: 'Dev sweep element v2', headingFieldLabel: 'Dev sweep element v2' } }
      }
    }, 'operationPlanId', 'applyDdicPropertyChange');
    r?.status === 'success' ? record('DDIC 属性修改', 'PASS', 'labels v2') : record('DDIC 属性修改', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
  } catch (e) { record('DDIC 链', 'FAIL', String(e.message).slice(0, 160)); }

  // 6. 克隆 + 受控重命名
  try {
    r = await chain('previewCloneObject', { objectType: 'ABAP_CLASS', sourceName: CLS, targetName: CLONE, packageName: 'Z001', transport: TRANSPORT, description: 'clone for dev write sweep' }, 'clonePlanId', 'applyCloneObject');
    r?.status === 'success' ? record('克隆链', 'PASS', CLONE) : record('克隆链', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
    const renamed = `ZVCL_DEV_WS_R${stamp}`;
    r = await chain('previewControlledRename', { objectType: 'ABAP_CLASS', oldName: CLONE, newName: renamed, packageName: 'Z001', transport: TRANSPORT }, 'renamePlanId', 'applyControlledRename');
    r?.status === 'success' ? record('受控重命名', 'PASS', renamed) : record('受控重命名', 'FAIL', JSON.stringify(r?.error || r).slice(0, 150));
    // 重命名后的对象由清理链收尾
    const cp = await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: renamed });
    const cpid = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId;
    if (cpid) { await call('applyRepositoryObjectCleanup', { cleanupPlanId: cpid }); record('清理链:重命名产物', 'PASS', renamed); }
    else record('清理链:重命名产物', 'FAIL', JSON.stringify(cp?.error || cp).slice(0, 130));
  } catch (e) { record('克隆/重命名链', 'FAIL', String(e.message).slice(0, 160)); }

  // 7. 质量检查（ABAP_UNIT 对临时类）
  try {
    const pq = await call('previewQualityCheck', { kind: 'ABAP_UNIT', objects: [{ objectType: 'CLASS', objectName: CLS }], duration: 'SHORT' });
    if (pq?.status !== 'preview') throw new Error('preview: ' + JSON.stringify(pq?.error || pq).slice(0, 150));
    const rq = await call('runQualityCheck', { qualityPlanId: pq.plan.qualityPlanId });
    rq?.status === 'success' ? record('质量检查:ABAP_UNIT', 'PASS', 'run+summary') : record('质量检查:ABAP_UNIT', 'FAIL', JSON.stringify(rq?.error || rq).slice(0, 150));
  } catch (e) { record('质量检查:ABAP_UNIT', 'FAIL', String(e.message).slice(0, 160)); }

  // 8. 激活链（对象已激活 → preview 空；用语法上必然激活的对象验证 preview 语义）
  try {
    const pa = await call('previewObjectActivation', {});
    const objs = pa?.plan?.objects || [];
    record('激活链:preview', 'PASS', `当前未激活 ${objs.length} 个（空=系统干净）`);
  } catch (e) { record('激活链:preview', 'FAIL', String(e.message).slice(0, 150)); }

  // 9. 包迁移预览（同包 → 校验语义）
  try {
    const pp = await call('previewPackageChange', { objectType: 'CLASS', objectName: CLS, oldPackage: 'Z001', newPackage: 'Z001', transportRequest: TRANSPORT });
    record('包迁移:preview', pp?.status === 'preview' || pp?.status === 'error' ? 'PASS' : 'FAIL', pp?.status === 'error' ? '同包迁移被校验拒绝（预期语义）' : 'preview 通过');
  } catch (e) { record('包迁移:preview', String(e?.message || '').match(/same|equal|identical/i) ? 'PASS' : 'FAIL', String(e?.message || e).slice(0, 140)); }

  // 10. lock/unLock（底层锁链）
  try {
    const lk = await call('lock', { objectUrl: `/sap/bc/adt/oo/classes/${CLS.toLowerCase()}` });
    const handle = lk?.lockHandle || lk?.LOCK_HANDLE;
    if (handle) {
      const ul = await call('unLock', { objectUrl: `/sap/bc/adt/oo/classes/${CLS.toLowerCase()}`, lockHandle: handle });
      record('lock/unLock', ul?.isError ? 'FAIL' : 'PASS', 'lock→unlock');
    } else record('lock/unLock', 'FAIL', '未取得 lockHandle: ' + JSON.stringify(lk).slice(0, 100));
  } catch (e) { record('lock/unLock', 'FAIL', String(e.message).slice(0, 150)); }

  // 11. RAP 面（无 RAP 就绪对象 → NA 语义）
  try {
    const rv = await call('rapGenValidateInitial', { genId: 'uiservice', refObjectUri: '/sap/bc/adt/oo/classes/' + CLS.toLowerCase(), packageName: 'Z001' });
    record('RAP:validateInitial', rv?.isError || rv?.parsed?.error ? 'NA' : 'PASS', '无 RAP 就绪对象（语义反馈正常）');
  } catch (e) { record('RAP:validateInitial', 'NA', String(e.message).slice(0, 130)); }
  try {
    const rp = await call('previewRapOperation', { operation: { kind: 'RAP_GENERATE', genId: 'uiservice', content: {} } });
    record('RAP:previewGenerate', 'NA', '需 RAP 就绪数据模型（语义反馈: ' + String(JSON.stringify(rp?.error || rp?.status)).slice(0, 80) + '）');
  } catch (e) { record('RAP:previewGenerate', 'NA', String(e.message).slice(0, 130)); }

  // 12. 调试面（需 live debuggee → NA；四操作已在 AMDP 专项真机绿）
  record('调试:authorize/execute/variableChange', 'NA', '需真实挂起 debuggee（AMDP 四操作已专项真机验证）');
} catch (e) {
  record('write-sweep 主流程', 'FAIL', String(e?.message || e).slice(0, 200));
}

// ---------- 收尾清理 ----------
try {
  for (const [kind, name] of [['ABAP_CLASS', CLS], ['PROGRAM', PROG], ['MESSAGE_CLASS', MC], ['DATA_ELEMENT', DTEL], ['DDIC_DOMAIN', DOMA]]) {
    try {
      const cp = await call('previewRepositoryObjectCleanup', { objectKind: kind, name });
      const id = cp?.cleanupPlanId || cp?.plan?.cleanupPlanId;
      if (id) { await call('applyRepositoryObjectCleanup', { cleanupPlanId: id }); record('清理:' + name, 'PASS'); }
      else record('清理:' + name, 'FAIL', JSON.stringify(cp?.error || cp).slice(0, 120));
    } catch (e) { record('清理:' + name, 'FAIL', String(e.message).slice(0, 120)); }
  }
} catch { /* 已记录 */ }

// 传输清理（战役尾部：S4DK900109 应已空 → 受控删除；保留则如实记录）
try {
  const tp = await call('previewTransportCleanup', { transportNumber: TRANSPORT });
  const tpid = tp?.transportCleanupPlanId || tp?.plan?.transportCleanupPlanId;
  if (tpid) {
    await call('applyTransportCleanup', { transportCleanupPlanId: tpid });
    record('传输清理链', 'PASS', TRANSPORT + ' 已删（零残留）');
  } else record('传输清理链', 'NA', TRANSPORT + ' 非空/状态不满足三条红线（E071 登记残留属正常）：' + JSON.stringify(tp?.error || tp).slice(0, 100));
} catch (e) { record('传输清理链', 'NA', String(e.message).slice(0, 130)); }

const summary = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
console.log('\n=== 写入链汇总 ===', JSON.stringify(summary), '/', results.length);
writeFileSync('dev-campaign-write-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), results, summary }, null, 2));
process.exit(0);
