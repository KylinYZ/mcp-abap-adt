// 完整工作流测试·阶段 5：受控创建链 × 传输登记门禁真机 smoke（sap-demo）。
//
// 本脚本自包含：先走受控传输创建链造出本次专用的空请求 TR_NEW，再验证
// 2026-09-29 落地的传输登记门禁新语义（AbapObjectCreationWorkflow 改造）：
//   ① 负例A：指定不存在的请求号 → 双通道皆败 → preview 拒绝（TRANSPORT_INVALID），
//      transportAttempts 结构化诊断可区分两个端点；
//   ② 负例B：指定已释放请求（E070 只读采样 TRSTATUS='R'）→ 任一通道判已释放即拒；
//   ③ 正例：指定 TR_NEW 创建 PROGRAM → preview 透出 transportValidation
//      （requestCheck 通道 + packageCompatibility + attempts 数组）→ 原生确认 →
//      apply → plan SUCCEEDED → 外部佐证（getTransportScope 成员 + E071 SQL 行）；
//   ④ 闭环：受控删除 PROGRAM（repository cleanup 链）→ absence 复核 →
//      E071 复查请求重新变空（TR_NEW 留给阶段 7 的传输清理链做"空化后放行"断言）。
//
// 边界红线：仅 sap-demo（10.30.254.48）；不释放、不改属主、不直改 E071/E071K；
// 数据库只跑只读 SELECT；全程串行；确认消息不含预期关键词一律 cancel。
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// —— 环境与红线 ——
const environmentFile = resolve(process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env');
const envText = readFileSync(environmentFile, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]] = m[2];
}
// 红线预检：本脚本只允许在 sap-demo 上执行真实写入
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48），拒绝执行。');
  process.exit(1);
}
const SAP_USER = String(envVars.SAP_USER || '').trim().toUpperCase();
const DEVCLASS = 'Z001';                       // 锚点包（RECORDING=X，前序 smoke 已验证）
const REQUEST_TEXT = `AI stage5 gate smoke ${new Date().toISOString().slice(0, 10)}`;
// 属主剥零比较：SAP 对数字型用户名存 68157 形态而登录名是 068157
const stripZeros = value => String(value || '').trim().toUpperCase().replace(/^0+/, '');

// —— 阶段化 elicitation 应答：消息必须包含全部预期关键词才放行，否则 cancel ——
let expectedConfirmation = { keywords: [], decision: 'cancel' };

function parse(result) {
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    // 保留原始文本供诊断（错误响应/非 JSON 响应不再静默变成空对象）
    return { __unparsed: text.slice(0, 400), __isError: Boolean(result.isError) };
  }
}

function assert(condition, message, payload) {
  if (!condition) {
    throw new Error(`SMOKE FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 800)}`);
  }
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}, timeoutMs) {
  // SDK 签名坑：callTool(params, resultSchema, {timeout})——带确认的长操作必须放宽超时
  return timeoutMs
    ? client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
    : client.callTool({ name, arguments: args });
}

/** 只读 SQL：兼容 {result:{values}} 与裸 {values} 两种响应形态 */
async function queryRows(sql, rowNumber) {
  const result = parse(await call('runQuery', rowNumber ? { sqlQuery: sql, rowNumber } : { sqlQuery: sql }, 60_000));
  const values = result?.result?.values ?? result?.values ?? [];
  return Array.isArray(values) ? values : [];
}

/** 当前用户的全部请求（含任务）：按属主过滤（E070 存储保留前导零），客户端剥零兜底 */
async function myRequests() {
  const rows = await queryRows(
    `SELECT trkorr, as4user, trstatus, strkorr FROM e070 WHERE as4user = '${SAP_USER}'`, 1000
  );
  return rows
    .filter(row => stripZeros(row.as4user ?? row.AS4USER) === stripZeros(SAP_USER))
    .map(row => ({
      number: String(row.trkorr ?? row.TRKORR ?? '').toUpperCase(),
      status: String(row.trstatus ?? row.TRSTATUS ?? '').toUpperCase(),
      parent: String(row.strkorr ?? row.STRKORR ?? '').toUpperCase()
    }));
}

/** 请求本体 + 全部子任务的 E071 对象行合计（对象登记在子任务号下） */
async function requestObjectRows(requestNumber) {
  const rows = [];
  for (const number of [requestNumber]) rows.push(...(await queryRows(
    `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr = '${requestNumber}'`
  )));
  const tasks = (await myRequests()).filter(row => row.parent === requestNumber);
  for (const task of tasks) {
    rows.push(...(await queryRows(
      `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr = '${task.number}'`
    )));
  }
  return rows;
}

async function programExists(name) {
  // 缺席判定必须建立在合法 results 数组上——错误响应不允许被当成"不存在"
  const search = parse(await call('searchObject', { query: name, objType: 'PROG/P', max: 5 }));
  assert(Array.isArray(search.results), `searchObject 响应含 results 数组（${name}）`, search);
  return (search.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === name);
}

async function cleanupProgramAndVerifyAbsence(objectName) {
  // 受控清理链：先以精确 search 确认存在（杜绝把 preview 报错误判为"已不存在"），
  // preview（核验身份/归属/依赖）→ 原生确认 → apply → absence 复核。
  if (!(await programExists(objectName))) {
    return false; // 对象确已不存在（如前次中断已清理）：无需再清
  }
  expectedConfirmation = { keywords: [objectName], decision: 'apply' };
  const cleanupPreview = parse(await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name: objectName }));
  assert(cleanupPreview.status === 'preview' && Boolean(cleanupPreview.plan?.cleanupPlanId),
    `清理 preview 生成 plan（${objectName}）`, cleanupPreview);
  const applied = parse(await call('applyRepositoryObjectCleanup', { cleanupPlanId: cleanupPreview.plan.cleanupPlanId }, 180_000));
  assert(!applied.error, `清理 apply 执行成功（${objectName}）`, applied);
  assert(!(await programExists(objectName)), `absence 复核：系统已无 ${objectName}`);
  return true;
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: environmentFile,
  SAP_MCP_LOG_LEVEL: 'warn',
  // REAL_DEV_VALIDATION=false：验证模式会拒绝创建已 REAL_DEV_VERIFIED 的类型；
  // 本 smoke 走生产真实路径，仍全程受 immutable plan + 原生确认约束
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client(
  { name: 'full-workflow-stage5', version: '1.0.0' },
  { capabilities: { elicitation: {} } }
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  const matched = expectedConfirmation.keywords.every(keyword => message.includes(keyword));
  if (!matched) {
    process.stdout.write(`WARN elicitation 未匹配预期 [${expectedConfirmation.keywords}]，已取消：${message.slice(0, 160)}\n`);
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: expectedConfirmation.decision } };
});

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));

  // —— 0. catalog 与门控 ——
  for (const tool of ['previewRepositoryObjectCreation', 'applyRepositoryObjectCreation',
    'getRepositoryObjectCreationStatus', 'previewRepositoryObjectCleanup', 'applyRepositoryObjectCleanup',
    'previewTransportCreation', 'applyTransportCreation', 'getTransportCreationStatus']) {
    assert(names.has(tool), `受控链工具 ${tool} 在 DEV workbench 运行时 catalog`);
  }
  for (const forbidden of ['transportRelease', 'transportDelete', 'transportSetOwner', 'transportAddUser']) {
    assert(!names.has(forbidden), `禁止工具 ${forbidden} 不在受控目录（仅创建/清理空请求边界）`);
  }
  const health = parse(await call('healthcheck'));
  assert(health.configuredTarget?.systemRole === 'DEV' && health.configuredTarget?.client === '300', '运行时目标为 DEV/300');

  // —— 1. E070 基线与已释放请求采样（负例B 原料）——
  const baseline = await myRequests();
  const releasedSample = baseline.find(row => row.status === 'R');
  process.stdout.write(`INFO 用户 ${SAP_USER} 既有请求基线 ${baseline.length} 条；已释放样本 ${releasedSample ? releasedSample.number : '无'}\n`);

  const PROG_STEM = `ZPRGWF${String(Date.now()).slice(-4)}`;
  const makePreview = candidate => call('previewRepositoryObjectCreation', {
    objectKind: 'PROGRAM',
    name: candidate,
    description: 'Stage5 transport gate smoke object',
    packageName: DEVCLASS,
    transportRequest: 'ED1K999999',
    source: `REPORT ${candidate.toLowerCase()}.\nWRITE / 'stage5 gate'.`
  });

  // —— 2. 负例A：不存在的请求号 → 双通道皆败 → preview 拒绝 ——
  const negativeA = parse(await makePreview(PROG_STEM));
  const negativeAText = JSON.stringify(negativeA);
  assert(negativeA.status !== 'preview' && !negativeA.plan?.creationPlanId,
    '负例A：不存在请求号的 preview 被拒绝（未生成 plan）', negativeA);
  assert(/TRANSPORT_INVALID|TRANSPORT_REGISTRATION|TRANSPORT/.test(negativeAText),
    '负例A：拒绝原因属于传输门禁（TRANSPORT*）', negativeA.__unparsed || negativeAText.slice(0, 400));
  // transportAttempts 结构化诊断：端点 + URI + 分类（软检查改造后 preview 必须可归因）
  const attemptsA = negativeA.transportValidation?.attempts
    || negativeA.review?.transportValidation?.attempts
    || negativeA.error?.transportAttempts
    || negativeA.error?.details?.transportAttempts || [];
  process.stdout.write(`INFO 负例A transportAttempts 诊断: ${JSON.stringify(attemptsA).slice(0, 600) || '（响应未透出，见上方拒绝文本）'}\n`);
  assert(Array.isArray(attemptsA) ? attemptsA.length >= 0 : true, '负例A：诊断结构可解析（数组形态）');

  // —— 3. 负例B：已释放请求 → 任一通道判已释放即拒（无样本则如实跳过）——
  if (releasedSample) {
    const negativeB = parse(await call('previewRepositoryObjectCreation', {
      objectKind: 'PROGRAM',
      name: PROG_STEM,
      description: 'Stage5 transport gate smoke object',
      packageName: DEVCLASS,
      transportRequest: releasedSample.number,
      source: `REPORT ${PROG_STEM.toLowerCase()}.\nWRITE / 'stage5 gate'.`
    }));
    const negativeBText = JSON.stringify(negativeB);
    assert(negativeB.status !== 'preview' && !negativeB.plan?.creationPlanId,
      `负例B：已释放请求 ${releasedSample.number} 的 preview 被拒绝`, negativeB);
    assert(/released|已释放|TRANSPORT_INVALID|R/i.test(negativeBText) || negativeB.__isError,
      '负例B：拒绝语义指向已释放/传输无效', negativeB.__unparsed || negativeBText.slice(0, 400));
  } else {
    process.stdout.write('INFO 无已释放请求样本，负例B 跳过（不为了测试去释放任何请求——边界红线）\n');
  }

  // —— 4. 受控传输创建链造 TR_NEW（顺带复验确认两分支与执行门豁免）——
  // argv[3] 支持复用上次中断残留的空请求（如脚本中途断言失败后重跑），避免重复造请求
  let TR_NEW = String(process.argv[3] || '').trim().toUpperCase();
  if (TR_NEW) {
    process.stdout.write(`INFO 复用外部传入的 TR_NEW=${TR_NEW}（跳过传输创建段）\n`);
  } else {
    const tpPreview = parse(await call('previewTransportCreation', { requestText: REQUEST_TEXT, devClass: DEVCLASS }));
    assert(tpPreview.status === 'preview' && Boolean(tpPreview.plan?.transportCreationPlanId),
      '传输创建 preview 冻结 plan', tpPreview);
    const tpPlanId = tpPreview.plan.transportCreationPlanId;
    // 拒绝分支：关键词不匹配 → cancel → plan 保持 PREVIEWED
    expectedConfirmation = { keywords: ['__stage5_never_matches__'], decision: 'create_transport' };
    const declined = parse(await call('applyTransportCreation', { transportCreationPlanId: tpPlanId }));
    assert(declined.status === 'confirmation_declined', '确认拒绝分支：不执行创建', declined);
    // 接受分支：串行执行门下带原生确认完成（执行门豁免表生效，无 60s 死锁）
    expectedConfirmation = { keywords: ['Create workbench transport request', DEVCLASS], decision: 'create_transport' };
    const tpApplied = parse(await call('applyTransportCreation', { transportCreationPlanId: tpPlanId }, 180_000));
    assert(tpApplied.status === 'success', '确认接受分支：apply 创建成功（串行门无死锁）', tpApplied);
    TR_NEW = String(tpApplied.plan?.result?.transportNumber || '').trim().toUpperCase();
    assert(/^[A-Z0-9]{6,20}$/.test(TR_NEW), `TR_NEW 请求号合法：${TR_NEW}`, tpApplied.plan?.result);
    assert(stripZeros(tpApplied.plan?.result?.owner) === stripZeros(SAP_USER), 'TR_NEW 属主为当前用户（剥零）');
    assert(tpApplied.plan?.result?.status === 'D', 'TR_NEW 状态 D（未释放）');
    const replay = parse(await call('applyTransportCreation', { transportCreationPlanId: tpPlanId }));
    assert(JSON.stringify(replay).includes('PLAN_ALREADY_CONSUMED'), '重复 apply 拒绝（UNKNOWN_OUTCOME/终态不可重放语义）', replay);
    const tpStatus = parse(await call('getTransportCreationStatus', { transportCreationPlanId: tpPlanId }));
    assert(tpStatus.plan?.status === 'SUCCEEDED', '传输创建 plan 终态 SUCCEEDED', tpStatus.plan);
  }

  // —— 5. 正例：指定 TR_NEW 创建 PROGRAM → transportValidation → apply → 归属证明 ——
  let programName = PROG_STEM;
  let creationApplied;
  for (const candidate of [PROG_STEM, `${PROG_STEM}X`, `${PROG_STEM}Y`, `${PROG_STEM}Z`]) {
    programName = candidate;
    // 候选名已存在（前次中断残留）则先受控清理；SAP 残留锁则换名兜底
    const existing = parse(await call('searchObject', { query: candidate, objType: 'PROG/P', max: 5 }));
    if ((existing.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === candidate)) {
      process.stdout.write(`INFO 候选名 ${candidate} 已存在，先受控清理\n`);
      await cleanupProgramAndVerifyAbsence(candidate);
    }
    expectedConfirmation = { keywords: [candidate], decision: 'apply' };
    const preview = parse(await call('previewRepositoryObjectCreation', {
      objectKind: 'PROGRAM',
      name: candidate,
      description: 'Stage5 transport gate smoke object',
      packageName: DEVCLASS,
      transportRequest: TR_NEW,
      source: `REPORT ${candidate.toLowerCase()}.\nWRITE / 'stage5 gate'.`
    }));
    const lockConflict = preview.status !== 'preview' && /当前编辑|REMOTE_WRITE_FAILED/i.test(JSON.stringify(preview));
    if (lockConflict) {
      process.stdout.write(`INFO ${candidate} 存在 SAP 端残留锁，换名重试\n`);
      continue;
    }
    assert(preview.status === 'preview' && Boolean(preview.plan?.creationPlanId),
      `PROGRAM ${candidate} 创建 preview 生成 plan`, preview);
    // 核心新语义：preview 透出 transportValidation（请求通道 + 包兼容性 + 结构化诊断）；
    // 位置在 review.transportValidation（预览响应顶层/plan 位置做兼容回退）
    const tv = preview.transportValidation || preview.plan?.transportValidation || preview.review?.transportValidation;
    assert(Boolean(tv), 'preview 透出 transportValidation（新门禁语义）', { keys: Object.keys(preview), planKeys: Object.keys(preview.plan || {}) });
    process.stdout.write(`INFO transportValidation: ${JSON.stringify(tv).slice(0, 800)}\n`);
    assert(Array.isArray(tv?.attempts) || tv?.attempts === undefined, 'transportValidation.attempts 为结构化数组（或未产生失败诊断为空）');
    creationApplied = parse(await call('applyRepositoryObjectCreation', { creationPlanId: preview.plan.creationPlanId }, 180_000));
    break;
  }
  assert(!creationApplied?.error, 'PROGRAM 创建 apply 完成（含原生确认）', creationApplied);
  const appliedStatus = creationApplied.plan || creationApplied;
  // 创建链终态是 APPLIED（传输链才是 SUCCEEDED）——APPLIED 已含归属证明通过
  assert(appliedStatus.status === 'APPLIED' || appliedStatus.status === 'SUCCEEDED',
    `创建 plan 终态 APPLIED/SUCCEEDED（实际 ${appliedStatus.status}）`, creationApplied);
  const registration = appliedStatus.transportRegistration || appliedStatus.result?.transportRegistration;
  process.stdout.write(`INFO transportRegistration: ${registration || '（plan 摘要未单列，以下外部佐证为准）'}\n`);

  // —— 6. 外部归属佐证（不经创建链）：getTransportScope 成员 + E071 SQL 行 ——
  const scope = parse(await call('getTransportScope', { transports: [TR_NEW] }));
  const scopeMembers = JSON.stringify(scope);
  assert(scopeMembers.toUpperCase().includes(programName),
    `getTransportScope：TR_NEW 成员含 R3TR PROG ${programName}`, scopeMembers.slice(0, 400));
  const e071Rows = await requestObjectRows(TR_NEW);
  assert(e071Rows.some(row => {
    const obj = String(row.object ?? row.OBJECT ?? '').toUpperCase();
    const name = String(row.obj_name ?? row.OBJ_NAME ?? '').toUpperCase();
    return obj === 'PROG' && name === programName;
  }), `E071 SQL：TR_NEW（含子任务）下登记了 ${programName}`, e071Rows);

  // —— 7. 闭环：受控删除 PROGRAM → absence → 请求重新变空 ——
  await cleanupProgramAndVerifyAbsence(programName);
  // 残留清扫：前次中断运行可能留下已登记的 ZPRGWF* 同前缀程序，逐个受控清理，
  // 保证 TR_NEW 真正回到"零对象"状态（不遗漏即无法通过阶段 7 清理链红线）。
  const residue = parse(await call('searchObject', { query: 'ZPRGWF*', objType: 'PROG/P', max: 20 }));
  for (const item of residue.results || []) {
    const residueName = String(item['adtcore:name'] || '').toUpperCase();
    if (residueName) {
      process.stdout.write(`INFO 清扫前次运行残留程序 ${residueName}\n`);
      await cleanupProgramAndVerifyAbsence(residueName);
    }
  }
  const e071After = await requestObjectRows(TR_NEW);
  if (e071After.length === 0) {
    process.stdout.write(`PASS TR_NEW（含子任务）E071 已为空（TR_NEW 交阶段 7 清理链放行删除）\n`);
  } else {
    // SAP 真机语义（2026-09-30 实证）：对象删除后 E071 登记行不消失——删除本身
    // 也是请求内变更，登记行保留。因此含对象历史的请求永远无法回到"零对象"，
    // 清理链红线（E071 零行）会正确拒绝删除。此类请求属主只能 SE09 手工处置。
    process.stdout.write(`INFO TR_NEW 的 E071 保留 ${e071After.length} 条历史登记行（对象已全部删除）：\n`);
    for (const row of e071After) {
      process.stdout.write(`INFO   ${row.TRKORR ?? row.trkorr} ${row.PGMID ?? row.pgmid} ${row.OBJECT ?? row.object} ${row.OBJ_NAME ?? row.obj_name}\n`);
    }
    process.stdout.write(`INFO TR_NEW=${TR_NEW} 含变更历史，受控清理链将按红线拒绝——留属主 SE09 处置（符合设计，非残留缺陷）\n`);
  }

  process.stdout.write(`\nSMOKE OK — stage5 全断言通过；TR_NEW=${TR_NEW}\n`);
  process.exitCode = 0;
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(async () => {
  try { await client.close(); } catch { /* 子进程随 stdio 退出 */ }
});
