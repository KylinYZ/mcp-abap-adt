/**
 * UI5 只读三工具真机 smoke（矩阵行 ui5.read 的 ui5-readonly-real-dev-smoke，
 * 全只读，零 SAP 写操作）。
 *
 * 验证目标（专用 DEV）：
 *   1. ui5ListApps      —— filestore 应用清单（Atom feed 解析 + 客户端过滤）
 *   2. ui5GetApp        —— 选中应用的文件树
 *   3. ui5GetFileContent —— 文件树中一个真实文件的原始内容
 *   4. 负例：路径穿越输入被 InvalidParams 拒绝（零网络往返）
 *
 * 用法：node ./scripts/ui5-readonly-real-dev-smoke.mjs <sap-dev.env路径>
 * 应用选择：优先取清单里的 Z/Y 自定义应用；没有则取第一个标准应用
 * （专用 DEV 实测系统带大量标准 UI5 应用，且 name 查询参数被系统忽略）。
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');

// 红线检查：环境文件必须指向专用 DEV（10.30.254.48 / client 300），否则立即停止
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

const client = new Client({ name: 'ui5-readonly-real-dev-smoke', version: '1.0.0' });
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
  for (const tool of ['ui5ListApps', 'ui5GetApp', 'ui5GetFileContent']) {
    assert(names.has(tool), `${tool} 已出现在真实运行时 catalog`);
  }

  // —— 1. ui5ListApps：全量清单（系统实测忽略 name 参数，客户端过滤兜底）——
  const list = parse(await call('ui5ListApps', { maxResults: 200 }));
  const listBody = list?.result || list;
  assert(list && !list.error, 'ui5ListApps 成功返回（无错误）', list);
  assert(Array.isArray(listBody.apps) && listBody.apps.length > 0,
    `ui5ListApps 返回 ${listBody.apps.length} 个应用（feedEntries=${listBody.feedEntries}）`, listBody);
  assert(typeof listBody.truncated === 'boolean' && typeof listBody.feedEntries === 'number',
    'ui5ListApps 返回截断与 feed 统计字段', listBody);
  process.stdout.write(`INFO 应用清单：feed ${listBody.feedEntries} 条，返回 ${listBody.apps.length} 个（truncated=${listBody.truncated}）\n`);
  const allNames = listBody.apps.map(a => a.name);
  process.stdout.write(`INFO 应用样例：${JSON.stringify(allNames.slice(0, 5))}\n`);

  // 客户端通配符过滤通道：Z* 查询应正确过滤或返回空（系统忽略服务端过滤）
  const zList = parse(await call('ui5ListApps', { query: 'Z*', maxResults: 50 }));
  const zBody = zList?.result || zList;
  assert(zList && !zList.error, 'ui5ListApps Z* 过滤成功返回', zList);
  assert(zBody.apps.every(app => String(app.name).toUpperCase().startsWith('Z')),
    'Z* 过滤结果全部以 Z 开头（客户端过滤生效）', zBody.apps);
  process.stdout.write(`INFO Z* 过滤命中 ${zBody.apps.length} 个自定义应用\n`);

  // —— 2. 选应用：优先 Z/Y 自定义应用，否则第一个标准应用 ——
  const custom = allNames.find(n => /^[ZY]/.test(String(n).toUpperCase()));
  const targetApp = custom || allNames[0];
  assert(targetApp, `选中目标应用 ${targetApp}`);
  process.stdout.write(`INFO 选中应用：${targetApp}${custom ? '（自定义）' : '（标准）'}\n`);

  // —— 3. ui5GetApp：文件树 ——
  const app = parse(await call('ui5GetApp', { appName: targetApp }));
  const appBody = app?.result || app;
  assert(app && !app.error, 'ui5GetApp 成功返回（无错误）', app);
  assert(appBody.appName === String(targetApp).toUpperCase(), 'ui5GetApp 返回规范应用名', appBody);
  assert(Array.isArray(appBody.files) && appBody.files.length > 0,
    `ui5GetApp 返回 ${appBody.files.length} 条文件树条目`, appBody);
  assert(appBody.files.every(f => String(f.path).startsWith('/')),
    '文件树路径全部以 / 开头（相对应用根）', appBody);
  assert(appBody.files.every(f => f.type === 'file' || f.type === 'folder'),
    '文件树条目类型合法（file/folder）', appBody);
  process.stdout.write(`INFO 文件树样例：${JSON.stringify(appBody.files.slice(0, 4).map(f => `${f.type}:${f.path}`))}\n`);

  // —— 4. ui5GetFileContent：读取树中一个真实文件（优先 .project 等小文件）——
  const candidates = appBody.files.filter(f => f.type === 'file');
  const preferred = candidates.find(f => /(^|\/)\.project$/i.test(f.path)) || candidates[0];
  assert(preferred, '文件树中至少存在一个文件条目', appBody.files);
  const relativePath = String(preferred.path).replace(/^\//, '');
  const file = parse(await call('ui5GetFileContent', { appName: targetApp, filePath: relativePath }));
  const fileBody = file?.result || file;
  assert(file && !file.error, 'ui5GetFileContent 成功返回（无错误）', file);
  assert(typeof fileBody.content === 'string' && fileBody.content.length > 0,
    `文件 ${relativePath} 内容非空（${fileBody.size} bytes）`, fileBody);
  assert(fileBody.appName === String(targetApp).toUpperCase() && fileBody.size > 0,
    '返回体带应用名与字节统计', fileBody);
  process.stdout.write(`INFO ${relativePath} 前 120 字符：${fileBody.content.slice(0, 120).replace(/\s+/g, ' ')}\n`);

  // —— 5. 负例：路径穿越在进入网络前被拒（MCP InvalidParams -32602）——
  // SDK 对工具层 McpError 可能返回 isError 结果或 error 字段两种形态，统一
  // 序列化后匹配错误码
  const traversal = await call('ui5GetFileContent', { appName: targetApp, filePath: '../../etc/passwd' });
  assert(/-32602/.test(JSON.stringify(traversal)),
    '路径穿越输入被 InvalidParams 拒绝（-32602）', traversal);

  process.stdout.write('SMOKE OK: UI5 只读三工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
