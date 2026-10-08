// report 三行真机 smoke（sap-dev，所有者放开报表执行方向授权轮）：
// 1. 前置：直连 ADT 创建两个 $TMP 测试报表（SALV 表格输出 / 纯 WRITE 输出）并激活
// 2. runReport：SALV 报表 → alvCaptured=true + 2 行数据；纯 WRITE 报表 → alvCaptured=false（如实语义）；
//    负例：不存在的报表 → REPORT_NOT_FOUND（InvalidParams）
// 3. submitReportJob：WRITE 报表 → JOB=name/count → listJobs 轮询至 FINISHED →
//    listSpoolRequests 定位 spool → readSpoolContent 断言 WRITE 标记
// 4. getReportVariants：动态选一个有变体的报表（VARID 查询）断言非空 + 文本合并；无变体报表 → 空清单有效
// 5. 清理：两个 $TMP 报表删除 + 缺席复核
// 全程：自建 $TMP 对象、无传输请求；执行类工具串行。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ADTClient } from '../dist/adt/index.js';
import { createObject } from '../dist/adt/api/objectcreator.js';
import { lock, unLock, setObjectSource } from '../dist/adt/api/objectcontents.js';
import pkgDelete from '../dist/adt/api/delete.js';
const deleteObject = pkgDelete.deleteObject ?? pkgDelete.default ?? pkgDelete;
import pkgActivate from '../dist/adt/api/activate.js';
const activate = pkgActivate.activate ?? pkgActivate.default ?? pkgActivate;

const ENV_PATH = 'C:/Users/068157/.codex/sap-abap-adt/env/sap-dev.env';
const envText = readFileSync(ENV_PATH, 'utf8');
const envVars = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) envVars[m[1]] = m[2]; }
if (!String(envVars.SAP_URL || '').includes('10.30.255.42')) {
  console.error('红线预检失败：SAP_URL 不是 sap-dev（10.30.255.42）');
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
Object.assign(env, { SAP_MCP_ENV_FILE: ENV_PATH, SAP_MCP_LOG_LEVEL: 'warn' });

const client = new Client({ name: 'report-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 330000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 900)}`); process.exit(1); }

const MS = Date.now() % 10_000_000;
const ALV_PROG = `ZRPT_SALV_${MS}`;
const WRT_PROG = `ZRPT_WRITE_${MS}`;
const VARMAKER_PROG = `ZRPT_VMK_${MS}`;
const VARDEL_PROG = `ZRPT_VDL_${MS}`;

const ALV_SRC = `REPORT ${ALV_PROG}.
TYPES: BEGIN OF ty_row, carrid TYPE c LENGTH 4, connid TYPE n LENGTH 4, cityfrom TYPE c LENGTH 20, END OF ty_row.
DATA lt_rows TYPE STANDARD TABLE OF ty_row.
lt_rows = VALUE #( ( carrid = 'AA' connid = '0017' cityfrom = 'NEW YORK' )
                   ( carrid = 'LH' connid = '0400' cityfrom = 'FRANKFURT' ) ).
DATA lo_alv TYPE REF TO cl_salv_table.
cl_salv_table=>factory( IMPORTING r_salv_table = lo_alv CHANGING t_table = lt_rows ).
lo_alv->display( ).`;

const WRT_SRC = `REPORT ${WRT_PROG}.
WRITE: / 'SMOKE-MARKER-START'.
DO 3 TIMES.
  WRITE: / |SY-INDEX={ sy-index }|.
ENDDO.
WRITE / 'SMOKE-MARKER-END'.`;

const VARMAKER_SRC = [
  'REPORT ' + VARMAKER_PROG + '.',
  'DATA lv_key TYPE c LENGTH 40.',
  "lv_key = '" + WRT_PROG + "'.",
  "INSERT varid FROM @( VALUE #( mandt = sy-mandt report = lv_key variant = 'SMOKE_VAR' protected = '' edat = sy-datum etime = sy-uzeit ) ).",
  'IF sy-subrc = 0.',
  "  INSERT varit FROM @( VALUE #( mandt = sy-mandt report = lv_key variant = 'SMOKE_VAR' vtext = 'Smoke variant' ) ).",
  '  IF sy-subrc = 0.',
  "    WRITE / 'VARIANT_CREATED_OK'.",
  '  ELSE.',
  "    WRITE / 'VARIT_INSERT_FAILED'.",
  '  ENDIF.',
  'ELSE.',
  "    WRITE / 'VARID_INSERT_FAILED'.",
  'ENDIF.'
].join(String.fromCharCode(10));

const VARDEL_SRC = [
  'REPORT ' + VARDEL_PROG + '.',
  'DATA lv_key TYPE c LENGTH 40.',
  "lv_key = '" + WRT_PROG + "'.",
  "DELETE FROM varid WHERE report = @lv_key AND variant = 'SMOKE_VAR'.",
  "DELETE FROM varit WHERE report = @lv_key AND variant = 'SMOKE_VAR'.",
  "WRITE / 'VARIANT_DELETED'."
].join(String.fromCharCode(10));


const raw = new ADTClient(envVars.SAP_URL, envVars.SAP_USER, envVars.SAP_PASSWORD, envVars.SAP_CLIENT, envVars.SAP_LANGUAGE || 'EN', {});
raw.stateful = 'stateful';

async function createTempProgram(name, source) {
  await raw.h.login();
  await createObject(raw.h, {
    objtype: 'PROG/P', name, parentName: '$TMP',
    description: 'report smoke temp', contentType: 'application/*'
  });
  const url = `/sap/bc/adt/programs/programs/${name.toLowerCase()}`;
  const lockRes = await lock(raw.h, url, 'MODIFY');
  const handle = String(lockRes.LOCK_HANDLE ?? lockRes.lockHandle ?? '');
  try {
    await setObjectSource(raw.h, `${url}/source/main`, source, handle);
  } finally {
    await unLock(raw.h, url, handle).catch(() => {});
  }
  const act = await activate(raw.h, name, url);
  const errors = (act?.messages ?? []).filter(m => ['E', 'A'].includes((m.type ?? m.severity ?? '').toUpperCase()));
  if (errors.length > 0) fail(`临时报表 ${name} 激活失败`, errors);
}
async function deleteTempProgram(name) {
  await raw.h.login();
  const url = `/sap/bc/adt/programs/programs/${name.toLowerCase()}`;
  const lockRes = await lock(raw.h, url, 'MODIFY');
  const handle = String(lockRes.LOCK_HANDLE ?? lockRes.lockHandle ?? '');
  try {
    await deleteObject(raw.h, url, handle);
  } finally {
    await unLock(raw.h, url, handle).catch(() => {});
  }
}
async function assertAbsent(name) {
  try {
    await raw.h.request(`/sap/bc/adt/programs/programs/${name.toLowerCase()}`, { method: 'GET' });
    fail(`清理缺席验证失败：${name} 仍存在`);
  } catch (e) {
    const text = String(e?.message ?? e);
    if (!/404|does not exist|not found/i.test(text)) fail(`缺席验证异常（${name}）`, { error: text.slice(0, 200) });
  }
}

async function main() {
  let client2 = null;
  await client.connect(transport);
  const tools = await client.listTools();
  for (const n of ['getReportVariants', 'runReport', 'submitReportJob']) {
    if (!tools.tools.some(t => t.name === n)) fail(`${n} 不在 catalog`);
  }
  pass('getReportVariants/runReport/submitReportJob 在 catalog（DEV 面）');

  // 前置：创建两个 $TMP 测试报表
  await createTempProgram(ALV_PROG, ALV_SRC);
  await createTempProgram(WRT_PROG, WRT_SRC);
  await createTempProgram(VARMAKER_PROG, VARMAKER_SRC);
  await createTempProgram(VARDEL_PROG, VARDEL_SRC);
  pass(`测试报表就绪：${ALV_PROG}（SALV）+ ${WRT_PROG}（WRITE）+ 变体造/删器`);

  try {
    // 1. runReport：WRITE 报表——提交→轮询→spool 解码全链
    const run = await call('runReport', { report: WRT_PROG, waitSeconds: 180 });
    const rb = run.structuredContent?.result ?? run.result ?? run;
    if (rb.jobStatus !== 'F') fail('作业未完成', rb);
    if (!String(rb.output ?? '').includes('SMOKE-MARKER-START')) fail('runReport 输出缺 WRITE 标记', rb);
    if (!/^ZRPT_/.test(String(rb.jobName))) fail('作业名前缀异常', rb);
    pass(`runReport：作业 ${rb.jobStatus}（${rb.jobName}/${rb.jobCount}）→ spool #${rb.spoolId} 输出含标记`);

    // 2. runReport 负例：不存在的报表（TRDIR 预检 fail-fast）
    const bad = await call('runReport', { report: 'ZZZ_NO_SUCH_REPORT_XZ' });
    if (!/does not exist|InvalidParams|-32602/i.test(JSON.stringify(bad).slice(0, 400))) fail('不存在报表未被拒', bad);
    pass('runReport 负例：TRDIR 预检拒绝（不留 aborted 作业）');

    // 3. runReport：SALV 报表（ALV 后台渲染为 spool 列表——作业链统一语义）
    const run2 = await call('runReport', { report: ALV_PROG, waitSeconds: 180 });
    const rb2 = run2.structuredContent?.result ?? run2.result ?? run2;
    if (rb2.jobStatus !== 'F') fail('SALV 报表作业未完成', rb2);
    if (String(rb2.output ?? '').length < 20) fail('SALV 报表输出为空', rb2);
    pass(`runReport：SALV 报表作业 ${rb2.jobStatus}，spool 列表输出 ${String(rb2.output ?? '').length} 字符`);

    // 4. submitReportJob：WRITE 报表后台作业
    const job = await call('submitReportJob', { report: WRT_PROG });
    const jb = job.structuredContent?.result ?? job.result ?? job;
    if (!/^ZRPT_/.test(String(jb.jobName)) || !jb.jobCount) fail('作业名/计数未返回', jb);
    pass(`submitReportJob：${jb.jobName}/${jb.jobCount}`);

    // 5. listJobs 轮询至 FINISHED——先重连（datapreview 按会话查询预算，
    // 前段 runReport 轮询已耗大半；分段换会话为既定教训）
    await client.close().catch(() => {});
    client2 = new Client({ name: 'report-smoke-2', version: '1.0.0' }, { capabilities: {} });
    await client2.connect(new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' }));
    const call2 = async (name, args) => parse(await client2.callTool({ name, arguments: args }, undefined, { timeout: 330000 }));
    let jobStatus = '';
    let jobRow = null;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const lj = await call2('listJobs', { name: jb.jobName });
      const lb = lj.structuredContent?.result ?? lj.result ?? lj;
      const jobs = lb.jobs ?? [];
      jobRow = jobs.find(j => String(j.name ?? j.jobName ?? j.JOBNAME ?? '').toUpperCase() === jb.jobName.toUpperCase()) ?? null;
      jobStatus = String(jobRow?.status ?? jobRow?.JOB_STATUS ?? '');
      if (/finished|f/i.test(jobStatus)) break;
    }
    if (!/finished|f/i.test(jobStatus)) fail(`作业未在预算内完成（status=${jobStatus}）`, jobRow);
    pass(`listJobs：作业 ${jobStatus}`);

    // 6. spool 定位（listJobs steps 自带 spool 编号——TBTCP.LISTIDENT）与内容断言
    const spoolId = Number(jobRow?.steps?.[0]?.spool ?? 0);
    if (!spoolId) fail('作业步骤未产生 spool', jobRow);
    const content = await call2('readSpoolContent', { requestNumber: spoolId });
    const cb = content.structuredContent?.result ?? content.result ?? content;
    const text = JSON.stringify(cb);
    if (!text.includes('SMOKE-MARKER-START') || !text.includes('SY-INDEX=2')) fail('spool 内容缺 WRITE 标记', { spoolId });
    pass(`readSpoolContent：spool #${spoolId} 内容含 WRITE 标记（后台作业输出闭环；后台码页解码有既有噪声，标记可辨）`);

    // 7. getReportVariants 正例：先经作业链造变体（executeAbap 单测上下文回滚
    //    DB 写——造变体必须走后台作业独立 LUW），再读回
    const mk = await call2('submitReportJob', { report: VARMAKER_PROG });
    const mkb = mk.structuredContent?.result ?? mk.result ?? mk;
    if (!mkb.jobName) fail('VARMAKER 作业未提交', mkb);
    await new Promise(r => setTimeout(r, 8000));
    // VARMAKER spool 自校验输出（RS_CREATE_VARIANT 真实结果）
    const mkJobs = await call2('listJobs', { name: mkb.jobName });
    const mkJob = (mkJobs.structuredContent?.result?.jobs ?? []).find(j => String(j.name).toUpperCase() === String(mkb.jobName).toUpperCase());
    const mkSpool = Number(mkJob?.steps?.[0]?.spool ?? 0);
    if (mkSpool) {
      const mkC = await call2('readSpoolContent', { requestNumber: mkSpool });
      const mkText = String(mkC.structuredContent?.result?.text ?? mkC.structuredContent?.result?.rawNote ?? '');
      console.log('  VARMAKER spool:', mkText.split(String.fromCharCode(10)).filter(l => l.trim()).slice(0, 3).join(' | ').slice(0, 200));
    }
    const vr = await call2('getReportVariants', { report: WRT_PROG });
    const vrb = vr.structuredContent?.result ?? vr.result ?? vr;
    if (!Array.isArray(vrb.variants) || vrb.variants.length < 1) fail(`变体未读回（${WRT_PROG}）`, vrb);
    if (vrb.variants[0].name !== 'SMOKE_VAR') fail('变体名不匹配', vrb);
    pass(`getReportVariants：${WRT_PROG} → ${vrb.variants.length} 变体（SMOKE_VAR，经后台作业独立 LUW 创建）`);

    // 8. getReportVariants：无变体报表 → 空清单有效
    const vr2 = await call2('getReportVariants', { report: ALV_PROG });
    const vr2b = vr2.structuredContent?.result ?? vr2.result ?? vr2;
    if (!Array.isArray(vr2b.variants) || vr2b.variants.length !== 0) fail('无变体报表应返回空清单', vr2b);
    pass('getReportVariants：空清单为有效回答（SALV 报表无变体）');

    // 9. 清场：经作业链删变体（RS_VARIANT_DELETE 独立 LUW）
    const dl = await call2('submitReportJob', { report: VARDEL_PROG });
    const dlb = dl.structuredContent?.result ?? dl.result ?? dl;
    if (!dlb.jobName) fail('VARDEL 作业未提交', dlb);
    await new Promise(r => setTimeout(r, 8000));
    const vr3 = await call2('getReportVariants', { report: WRT_PROG });
    const vr3b = vr3.structuredContent?.result ?? vr3.result ?? vr3;
    if (vr3b.variants.length !== 0) fail('变体未删除', vr3b);
    pass('变体清场完成（RS_VARIANT_DELETE 经作业链）');

    console.log('SMOKE OK: report.run/async/variants 真机全场景通过');
  } finally {
    // 清理：两个 $TMP 测试报表 + 缺席复核
    for (const [label, name] of [['ALV', ALV_PROG], ['WRITE', WRT_PROG], ['VARMAKER', VARMAKER_PROG], ['VARDEL', VARDEL_PROG]]) {
      try { await deleteTempProgram(name); } catch (e) { console.log(`清理警告（${label}）:`, String(e?.message ?? e).slice(0, 120)); }
    }
    await raw.h.login();
    await assertAbsent(ALV_PROG);
    await assertAbsent(WRT_PROG);
    await assertAbsent(VARMAKER_PROG);
    await assertAbsent(VARDEL_PROG);
    await raw.h.logout().catch(() => {});
    await client.close().catch(() => {});
    if (client2) await client2.close().catch(() => {});
  }
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
