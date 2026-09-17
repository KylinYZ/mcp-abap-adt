/**
 * 对象间源码对比只读工具真机 smoke（矩阵行 crud.compare-source 的
 * compare-source-real-dev-smoke，全只读）。
 *
 * 验证目标（专用 DEV）：
 *   1. 同对象自比 → identical=true
 *   2. 两个真实对象对比 → diff/增删行计数/行数统计
 *   3. 负例：非法 objectType/缺字段/非法名字被 InvalidParams 拒绝
 *
 * 用法：node ./scripts/compare-source-real-dev-smoke.mjs <sap-dev.env路径> [对象1类型] [对象1名] [对象2类型] [对象2名]
 * 默认对比 ZVCL_CAMPAIGN（CLAS）与 ZVCLINCSMK 残留类——若 ZVCLINCSMK 不存在，
 * 退化为 ZVCL_CAMPAIGN 自比 + RFITEMAP 程序对比。
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const t1 = String(process.argv[3] || 'CLAS').trim().toUpperCase();
const n1 = String(process.argv[4] || 'ZVCL_CAMPAIGN').trim().toUpperCase();
let t2 = String(process.argv[5] || 'CLAS').trim().toUpperCase();
let n2 = String(process.argv[6] || 'ZVCLINCSMK').trim().toUpperCase();
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
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false'
});

const client = new Client({ name: 'compare-source-real-dev-smoke', version: '1.0.0' });
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
  assert(names.has('compareSourceObjects'), 'compareSourceObjects 已出现在真实运行时 catalog');

  // —— 1. 同对象自比 → identical ——
  const self = parse(await call('compareSourceObjects', { objectType1: t1, objectName1: n1, objectType2: t1, objectName2: n1 }));
  const selfBody = self?.result || self;
  assert(self && !self.error, '同对象自比成功返回（无错误）', self);
  assert(selfBody.identical === true && selfBody.diff === 'Sources are identical',
    '同对象自比判定 identical 且无 diff 体', selfBody);
  assert(selfBody.lines1 === selfBody.lines2 && selfBody.lines1 > 0, `行数统计一致（${selfBody.lines1} 行）`, selfBody);

  // —— 2. 两个不同对象对比（先探测第二对象是否存在）——
  const probe = await call('getObjectSource', { objectType: t2, objectName: n2 }).catch(() => null);
  const probeBody = probe ? parse(probe) : null;
  if (!probeBody || probeBody.error || String(probeBody.__unparsed || '').includes('not')) {
    // 退化为 CLAS vs PROG（标准对象必有）
    t2 = 'PROG';
    n2 = 'RFITEMAP';
  }
  const diff = parse(await call('compareSourceObjects', { objectType1: t1, objectName1: n1, objectType2: t2, objectName2: n2 }));
  const diffBody = diff?.result || diff;
  assert(diff && !diff.error, `compareSourceObjects ${n1} vs ${n2} 成功返回（无错误）`, diff);
  assert(typeof diffBody.identical === 'boolean', 'identical 判定返回', diffBody);
  if (!diffBody.identical) {
    assert(diffBody.addedLines > 0 && diffBody.removedLines > 0, `增删行计数（+${diffBody.addedLines}/-${diffBody.removedLines}）`, diffBody);
    assert(String(diffBody.diff).includes('@@'), 'diff 含 unified hunk 头', diffBody.diff.slice(0, 200));
    assert(diffBody.label1 === `${t1}:${n1}` && diffBody.label2 === `${t2}:${n2}`, '两侧标注正确', diffBody);
  }
  assert(diffBody.lines1 > 0 && diffBody.lines2 > 0, '两侧行数统计非零', diffBody);
  process.stdout.write(`INFO 对比：${diffBody.label1}（${diffBody.lines1} 行） vs ${diffBody.label2}（${diffBody.lines2} 行） identical=${diffBody.identical} (+${diffBody.addedLines}/-${diffBody.removedLines})\n`);

  // —— 3. 负例：参数层拒绝 ——
  const badKind = await call('compareSourceObjects', { objectType1: 'TABL', objectName1: 'Z1', objectType2: 'PROG', objectName2: 'Z2' });
  assert(/-32602|objectType1/.test(JSON.stringify(badKind)), '非法 objectType1 被 InvalidParams 拒绝', badKind);
  const missing = await call('compareSourceObjects', { objectType1: 'PROG', objectName1: 'Z1', objectType2: 'PROG' });
  assert(/-32602|objectName2/.test(JSON.stringify(missing)), '缺 objectName2 被 InvalidParams 拒绝', missing);
  const badName = await call('compareSourceObjects', { objectType1: 'PROG', objectName1: "Z';--", objectType2: 'PROG', objectName2: 'Z2' });
  assert(/-32602|not a repository name/.test(JSON.stringify(badName)), '非法名字被 InvalidParams 拒绝', badName);

  process.stdout.write('SMOKE OK: 对象间源码对比只读工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
