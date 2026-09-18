/**
 * RFC 受控调用/接口描述真机 smoke（矩阵行 rfc.remote-enabled.call /
 * rfc.remote-enabled.describe 的 call-describe-real-dev-smoke，全只读）。
 *
 * 验证目标（专用 DEV，RFC 直链 sysnr=01 网关 3301）：
 *   1. describeRfm 对 RFC_READ_TABLE 返回参数级描述 + inputSchema（不执行 FM）
 *   2. describeRfm 对 RFC_FUNCTION_SEARCH 的输出驱动 callRfm 组参（先描述后调用闭环）
 *   3. callRfm 调用 RFC_SYSTEM_INFO（指纹）与 RFC_READ_TABLE（带 ET_DATA 开关读表）
 *   4. 安全负例：白名单外 FM 被 RF_CALL_NOT_ALLOWED 拒绝（零网络往返）
 *   5. 参数负例：非法 FM 名被 InvalidParams 拒绝
 *
 * 用法：node ./scripts/rfc-call-describe-real-dev-smoke.mjs <sap-dev.env路径>
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

const client = new Client({ name: 'rfc-call-describe-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('describeRfm') && names.has('callRfm'), 'describeRfm/callRfm 已出现在真实运行时 catalog');

  // —— 1. describeRfm：RFC_READ_TABLE 接口描述（元数据通道，不执行 FM）——
  const described = parse(await client.callTool(
    { name: 'describeRfm', arguments: { functionName: 'RFC_READ_TABLE' } },
    undefined, { timeout: 300_000 }
  ));
  const descBody = described?.result || described;
  assert(described && !described.error, 'describeRfm RFC_READ_TABLE 成功返回', described);
  const paramNames = descBody.parameters.map(p => p.name);
  assert(paramNames.includes('QUERY_TABLE') && paramNames.includes('DATA'), '参数清单含 QUERY_TABLE/DATA', descBody);
  assert(descBody.inputSchema.required.includes('QUERY_TABLE'), 'inputSchema 收录必填导入参数 QUERY_TABLE', descBody);
  assert(descBody.allowlisted === true, 'RFC_READ_TABLE 的 allowlisted 提示为 true', descBody);
  process.stdout.write(`INFO RFC_READ_TABLE 参数 ${descBody.parameterCount} 个：${paramNames.join(',')}\n`);

  // —— 2. describeRfm → callRfm 组参闭环：RFC_FUNCTION_SEARCH ——
  const searchDesc = parse(await client.callTool(
    { name: 'describeRfm', arguments: { functionName: 'RFC_FUNCTION_SEARCH' } },
    undefined, { timeout: 300_000 }
  ));
  const searchBody = searchDesc?.result || searchDesc;
  assert(searchDesc && !searchDesc.error, 'describeRfm RFC_FUNCTION_SEARCH 成功返回', searchDesc);
  const funcNameParam = searchBody.parameters.find(p => p.direction === 'I' && p.name.includes('FUNCNAME'));
  assert(!!funcNameParam, `找到检索用导入参数（${funcNameParam ? funcNameParam.name : '无'}）`, searchBody);

  // —— 3. callRfm：指纹 + 检索 + 读表（ET_DATA 路径）——
  const info = parse(await client.callTool(
    { name: 'callRfm', arguments: { functionName: 'RFC_SYSTEM_INFO' } },
    undefined, { timeout: 300_000 }
  ));
  const infoBody = info?.result || info;
  assert(info && !info.error, 'callRfm RFC_SYSTEM_INFO 成功返回', info);
  // 裸 RFM 透传保真：指纹在 RFCSI_EXPORT 结构内（RFCSYSID），不做扁平化
  assert(infoBody.values?.RFCSI_EXPORT?.RFCSYSID === 'S4H',
    `系统指纹 RFCSI_EXPORT.RFCSYSID=${infoBody.values?.RFCSI_EXPORT?.RFCSYSID}`, infoBody);

  const search = parse(await client.callTool(
    { name: 'callRfm', arguments: { functionName: 'RFC_FUNCTION_SEARCH', args: { [funcNameParam.name]: 'RFC_READ_TABLE' } } },
    undefined, { timeout: 300_000 }
  ));
  const searchCallBody = search?.result || search;
  assert(search && !search.error, 'callRfm RFC_FUNCTION_SEARCH 成功返回（describe 输出驱动的组参）', search);

  const read = parse(await client.callTool(
    {
      name: 'callRfm',
      arguments: {
        functionName: 'RFC_READ_TABLE',
        args: { QUERY_TABLE: 'T001', DELIMITER: '|', ROWCOUNT: 2, USE_ET_DATA_4_RETURN: 'X' }
      }
    },
    undefined, { timeout: 300_000 }
  ));
  const readBody = read?.result || read;
  assert(read && !read.error, 'callRfm RFC_READ_TABLE 成功返回（透传载荷）', read);
  assert((readBody.tables?.ET_DATA || []).length === 2, `ET_DATA 读回 ${(readBody.tables?.ET_DATA || []).length} 行`, readBody);
  process.stdout.write(`INFO ET_DATA 首行：${JSON.stringify((readBody.tables?.ET_DATA || [])[0] || {}).slice(0, 160)}\n`);

  // —— 4. 安全负例：白名单外 FM 拒绝（携带当前白名单文本）——
  const denied = parse(await client.callTool(
    { name: 'callRfm', arguments: { functionName: 'BAPI_USER_GET_DETAIL' } },
    undefined, { timeout: 300_000 }
  ));
  assert(/RF_CALL_NOT_ALLOWED/.test(JSON.stringify(denied)), '白名单外 FM 被 RF_CALL_NOT_ALLOWED 拒绝', denied);

  // —— 5. 参数负例：非法 FM 名参数层拒绝 ——
  const bad = parse(await client.callTool(
    { name: 'callRfm', arguments: { functionName: "Z';--" } },
    undefined, { timeout: 300_000 }
  ));
  assert(/-32602|not a valid/.test(JSON.stringify(bad)), '非法 FM 名被 InvalidParams 拒绝', bad);

  process.stdout.write('SMOKE OK: RFC 受控调用/接口描述在真实 DEV 上验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
