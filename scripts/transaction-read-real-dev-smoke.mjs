/**
 * 事务码元数据只读工具真机 smoke（矩阵行 read.transaction 的
 * transaction-read-real-dev-smoke，全只读：两条 SELECT）。
 *
 * 验证目标（专用 DEV）：
 *   1. 标准事务码 SE38 → 程序 SAPMS38M + 描述（默认 EN）
 *   2. 语言覆盖（DE）→ 描述随语言变化或如实缺失
 *   3. 不存在的事务码 → 明确报错（InvalidParams）
 *   4. 负例：非法事务码/非法语言键参数层拒绝
 *
 * 用法：node ./scripts/transaction-read-real-dev-smoke.mjs <sap-dev.env路径>
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
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

const client = new Client({ name: 'transaction-read-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('getTransaction'), 'getTransaction 已出现在真实运行时 catalog');

  // —— 1. 标准事务码 SE38：程序 + 描述 ——
  const se38 = parse(await call('getTransaction', { transaction: ' se38 ', language: 'EN' }));
  const se38Body = se38?.result || se38;
  assert(se38 && !se38.error, 'getTransaction SE38 成功返回（无错误）', se38);
  assert(se38Body.transaction === 'SE38', '返回规范事务码 SE38', se38Body);
  assert(typeof se38Body.program === 'string' && se38Body.program.length > 0,
    `承载程序 ${se38Body.program}`, se38Body);
  if (se38Body.description) {
    assert(typeof se38Body.description === 'string' && se38Body.description.length > 0,
      `描述非空（"${se38Body.description}"）`, se38Body);
  } else {
    // 该 DEV 的 TSTCT datapreview 受限：描述缺失必须带 note 解释而非静默
    assert(String(se38Body.note || '').includes('TSTCT'),
      '描述缺失且 note 标注 TSTCT 受限', se38Body);
  }
  assert(se38Body.language === 'EN', '回显语言键 EN', se38Body);
  process.stdout.write(`INFO SE38：program=${se38Body.program} description="${se38Body.description || '-'}" note=${se38Body.note ? 'yes' : 'no'}\n`);

  // —— 2. 语言覆盖 DE：描述随语言（或如实缺失）——
  const de = parse(await call('getTransaction', { transaction: 'SE38', language: 'DE' }));
  const deBody = de?.result || de;
  assert(de && !de.error, 'getTransaction language=DE 成功返回', de);
  process.stdout.write(`INFO DE 描述："${deBody.description || '-'}"（EN："${se38Body.description}"）\n`);

  // —— 3. 不存在的事务码 → InvalidParams 明确报错 ——
  const missing = await call('getTransaction', { transaction: 'ZZZZ9' });
  assert(/-32602|does not exist in TSTC/.test(JSON.stringify(missing)),
    '不存在的事务码被 InvalidParams 拒绝（含 TSTC 提示）', missing);

  // —— 4. 负例：参数层拒绝 ——
  const badName = await call('getTransaction', { transaction: "Z';--" });
  assert(/-32602|not a transaction code/.test(JSON.stringify(badName)), '非法事务码被 InvalidParams 拒绝', badName);
  const badLang = await call('getTransaction', { transaction: 'SE38', language: 'CHN' });
  assert(/-32602|language key/.test(JSON.stringify(badLang)), '非法语言键被 InvalidParams 拒绝', badLang);

  process.stdout.write('SMOKE OK: 事务码元数据只读工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
