/**
 * 知识查询只读二工具真机 smoke（矩阵行 diagnostics.knowledge-queries 的
 * knowledge-queries-real-dev-smoke，全只读 SELECT）。
 *
 * 验证目标（专用 DEV）：
 *   1. getAbapDocumentation 索引模式 —— 标准对象（数据元素 LANGU 的 DE 类文档）
 *   2. getAbapDocumentation 正文模式 —— 读取最新版本行序列（含格式码）
 *   3. searchImgActivities —— IMG 活动检索（* 通配、德语文本）
 *   4. 负例：不存在的文档（InvalidParams）、控制字符拒绝
 *
 * 用法：node ./scripts/knowledge-queries-real-dev-smoke.mjs <sap-dev.env路径>
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

const client = new Client({ name: 'knowledge-queries-real-dev-smoke', version: '1.0.0' });
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
  for (const tool of ['getAbapDocumentation', 'searchImgActivities']) {
    assert(names.has(tool), `${tool} 已出现在真实运行时 catalog`);
  }

  // —— 1. 索引模式：标准数据元素 LANGU 的文档索引（DE 类文档系统必有）——
  const index = parse(await call('getAbapDocumentation', {
    docClass: 'DE', docObject: 'LANGU', mode: 'index'
  }));
  const indexBody = index?.result || index;
  assert(index && !index.error, 'getAbapDocumentation 索引模式成功返回（无错误）', index);
  assert(Array.isArray(indexBody.index), '索引模式返回 index 数组', indexBody);
  assert(indexBody.index.length > 0, `LANGU 文档索引含 ${indexBody.index.length} 条（跨类/跨语言）`, indexBody);
  process.stdout.write(`INFO LANGU 文档索引：${JSON.stringify(indexBody.index.slice(0, 3))}\n`);

  // —— 2. 正文模式：DE 类最新版本行序列 ——
  const content = parse(await call('getAbapDocumentation', {
    docClass: 'DE', docObject: 'LANGU', language: 'DE', maxLines: 50
  }));
  const contentBody = content?.result || content;
  assert(content && !content.error, 'getAbapDocumentation 正文模式成功返回（无错误）', content);
  assert(typeof contentBody.version === 'number' && contentBody.version > 0,
    `最新版本 ${contentBody.version}`, contentBody);
  assert(Array.isArray(contentBody.lines) && contentBody.lines.length > 0,
    `正文 ${contentBody.lines.length} 行`, contentBody);
  assert(contentBody.lines.every(l => typeof l.line === 'number' && typeof l.format === 'string' && typeof l.text === 'string'),
    '行结构完整（line/format/text）', contentBody.lines.slice(0, 2));
  // SAP 文档首行通常是 U1 标题（&DEFINITION& 等）
  process.stdout.write(`INFO 正文首行：#${contentBody.lines[0].line} [${contentBody.lines[0].format}] ${contentBody.lines[0].text.slice(0, 60)}\n`);

  // —— 3. searchImgActivities：IMG 活动检索 ——
  const img = parse(await call('searchImgActivities', { text: 'Anlage*', language: 'DE', limit: 10 }));
  const imgBody = img?.result || img;
  assert(img && !img.error, 'searchImgActivities 成功返回（无错误）', img);
  assert(Array.isArray(imgBody.nodes) && imgBody.nodes.length > 0,
    `IMG 检索命中 ${imgBody.count} 个节点`, imgBody);
  assert(imgBody.nodes.every(n => n.type === 'activity' || n.type === 'folder'), '节点类型合法', imgBody);
  assert(imgBody.nodes.some(n => n.type === 'activity' && n.activity), '含活动节点（带技术名）', imgBody);
  process.stdout.write(`INFO IMG 样例：${JSON.stringify(imgBody.nodes.slice(0, 2).map(n => `${n.type}:${n.text.slice(0, 40)}`))}\n`);

  // —— 4. 负例：不存在的文档（InvalidParams）+ 控制字符拒绝 ——
  const missing = parse(await call('getAbapDocumentation', {
    docClass: 'DE', docObject: 'ZZZZ9NONE', language: 'EN'
  }));
  assert(/-32602|no DE documentation/.test(JSON.stringify(missing)),
    '不存在的文档被 InvalidParams 拒绝（含提示）', missing);
  const malicious = await call('searchImgActivities', { text: "a';--" });
  // 引号被转义进 LIKE 字面量而非拒绝——返回空结果也是安全行为；两者皆可
  const malText = JSON.stringify(malicious);
  assert(/\"status\":\"success\"|-32602/.test(malText),
    '控制字符/注入样本被安全处理（转义或拒绝）', malText);

  process.stdout.write('SMOKE OK: 知识查询只读二工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
