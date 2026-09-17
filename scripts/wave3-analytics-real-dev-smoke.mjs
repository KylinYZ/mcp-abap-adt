/**
 * Wave 3 分析四工具真机 smoke（矩阵行 search.content-grep / read.coverage /
 * diagnostics.application-log / analysis.callgraph 的 real-dev-smoke）。
 *
 * 验证目标（专用 DEV，只读优先）：
 *   1. grepPackage      —— Z001 包源码内容正则搜索（只读）
 *   2. getCallees       —— WBCROSSGT/CROSS 交叉表只读查询（只读）
 *   3. readApplicationLog —— BALHDR 应用日志只读查询（只读，最近 1 天窗口）
 *   4. runUnitCoverage  —— 对自有验证类运行覆盖率（执行行为：运行被测对象的
 *      测试代码；目标限定 Z001 包内本用户历史 campaign 验证类，零修改）
 *
 * 用法：node ./scripts/wave3-analytics-real-dev-smoke.mjs <sap-dev.env路径> [覆盖率目标类名]
 */
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const coverageTarget = String(process.argv[3] || 'ZVPCL01').trim().toUpperCase();
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');

function parse(result) {
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try { return JSON.parse(text); } catch { return { __unparsed: text.slice(0, 300) }; }
}

function assert(condition, message, payload) {
  if (!condition) {
    throw new Error(`SMOKE FAILED: ${message}\n实际响应: ${JSON.stringify(payload || {}).slice(0, 500)}`);
  }
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}) {
  // DEV 系统响应较慢（单对象源码拉取可达 15s+，包级 grep 是多请求组合），
  // 单调用超时放宽到 5 分钟
  return client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'wave3-analytics-real-dev-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const tool of ['grepPackage', 'grepObjects', 'getCallees', 'readApplicationLog', 'runUnitCoverage']) {
    assert(names.has(tool), `${tool} 已出现在 DEV focused 运行时 catalog`);
  }

  // —— 1. grepPackage：在 Z001 包搜 "definition"（大小写不敏感）——
  // objectTypes 限定 PROG 缩小枚举面（DEV 系统响应慢，控制组合请求数）
  const grep = parse(await call('grepPackage', {
    packageName: 'Z001', pattern: 'definition', caseInsensitive: true, maxResults: 20, objectTypes: ['PROG']
  }));
  assert(grep?.result && !grep.error, 'grepPackage 成功返回（无错误）', grep);
  assert(typeof grep.result.totalMatches === 'number' && Array.isArray(grep.result.objects), 'grepPackage 返回结构完整');
  assert(grep.result.truncated === false, 'grepPackage 未触发截断（包规模受控）');
  process.stdout.write(`INFO Z001 包内 "definition" 命中 ${grep.result.totalMatches} 处 / ${grep.result.objects.length} 个对象（searchedObjects=${grep.result.searchedObjects}）\n`);
  process.stdout.write(`INFO 命中样例：${JSON.stringify(grep.result.objects.slice(0, 2)).slice(0, 300)}\n`);

  // —— 2. getCallees：ZVPCL01 的 down 方向交叉引用 ——
  const callees = parse(await call('getCallees', { objectType: 'CLAS', objectName: 'ZVPCL01' }));
  const calleesBody = callees?.result || callees;
  assert(callees && !callees.error, 'getCallees 成功返回（无错误）', callees);
  assert(Array.isArray(calleesBody.callees), 'getCallees 返回 callees 数组');
  assert(calleesBody.failedSources !== undefined, 'getCallees 返回 failedSources 容错字段');
  process.stdout.write(`INFO ZVPCL01 引用 ${calleesBody.callees.length} 个 callee（kind 分布：${JSON.stringify(calleesBody.callees.reduce((acc, c) => { acc[c.kind] = (acc[c.kind] || 0) + 1; return acc; }, {}))}），failedSources=${calleesBody.failedSources.length}\n`);

  // —— 3. readApplicationLog：最近 1 天窗口 ——
  const today = new Date();
  const dayAgo = new Date(today.getTime() - 24 * 3600 * 1000);
  const iso = d => d.toISOString().slice(0, 10);
  const applog = parse(await call('readApplicationLog', { timeFrom: iso(dayAgo), timeTo: iso(today), maxResults: 50 }));
  const applogBody = applog?.result || applog;
  assert(applog && !applog.error, 'readApplicationLog 成功返回（无错误）', applog);
  assert(Array.isArray(applogBody.entries), 'readApplicationLog 返回 entries 数组');
  process.stdout.write(`INFO 最近一天 BAL 应用日志 ${applogBody.entries.length} 条（truncated=${applogBody.truncated}）\n`);

  // —— 4. runUnitCoverage：对自有验证类执行覆盖率（执行行为，零修改）——
  const coverage = parse(await call('runUnitCoverage', { objectType: 'CLASS', objectName: coverageTarget }));
  const coverageBody = coverage?.result || coverage;
  assert(coverage && !coverage.error, `runUnitCoverage 对 ${coverageTarget} 执行成功（无错误）`, coverage);
  process.stdout.write(`INFO ${coverageTarget} 覆盖率结果：${JSON.stringify(coverageBody).slice(0, 400)}\n`);

  process.stdout.write('SMOKE OK: Wave 3 分析四工具在真实 DEV 系统上全部验证通过\n');
}

try {
  await main();
} finally {
  await client.close();
}
