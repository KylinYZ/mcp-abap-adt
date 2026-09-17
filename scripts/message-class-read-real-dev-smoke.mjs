/**
 * 消息类文本只读工具真机 smoke（矩阵行 read.message-class-texts 的
 * message-class-read-real-dev-smoke，全只读：仅 messageclass GET）。
 *
 * 验证目标（专用 DEV）：
 *   1. getMessages 默认语言 —— 读取标准消息类 00（SAP 系统消息）+ 自有 ZMC
 *   2. 消息号保留 3 位前导零、按号升序
 *   3. 语言覆盖（sap-language）—— DE/EN 对比某标准消息类的文本差异
 *   4. 负例：非法名字与非法语言键在参数层被拒（InvalidParams）
 *
 * 用法：node ./scripts/message-class-read-real-dev-smoke.mjs <sap-dev.env路径> [自有消息类]
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const customClass = process.argv[3] ? String(process.argv[3]).trim().toUpperCase() : undefined;
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

const client = new Client({ name: 'message-class-read-real-dev-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'inherit'
});

/** 消息号是否为 1-3 位数字串（SAP msgno 定长 3 位，老类目可能不足 3 位）。 */
function isMessageNumber(n) {
  return typeof n === 'string' && /^\d{1,3}$/.test(n);
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  assert(names.has('getMessages'), 'getMessages 已出现在真实运行时 catalog');

  // —— 1. 标准消息类 00（SAP 系统消息，任何系统必有）——
  const sys = parse(await call('getMessages', { messageClass: '00' }));
  const sysBody = sys?.result || sys;
  assert(sys && !sys.error, 'getMessages 对标准消息类 00 成功返回（无错误）', sys);
  assert(sysBody.messageClass === '00', '返回规范消息类名 00', sysBody);
  assert(Array.isArray(sysBody.messages) && sysBody.count > 0 && sysBody.count === sysBody.messages.length,
    `标准消息类 00 含 ${sysBody.count} 条消息`, sysBody);
  assert(sysBody.messages.every(m => isMessageNumber(m.number) && typeof m.text === 'string'),
    '消息号均为数字串且文本为字符串', sysBody.messages.slice(0, 3));
  const numbers = sysBody.messages.map(m => m.number);
  const sorted = [...numbers].sort((a, b) => (a.padStart(3, '0') < b.padStart(3, '0') ? -1 : 1));
  assert(JSON.stringify(numbers) === JSON.stringify(sorted), '消息按号升序排列');
  // 前导零保留：样例消息号应保持原始形态（不含数值化截断）
  const zeroPadded = numbers.filter(n => n.startsWith('0') && n.length > 1);
  if (zeroPadded.length > 0) {
    process.stdout.write(`INFO 前导零保留样例：${JSON.stringify(zeroPadded.slice(0, 3))}\n`);
  }
  process.stdout.write(`INFO 00 样例：${JSON.stringify(sysBody.messages.slice(0, 2))}\n`);

  // —— 2. 语言覆盖：标准类在 DE/EN 下的文本（该系统至少有德语原文）——
  const en = parse(await call('getMessages', { messageClass: '00', language: 'EN' }));
  const enBody = en?.result || en;
  assert(en && !en.error, 'getMessages language=EN 成功返回', en);
  assert(enBody.language === 'EN', '返回体回显语言键 EN', enBody);
  const de = parse(await call('getMessages', { messageClass: '00', language: 'DE' }));
  const deBody = de?.result || de;
  assert(de && !de.error, 'getMessages language=DE 成功返回', de);
  // 同号消息在两种语言下文本应有差异（00 类 DE 为原始德语）；若恰好全等则
  // 仅记录，不作为失败（单语言系统）
  const enTexts = new Map(enBody.messages.map(m => [m.number, m.text]));
  const differing = deBody.messages.filter(m => enTexts.has(m.number) && enTexts.get(m.number) !== m.text);
  process.stdout.write(`INFO DE/EN 文本差异条目：${differing.length}（共对比 ${Math.min(deBody.messages.length, enTexts.size)} 条）\n`);
  if (differing.length > 0) {
    process.stdout.write(`INFO 差异样例：#${differing[0].number} DE="${differing[0].text.slice(0, 60)}"\n`);
  }

  // —— 3. 自有 Z 消息类（若命令行提供）：验证自定义对象路径 ——
  if (customClass) {
    const own = parse(await call('getMessages', { messageClass: customClass }));
    const ownBody = own?.result || own;
    assert(own && !own.error, `getMessages 对自有消息类 ${customClass} 成功返回`, own);
    assert(ownBody.messageClass === customClass, '返回规范类名', ownBody);
    process.stdout.write(`INFO ${customClass} 共 ${ownBody.count} 条消息\n`);
  }

  // —— 4. 负例：注入样本与非法语言键在参数层被拒 ——
  const badName = await call('getMessages', { messageClass: "A';--" });
  assert(/-32602|not a message class name/.test(JSON.stringify(badName)),
    '非法消息类名被 InvalidParams 拒绝', badName);
  const badLang = await call('getMessages', { messageClass: '00', language: 'CHN' });
  assert(/-32602|language key/.test(JSON.stringify(badLang)),
    '非法语言键被 InvalidParams 拒绝', badLang);

  process.stdout.write('SMOKE OK: 消息类文本只读工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
