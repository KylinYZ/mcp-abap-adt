/**
 * RFC 探测只读工具真机 smoke（矩阵行 rfc.remote-enabled.discovery 的
 * rfc-probe-real-dev-smoke，全只读：RFC_PING + RFC_SYSTEM_INFO）。
 *
 * 验证目标（专用 DEV，RFC 直链 sysnr=01 网关 3301）：
 *   1. probeRfcSystem → RFC_PING 连通（open-rfc 纯 TS 客户端直连网关）
 *   2. RFC_SYSTEM_INFO 系统指纹（sysid=S4H、release、host）
 *   3. 只读门控：白名单外 FM 不可能经本工具发出（工具无入参固定调用面）
 *
 * 用法：node ./scripts/rfc-probe-real-dev-smoke.mjs <sap-dev.env路径>
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

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false',
  RFC_SYSNR: '01'
});

const client = new Client({ name: 'rfc-probe-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('probeRfcSystem'), 'probeRfcSystem 已出现在真实运行时 catalog');

  const t0 = Date.now();
  const report = parse(await client.callTool(
    { name: 'probeRfcSystem', arguments: {} },
    undefined,
    { timeout: 300_000 }
  ));
  const body = report?.result || report;
  assert(report && !report.error, 'probeRfcSystem 成功返回（无错误）', report);

  // —— RFC_PING ——
  assert(body.ping && body.ping.pong === true, 'RFC_PING 连通（SOAP-RFC 无关，直链网关）', body.ping);
  process.stdout.write(`INFO RFC_PING：${body.ping.detail}\n`);

  // —— RFC_SYSTEM_INFO 指纹（RFCSI_EXPORT 结构块嵌套在输出里）——
  const info = body.systemInfo || {};
  const rfcsi = info.RFCSI_EXPORT || {};
  assert(rfcsi.RFCSYSID === 'S4H', `系统号 RFCSYSID=S4H（实测）`, rfcsi);
  assert(typeof rfcsi.RFCSAPRL === 'string' && rfcsi.RFCSAPRL.length > 0, `release ${rfcsi.RFCSAPRL}`, rfcsi);
  assert(typeof rfcsi.RFCHOST === 'string' && rfcsi.RFCHOST.length > 0, `主机 ${rfcsi.RFCHOST}`, rfcsi);
  assert(typeof rfcsi.RFCDBSYS === 'string' && rfcsi.RFCDBSYS.length > 0, `数据库系统 ${rfcsi.RFCDBSYS}`, rfcsi);
  assert(typeof rfcsi.RFCIPADDR === 'string' && rfcsi.RFCIPADDR.length > 0, `IP ${rfcsi.RFCIPADDR}`, rfcsi);
  process.stdout.write(`INFO 指纹：sysid=${rfcsi.RFCSYSID} release=${rfcsi.RFCSAPRL} host=${rfcsi.RFCHOST} dbsys=${rfcsi.RFCDBSYS} ip=${rfcsi.RFCIPADDR} kernel=${rfcsi.RFCKERNRL}\n`);


  process.stdout.write(`SMOKE OK: RFC 探测在真实 DEV 上验证通过（耗时 ${Date.now() - t0}ms，只读，零写操作）\n`);
}

try {
  await main();
} finally {
  await client.close();
}
