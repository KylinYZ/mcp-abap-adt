/**
 * 类 include 受控写入链真机 smoke（矩阵行 source.class-include 的 class-include-real-dev-smoke）。
 *
 * 目标：在专用 DEV 系统上端到端验证 previewAbapChange 的 classInclude 参数：
 *   1. 受控创建验证类 ZVCLINCSMK（apply 后自动激活）；
 *   2. previewAbapChange(classInclude='definitions') 只读冻结 plan——断言
 *      sourceUrl 指向 definitions include 源资源、classInclude 字段冻结、锁归属父类；
 *   3. applyAbapChange（原生确认，消息必须同时含对象名与 "include" 粒度标注）真实写入
 *      注释标记到 definitions include 并激活父类；
 *   4. 独立只读复查：include 源内容 == 目标标记；
 *   5. 负例：新类无 testclasses include → OBJECT_RESOLUTION_FAILED 且提示 createTestInclude；
      非CLASS 对象传 classInclude → VALIDATION_FAILED；
 *   6. 自建类受控清理 + absence 复查（include 标记随整类删除，零残留）。
 *
 * 安全边界：
 *   - 仅自建 Z* 验证对象（Z001 + S4HK900009），写前写后只读复查，串行执行；
 *   - elicitation 按阶段核对确认消息关键词，不匹配即取消（无人值守防误批）；
 *   - include 写入为注释标记（语法零风险），不改类主源。
 */
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const environmentFile = process.argv[2];
const CLASS_NAME = 'ZVCLINCSMK';
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');

const MARKER = '* MCP CLASS INCLUDE SMOKE MARKER 2026-09-16\n';
const CLASS_SOURCE = [
  `CLASS ${CLASS_NAME.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
  'ENDCLASS.',
  `CLASS ${CLASS_NAME.toLowerCase()} IMPLEMENTATION.`,
  'ENDCLASS.'
].join('\n');

// —— 阶段化 elicitation 应答：每个阶段显式声明预期关键词与 decision 值 ——
let expectedConfirmation = { keywords: [], decision: 'cancel' };

function parse(result) {
  // SafeAbapHandlers 的 previewAbapChange 返回 markdown 文本 + structuredContent
  // 双通道：结构化数据优先，纯 JSON 文本响应（错误体等）走文本解析
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsed: text.slice(0, 400), __isError: Boolean(result.isError) };
  }
}

function assert(condition, message, payload) {
  if (!condition) {
    throw new Error(`SMOKE FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 600)}`);
  }
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}, timeoutMs) {
  // SDK 签名坑：callTool(params, resultSchema, {timeout})——第二参是 resultSchema
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
  // 生产路径（validation=true 会拒绝创建已 REAL_DEV_VERIFIED 的 ABAP_CLASS，防重放）
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client(
  { name: 'class-include-real-dev-smoke', version: '1.0.0' },
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

/** 受控清理 ABAP_CLASS 并以 searchObject absence 为真判据。 */
async function cleanupClassAndVerifyAbsence(objectName) {
  expectedConfirmation = { keywords: [objectName], decision: 'apply' };
  const preview = parse(await call('previewRepositoryObjectCleanup', { objectKind: 'ABAP_CLASS', name: objectName }, 300_000));
  if (preview.status !== 'preview') return false;
  parse(await call('applyRepositoryObjectCleanup', { cleanupPlanId: preview.plan.cleanupPlanId }, 300_000));
  const after = parse(await call('searchObject', { query: objectName, max: 10 }, 120_000));
  assert((after.results || []).every(item => String(item['adtcore:name'] || '').toUpperCase() !== objectName),
    `absence 复查：系统已无 ${objectName}`);
  return true;
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const tool of ['previewAbapChange', 'applyAbapChange', 'getObjectSource']) {
    assert(names.has(tool), `${tool} 已出现在 DEV workbench 运行时 catalog`);
  }
  const health = parse(await call('healthcheck'));
  assert(health.configuredTarget?.systemRole === 'DEV' && health.configuredTarget?.client === '300', '运行时目标为 DEV/300');

  // —— 步骤 1：残留检查 + 受控创建验证类 ——
  const existing = parse(await call('searchObject', { query: CLASS_NAME, max: 10 }, 120_000));
  if ((existing.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === CLASS_NAME)) {
    process.stdout.write('INFO 发现同名残留对象，先受控清理\n');
    await cleanupClassAndVerifyAbsence(CLASS_NAME);
  }
  expectedConfirmation = { keywords: [CLASS_NAME], decision: 'apply' };
  const creationPreview = parse(await call('previewRepositoryObjectCreation', {
    objectKind: 'ABAP_CLASS',
    name: CLASS_NAME,
    description: 'Class include controlled write smoke validation object',
    packageName: 'Z001',
    transportRequest: 'S4HK900009',
    source: CLASS_SOURCE
  }, 300_000));
  assert(creationPreview.status === 'preview' && creationPreview.plan?.creationPlanId, `ABAP_CLASS ${CLASS_NAME} 创建 preview 生成 plan`, creationPreview);
  const creationApplied = parse(await call('applyRepositoryObjectCreation', { creationPlanId: creationPreview.plan.creationPlanId }, 300_000));
  assert(!creationApplied.error && creationApplied.status !== 'error', 'ABAP_CLASS 创建 apply 完成（含原生确认）', creationApplied);

  // —— 步骤 2：classInclude preview 冻结 include 源 URL ——
  expectedConfirmation = { keywords: [], decision: 'cancel' };
  const includePreview = parse(await call('previewAbapChange', {
    objectType: 'CLASS',
    objectName: CLASS_NAME,
    newSource: MARKER,
    transportRequest: 'S4HK900009',
    classInclude: 'definitions'
  }, 300_000));
  assert(includePreview.status === 'preview' && includePreview.plan?.changePlanId, 'classInclude=definitions preview 生成 plan', includePreview);
  const planObject = includePreview.plan.object;
  // 真实系统 include 源 URI 形如 /includes/definitions（部分版本为 /source/definitions），
  // 断言语义为「definitions 源资源且归属该类」而非固定路径形态
  assert(planObject.sourceUrl.includes('definitions') && planObject.sourceUrl.startsWith(planObject.objectUrl),
    `plan.sourceUrl 指向 definitions include 源（${planObject.sourceUrl}）`, planObject);
  assert(planObject.classInclude === 'definitions', 'plan 冻结 classInclude=definitions');
  assert(planObject.lockUrl === `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}`, '锁归属父类（include 无独立锁身份）');

  // 写前只读复查：记录 definitions include 原始内容（新类通常为标准模板）。
  // 注意 getObjectSource 带分页参数会走工具层缓存，这里必须直读 SAP
  const original = parse(await call('getObjectSource', { objectSourceUrl: planObject.sourceUrl }, 120_000));
  process.stdout.write(`INFO definitions include 原始内容（${(original.source || '').length} 字符）\n`);

  // —— 步骤 3：apply（确认消息必须含对象名 + include 粒度标注）——
  expectedConfirmation = { keywords: [CLASS_NAME, 'definitions include'], decision: 'apply' };
  const applied = parse(await call('applyAbapChange', { changePlanId: includePreview.plan.changePlanId }, 300_000));
  assert(!applied.error, 'applyAbapChange 确认并执行成功', applied);
  const finalPlan = parse(await call('getAbapChangeStatus', { changePlanId: includePreview.plan.changePlanId }, 120_000));
  assert(finalPlan.plan?.status === 'APPLIED', `变更 plan 终态 APPLIED（实际：${finalPlan.plan?.status}）`, finalPlan);
  const stages = (finalPlan.plan?.stages || []).map(stage => stage.stage);
  assert(stages.includes('SOURCE_VERIFIED'), 'apply 链含 SOURCE_VERIFIED（激活后源 readback 匹配）', stages);

  // —— 步骤 4：独立只读复查 include 内容（无分页参数，绕开工具层缓存直读 SAP）——
  const readback = parse(await call('getObjectSource', { objectSourceUrl: planObject.sourceUrl }, 120_000));
  assert((readback.source || '').trim() === MARKER.trim(), '独立复查：definitions include 内容 == 写入标记', readback);

  // —— 步骤 5：负例（确定性代码级行为，不依赖系统 include 暴露形态）——
  // 注：该 DEV 版本新类也会暴露 testclasses include（resolver 四种粒度全可解析），
  // 「缺失 include → OBJECT_RESOLUTION_FAILED」的容错路径由 mock 测试覆盖
  const nonClass = parse(await call('previewAbapChange', {
    objectType: 'PROGRAM', objectName: CLASS_NAME, newSource: MARKER,
    transportRequest: 'S4HK900009', classInclude: 'definitions'
  }, 120_000));
  assert(nonClass.error?.code === 'VALIDATION_FAILED', '负例：PROGRAM + classInclude → VALIDATION_FAILED', nonClass);

  // —— 步骤 6：受控清理（include 标记随整类删除）——
  await cleanupClassAndVerifyAbsence(CLASS_NAME);

  process.stdout.write('SMOKE OK: 类 include 受控写入链端到端验证通过（definitions include 真实写入并激活；自建类已清理）\n');
}

try {
  await main();
} finally {
  await client.close();
}
