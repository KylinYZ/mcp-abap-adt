/**
 * 版本源码只读工具真机 smoke（矩阵行 revisions.source 的
 * revision-source-real-dev-smoke，全只读）。
 *
 * 验证目标（专用 DEV）：
 *   1. 发现模式 —— 不带版本选择器，返回对象版本清单
 *   2. index 选择 —— 按清单序号读取版本源码（非空、行数一致）
 *   3. version 选择 —— 按标签读取（用发现模式返回的标签回填）
 *   4. 负例：未知版本标签（InvalidParams）、非法名字（InvalidParams）
 *
 * 用法：node ./scripts/revision-source-real-dev-smoke.mjs <sap-dev.env路径> [对象类型] [对象名]
 * 默认目标 ZVCL_CAMPAIGN（CLAS，历史 campaign 验证对象，有激活历史即有版本）。
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const targetType = String(process.argv[3] || 'CLAS').trim().toUpperCase();
const targetName = String(process.argv[4] || 'ZVCL_CAMPAIGN').trim().toUpperCase();
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

const client = new Client({ name: 'revision-source-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('getRevisionSource'), 'getRevisionSource 已出现在真实运行时 catalog');

  // —— 1. 发现模式：版本清单 ——
  const discovery = parse(await call('getRevisionSource', { objectType: targetType, objectName: targetName }));
  const discBody = discovery?.result || discovery;
  assert(discovery && !discovery.error, '发现模式成功返回（无错误）', discovery);
  assert(Array.isArray(discBody.availableVersions), `发现模式返回版本清单（${(discBody.availableVersions || []).length} 个版本）`, discBody);
  assert(String(discBody.message || '').includes('Discovery mode'), '发现模式带选择提示', discBody);
  assert((discBody.availableVersions || []).length > 0, `对象 ${targetName} 至少有一个版本（激活历史）`, discBody);
  process.stdout.write(`INFO 版本清单：${JSON.stringify(discBody.availableVersions.map(v => v.version || v.versionTitle))}\n`);

  // —— 2. index 选择：读清单第 1 个版本（最新）——
  const byIndex = parse(await call('getRevisionSource', { objectType: targetType, objectName: targetName, index: 1 }));
  const idxBody = byIndex?.result || byIndex;
  assert(byIndex && !byIndex.error, 'getRevisionSource index=1 成功返回（无错误）', byIndex);
  assert(typeof idxBody.source === 'string' && idxBody.source.length > 0, `版本 ${idxBody.version} 源码非空（${idxBody.lines} 行）`, idxBody);
  assert(idxBody.lines === idxBody.source.split('\n').length, '行数统计与源码一致', idxBody);
  process.stdout.write(`INFO index=1 命中版本 ${idxBody.version}，源码头 80 字符：${idxBody.source.slice(0, 80).replace(/\s+/g, ' ')}\n`);

  // —— 3. version 选择：用发现模式返回的标签回填 ——
  const firstLabel = discBody.availableVersions[0].version || discBody.availableVersions[0].versionTitle;
  if (firstLabel) {
    const byLabel = parse(await call('getRevisionSource', { objectType: targetType, objectName: targetName, version: String(firstLabel).toLowerCase() }));
    const labelBody = byLabel?.result || byLabel;
    assert(byLabel && !byLabel.error, `按标签（小写形式 '${String(firstLabel).toLowerCase()}'）读取成功`, byLabel);
    assert(labelBody.source === idxBody.source, '标签选择与序号选择读到同一版本源码（内容一致）');
  }

  // —— 4. 负例：未知版本标签 / 非法名字 / 非法 objectType ——
  const badVersion = await call('getRevisionSource', { objectType: targetType, objectName: targetName, version: 'NO_SUCH_VERSION' });
  assert(/-32602|not found/.test(JSON.stringify(badVersion)), '未知版本标签被拒绝（InvalidParams/not found）', badVersion);
  const badName = await call('getRevisionSource', { objectType: targetType, objectName: "A';--" });
  assert(/-32602/.test(JSON.stringify(badName)), '非法名字被 InvalidParams 拒绝', badName);
  const badType = await call('getRevisionSource', { objectType: 'XSLT', objectName: targetName });
  assert(/-32602/.test(JSON.stringify(badType)), '非法 objectType 被 InvalidParams 拒绝', badType);

  process.stdout.write('SMOKE OK: 版本源码只读工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
