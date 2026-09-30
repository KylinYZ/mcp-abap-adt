// 完整工作流测试·残留清扫（sap-demo）：对显式列出的 PROGRAM 逐个走
// previewRepositoryObjectCleanup → 原生确认 → applyRepositoryCleanup → absence 复核。
//
// 为什么需要覆盖 SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT：清理链只接受归属于
// "配置的校验传输"的对象（防误删他人/他链对象）。阶段5 的程序登记在本次战役
// 自建的 S4HK900029 下，而非 env 默认校验传输 S4HK900009——因此清扫时必须把
// 校验传输临时指向对象真实归属的 S4HK900029（该请求未释放、属主本人、由本
// 战役受控创建，边界不放宽）。
//
// 红线：仅 sap-demo（10.30.254.48）；只删显式列出的对象；确认消息不含预期
// 关键词一律 cancel；全程串行。
// 用法：node scripts/full-workflow-residue-cleanup.mjs <校验传输号> <程序名...>
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const validationTransport = String(process.argv[2] || '').trim().toUpperCase();
const programNames = process.argv.slice(3).map(v => String(v).trim().toUpperCase()).filter(Boolean);
if (!/^[A-Z0-9]{6,20}$/.test(validationTransport) || programNames.length === 0) {
  console.error('用法：node scripts/full-workflow-residue-cleanup.mjs <校验传输号> <程序名...>');
  process.exit(1);
}

const environmentFile = resolve('C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env');
const envText = readFileSync(environmentFile, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]] = m[2];
}
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48），拒绝执行。');
  process.exit(1);
}

// 阶段化应答：确认消息必须包含当前目标对象名，否则 cancel
let currentTarget = '';
const client = new Client({ name: 'full-workflow-residue-cleanup', version: '1.0.0' },
  { capabilities: { elicitation: {} } });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: Object.assign(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    {
      SAP_MCP_ENV_FILE: environmentFile,
      SAP_MCP_LOG_LEVEL: 'warn',
      SAP_MCP_REAL_DEV_VALIDATION: 'false',
      // 覆盖校验传输号为对象真实归属（本战役自建的 S4HK900029）
      SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT: validationTransport
    }
  ),
  stderr: 'pipe'
});
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  if (!currentTarget || !message.includes(currentTarget)) {
    process.stdout.write(`WARN 确认未匹配目标 [${currentTarget}]，已取消：${message.slice(0, 140)}\n`);
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: 'apply' } };
});

function parse(result) {
  const text = (result.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(text); } catch { return { __unparsed: text.slice(0, 400), __isError: Boolean(result.isError) }; }
}
function assert(condition, message, payload) {
  if (!condition) throw new Error(`CLEANUP FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 800)}`);
  process.stdout.write(`PASS ${message}\n`);
}
async function call(name, args, timeoutMs) {
  return timeoutMs
    ? client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
    : client.callTool({ name, arguments: args });
}
/** 精确缺席检查：必须拿到合法 results 数组再判空——错误响应不允许被当成"不存在" */
async function programExists(name) {
  const search = parse(await call('searchObject', { query: name, objType: 'PROG/P', max: 5 }));
  assert(Array.isArray(search.results), `searchObject 响应含 results 数组（${name}）`, search);
  return search.results.some(item => String(item['adtcore:name'] || '').toUpperCase() === name);
}

await client.connect(transport);
for (const name of programNames) {
  currentTarget = name;
  if (!(await programExists(name))) {
    process.stdout.write(`SKIP ${name} 已不存在\n`);
    continue;
  }
  const preview = parse(await call('previewRepositoryObjectCleanup', { objectKind: 'PROGRAM', name }));
  assert(preview.status === 'preview' && Boolean(preview.plan?.cleanupPlanId), `${name} 清理 preview 生成 plan`, preview);
  const applied = parse(await call('applyRepositoryObjectCleanup', { cleanupPlanId: preview.plan.cleanupPlanId }, 180_000));
  assert(!applied.error && (applied.plan?.status === 'SUCCEEDED' || applied.plan?.status === 'APPLIED' || applied.status === 'success'),
    `${name} 清理 apply 执行成功`, applied);
  assert(!(await programExists(name)), `${name} absence 复核通过`);
}
process.stdout.write(`\nCLEANUP OK — ${programNames.length} 个对象处理完毕（校验传输 ${validationTransport}）\n`);
await client.close();
