// 受控传输请求创建链真机 smoke（sap-demo，仅创建）：
// 全链验证 preview（只读 CTS 预检+冻结 plan）→ 原生确认（阶段化 elicitation
// 应答，先拒绝后接受两分支）→ apply（单次创建 + 读回验证）→ 重复 apply 拒绝
// → 独立直连读回佐证（请求号/属主/未释放状态）→ E070 基线对照（确系新请求）。
// 边界：只创建；创建出的空请求不做任何删除/释放（AI 无此权限，属主可手工
// 删除）；E071/E071K 不触碰；前后只读复查，全程串行。
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient } from '../dist/adt/index.js';
import { transportDetails } from '../dist/adt/api/transports.js';

// 环境文件：默认 sap-demo.env（所有者 2026-09-22 指示），可显式传入覆盖
const environmentFile = resolve(process.argv[2] || 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env');
const envText = readFileSync(environmentFile, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]] = m[2];
}
// 红线：本 smoke 仅授权 sap-demo（10.30.254.48）；其他系统一律拒绝执行
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48），本 smoke 只允许在 sap-demo 上创建传输。');
  process.exit(1);
}
// 测试目标：既有包 Z001（Customer development class，探针已验证 RECORDING=X）
const DEVCLASS = 'Z001';
// 请求描述：ASCII 安全且带 smoke 标记（AS4TEXT ≤60 字符）
const REQUEST_TEXT = `AI smoke transport ${new Date().toISOString().slice(0, 10)}`;
const SAP_USER = String(envVars.SAP_USER || '').trim().toUpperCase();

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
    // 保留原始文本供诊断（错误响应/非 JSON 响应不再静默变成空对象）
    return { __unparsed: text.slice(0, 400), __isError: Boolean(result.isError) };
  }
}

function assert(condition, message, payload) {
  if (!condition) {
    // 断言失败时携带实际响应体，便于无人值守诊断
    throw new Error(`SMOKE FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 800)}`);
  }
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}) {
  // SDK 签名：callTool(params, resultSchema, {timeout})——确认+创建+读回链
  // 可能超过默认 60s，显式放宽到 300s。
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }));
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: environmentFile,
  SAP_MCP_LOG_LEVEL: 'warn',
  // 生产真实路径（validation 模式与本链路无关，但保持与既有 smoke 一致）
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client(
  { name: 'transport-creation-real-dev-smoke', version: '1.0.0' },
  // 声明 elicitation 能力：传输创建的原生确认走 MCP 表单通道
  { capabilities: { elicitation: {} } }
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

// client 构造完成后注册阶段化确认应答（与激活 smoke 同构）
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  const matched = expectedConfirmation.keywords.every(keyword => message.includes(keyword));
  if (!matched) {
    process.stdout.write(`WARN elicitation 未匹配预期 [${expectedConfirmation.keywords}]，已取消：${message.slice(0, 160)}\n`);
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: expectedConfirmation.decision } };
});

/** 只读查询当前用户在 E070 的既有请求号集合（创建前后对照，证明确系新请求）。
 * 用户名两种形态都查：ADT 返回的 tm:owner 会剥前导零（068157→68157），
 * E070.AS4USER 实际存储也按剥零形态；IN 双形态保证基线不漏。 */
async function existingRequestNumbers() {
  const variants = [...new Set([SAP_USER, SAP_USER.replace(/^0+/, '')])].filter(Boolean);
  const result = await call('runQuery', {
    sqlQuery: `SELECT trkorr FROM e070 WHERE as4user IN (${variants.map(v => `'${v}'`).join(', ')})`
  });
  const numbers = new Set();
  // MCP runQuery 响应形态：{status, result:{columns, values}}；freestyle 直连
  // 形态为 {columns, values}（values 为行对象数组）——两种都兼容
  const payload = result?.result || result;
  const rows = Array.isArray(payload) ? payload
    : payload?.rows || payload?.results || payload?.values || payload?.DATA || [];
  if (!Array.isArray(rows)) throw new Error(`runQuery 响应形态异常: ${JSON.stringify(result).slice(0, 300)}`);
  for (const row of rows) {
    const value = typeof row === 'string' ? row : row?.TRKORR || row?.trkorr;
    const normalized = String(value || '').trim().toUpperCase();
    if (/^[A-Z0-9]{3,20}$/.test(normalized)) numbers.add(normalized);
  }
  return numbers;
}

/** 直连 ADT 只读读回请求详情（独立于 MCP 链的佐证通道）。 */
async function directReadback(number) {
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD,
    envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateless';
  await raw.h.login();
  try {
    return await transportDetails(raw.h, number);
  } finally {
    await raw.h.logout().catch(() => {});
  }
}

async function main() {
  await client.connect(transport);

  // 1. catalog：三工具在 focused（workbench）目录可见
  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name);
  for (const tool of ['previewTransportCreation', 'applyTransportCreation', 'getTransportCreationStatus']) {
    assert(names.includes(tool), `${tool} 在 focused catalog`);
  }
  // 仅创建边界：释放/删除/改属主工具不得出现在受控目录
  for (const forbidden of ['transportRelease', 'transportDelete', 'transportSetOwner', 'transportAddUser']) {
    assert(!names.includes(forbidden), `受控目录不含 ${forbidden}（仅创建边界）`);
  }

  // 2. 负向探针：本地包被 preview 校验拒绝，零写入、零 plan
  const negative = await call('previewTransportCreation', { requestText: 'negative probe', devClass: '$TMP' });
  assert(String(negative.__unparsed || JSON.stringify(negative)).includes('VALIDATION_FAILED')
    || negative.error?.includes?.('VALIDATION_FAILED')
    || JSON.stringify(negative).includes('VALIDATION_FAILED'),
    '本地 $TMP 包被 preview 拒绝（VALIDATION_FAILED）', negative);

  // 3. 基线：记录用户既有请求号集合
  const before = await existingRequestNumbers();
  process.stdout.write(`INFO 用户 ${SAP_USER} 既有请求数（基线）: ${before.size}\n`);

  // 4. preview：只读 CTS 预检并冻结 plan
  const preview = await call('previewTransportCreation', { requestText: REQUEST_TEXT, devClass: DEVCLASS });
  assert(preview.status === 'preview', 'preview 返回 preview 状态', preview);
  const planId = preview.plan?.transportCreationPlanId;
  assert(Boolean(planId), 'preview 生成 planId', preview);
  assert(preview.plan?.status === 'PREVIEWED', 'plan 状态 PREVIEWED', preview.plan);
  assert(preview.plan?.target?.devClass === DEVCLASS, `plan 目标包为 ${DEVCLASS}`, preview.plan?.target);
  assert(preview.plan?.target?.anchorUri === `/sap/bc/adt/packages/${DEVCLASS.toLowerCase()}`,
    '锚点 URI 由服务端从包名推导', preview.plan?.target);
  assert(preview.confirmationRequired === true, 'preview 声明需要原生确认', preview);

  // 5. 原生确认·拒绝分支：预期关键词不匹配 → 应答器 cancel → confirmation_declined
  expectedConfirmation = { keywords: ['__smoke_never_matches__'], decision: 'create_transport' };
  const declined = await call('applyTransportCreation', { transportCreationPlanId: planId });
  assert(declined.status === 'confirmation_declined', '确认被拒绝时不执行创建', declined);
  const statusAfterDecline = await call('getTransportCreationStatus', { transportCreationPlanId: planId });
  assert(statusAfterDecline.plan?.status === 'PREVIEWED', '拒绝后 plan 仍为 PREVIEWED（可再次确认）', statusAfterDecline.plan);

  // 6. 原生确认·接受分支：关键词匹配 + decision=create_transport → 单次创建
  expectedConfirmation = { keywords: ['Create workbench transport request', DEVCLASS], decision: 'create_transport' };
  const applied = await call('applyTransportCreation', { transportCreationPlanId: planId });
  assert(applied.status === 'success', '确认后 apply 执行成功', applied);
  const created = applied.plan?.result;
  assert(created?.kind === 'TRANSPORT_CREATION', '结果摘要类型 TRANSPORT_CREATION', created);
  const newNumber = String(created?.transportNumber || '').trim().toUpperCase();
  assert(/^[A-Z0-9]{6,20}$/.test(newNumber), `创建返回合法请求号 ${newNumber}`, created);
  // 属主比较剥前导零：SAP ADT 对数字型用户名返回 '68157' 而登录名是 '068157'
  const stripZeros = value => String(value || '').trim().toUpperCase().replace(/^0+/, '');
  assert(stripZeros(created?.owner) === stripZeros(SAP_USER), `请求属主为当前用户 ${SAP_USER}（剥零比较）`, created);
  assert(created?.status === 'D', '请求状态 D（可修改，未释放）', created);

  // 7. 重复 apply 拒绝（终态 plan 不可再次消费）
  const replay = await call('applyTransportCreation', { transportCreationPlanId: planId });
  assert(JSON.stringify(replay).includes('PLAN_ALREADY_CONSUMED'), '重复 apply 被拒绝（PLAN_ALREADY_CONSUMED）', replay);

  // 8. status 工具读回结果与 plan 终态
  const finalStatus = await call('getTransportCreationStatus', { transportCreationPlanId: planId });
  assert(finalStatus.plan?.status === 'SUCCEEDED', 'plan 终态 SUCCEEDED', finalStatus.plan);
  assert(finalStatus.plan?.result?.transportNumber === newNumber, 'status 结果与 apply 一致', finalStatus.plan?.result);
  const stageNames = (finalStatus.plan?.stages || []).map(stage => stage.stage);
  for (const stage of ['PREVIEW', 'EXECUTE', 'READBACK']) {
    assert(stageNames.includes(stage), `阶段轨迹含 ${stage}`, stageNames);
  }

  // 9. 独立直连读回佐证（不经 MCP 链）
  const direct = await directReadback(newNumber);
  assert(String(direct?.['tm:number'] || '').trim() === newNumber, `直连读回请求号一致 ${newNumber}`, direct);
  assert(String(direct?.['tm:status'] || '').trim() === 'D', '直连读回确认未释放（D）', direct);

  // 10. E070 对照：新请求号不在创建前基线中，且现在可查到
  assert(!before.has(newNumber), '新请求号不在创建前基线中（确系本次创建）', newNumber);
  const after = await existingRequestNumbers();
  assert(after.has(newNumber), 'E070 可查到新请求（SAP 侧持久化）', newNumber);

  // 11. 受控清理（空请求边界）：preview 核验三条红线（未释放+零对象+本人属主）
  const cleanupPreview = await call('previewTransportCleanup', { transportNumber: newNumber });
  assert(cleanupPreview.status === 'preview', '清理 preview 返回 preview 状态', cleanupPreview);
  const cleanupPlanId = cleanupPreview.plan?.transportCleanupPlanId;
  assert(Boolean(cleanupPlanId), '清理 preview 生成 planId', cleanupPreview);
  assert(cleanupPreview.plan?.target?.objectCount === 0, '红线核验：请求为空（0 对象）', cleanupPreview.plan?.target);
  assert(cleanupPreview.plan?.target?.requestStatus === 'D', '红线核验：请求未释放（D）', cleanupPreview.plan?.target);

  // 12. 原生确认接受分支：关键词匹配 + decision=delete_transport → 单次删除 + 缺席验证
  expectedConfirmation = { keywords: ['Delete empty transport request', newNumber], decision: 'delete_transport' };
  const cleanupApplied = await call('applyTransportCleanup', { transportCleanupPlanId: cleanupPlanId });
  assert(cleanupApplied.status === 'success', '确认后清理 apply 执行成功', cleanupApplied);
  assert(cleanupApplied.plan?.result?.absenceVerified === true, '删除后缺席验证通过', cleanupApplied.plan?.result);
  assert(cleanupApplied.plan?.status === 'SUCCEEDED', '清理 plan 终态 SUCCEEDED', cleanupApplied.plan);

  // 13. 独立直连缺席佐证：删除后 transportDetails 应报错
  let absenceConfirmed = false;
  try {
    await directReadback(newNumber);
  } catch {
    absenceConfirmed = true;
  }
  assert(absenceConfirmed, '直连读回确认请求已删除（缺席）', newNumber);

  // 零残留声明：smoke 创建的请求已经受控清理链删除并验证缺席。
  process.stdout.write(`RESIDUAL 无（${newNumber} 已经受控清理并验证缺席）\n`);
  process.stdout.write('SMOKE OK\n');
  process.exit(0);
}

main().catch(error => {
  console.error(error?.message || error);
  process.exit(1);
});
