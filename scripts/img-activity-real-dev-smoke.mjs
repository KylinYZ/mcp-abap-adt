/**
 * IMG 活动详情真机 smoke（矩阵行 diagnostics.knowledge-queries 的
 * img-activity-real-dev-smoke，全只读 SELECT）。
 *
 * 顺序约束（专用 DEV 实测）：datapreview 有按会话的查询预算（约 19 次，
 * 耗尽后本会话持续报错）。因此本脚本先跑轻量负例/回归、最后跑查询密集的
 * 活动详情（maxRefs=2 控制预算），总查询量保持在预算内。
 *
 * 验证目标（专用 DEV）：
 *   1. 负例：不存在活动 InvalidParams；注入样本参数层拒绝
 *   2. 回归：searchImgActivities 检索语义不受本轮改动影响
 *   3. getImgActivity 对 APOC_C_FORMV 返回基础行/事务码/菜单路径
 *      （TNODEIMG 向上递归 + TNODEIMGT 文本）；HY 文档容错
 *
 * 用法：node ./scripts/img-activity-real-dev-smoke.mjs <sap-dev.env路径>
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

const client = new Client({ name: 'img-activity-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('getImgActivity'), 'getImgActivity 已出现在真实运行时 catalog');

  // —— 1. 负例先行（消耗查询预算最少）：不存在的活动 ——
  const missing = parse(await client.callTool(
    { name: 'getImgActivity', arguments: { activity: 'ZZZZ9NOPE' } },
    undefined, { timeout: 300_000 }
  ));
  assert(/-32602|does not exist/.test(JSON.stringify(missing)), '不存在的活动被 InvalidParams 拒绝', missing);

  // —— 2. 注入负例（参数层拒绝，零查询）——
  const bad = parse(await client.callTool(
    { name: 'getImgActivity', arguments: { activity: "Z';--" } },
    undefined, { timeout: 300_000 }
  ));
  assert(/-32602|not a valid/.test(JSON.stringify(bad)), '注入样本被 InvalidParams 拒绝', bad);

  // —— 3. 回归：IMG 检索 ——
  const search = parse(await client.callTool(
    { name: 'searchImgActivities', arguments: { text: 'Anlage*', language: 'DE', limit: 10 } },
    undefined, { timeout: 300_000 }
  ));
  const searchBody = search?.result || search;
  assert(search && !search.error, 'searchImgActivities 回归成功', search);
  assert(searchBody.count > 0, `检索命中 ${searchBody.count} 节点`, searchBody);

  // —— 4. 活动详情（查询密集，放最后；maxRefs=2 控制预算）——
  const detail = parse(await client.callTool(
    { name: 'getImgActivity', arguments: { activity: 'APOC_C_FORMV', language: 'EN', maxRefs: 2 } },
    undefined, { timeout: 300_000 }
  ));
  const body = detail?.result || detail;
  assert(detail && !detail.error, 'getImgActivity APOC_C_FORMV 成功返回', detail);
  assert(body.activity === 'APOC_C_FORMV', '活动名归一大写回显', body);
  assert(!!body.transaction, `事务码 ${body.transaction || '(缺失)'}`, body);
  assert(Array.isArray(body.paths) && body.paths.length > 0, `菜单路径 ${body.paths.length} 条（TNODEIMG 递归 + TNODEIMGT 文本）`, body);
  process.stdout.write(`INFO 首条路径：${String(body.paths[0]).slice(0, 160)}\n`);
  if (body.documentation) {
    process.stdout.write(`INFO HY 文档 ${body.documentation.lines.length} 行（v${body.documentation.version}）\n`);
  } else {
    process.stdout.write(`INFO HY 文档缺省（notes：${(body.notes || []).join(' | ').slice(0, 160)}）\n`);
  }

  process.stdout.write('SMOKE OK: IMG 活动详情（路径递归）在真实 DEV 上验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
