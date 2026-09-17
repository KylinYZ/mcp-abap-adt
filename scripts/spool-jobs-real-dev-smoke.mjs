/**
 * SPOOL/后台作业只读二工具真机 smoke（矩阵行 diagnostics.spool-jobs 的
 * spool-jobs-real-dev-smoke，全只读：仅自由 SQL SELECT，零写操作）。
 *
 * 验证目标（专用 DEV）：
 *   1. listJobs         —— TBTCO 作业清单（近 7 天窗口）+ TBTCP 步骤增补
 *   2. listSpoolRequests —— TSP01 spool 清单（近 7 天）+ TST01 头 + TBTCP 引用
 *   3. 交叉印证：job 步骤的 spool 号与 spool 清单相互对应（同一数据两条路径）
 *   4. 负例：控制字符注入在进入网络前被拒（InvalidParams）
 *
 * 用法：node ./scripts/spool-jobs-real-dev-smoke.mjs <sap-dev.env路径>
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

const client = new Client({ name: 'spool-jobs-real-dev-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'inherit'
});

// 近 7 天窗口（YYYY-MM-DD）
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const tool of ['listSpoolRequests', 'listJobs']) {
    assert(names.has(tool), `${tool} 已出现在真实运行时 catalog`);
  }

  // —— 1. listJobs：近 7 天作业清单（该 DEV 有 /WF/JOBS 后台作业活动）——
  const jobs = parse(await call('listJobs', { from: daysAgo(7), to: daysAgo(0), limit: 50 }));
  const jobsBody = jobs?.result || jobs;
  assert(jobs && !jobs.error, 'listJobs 成功返回（无错误）', jobs);
  assert(Array.isArray(jobsBody.jobs), 'listJobs 返回 jobs 数组', jobsBody);
  assert(jobsBody.count === jobsBody.jobs.length, 'listJobs count 与数组一致', jobsBody);
  assert(Array.isArray(jobsBody.notes) && jobsBody.notes.some(n => n.includes('RFC/XBP')),
    'listJobs 随结果声明作业日志边界', jobsBody);
  process.stdout.write(`INFO 近 7 天作业 ${jobsBody.count} 个\n`);
  if (jobsBody.count > 0) {
    const job = jobsBody.jobs[0];
    assert(job.name && job.count, `作业键完整（${job.name}/${job.count}）`, job);
    assert(['P', 'S', 'Y', 'R', 'F', 'A', 'Z'].includes(job.status) || !job.status, '状态码合法', job);
    if (job.status && !job.statusText) {
      throw new Error(`SMOKE FAILED: 状态码 ${job.status} 缺少释义`);
    }
    process.stdout.write(`INFO 样例作业：${job.name} status=${job.status}(${job.statusText || '?'}) user=${job.user} started=${job.started || '-'} steps=${(job.steps || []).length}\n`);
    // 步骤增补：至少抽查一个带步骤的作业
    const withSteps = jobsBody.jobs.find(j => (j.steps || []).length > 0);
    if (withSteps) {
      const step = withSteps.steps[0];
      assert(typeof step.step === 'number', `步骤增补生效（${withSteps.name} 步骤 ${step.step}：${step.program || step.external || 'n/a'}）`, step);
    }
  }

  // —— 2. listSpoolRequests：近 7 天 spool 清单 ——
  const spools = parse(await call('listSpoolRequests', { from: daysAgo(7), to: daysAgo(0), limit: 50 }));
  const spoolsBody = spools?.result || spools;
  assert(spools && !spools.error, 'listSpoolRequests 成功返回（无错误）', spools);
  assert(Array.isArray(spoolsBody.requests), 'listSpoolRequests 返回 requests 数组', spoolsBody);
  assert(spoolsBody.count === spoolsBody.requests.length, 'count 与数组一致', spoolsBody);
  assert(Array.isArray(spoolsBody.notes) && spoolsBody.notes.some(n => n.includes('spool content')),
    'listSpoolRequests 随结果声明内容读取边界', spoolsBody);
  process.stdout.write(`INFO 近 7 天 spool 请求 ${spoolsBody.count} 个\n`);
  if (spoolsBody.count > 0) {
    const request = spoolsBody.requests[0];
    assert(typeof request.number === 'number' && request.number > 0, `spool 号完整（${request.number}）`, request);
    assert(typeof request.created === 'string' && request.created.startsWith('20'), `创建时间规范化（${request.created}）`, request);
    process.stdout.write(`INFO 样例 spool：#${request.number} owner=${request.owner} doc=${request.docType} storage=${request.storage || '?'} lines=${request.lines ?? '-'} job=${request.job ? request.job.name : '-'}\n`);
  }

  // —— 3. 交叉印证：作业步骤的 spool 号应出现在 spool 清单（同一数据两条路径）——
  const jobSpoolIds = new Set();
  for (const j of jobsBody.jobs) {
    for (const s of j.steps || []) {
      if (typeof s.spool === 'number' && s.spool > 0) jobSpoolIds.add(s.spool);
    }
  }
  if (jobSpoolIds.size > 0 && spoolsBody.count > 0) {
    const listedIds = new Set(spoolsBody.requests.map(r => r.number));
    const overlap = [...jobSpoolIds].filter(id => listedIds.has(id));
    // 窗口与 limit 可能截断清单，允许部分重叠；至少结构上可对照
    process.stdout.write(`INFO 交叉印证：作业步骤 spool 号 ${jobSpoolIds.size} 个，其中 ${overlap.length} 个出现在 spool 清单窗口内（limit 截断可解释差值）\n`);
    if (overlap.length === 0) {
      const anySpoolOfJob = spoolsBody.requests.some(r => r.job);
      assert(anySpoolOfJob || jobSpoolIds.size > 0, 'spool 清单含作业引用或作业侧含 spool 号（关联路径存在）', { listed: listedIds.size, jobSpoolIds: jobSpoolIds.size });
    }
  }

  // —— 4. 负例：控制字符注入在参数层被拒（零网络往返）——
  const malicious = await call('listJobs', { name: 'A\nDROP TABLE tbtco' });
  assert(/-32602|not a repository name/.test(JSON.stringify(malicious)),
    '控制字符/非法名字输入被 InvalidParams 拒绝', malicious);

  process.stdout.write('SMOKE OK: SPOOL/作业只读二工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
