// executeAbap 真机 smoke（sap-demo，devtools.execute-abap 受控执行链）：
// 全链走 MCP 面（工具自建 $TMP 临时程序 → 激活 → ABAP Unit 单次运行 → 删除），
// 覆盖 happy path（EXEC_RESULT 输出捕获）、运行时异常（PayloadFailure + 行号
// 回译）、编译失败（激活步 syntaxError）、keepProgram 保留语义（直连确认存在
// 后直连清理）与清理缺席（直连 GET 404）。临时程序全部 $TMP 本地包、无
// transport；串行；失败即退出。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ADTClient } from '../dist/adt/index.js';
import { lock, unLock } from '../dist/adt/api/objectcontents.js';
import pkgDelete from '../dist/adt/api/delete.js';
const deleteObject = pkgDelete.deleteObject ?? pkgDelete.default ?? pkgDelete;

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

const client = new Client({ name: 'exec-abap-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 800)}`); process.exit(1); }

/** 直连 ADT 会话（缺席验证与 keepProgram 清理用；stateful 模式）。 */
async function rawClient() {
  const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
  raw.stateful = 'stateful';
  await raw.h.login();
  return raw;
}

/** 缺席验证：直连 GET 程序 URL，404/异常 = 已删除。 */
async function assertAbsent(raw, programName, label) {
  try {
    await raw.h.request(`/sap/bc/adt/programs/programs/${programName.toLowerCase()}`, { method: 'GET' });
    fail(`${label}：临时程序 ${programName} 仍然存在（清理缺席验证失败）`);
  } catch (e) {
    const text = String(e?.message || e);
    // ADT 对不存在对象的 GET 抛 "X does not exist"（非 HTTP 状态码形态）
    if (!/404|not Found|not_found|NotFound|RESOURCE_NOT_FOUND|does not exist/i.test(text)) {
      fail(`${label}：缺席验证遇到非 404 异常`, { error: text.slice(0, 300) });
    }
  }
  pass(`${label}：临时程序已删除（缺席验证过）`);
}

async function main() {
  await client.connect(transport);

  // 0. catalog：executeAbap 在 focused（development-workbench）面
  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'executeAbap')) fail('executeAbap 不在 focused catalog');
  pass('executeAbap 在 focused catalog');

  const raw = await rawClient();
  try {
    // 1. happy path：字符串模板拼系统字段 → EXEC_RESULT 输出捕获 + 清理删除
    const ok = await call('executeAbap', {
      code: "lv_result = 'hello from executeAbap'.\nlv_result = |UNAME={ lv_result } SYSID={ sy-sysid }|."
    });
    const okBody = ok.structuredContent?.result ?? ok.result ?? ok;
    if (!okBody?.success) fail('happy path 未成功', okBody);
    if (!Array.isArray(okBody.output) || okBody.output.length !== 1) fail('happy path 输出数量异常', okBody);
    if (!/UNAME=hello from executeAbap SYSID=/.test(String(okBody.output[0]))) fail('happy path 输出内容不匹配', okBody);
    if (okBody.cleanedUp !== true) fail('happy path 临时程序未清理', okBody);
    if (!/^ZTEMP_EXEC_/.test(String(okBody.programName))) fail('临时程序名前缀异常', okBody);
    pass(`happy path：output=${JSON.stringify(okBody.output[0])} program=${okBody.programName}`);
    await assertAbsent(raw, okBody.programName, 'happy path');

    // 2. 运行时异常：除零 → PayloadFailure（exception）+ 仍清理
    const boom = await call('executeAbap', {
      code: 'DATA lv_zero TYPE i.\nlv_zero = 0.\nlv_result = |never|. \nDATA lv_d TYPE i.\nlv_d = 1 / lv_zero.\nlv_result = |also never|.'
    });
    const boomBody = boom.structuredContent?.result ?? boom.result ?? boom;
    if (boomBody?.success !== false) fail('运行时异常场景应软失败', boomBody);
    if (boomBody.failure?.kind !== 'exception') fail('failure.kind 应为 exception', boomBody);
    if (!/DIVIDE|ZERO/i.test(JSON.stringify(boomBody.failure))) fail('异常名应含除零语义', boomBody);
    if (boomBody.cleanedUp !== true) fail('异常场景临时程序未清理', boomBody);
    pass(`runtime exception：failure=${boomBody.failure?.kind}/${String(boomBody.failure?.title).slice(0, 60)}`);
    await assertAbsent(raw, boomBody.programName, 'runtime exception');

    // 3. 编译失败：未定义变量 → 激活步 syntaxError，不进入运行步
    const syntax = await call('executeAbap', { code: 'lv_result = undefined_variable_zz.' });
    const syntaxBody = syntax.structuredContent?.result ?? syntax.result ?? syntax;
    if (syntaxBody?.success !== false) fail('编译失败场景应软失败', syntaxBody);
    if (syntaxBody.failure?.kind !== 'syntaxError') fail('failure.kind 应为 syntaxError', syntaxBody);
    if (!/did not compile/i.test(String(syntaxBody.message))) fail('编译失败消息语义缺失', syntaxBody);
    if (syntaxBody.cleanedUp !== true) fail('编译失败场景临时程序未清理', syntaxBody);
    pass(`syntax error：title=${String(syntaxBody.failure?.title).slice(0, 70)}`);
    await assertAbsent(raw, syntaxBody.programName, 'syntax error');

    // 4. keepProgram：程序保留（直连确认存在）→ 直连锁删清理
    const kept = await call('executeAbap', {
      code: "lv_result = 'kept for inspection'.", keepProgram: true
    });
    const keptBody = kept.structuredContent?.result ?? kept.result ?? kept;
    if (keptBody?.success !== true || keptBody.cleanedUp !== false) fail('keepProgram 语义异常', keptBody);
    const keptName = keptBody.programName;
    try {
      await raw.h.request(`/sap/bc/adt/programs/programs/${keptName.toLowerCase()}`, { method: 'GET' });
    } catch {
      fail(`keepProgram：临时程序 ${keptName} 未保留`);
    }
    pass(`keepProgram：${keptName} 保留确认`);
    // 直连清理保留的临时程序（lock → DELETE）
    const lockHandle = String((await lock(raw.h, `/sap/bc/adt/programs/programs/${keptName.toLowerCase()}`, 'MODIFY')).LOCK_HANDLE || '');
    if (!lockHandle) fail(`keepProgram 清理加锁失败（${keptName}）`);
    await deleteObject(raw.h, `/sap/bc/adt/programs/programs/${keptName.toLowerCase()}`, lockHandle);
    pass(`keepProgram 清理完成（${keptName}）`);

    // 5. negative：非法 returnVariable 在 handler 层被拒（InvalidParams，无任何 SAP 调用）
    const badVar = await call('executeAbap', { code: 'lv_result = 1.', returnVariable: '1bad name' });
    // -32602 = MCP InvalidParams；消息文本含变量名规则（无 "invalid" 字样也认）
    if (!/-32602|InvalidParams|valid ABAP variable/i.test(JSON.stringify(badVar).slice(0, 400))) fail('非法 returnVariable 未被拒', badVar);
    pass('negative：非法 returnVariable 被拒');

    console.log('SMOKE OK: executeAbap real-dev 全场景通过');
  } finally {
    await client.close().catch(() => {});
    await raw.h.logout().catch(() => {});
  }
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
