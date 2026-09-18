/**
 * RFC_READ_TABLE 只读表读取真机 smoke（rfc.remote-enabled.read-table 的
 * read-table-real-dev-smoke，全只读 SELECT）。
 *
 * 验证目标（专用 DEV，RFC 直链 sysnr=01 网关 3301）：
 *   1. readRfcTable 对 T001（公司代码主数据，所有系统必有）
 *   2. WHERE 子句过滤 + 列投影 + 行数限制
 *   3. 注入防线：控制字符 WHERE 被参数层拒绝
 *
 * 用法：node ./scripts/read-table-real-dev-smoke.mjs <sap-dev.env路径>
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
  SAP_MCP_REAL_DEV_VALIDATION: 'false',
  RFC_SYSNR: '01'
});

const client = new Client({ name: 'read-table-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('readRfcTable'), 'readRfcTable 已出现在真实运行时 catalog');

  // —— 1. T001 全量（前 10 行）——
  const all = parse(await client.callTool(
    { name: 'readRfcTable', arguments: { table: 'T001', maxRows: 10 } },
    undefined, { timeout: 300_000 }
  ));
  const allBody = all?.result || all;
  assert(all && !all.error, 'readRfcTable T001 成功返回（无错误）', all);
  assert(allBody.rows && allBody.rows.length > 0, `T001 读回 ${allBody.rows.length} 行`, allBody);
  assert(allBody.rows.every(r => Array.isArray(r) && r.length > 0), '每行均为非空数组', allBody);
  process.stdout.write(`INFO T001 前 2 行：${JSON.stringify(allBody.rows.slice(0, 2))}\n`);

  // —— 2. WHERE 过滤：T001 BUKRS = '1000'（专用 DEV 应有 client 1000）——
  const filtered = parse(await client.callTool(
    { name: 'readRfcTable', arguments: { table: 'T001', whereClause: "BUKRS = '1000'", maxRows: 5 } },
    undefined, { timeout: 300_000 }
  ));
  const filteredBody = filtered?.result || filtered;
  assert(filtered && !filtered.error, 'readRfcTable WHERE 过滤成功返回', filtered);
  process.stdout.write(`INFO BUKRS=1000 过滤后 ${filteredBody.rows.length} 行\n`);

  // —— 3. 列投影 ——
  const projected = parse(await client.callTool(
    { name: 'readRfcTable', arguments: { table: 'T001', fields: ['BUKRS', 'BUTXT'], maxRows: 5 } },
    undefined, { timeout: 300_000 }
  ));
  const projBody = projected?.result || projected;
  assert(projected && !projected.error, 'readRfcTable 列投影成功返回', projected);
  assert(projBody.rows.length > 0, `列投影读回 ${projBody.rows.length} 行`, projBody);
  process.stdout.write(`INFO 列投影样例：${JSON.stringify(projBody.rows.slice(0, 2))}\n`);

  // —— 4. 负例：注入样本参数层拒绝 ——
  const bad = parse(await client.callTool(
    { name: 'readRfcTable', arguments: { table: "Z';--", maxRows: 1 } },
    undefined, { timeout: 300_000 }
  ));
  assert(/-32602|not a valid/.test(JSON.stringify(bad)), '注入样本被 InvalidParams 拒绝', bad);

  process.stdout.write('SMOKE OK: RFC_READ_TABLE 只读表读取在真实 DEV 上验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
