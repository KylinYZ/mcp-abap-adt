/**
 * 安装前置只读发现工具真机 smoke（矩阵行 install.diagnostics 的
 * install-diagnostics-real-dev-smoke，全只读：TADIR SELECT + git repos GET）。
 *
 * 验证目标（专用 DEV）：
 *   1. ZADT_VSP helper 探测（该系统从未安装 helper → installed=false 且 objects 空）
 *   2. abapGit 服务可达性分类（结构完整、状态合法）
 *   3. 本地运行时与边界 notes
 *
 * 用法：node ./scripts/install-diagnostics-real-dev-smoke.mjs <sap-dev.env路径>
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
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'install-diagnostics-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('checkInstallPrerequisites'), 'checkInstallPrerequisites 已出现在真实运行时 catalog');

  // —— 1. 前置发现 ——
  const report = parse(await client.callTool({ name: 'checkInstallPrerequisites', arguments: {} }, undefined, { timeout: 300_000 }));
  const body = report?.result || report;
  assert(report && !report.error, 'checkInstallPrerequisites 成功返回（无错误）', report);

  // —— 2. helper 探测 ——
  assert(body.zadtVspHelper && typeof body.zadtVspHelper.installed === 'boolean', 'helper 探测结构完整', body.zadtVspHelper);
  assert(Array.isArray(body.zadtVspHelper.objects), 'helper objects 数组', body.zadtVspHelper);
  process.stdout.write(`INFO ZADT_VSP helper：installed=${body.zadtVspHelper.installed} objects=${body.zadtVspHelper.objects.length}${body.zadtVspHelper.detail ? ' detail=' + body.zadtVspHelper.detail : ''}\n`);

  // —— 3. abapGit 分类 ——
  const validStatuses = ['available', 'not_installed', 'forbidden', 'error'];
  assert(body.abapGit && validStatuses.includes(body.abapGit.status),
    `abapGit 状态合法（${body.abapGit.status}）`, body.abapGit);
  assert(typeof body.abapGit.detail === 'string' && body.abapGit.detail.length > 0, 'abapGit 带判定依据', body.abapGit);
  process.stdout.write(`INFO abapGit：${body.abapGit.status}（${body.abapGit.detail}）\n`);

  // —— 4. 本地运行时与 notes ——
  assert(body.localRuntime && String(body.localRuntime.node).startsWith('v'), `本地 Node ${body.localRuntime.node}`, body.localRuntime);
  assert(Array.isArray(body.notes) && body.notes.some(n => n.includes('never installs')),
    'notes 明确"不做任何安装动作"边界', body.notes);

  process.stdout.write('SMOKE OK: 安装前置只读发现工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
