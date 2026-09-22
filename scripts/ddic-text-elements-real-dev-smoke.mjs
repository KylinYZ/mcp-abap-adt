// 受控 DDIC/文本写入真机闭环（写操作，全自建对象）：
// A 段：受控创建 PROGRAM → SET_TEXT_ELEMENTS preview/apply/readback → 同值短路负例 → 清理
// B 段：受控创建 DDIC_DOMAIN → DATA_ELEMENT → SET_DATA_ELEMENT_PROPERTIES 标签修改 preview/apply/readback → 清理
// 目的：为矩阵 report.text-elements / i18n.write(write_labels) 晋级提供真机证据。
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SUFFIX = String(Date.now()).slice(-4);
const PROG = `ZDDCSMK${SUFFIX}`;        // A 段自建程序（文本池写入目标）
const DOM = `ZDDCDOM${SUFFIX}`;         // B 段自建 domain（数据元素类型依赖）
const DTEL = `ZDDCDTE${SUFFIX}`;        // B 段自建数据元素（标签修改目标）
const TR = 'S4HK900009';                // sap-demo 上 TRSTATUS=D 的既有未释放传输
const PKG = 'Z001';

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, {
  SAP_MCP_ENV_FILE: resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env'),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'ddic-text-smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env,
  stderr: 'inherit' // 服务器 stderr 透传：500 时可见 unhandled tool error 栈
});

function parse(r) {
  // SafeAdvancedHandlers 系工具返回 markdown 文本 + structuredContent 双通道，优先取结构化载荷
  if (r?.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}

// elicitation 自动确认：仅当确认消息包含全部 expectKeywords 时接受，否则取消（防止误批无关计划）
let expectKeywords = [];
let expectDecision = 'cancel';
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  if (!expectKeywords.every(k => message.includes(k))) {
    console.log('WARN 确认未匹配，已取消:', message.slice(0, 160));
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: expectDecision } };
});

let failed = false;
function pass(m) { console.log('PASS', m); }
function fail(m, p) { failed = true; console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 500)}`); }
async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}

// 受控创建一个仓库对象并断言成功（immutable plan + 原生确认）
async function createObject(objectKind, name, extra) {
  expectKeywords = [name]; expectDecision = 'apply';
  const p = await call('previewRepositoryObjectCreation', {
    objectKind, name, packageName: PKG, transportRequest: TR, ...extra
  });
  if (p.status !== 'preview') { fail(`${objectKind} ${name} 创建 preview`, p); return false; }
  const a = await call('applyRepositoryObjectCreation', { creationPlanId: p.plan.creationPlanId });
  if (!(a.status === 'success' || a.plan?.status === 'SUCCEEDED')) { fail(`${objectKind} ${name} 创建 apply`, a); return false; }
  pass(`${objectKind} ${name} 受控创建完成`);
  return true;
}

// 受控清理 + absence 复查（对象必须消失）
async function cleanupObject(objectKind, name, objType) {
  expectKeywords = [name]; expectDecision = 'apply';
  const cp = await call('previewRepositoryObjectCleanup', { objectKind, name });
  if (cp.status !== 'preview') { fail(`${name} 清理 preview`, cp); return; }
  await call('applyRepositoryObjectCleanup', { cleanupPlanId: cp.plan.cleanupPlanId });
  const s = await call('searchObject', { query: name, objType, max: 5 });
  if ((s.results || []).length === 0) pass(`${name} 受控清理 + absence 通过（零残留）`);
  else fail(`${name} absence 失败：对象仍存在`, s);
}

async function main() {
  await client.connect(transport);

  // ============ A 段：SET_TEXT_ELEMENTS 受控写入（report.text-elements） ============
  console.log('--- A 段：SET_TEXT_ELEMENTS（程序文本池受控写入） ---');
  const created = await createObject('PROGRAM', PROG, {
    description: 'DDIC text smoke', source: `REPORT ${PROG.toLowerCase()}.\nWRITE / 'ddic-text'.`
  });
  if (!created) { console.log('SMOKE FAILED: A 段创建失败'); await client.close(); process.exit(1); }

  // A1 负例：非法 category 应被验证层拒绝（VALIDATION_FAILED），不产生 plan
  const bad = await call('previewDdicPropertyChange', {
    operation: { kind: 'SET_TEXT_ELEMENTS', objectType: 'PROGRAM', objectName: PROG, category: 'bogus', elements: [{ id: '001', text: 'x' }], transportRequest: TR }
  });
  const badMsg = JSON.stringify(bad);
  if (!badMsg.includes('VALIDATION_FAILED')) fail('A1 非法 category 负例未按 VALIDATION_FAILED 拒绝', bad);
  else pass('A1 非法 category 负例被验证层拒绝');

  // A2 preview：向空文本池写入两个文本符号（只读预检，冻结 immutable plan）
  // maxLength 必须显式给出：S/4 写入侧要求每符号 @MaxLength，readback 会回填该值参与 hash 校验
  expectKeywords = []; expectDecision = 'cancel';
  const p1raw = await call('previewDdicPropertyChange', {
    operation: {
      kind: 'SET_TEXT_ELEMENTS', objectType: 'PROGRAM', objectName: PROG,
      category: 'symbols', transportRequest: TR,
      elements: [
        { id: '001', text: 'DDIC smoke first text', maxLength: 132 },
        { id: '002', text: 'DDIC smoke second text', maxLength: 132 }
      ]
    }
  });
  const p1 = p1raw?.result || p1raw;
  if (p1?.status !== 'preview') { fail('A2 文本池 preview', p1raw); }
  else pass(`A2 文本池 plan 冻结（changedFields=${JSON.stringify(p1.plan?.inputSummary?.changedFields || [])}）`);

  // A3 确认 apply：锁→写→解锁→激活→readback hash 比对
  expectKeywords = [PROG]; expectDecision = 'apply';
  const a1raw = await call('applyDdicPropertyChange', { operationPlanId: p1.plan.operationPlanId });
  const a1 = a1raw?.result || a1raw;
  const a1Status = a1?.plan?.status || a1?.status;
  if (a1Status !== 'APPLIED' && a1?.status !== 'success') fail('A3 文本池 apply', a1raw);
  else pass(`A3 文本池 apply 成功（plan=${a1Status}）`);

  // A4 独立 readback：focused getTextElements 直读文本池，与写入内容逐项比对
  const rb = await call('getTextElements', { url: `/sap/bc/adt/textelements/programs/${PROG.toLowerCase()}`, category: 'symbols' });
  const rbs = rb?.result?.textElements || rb?.textElements || [];
  const got001 = rbs.find(e => e.id === '001');
  const got002 = rbs.find(e => e.id === '002');
  if (got001?.text === 'DDIC smoke first text' && got002?.text === 'DDIC smoke second text') {
    pass(`A4 独立 readback 一致（${rbs.length} 个文本符号，TEXT-001/002 逐字匹配）`);
  } else fail('A4 独立 readback 不一致', rbs);

  // A5 同值短路负例：相同内容再 preview 必须被拒绝（与 SAP 当前态一致即 VALIDATION_FAILED）
  expectKeywords = []; expectDecision = 'cancel';
  const dup = await call('previewDdicPropertyChange', {
    operation: {
      kind: 'SET_TEXT_ELEMENTS', objectType: 'PROGRAM', objectName: PROG,
      category: 'symbols', transportRequest: TR,
      elements: [
        { id: '001', text: 'DDIC smoke first text', maxLength: 132 },
        { id: '002', text: 'DDIC smoke second text', maxLength: 132 }
      ]
    }
  });
  const dupMsg = JSON.stringify(dup);
  if (!dupMsg.includes('identical to the current SAP state')) fail('A5 同值短路负例未生效', dup);
  else pass('A5 同值短路负例生效（identical 拒绝）');

  // A 段清理
  await cleanupObject('PROGRAM', PROG, 'PROG/P');

  // ============ B 段：SET_DATA_ELEMENT_PROPERTIES 标签受控修改（i18n.write write_labels） ============
  console.log('--- B 段：SET_DATA_ELEMENT_PROPERTIES（数据元素标签受控修改） ---');
  const okDom = await createObject('DDIC_DOMAIN', DOM, {
    description: 'DDIC text smoke domain',
    properties: {
      typeInformation: { datatype: 'CHAR', length: 10, decimals: 0 },
      outputInformation: { length: 10, conversionExit: '', signExists: false, lowercase: false, ampmFormat: false }
    }
  });
  const okDtel = okDom && await createObject('DATA_ELEMENT', DTEL, {
    description: 'DDIC text smoke element',
    properties: {
      typeName: DOM, dataType: 'CHAR', dataTypeLength: 10, dataTypeDecimals: 0,
      fieldLabels: {
        shortFieldLabel: 'LblOrigS', mediumFieldLabel: 'Label original M',
        longFieldLabel: 'Label original long', headingFieldLabel: 'Label original heading'
      }
    }
  });
  if (!okDtel) {
    // B 段创建失败：尽力清理已建对象后终止（A 段证据已成立，不影响 report.text-elements 晋级判断）
    if (okDom) await cleanupObject('DDIC_DOMAIN', DOM, 'DOMA/DD');
    console.log('SMOKE PARTIAL: B 段创建失败（A 段已完成）');
    if (failed) process.exit(1);
    await client.close();
    return;
  }

  // B1 只读读当前属性：properties 必须全量回填（整体替换语义），metaData 取身份字段
  const cur = await call('getDataElementProperties', { dataElementUrl: `/sap/bc/adt/ddic/dataelements/${DTEL.toLowerCase()}` });
  const curMeta = cur?.result?.metaData || cur?.metaData || {};
  const curProps = cur?.result?.properties || cur?.properties || {};
  if (!curProps.fieldLabels) fail('B1 读当前数据元素属性', cur);

  // B2 preview：仅改四段标签，其余属性原样提交（防类型信息被抹）
  expectKeywords = []; expectDecision = 'cancel';
  const p2raw = await call('previewDdicPropertyChange', {
    operation: {
      kind: 'SET_DATA_ELEMENT_PROPERTIES', objectName: DTEL, transportRequest: TR,
      properties: {
        typeName: curProps.typeName || DOM,
        dataType: curProps.dataType || 'CHAR',
        dataTypeLength: curProps.dataTypeLength ?? 10,
        dataTypeDecimals: curProps.dataTypeDecimals ?? 0,
        fieldLabels: {
          shortFieldLabel: 'LblNewS', mediumFieldLabel: 'Label updated M',
          longFieldLabel: 'Label updated long', headingFieldLabel: 'Label updated heading'
        }
      },
      metaData: {
        name: DTEL, description: 'DDIC text smoke element',
        language: curMeta.language || 'ZH', masterLanguage: curMeta.masterLanguage || 'ZH',
        masterSystem: curMeta.masterSystem || 'S4H',
        responsible: curMeta.responsible ?? '068157', packageName: PKG
      }
    }
  });
  const p2 = p2raw?.result || p2raw;
  if (p2?.status !== 'preview') { fail('B2 标签修改 preview', p2raw); }
  else pass(`B2 标签修改 plan 冻结（changedFields=${(p2.plan?.inputSummary?.changedFields || []).length} 条）`);

  // B3 确认 apply（B2 失败时跳过直接进清理，避免空引用崩溃）
  if (p2?.status === 'preview') {
    expectKeywords = [DTEL]; expectDecision = 'apply';
    const a2raw = await call('applyDdicPropertyChange', { operationPlanId: p2.plan.operationPlanId });
    const a2 = a2raw?.result || a2raw;
    const a2Status = a2?.plan?.status || a2?.status;
    if (a2Status !== 'APPLIED' && a2?.status !== 'success') fail('B3 标签修改 apply', a2raw);
    else pass(`B3 标签修改 apply 成功（plan=${a2Status}）`);

    // B4 独立 readback：四段标签逐项比对
    const rb2 = await call('getDataElementProperties', { dataElementUrl: `/sap/bc/adt/ddic/dataelements/${DTEL.toLowerCase()}` });
    const lb = rb2?.result?.properties?.fieldLabels || rb2?.properties?.fieldLabels || {};
    if (lb.shortFieldLabel === 'LblNewS' && lb.mediumFieldLabel === 'Label updated M'
      && lb.longFieldLabel === 'Label updated long' && lb.headingFieldLabel === 'Label updated heading') {
      pass('B4 独立 readback 标签一致（四段逐字匹配）');
    } else fail('B4 独立 readback 标签不一致', lb);
  }

  // B 段清理（先数据元素后 domain，依赖顺序）
  await cleanupObject('DATA_ELEMENT', DTEL, 'DTEL/DE');
  await cleanupObject('DDIC_DOMAIN', DOM, 'DOMA/DD');

  if (failed) { console.log('SMOKE FAILED: 存在 FAIL 断言'); await client.close(); process.exit(1); }
  console.log('SMOKE OK: SET_TEXT_ELEMENTS + SET_DATA_ELEMENT_PROPERTIES 受控链在真实 DEV 端到端验证通过');
  await client.close();
}

main().catch(async e => {
  console.error('SMOKE FAILED:', e?.message?.slice(0, 300));
  try { await client.close(); } catch { /* ignore */ }
  process.exit(1);
});
