/**
 * 受控对象激活链真机 smoke（矩阵行 devtools.activate 的 activation-real-dev-smoke）。
 *
 * 目标：在专用 DEV 系统上端到端验证受控激活工作流：
 *   1. 受控创建 PROGRAM ZVACTSMOKE → 复查（顺带证明受控创建链 apply 后自动激活）；
 *   2. previewObjectActivation 只读冻结激活 plan（objectNames 严格限定目标）；
 *   3. applyObjectActivation（原生表单确认 + 单次激活）真实激活一个 inactive 对象；
 *   4. 只读复查激活结果 + 重复 apply 拒绝；
 *   5. 自建对象受控清理 + absence 复查。
 *
 * 激活目标的构造约束（重要）：受控创建/变更链 apply 后强制激活（activateOrThrow
 * 是变更完整性设计），受控 profile 内不存在"新建即 inactive"的自然场景——这正是
 * VSP Activate 工具对应的真实空白。因此激活 apply 的目标必须显式指定为系统中
 * 已有的 inactive 对象：
 *   node object-activation-real-dev-smoke.mjs <sap-dev.env> [激活目标对象名]
 * 目标必须同时通过安全检查：Z* 验证命名空间、确在 inactiveObjects 列表中、
 * 归属当前 SAP 用户（user 字段核对）。不指定目标时只跑只读验证，激活 apply
 * 降级跳过（preview 生成的 plan 由 TTL 自然过期，无副作用）。
 *
 * 安全边界：
 *   - previewObjectActivation 始终带 objectNames 过滤，并断言 plan 只含目标对象，
 *     绝不允许激活系统内任何其他未激活对象；
 *   - 激活目标不是本脚本创建的，因此只激活、不删除；
 *   - elicitation 自动应答按阶段核对确认消息语义，不匹配即取消；
 *   - 串行执行；自建对象 ZVACTSMOKE 结束时受控清理。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const environmentFile = process.argv[2];
// 激活目标（可选）：必须是系统已有的、属于当前 SAP 用户的 Z* 未激活对象
const activationTarget = String(process.argv[3] || '').trim().toUpperCase();
const PROGRAM_NAME = 'ZVACTSMOKE';
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');
if (activationTarget && !/^Z[A-Z0-9_]{1,29}$/.test(activationTarget)) {
  throw new Error('激活目标必须是 Z 命名空间内的有界对象名。');
}

// —— 阶段化 elicitation 应答：每个阶段显式声明预期关键词与 decision 值 ——
// 消息不含预期关键词时一律 cancel，防止无人值守会话批准任何意外确认框。
let expectedConfirmation = { keywords: [], decision: 'cancel' };

function parse(result) {
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    // 保留原始文本供诊断（空响应/非 JSON 响应不再静默变成空对象）
    return { __unparsed: text.slice(0, 400), __isError: Boolean(result.isError) };
  }
}

function assert(condition, message, payload) {
  if (!condition) {
    // 断言失败时携带实际响应体，便于无人值守诊断
    throw new Error(`SMOKE FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 600)}`);
  }
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}, timeoutMs) {
  // SDK 签名坑：callTool(params, resultSchema, {timeout})——第二参是 resultSchema，
  // 长 SAP 操作（如多 include 激活）必须显式放宽超时，避免默认 60s 误杀仍在执行的请求。
  return timeoutMs
    ? client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
    : client.callTool({ name, arguments: args });
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  // REAL_DEV_VALIDATION 必须为 false：验证模式（true）会拒绝创建已 REAL_DEV_VERIFIED
  // 的类型（如 PROGRAM），防止重放已验证结果；本 smoke 走生产真实路径（受控链
  // 28 类可写），仍全程受 immutable plan + 原生确认约束。
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client(
  { name: 'object-activation-real-dev-smoke', version: '1.0.0' },
  // 声明 elicitation 能力：激活与创建/清理的原生确认都走 MCP 表单通道
  { capabilities: { elicitation: {} } }
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

// client 构造完成后注册阶段化确认应答
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  const matched = expectedConfirmation.keywords.every(keyword => message.includes(keyword));
  if (!matched) {
    process.stdout.write(`WARN elicitation 未匹配预期 [${expectedConfirmation.keywords}]，已取消：${message.slice(0, 160)}\n`);
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: expectedConfirmation.decision } };
});

/**
 * 只读拉取未激活对象条目（名称 + 归属用户）。
 * inactiveObjects 返回按传输分组的记录；对象条目在 record.object 下，
 * 其 adtcore:name 为对象名、user 为锁定/修改用户（SAP 用户编号）。
 */
async function inactiveEntries() {
  const result = parse(await call('inactiveObjects'));
  const records = Array.isArray(result) ? result : result.objects || result.results || [];
  return records
    .filter(record => record?.object)
    .map(record => ({
      name: String(record.object['adtcore:name'] || '').toUpperCase(),
      user: String(record.object.user ?? '')
    }))
    .filter(entry => entry.name);
}

/** 受控清理一个 PROGRAM 并以 absence 复查为真判据（apply 响应体可能为空，不作为唯一依据）。 */
async function cleanupProgramAndVerifyAbsence(objectName) {
  expectedConfirmation = { keywords: [objectName], decision: 'apply' };
  const cleanupPreview = parse(await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name: objectName }));
  if (cleanupPreview.status !== 'preview') {
    // 对象已不存在（如已被前次清理）：无需再清
    return false;
  }
  assert(Boolean(cleanupPreview.plan?.cleanupPlanId), '清理 preview 生成 plan', cleanupPreview);
  parse(await call('applyRepositoryObjectCleanup', { cleanupPlanId: cleanupPreview.plan.cleanupPlanId }));
  const searchAfter = parse(await call('searchObject', { query: objectName, objType: 'PROG/P', max: 5 }));
  assert((searchAfter.results || []).length === 0, `absence 复查：系统已无 ${objectName}（清理彻底）`);
  return true;
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const tool of ['previewObjectActivation', 'applyObjectActivation', 'getObjectActivationStatus']) {
    assert(names.has(tool), `${tool} 已出现在 DEV workbench 运行时 catalog`);
  }
  const health = parse(await call('healthcheck'));
  assert(health.configuredTarget?.systemRole === 'DEV' && health.configuredTarget?.client === '300', '运行时目标为 DEV/300');
  // healthcheck 的 configuredTarget 不含 sapUser；从 env 文件解析当前 SAP 用户用于归属比对
  const envText = readFileSync(resolve(environmentFile), 'utf8');
  const sapUser = (envText.match(/^SAP_USER=(.*)$/m) || [])[1]?.trim() || '';

  // —— 步骤 1：受控创建验证 PROGRAM（若上次中断有残留先清理）——
  const searchExisting = parse(await call('searchObject', { query: PROGRAM_NAME, objType: 'PROG/P', max: 5 }));
  if ((searchExisting.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === PROGRAM_NAME)) {
    process.stdout.write('INFO 发现同名残留对象，先受控清理\n');
    // 此处 programName 尚未声明（let 存在暂时性死区），必须用常量 PROGRAM_NAME
    await cleanupProgramAndVerifyAbsence(PROGRAM_NAME);
  }

  // 受控创建验证 PROGRAM；SAP 端残留锁（如上次中断留下的 ENQ）会导致
  // REMOTE_WRITE_FAILED“当前编辑”，此时自动换名重试，避免与锁纠缠。
  let programName = PROGRAM_NAME;
  let creationApplied;
  for (const candidate of [PROGRAM_NAME, `${PROGRAM_NAME}2`, `${PROGRAM_NAME}3`, `${PROGRAM_NAME}4`]) {
    programName = candidate;
    // 候选名若因前次中断已存在，先受控清理（锁残留则由换名逻辑兜底）
    const candidateSearch = parse(await call('searchObject', { query: candidate, objType: 'PROG/P', max: 5 }));
    if ((candidateSearch.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === candidate)) {
      process.stdout.write(`INFO 候选名 ${candidate} 已存在，先受控清理
`);
      await cleanupProgramAndVerifyAbsence(candidate);
    }
    expectedConfirmation = { keywords: [candidate], decision: 'apply' };
    const creationPreview = parse(await call('previewRepositoryObjectCreation', {
      objectKind: 'PROGRAM',
      name: candidate,
      description: 'Controlled activation smoke validation object',
      packageName: 'Z001',
      transportRequest: 'S4HK900009',
      source: `REPORT ${candidate.toLowerCase()}.\nWRITE / 'activation smoke'.`
    }));
    assert(creationPreview.status === 'preview' && creationPreview.plan?.creationPlanId, `PROGRAM ${candidate} 创建 preview 生成 plan`, creationPreview);
    creationApplied = parse(await call('applyRepositoryObjectCreation', { creationPlanId: creationPreview.plan.creationPlanId }));
    const lockConflict = creationApplied.error?.code === 'REMOTE_WRITE_FAILED' && /当前编辑/.test(creationApplied.error?.message || '');
    if (lockConflict) {
      process.stdout.write(`INFO ${candidate} 存在 SAP 端残留锁，换名重试\n`);
      continue;
    }
    break;
  }
  assert(!creationApplied.error && creationApplied.status !== 'error', 'PROGRAM 创建 apply 完成（含原生确认）', creationApplied);

  // —— 步骤 2：复查创建链语义——apply 后对象应为激活态（activateOrThrow 设计）——
  const inactiveAfterCreate = await inactiveEntries();
  assert(!inactiveAfterCreate.some(entry => entry.name === programName),
    '受控创建链 apply 后对象已激活（不在 inactiveObjects 列表，与 ACTIVE_VERIFIED 设计一致）');

  // —— 步骤 3：受控激活 preview + apply（目标可选，安全检查先行）——
  let activationVerified = false;
  if (activationTarget) {
    const entries = await inactiveEntries();
    const targetEntry = entries.find(entry => entry.name === activationTarget);
    assert(Boolean(targetEntry), `目标对象 ${activationTarget} 确在 inactiveObjects 列表中`, { inactive: entries.map(e => e.name) });
    assert(targetEntry.user === sapUser || targetEntry.user === String(Number(sapUser) || sapUser),
      `目标对象归属当前 SAP 用户（${targetEntry.user} vs ${sapUser}），非他人对象`);

    expectedConfirmation = { keywords: [], decision: 'cancel' };
    const activationPreview = parse(await call('previewObjectActivation', { objectNames: [activationTarget] }));
    assert(activationPreview.status === 'preview' && activationPreview.plan?.activationPlanId, 'previewObjectActivation 生成激活 plan', activationPreview);
    const planObjects = (activationPreview.plan?.objects || []).map(item => String(item.objectName || '').toUpperCase());
    // 类对象会有多个未激活 include 条目（DEFINITIONS/IMPLEMENTATIONS/MACROS 等），
    // 因此断言语义是“所有条目都属目标对象”，而非“只有一条”。
    assert(planObjects.length >= 1 && planObjects.every(name => name === activationTarget), `激活 plan 的 ${planObjects.length} 个条目全部属于目标 ${activationTarget}（无其他对象混入）`, planObjects);
    assert(Boolean(activationPreview.plan?.payloadHash) && activationPreview.plan?.status === 'PREVIEWED', 'plan 冻结 payloadHash 且状态 PREVIEWED');

        // 确认消息形如 "Activate N inactive object(s) · host/client · profile · Activation is
    // a repository write. ..."——不含对象名，因此核对激活语义语句即可；
    // 条目数与对象归属已由上方 plan 断言保证。
    expectedConfirmation = { keywords: ['Activation is a repository write'], decision: 'activate' };
    // 激活目标可能含多个 include 条目，DEV 慢时段下执行可超 60s，放宽到 5 分钟
    const activationApplied = parse(await call('applyObjectActivation', { activationPlanId: activationPreview.plan.activationPlanId }, 300_000));
    assert(!activationApplied.error, 'applyObjectActivation 确认并执行成功', activationApplied);
    const appliedStatus = activationApplied.plan || activationApplied;
    assert(appliedStatus.status === 'SUCCEEDED', `激活 plan 终态 SUCCEEDED（实际：${appliedStatus.status}）`, activationApplied);

    const consumed = parse(await call('applyObjectActivation', { activationPlanId: activationPreview.plan.activationPlanId }));
    assert(consumed.error?.code === 'PLAN_ALREADY_CONSUMED' || consumed.error?.code === 'PLAN_EXPIRED', '重复 apply 被拒绝（单次执行语义）');

    const entriesAfter = await inactiveEntries();
    assert(!entriesAfter.some(entry => entry.name === activationTarget), `激活后 ${activationTarget} 已离开未激活列表（真实系统状态改变）`);
    activationVerified = true;
  } else {
    // 未指定目标：只读 preview 仍要验证（生成 plan 后不 apply，由 TTL 过期，无副作用）
    const probeEntries = await inactiveEntries();
    const probeTarget = probeEntries[0]?.name;
    assert(Boolean(probeTarget), '系统存在可探测的未激活对象（只读）', probeEntries);
    const readOnlyPreview = parse(await call('previewObjectActivation', { objectNames: [probeTarget] }));
    assert(readOnlyPreview.status === 'preview' && readOnlyPreview.plan?.status === 'PREVIEWED', 'previewObjectActivation 只读冻结 plan 成功');
    process.stdout.write(`INFO 未提供激活目标：激活 apply 部分降级跳过（plan ${readOnlyPreview.plan.activationPlanId} 将由 TTL 过期）\n`);
  }

  // —— 步骤 4：自建对象受控清理 + absence 复查 ——
  await cleanupProgramAndVerifyAbsence(programName);

  if (activationVerified) {
    process.stdout.write(`SMOKE OK: 受控激活链端到端验证通过（目标 ${activationTarget} 已真实激活；自建对象已清理）\n`);
  } else {
    process.stdout.write('SMOKE OK(部分): 创建/清理/只读 preview 链路验证通过；激活 apply 未执行（未提供目标）——需显式传入 Z* inactive 对象名重跑\n');
  }
}

try {
  await main();
} finally {
  await client.close();
}
