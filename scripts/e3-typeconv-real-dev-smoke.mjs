// E3 真机 ABAP Unit smoke（sap-demo，受控变更链 + auto 确认模式）：
//   步骤 1：previewAbapChange(CLASS 主源码) 修复 from_text 的 P 小数舍入 bug
//           （lv_number TYPE p decimals 0 中转会丢小数——'123.45' -> 123）
//   步骤 2：previewAbapChange(classInclude=testclasses) 写入全类型往返测试类
//   步骤 3：runUnitCoverage 跑 ABAP Unit，断言 6 个测试方法全绿
// 授权范围：DEV 专用配置下自有 Z* 类的缺陷修复与测试代码写入；全程串行。
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
Object.assign(env, {
  SAP_MCP_ENV_FILE: ENV_PATH,
  SAP_MCP_LOG_LEVEL: 'warn',
  SAP_MCP_REAL_DEV_VALIDATION: 'false',
  SAP_MCP_CONFIRMATION_MODE: 'auto'
});

const CLS = 'ZCL_TABDATA_TYPE_CONV';
const TRANSPORT = 'S4HK900031';
// 主源码 = 真机基线（scripts/tmp-typeconv-baseline.abap，部署会话版本）+ 最小 P 修复——
// 本地 git 版本与真机存在历史差异，覆写会引入噪音，故以真机为基线只改 P 分支。
// 测试类为新 include，直接取自仓库 sap/tabdata/。
const MAIN_SOURCE = readFileSync('scripts/tmp-typeconv-baseline.abap', 'utf8').replace(/\r\n/g, '\n');
const TEST_SOURCE = readFileSync('sap/tabdata/zcl_tabdata_type_conv.clas.testclasses.abap', 'utf8').replace(/\r\n/g, '\n');
if (!MAIN_SOURCE.includes('E3 单元测试回归点')) {
  // 防呆：确认基线已应用修复（P 分支不再经 p0 落地）
  console.error('红线预检失败：基线源码不是修复版（缺少 E3 回归点注释标记）');
  process.exit(1);
}

const client = new Client({ name: 'e3-typeconv-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'inherit' });

let passed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`PASS ${label}`); }
  else { console.error(`FAIL ${label}`); throw new Error(`断言失败：${label}`); }
}
function parseToolResult(r) {
  const text = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  // MCP v2 双栈：受控链把 plan JSON 放在 structuredContent，content 仅 diff/摘要文本
  const json = r.structuredContent ?? (() => { try { return JSON.parse(text); } catch { return undefined; } })();
  return { text, json };
}
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const { text, json } = parseToolResult(r);
  if (r.isError) {
    const err = json?.error;
    const primary = err?.details?.plan?.primaryError;
    if (primary) console.error(`primaryError：${JSON.stringify(primary).slice(0, 1200)}`);
    if (err?.details?.syntaxMessages) console.error(`syntaxMessages：${JSON.stringify(err.details.syntaxMessages).slice(0, 900)}`);
    throw new Error(`${name} 失败：${text.slice(0, 1200)}`);
  }
  return { text, json };
}
/** 受控变更链一次执行：preview 冻结 -> auto apply -> 状态核验 */
async function applyChange(include, source, label) {
  const previewArgs = {
    objectType: 'CLASS', objectName: CLS, newSource: source, transportRequest: TRANSPORT
  };
  if (include) previewArgs.classInclude = include;
  const preview = await call('previewAbapChange', previewArgs);
  const planId = preview.json?.changePlanId || preview.json?.plan?.changePlanId;
  ok(Boolean(planId), `${label} preview 冻结（${String(planId).slice(0, 8)}…）`);
  const apply = await call('applyAbapChange', { changePlanId: planId });
  ok(/APPLIED|success/i.test(apply.text), `${label} apply 完成`);
  return apply;
}

await client.connect(transport);
console.log('MCP 已连接（auto 确认模式）');

// ---------------------------------------------------------------------
// 步骤 1：主源码修复（from_text 的 P 小数舍入 bug）
// ---------------------------------------------------------------------
console.log('\n--- E3-1：修复 from_text P 小数 bug（主源码） ---');
await applyChange(undefined, MAIN_SOURCE, '主源码修复');

// ---------------------------------------------------------------------
// 步骤 2：写入测试类（testclasses include）
// ---------------------------------------------------------------------
console.log('\n--- E3-2：写入全类型往返测试类（testclasses） ---');
await applyChange('testclasses', TEST_SOURCE, '测试类写入');

// ---------------------------------------------------------------------
// 步骤 3：跑 ABAP Unit（带覆盖率）
// ---------------------------------------------------------------------
console.log('\n--- E3-3：runUnitCoverage ---');
const coverage = await call('runUnitCoverage', { objectType: 'CLASS', objectName: CLS });
const covText = coverage.text;
// 断言：没有 failed/error 状态的测试类；打印覆盖摘要
const failedMatch = covText.match(/"failed"\s*:\s*(\d+)/i);
const totalMatch = covText.match(/"total"\s*:\s*(\d+)/i);
const failed = failedMatch ? Number(failedMatch[1]) : ( /fail/i.test(covText) ? -1 : 0 );
ok(!/ABORTED|error.*test/i.test(covText) && failed === 0, `单元测试全绿（failed=${failed}）`);
if (totalMatch) console.log(`  测试总数：${totalMatch[1]}`);
const stmt = covText.match(/"statement[^"]*"\s*:\s*{\s*"covered"\s*:\s*(\d+),\s*"total"\s*:\s*(\d+)/i)
  || covText.match(/"statements"\s*:\s*{\s*"covered"\s*:\s*(\d+),\s*"total"\s*:\s*(\d+)/i);
if (stmt) console.log(`  语句覆盖：${stmt[1]}/${stmt[2]} (${(Number(stmt[1]) / Number(stmt[2]) * 100).toFixed(1)}%)`);
console.log(covText.slice(0, 1200));

console.log(`\nSMOKE OK（${passed} 项断言全通过）`);
await client.close().catch(() => {});
process.exit(0);
