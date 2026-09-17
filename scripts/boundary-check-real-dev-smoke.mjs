/**
 * 包边界只读检查工具真机 smoke（矩阵行 analysis.boundaries 的
 * boundary-check-real-dev-smoke，全只读：TADIR SELECT + 源码 GET）。
 *
 * 验证目标（专用 DEV）：
 *   1. Z001 包边界分析（应命中历史 campaign 自有验证对象及其依赖）
 *   2. 聚合结构完整（六类计数 + crossedPackages + violatingObjects + notes）
 *   3. 白名单生效（把实际跨入的包加入白名单后 violations 下降）
 *   4. 负例：非法包名/非法 objectKinds 在参数层被拒
 *
 * 用法：node ./scripts/boundary-check-real-dev-smoke.mjs <sap-dev.env路径> [包名]
 * 默认包 Z001（本用户历史 campaign 验证对象所在包）。
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const packageName = String(process.argv[3] || 'Z001').trim().toUpperCase();
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');

const envText = readFileSync(environmentFile, 'utf8');
const urlMatch = envText.match(/SAP_URL\s*=\s*(\S+)/);
if (!urlMatch || !urlMatch[1].includes('10.30.254.48')) {
  throw new Error(`SMOKE FAILED: 环境文件 ${environmentFile} 未指向专用 DEV（SAP_URL 缺失或非 10.30.254.48），拒绝继续。`);
}

function parse(result) {
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try { return JSON.parse(text); } catch { return { __unparsed: text.slice(0, 300) }; }
}

function assert(condition, message, payload) {
  if (!condition) {
    throw new Error(`SMOKE FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 600)}`);
  }
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'boundary-check-real-dev-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'inherit'
});

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  assert(names.has('checkPackageBoundaries'), 'checkPackageBoundaries 已出现在真实运行时 catalog');

  // —— 1. Z001 包边界分析（逐对象串行取源，预留长超时）——
  const report = parse(await call('checkPackageBoundaries', { packageName, objectLimit: 15 }));
  const body = report?.result || report;
  assert(report && !report.error, 'checkPackageBoundaries 成功返回（无错误）', report);
  assert(body.rootPackage === packageName, `返回规范包名 ${packageName}`, body);
  assert(typeof body.analyzedObjects === 'number', `分析对象数 ${body.analyzedObjects}`, body);
  assert(typeof body.totalDeps === 'number' && body.totalDeps >= 0, `依赖总数 ${body.totalDeps}`, body);
  const counters = ['standard', 'samePackage', 'allowed', 'violations', 'dynamic', 'unknown'];
  assert(counters.every(k => typeof body[k] === 'number'), '六类计数齐备', body);
  assert(counters.reduce((acc, k) => acc + body[k], 0) === body.totalDeps,
    '六类计数之和等于依赖总数', body);
  assert(Array.isArray(body.entries) && Array.isArray(body.violatingObjects) && Array.isArray(body.notes),
    'entries/violatingObjects/notes 结构完整', body);
  assert(typeof body.crossedPackages === 'object', 'crossedPackages 结构完整', body);
  assert(body.notes.some(n => n.includes('dynamic')), 'notes 标注动态调用检测边界', body);
  process.stdout.write(`INFO 分析 ${body.analyzedObjects} 对象 / ${body.totalDeps} 依赖：standard=${body.standard} same=${body.samePackage} allowed=${body.allowed} violation=${body.violations} unknown=${body.unknown}\n`);
  process.stdout.write(`INFO 跨包分布：${JSON.stringify(body.crossedPackages)}\n`);
  process.stdout.write(`INFO 违规对象：${JSON.stringify(body.violatingObjects)}\n`);

  // —— 2. 白名单生效验证：把实际跨入的包全部加入白名单 → violations 归零 ——
  const crossed = Object.keys(body.crossedPackages || {});
  if (crossed.length > 0) {
    const whitelisted = parse(await call('checkPackageBoundaries', {
      packageName, whitelist: crossed, objectLimit: 15
    }));
    const wlBody = whitelisted?.result || whitelisted;
    assert(whitelisted && !whitelisted.error, '白名单版本成功返回', whitelisted);
    assert(wlBody.violations === 0, '全部跨入包加入白名单后 violations 归零', wlBody);
    assert(wlBody.allowed === body.violations, `原违规边转为 allowed=${wlBody.allowed}`, wlBody);
    assert(wlBody.whitelist.length === crossed.length, '回显生效白名单', wlBody.whitelist);
  } else {
    process.stdout.write('INFO 该包无跨包 Z 依赖，白名单路径以负例覆盖\n');
  }

  // —— 3. 负例：参数层拒绝 ——
  const badPkg = await call('checkPackageBoundaries', { packageName: "Z';--" });
  assert(/-32602|repository name/.test(JSON.stringify(badPkg)), '非法包名被 InvalidParams 拒绝', badPkg);
  const badKinds = await call('checkPackageBoundaries', { packageName, objectKinds: ['TABL'] });
  assert(/-32602|objectKinds/.test(JSON.stringify(badKinds)), '非法 objectKinds 被 InvalidParams 拒绝', badKinds);

  process.stdout.write('SMOKE OK: 包边界只读检查工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
