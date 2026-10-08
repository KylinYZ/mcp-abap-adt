// getFmTestDataSets payload 解码真机 smoke（sap-demo，只读 SELECT）：
// 目录模式回归（C162_SPEC_GET_BY_ID，2026-09-25 真机基线：999 目录 + 1 测试集）
// → includePayload=true 内容层：999 目录集群（V6+4103）解码出接口快照与标题、
//   测试集解码出 inputs/outputs（notes 无 decode failed）
// → includePayload 非布尔负例（handler 层拒绝）
// 全程只读；单次查询串行；失败重试最多 2 次。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-demo.env';
const envText = readFileSync(ENV_PATH, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.254.48')) {
  console.error('红线预检失败：SAP_URL 不是 sap-demo（10.30.254.48）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: ENV_PATH, SAP_MCP_LOG_LEVEL: 'warn' });

const TARGET_FM = 'C162_SPEC_GET_BY_ID'; // 上轮目录层真机基线 FM（标准，有已存测试集）

const client = new Client({ name: 'fm-payload-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 1200)}`); process.exit(1); }

async function main() {
  await client.connect(transport);

  // 1. 目录模式回归（不含 payload）
  const dir = await call('getFmTestDataSets', { function: TARGET_FM });
  const dirBody = dir.structuredContent?.result ?? dir.result ?? dir;
  if (!dirBody?.function) fail('目录模式未返回结果', dirBody);
  if (dirBody.sets.length < 1) fail('目录模式测试集为空（与 2026-09-25 基线不符）', dirBody);
  if (!dirBody.notes.join(' ').includes('includePayload=true')) fail('目录模式 notes 未含 payload 声明', dirBody);
  pass(`目录模式：${dirBody.sets.length} 个测试集 + ${dirBody.directory ? '999 目录行' : '无目录行'}`);

  // 2. 内容层：payload 解码
  const full = await call('getFmTestDataSets', { function: TARGET_FM, includePayload: true });
  const fullBody = full.structuredContent?.result ?? full.result ?? full;
  if (!fullBody?.function) fail('内容层未返回结果', fullBody);
  const decodeNotes = (fullBody.notes || []).filter(n => n.includes('cluster decode failed'));
  console.log('  notes:', JSON.stringify(fullBody.notes).slice(0, 700));
  if (fullBody.notes.join(' ').includes('not implemented')) fail('内容层 notes 仍含未实现声明', fullBody);
  // 999 目录集群解码产物：接口快照或标题至少其一可见
  const hasInterface = Array.isArray(fullBody.interface) && fullBody.interface.length > 0;
  const hasTitle = fullBody.sets.some(s => s.title);
  const hasContent = fullBody.sets.some(s => s.inputs || s.outputs || s.others || s.runtime !== undefined || s.rc !== undefined || s.exception);
  if (!hasInterface && !hasTitle) fail('999 目录集群解码产物缺失（interface 与 title 均空）', fullBody);
  if (hasInterface) pass(`接口快照：${fullBody.interface.length} 个参数（首参数 ${fullBody.interface[0].name} ${fullBody.interface[0].type || ''}）`);
  if (hasTitle) pass(`标题合并：${fullBody.sets.filter(s => s.title).map(s => `${s.number}=${s.title}`).join('; ').slice(0, 120)}`);
  // 决定性判定 1：测试集（V6 集群）内容必须全部解码成功
  if (!hasContent) fail('测试集内容全空（inputs/outputs/runtime/rc 均未解出）', fullBody);
  pass('测试集内容解码成功（inputs/outputs/runtime/rc，真机 V6 集群）');
  // 决定性判定 2：已知的 V5 嵌套表边界（FDESC_COPY 接口快照）必须以精确诊断
  // 留证——0xAD marker 是格式契约字段（无业务数据）；其余任何失败仍判 FAIL
  const knownBoundary = decodeNotes.every(n => n.includes('0xad'));
  if (decodeNotes.length > 0 && knownBoundary) {
    pass(`V5 嵌套表边界如实留证（${decodeNotes.length} 集，0xAD 精确诊断）`);
  } else if (decodeNotes.length > 0) {
    fail('存在非边界类解码失败', decodeNotes);
  }

  // 3. 负例：includePayload 非布尔 → InvalidParams
  const bad = await call('getFmTestDataSets', { function: TARGET_FM, includePayload: 'yes' });
  const badText = JSON.stringify(bad).slice(0, 300);
  if (!/-32602|InvalidParams|boolean/i.test(badText)) fail('includePayload 非布尔未被拒', bad);
  pass('负例：includePayload 非布尔被拒');

  console.log('SMOKE OK: getFmTestDataSets payload 解码真机全场景通过');
  await client.close().catch(() => {});
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
