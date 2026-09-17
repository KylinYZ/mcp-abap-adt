/**
 * 版本对比只读工具真机 smoke（矩阵行 revisions.compare 的
 * revision-compare-real-dev-smoke，全只读）。
 *
 * 验证目标（专用 DEV）：
 *   1. compareRevisions 相同版本对比 → identical=true
 *   2. 版本 vs current → diff/增删行计数（若当前源码与版本一致则 identical）
 *   3. 纯数字序号选择器（1/2）
 *   4. 负例：未知版本标签（InvalidParams）、缺 version1（InvalidParams）
 *
 * 用法：node ./scripts/revision-compare-real-dev-smoke.mjs <sap-dev.env路径> [对象类型] [对象名]
 * 默认目标 ZVCL_CAMPAIGN（CLAS，历史 campaign 验证对象）。
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

const client = new Client({ name: 'revision-compare-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('compareRevisions'), 'compareRevisions 已出现在真实运行时 catalog');

  // —— 1. 相同版本对比（1 vs 1）→ identical ——
  const same = parse(await call('compareRevisions', { objectType: targetType, objectName: targetName, version1: '1', version2: '1' }));
  const sameBody = same?.result || same;
  assert(same && !same.error, 'compareRevisions 相同版本成功返回（无错误）', same);
  assert(sameBody.identical === true && sameBody.diff === 'Sources are identical',
    '相同版本判定 identical 且无 diff 体', sameBody);

  // —— 2. 版本 vs current ——
  const vsCurrent = parse(await call('compareRevisions', { objectType: targetType, objectName: targetName, version1: '1' }));
  const vcBody = vsCurrent?.result || vsCurrent;
  assert(vsCurrent && !vsCurrent.error, 'compareRevisions 版本 vs current 成功返回（无错误）', vsCurrent);
  assert(vcBody.label2.endsWith('@current'), 'version2 缺省为 current', vcBody);
  assert(typeof vcBody.addedLines === 'number' && typeof vcBody.removedLines === 'number',
    `增删行计数返回（+${vcBody.addedLines}/-${vcBody.removedLines}）`, vcBody);
  assert(vcBody.identical === (vcBody.addedLines === 0 && vcBody.removedLines === 0),
    'identical 与增删行计数自洽', vcBody);
  if (!vcBody.identical) {
    assert(String(vcBody.diff).includes('@@'), 'diff 含 unified hunk 头', vcBody.diff.slice(0, 200));
    assert(String(vcBody.diff).split('\n').some(l => l.startsWith('+') && !l.startsWith('+++')),
      'diff 含新增行', vcBody.diff.slice(0, 200));
  }
  process.stdout.write(`INFO 对比结果：${vcBody.label1} vs ${vcBody.label2} identical=${vcBody.identical} (+${vcBody.addedLines}/-${vcBody.removedLines})\n`);
  process.stdout.write(`INFO diff 前 5 行：${String(vcBody.diff).split('\n').slice(0, 5).join(' | ').slice(0, 300)}\n`);

  // —— 3. 标签选择器：用 getRevisionSource 发现的标签回填两侧 ——
  const discovery = parse(await call('getRevisionSource', { objectType: targetType, objectName: targetName }));
  const discBody = discovery?.result || discovery;
  const label = discBody?.availableVersions?.[0]?.version;
  if (label) {
    const byLabel = parse(await call('compareRevisions', { objectType: targetType, objectName: targetName, version1: String(label).toLowerCase(), version2: String(label).toUpperCase() }));
    const lbBody = byLabel?.result || byLabel;
    assert(byLabel && !byLabel.error, '按标签（大小写混合形式）对比成功', byLabel);
    assert(lbBody.identical === true, '同标签两侧对比 identical', lbBody);
  }

  // —— 4. 负例 ——
  const badVersion = await call('compareRevisions', { objectType: targetType, objectName: targetName, version1: 'NO_SUCH_VERSION' });
  assert(/-32602|not found/.test(JSON.stringify(badVersion)), '未知版本被拒绝（InvalidParams/not found）', badVersion);
  const missing = await call('compareRevisions', { objectType: targetType, objectName: targetName });
  assert(/-32602|version1/.test(JSON.stringify(missing)), '缺 version1 被 InvalidParams 拒绝', missing);

  process.stdout.write('SMOKE OK: 版本对比只读工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
