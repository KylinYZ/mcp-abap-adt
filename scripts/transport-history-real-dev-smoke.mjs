/**
 * 传输历史真机 smoke（矩阵行 analysis.history 的 transport-history-real-dev-
 * smoke，全只读 SELECT）。
 *
 * 验证目标（专用 DEV）：
 *   1. getCrHistory 对 ZVCL_CAMPAIGN（历史验证对象，已知有传输 S4HK900009）
 *      返回传输清单/请求层级/用户日期
 *   2. getCoChange 对同一对象返回共现频次排行（可能为空——单对象传输）
 *   3. 负例：非法对象名参数层拒绝
 *
 * 查询预算：约 8 次（负例零查询），远低于会话预算。
 *
 * 用法：node ./scripts/transport-history-real-dev-smoke.mjs <sap-dev.env路径>
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径。');

const envText = readFileSync(environmentFile, 'utf8');
const urlMatch = envText.match(/SAP_URL\s*=\s*(\S+)/);
if (!urlMatch || !urlMatch[1].includes('10.30.254.48')) {
  throw new Error(`SMOKE FAILED: 环境文件 ${environmentFile} 未指向专用 DEV，拒绝继续。`);
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

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'transport-history-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('getCrHistory') && names.has('getCoChange'), 'getCrHistory/getCoChange 已出现在真实运行时 catalog');

  // —— 1. CR 历史：ZVCL_CAMPAIGN（历史验证对象，S4HK900009 传输）——
  const history = parse(await client.callTool(
    { name: 'getCrHistory', arguments: { objectType: 'CLAS', objectName: 'ZVCL_CAMPAIGN' } },
    undefined, { timeout: 300_000 }
  ));
  const historyBody = history?.result || history;
  assert(history && !history.error, 'getCrHistory ZVCL_CAMPAIGN 成功返回', history);
  assert(Array.isArray(historyBody.transports) && historyBody.transports.length > 0,
    `传输/任务清单 ${historyBody.transports.length} 条：${(historyBody.transports || []).join(',')}`, historyBody);
  // 已知：ZVCL_CAMPAIGN 经任务 S4HK900010 挂在请求 S4HK900009 下（任务→请求层级解析）
  assert((historyBody.requests || []).includes('S4HK900009'), '任务解析到已知请求 S4HK900009', historyBody);
  assert(Array.isArray(historyBody.requests) && historyBody.requests.length > 0, `请求层级 ${historyBody.requests.length} 条`, historyBody);
  const withUser = (historyBody.details || []).find(d => d.user);
  if (withUser) process.stdout.write(`INFO 传输 ${withUser.trkorr} 用户 ${withUser.user} 日期 ${withUser.date || '-'}\n`);
  assert((historyBody.notes || []).some(n => n.includes('E070A')), 'notes 标注 E070A CR 属性未配置', historyBody);

  // —— 2. 共同变更排行（可能为空：单对象验证传输）——
  const coChange = parse(await client.callTool(
    { name: 'getCoChange', arguments: { objectType: 'CLAS', objectName: 'ZVCL_CAMPAIGN', topN: 5 } },
    undefined, { timeout: 300_000 }
  ));
  const coBody = coChange?.result || coChange;
  assert(coChange && !coChange.error, 'getCoChange ZVCL_CAMPAIGN 成功返回', coChange);
  assert(Number.isFinite(coBody.transportsScanned), `扫描传输 ${coBody.transportsScanned} 个、请求 ${coBody.requestsCovered} 个`, coBody);
  assert(Array.isArray(coBody.coChanges), `共现对象 ${(coBody.coChanges || []).length} 条（频次降序）`, coBody);
  process.stdout.write(`INFO 共现 Top：${JSON.stringify((coBody.coChanges || []).slice(0, 2))}\n`);

  // —— 3. 负例：非法对象名 ——
  const bad = parse(await client.callTool(
    { name: 'getCrHistory', arguments: { objectType: 'CLAS', objectName: "Z';--" } },
    undefined, { timeout: 300_000 }
  ));
  assert(/-32602|not a valid/.test(JSON.stringify(bad)), '注入样本被 InvalidParams 拒绝', bad);

  process.stdout.write('SMOKE OK: 传输历史（CR 历史 + 共同变更）在真实 DEV 上验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
