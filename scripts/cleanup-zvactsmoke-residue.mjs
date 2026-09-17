/**
 * 一次性残留清理脚本：受控清理 smoke 留下的自建验证对象（PROGRAM 或 ABAP_CLASS）。
 *
 * 背景：activation/class-include smoke 中断时自建对象可能未被末步清理。本脚本只做
 * 一件事：对指定对象执行受控清理闭环（preview → 原生确认 → apply → searchObject
 * 缺席复查），不复用、不重试、不触碰任何其他对象。
 *
 * 用法：node cleanup-zvactsmoke-residue.mjs <sap-dev.env> <对象名> [PROGRAM|ABAP_CLASS]
 * 安全边界：仅接受 Z* 命名空间；确认 elicitation 按对象名关键词核对，不匹配即取消。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'path';

const environmentFile = process.argv[2];
const targetName = String(process.argv[3] || '').trim().toUpperCase();
const objectKind = String(process.argv[4] || 'PROGRAM').trim().toUpperCase();
const searchType = objectKind === 'ABAP_CLASS' ? 'CLAS/OC' : 'PROG/P';
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径。');
if (!/^Z[A-Z0-9_]{1,29}$/.test(targetName)) throw new Error('目标必须是 Z 命名空间内的有界对象名。');
if (!['PROGRAM', 'ABAP_CLASS'].includes(objectKind)) throw new Error('objectKind 仅支持 PROGRAM 或 ABAP_CLASS。');

function parse(result) {
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

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client(
  { name: 'cleanup-zvactsmoke-residue', version: '1.0.0' },
  { capabilities: { elicitation: {} } }
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

// 确认应答：仅当消息包含目标对象名时接受清理，否则取消（无人值守防误批）
client.setRequestHandler(ElicitRequestSchema, request => {
  const message = String(request.params?.message || '');
  if (!message.includes(targetName)) {
    process.stdout.write(`WARN 确认消息未含 ${targetName}，已取消：${message.slice(0, 160)}\n`);
    return { action: 'cancel' };
  }
  return { action: 'accept', content: { decision: 'apply' } };
});

await client.connect(transport);
try {
  const preview = parse(await client.callTool({
    name: 'previewRepositoryObjectCleanup',
    arguments: { objectKind, name: targetName }
  }, undefined, { timeout: 300_000 }));
  if (preview.status !== 'preview') {
    console.log(`SKIP ${targetName} 无可清理 plan（可能已不存在）：${JSON.stringify(preview).slice(0, 200)}`);
  } else {
    console.log(`PASS 清理 preview plan ${preview.plan.cleanupPlanId}`);
    const applied = parse(await client.callTool({
      name: 'applyRepositoryObjectCleanup',
      arguments: { cleanupPlanId: preview.plan.cleanupPlanId }
    }, undefined, { timeout: 300_000 }));
    console.log(`INFO apply 响应: ${JSON.stringify(applied).slice(0, 300)}`);
  }
  // 缺席复查为清理真判据（apply 响应体可能为空）
  const after = parse(await client.callTool({
    name: 'searchObject',
    arguments: { query: targetName, objType: searchType, max: 5 }
  }, undefined, { timeout: 120_000 }));
  const remains = (after.results || []).some(item => String(item['adtcore:name'] || '').toUpperCase() === targetName);
  if (remains) {
    console.log(`FAIL ${targetName} 仍存在，清理未完成`);
    process.exitCode = 1;
  } else {
    console.log(`PASS absence 复查：系统已无 ${targetName}`);
  }
} finally {
  await client.close();
}
