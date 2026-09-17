/**
 * i18n 按语言只读四工具真机 smoke（矩阵行 i18n.read 的
 * i18n-language-read-real-dev-smoke，全只读 GET）。
 *
 * 验证目标（专用 DEV）：
 *   1. getDataElementLabels  —— 数据元素四段标签按语言（标准元素 LANGU）
 *   2. getTextPoolInLanguage —— 程序文本池（标准报表 RFITEMAP 或自有对象）
 *   3. getObjectContentInLanguage / compareObjectLanguages —— 标准对象双语
 *      内容读取与行级对比
 *   4. 负例：非法语言键/非法名字在参数层被拒
 *
 * 用法：node ./scripts/i18n-language-read-real-dev-smoke.mjs <sap-dev.env路径>
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

const client = new Client({ name: 'i18n-language-read-real-dev-smoke', version: '1.0.0' });
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
  for (const tool of ['getObjectContentInLanguage', 'getDataElementLabels', 'getTextPoolInLanguage', 'compareObjectLanguages']) {
    assert(names.has(tool), `${tool} 已出现在真实运行时 catalog`);
  }

  // —— 1. getDataElementLabels：标准数据元素（DDIC 必有）双语对比 ——
  const en = parse(await call('getDataElementLabels', { dataElement: 'LANGU', language: 'EN' }));
  const enBody = en?.result || en;
  assert(en && !en.error, 'getDataElementLabels language=EN 成功返回（无错误）', en);
  assert(enBody.labels && typeof enBody.labels === 'object', '返回 labels 对象', enBody);
  assert(enBody.labels.short || enBody.labels.medium || enBody.labels.long || enBody.labels.heading,
    `标签非空（short=${enBody.labels.short || '-'}）`, enBody.labels);
  assert(enBody.language === 'EN', '回显语言键 EN', enBody);
  assert(String(enBody.note || '').includes('master language'), '标注主语言回退行为差异', enBody);
  const de = parse(await call('getDataElementLabels', { dataElement: 'LANGU', language: 'DE' }));
  const deBody = de?.result || de;
  assert(de && !de.error, 'getDataElementLabels language=DE 成功返回', de);
  process.stdout.write(`INFO LANGU 标签 EN=${JSON.stringify(enBody.labels)} DE=${JSON.stringify(deBody.labels)}\n`);

  // —— 2. getTextPoolInLanguage：标准报表文本池（RFITEMAP 为常用应收报表）——
  const pool = parse(await call('getTextPoolInLanguage', { program: 'RFITEMAP', language: 'EN' }));
  const poolBody = pool?.result || pool;
  assert(pool && !pool.error, 'getTextPoolInLanguage 成功返回（无错误）', pool);
  assert(Array.isArray(poolBody.entries), '返回 entries 数组', poolBody);
  assert(Array.isArray(poolBody.missing), '返回 missing 子资源清单', poolBody);
  assert(poolBody.entries.every(e => ['I', 'S', 'H'].includes(e.id) && typeof e.key === 'string'),
    '条目 id/key 合法', poolBody.entries.slice(0, 3));
  process.stdout.write(`INFO RFITEMAP 文本池 ${poolBody.entries.length} 条（missing=${JSON.stringify(poolBody.missing)}），样例：${JSON.stringify(poolBody.entries.slice(0, 2))}\n`);

  // —— 3. getObjectContentInLanguage + compareObjectLanguages：标准报表双语内容 ——
  const content = parse(await call('getObjectContentInLanguage', { objectType: 'PROG', objectName: 'RFITEMAP', language: 'EN' }));
  const contentBody = content?.result || content;
  assert(content && !content.error, 'getObjectContentInLanguage 成功返回（无错误）', content);
  assert(typeof contentBody.content === 'string' && contentBody.content.length > 0 && contentBody.lines > 0,
    `对象内容非空（${contentBody.lines} 行）`, contentBody);
  const compare = parse(await call('compareObjectLanguages', { objectType: 'PROG', objectName: 'RFITEMAP', sourceLanguage: 'EN', targetLanguage: 'DE' }));
  const compareBody = compare?.result || compare;
  assert(compare && !compare.error, 'compareObjectLanguages 成功返回（无错误）', compare);
  assert(compareBody.totalLines > 0 && Array.isArray(compareBody.entries) && typeof compareBody.differing === 'number',
    `对比结构完整（totalLines=${compareBody.totalLines} differing=${compareBody.differing}）`, compareBody);
  assert(compareBody.differing === compareBody.entries.length, 'differing 与 entries 长度一致', compareBody);
  process.stdout.write(`INFO 双语对比：EN ${compareBody.totalLines} 行 vs DE，差异 ${compareBody.differing} 行（纯代码行通常无差异）\n`);

  // —— 4. 负例：参数层拒绝 ——
  const badLang = await call('getDataElementLabels', { dataElement: 'LANGU', language: 'CHN' });
  assert(/-32602|language key/.test(JSON.stringify(badLang)), '非法语言键被 InvalidParams 拒绝', badLang);
  const badName = await call('getTextPoolInLanguage', { program: "Z';--", language: 'EN' });
  assert(/-32602|repository name/.test(JSON.stringify(badName)), '非法程序名被 InvalidParams 拒绝', badName);

  process.stdout.write('SMOKE OK: i18n 按语言只读四工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
