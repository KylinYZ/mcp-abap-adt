#!/usr/bin/env node
/**
 * VSP 能力对齐矩阵校验与 Markdown 生成脚本。
 *
 * 用途：
 *   1. `docs/evidence/vsp-capability-parity-matrix.json` 是唯一机器可读真源；
 *      本脚本校验其 schema、唯一性、状态词汇、映射目标工具存在性与限制完整性。
 *   2. `docs/evidence/vsp-capability-parity-matrix.md` 是从 JSON 生成的评审视图，
 *      禁止手工编辑；默认模式下本脚本直接重写该文件，`--check` 模式只校验不写。
 *
 * 用法：
 *   node scripts/check-vsp-capability-parity.mjs           # 校验 JSON + 重新生成 MD
 *   node scripts/check-vsp-capability-parity.mjs --check   # 校验 JSON + MD 是否同步（CI 门禁）
 *
 * 边界：
 *   - 本脚本只做本地静态校验与文件生成，不连接 SAP、不执行 RFC、不访问 VSP 仓库；
 *     运行时工具存在性由 src/__tests__/VspCapabilityParity.test.ts 基于 catalog 证明。
 *   - VSP 基线（commit + worktree 状态）记录在 JSON 元数据中，由人工在审计时更新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixJsonPath = path.join(repoRoot, 'docs/evidence/vsp-capability-parity-matrix.json');
const matrixMdPath = path.join(repoRoot, 'docs/evidence/vsp-capability-parity-matrix.md');
const checkOnly = process.argv.includes('--check');

const errors = [];

/** 记录一条校验错误（附带矩阵行 id 便于定位）。 */
function fail(message, rowId = '') {
  errors.push(rowId ? `[${rowId}] ${message}` : message);
}

// ---------------------------------------------------------------------------
// 1. 读取并解析 JSON 真源
// ---------------------------------------------------------------------------

let matrix;
try {
  matrix = JSON.parse(fs.readFileSync(matrixJsonPath, 'utf8'));
} catch (error) {
  console.error(`无法解析 ${matrixJsonPath}: ${error.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. 词汇表（与计划文档对齐，任何未知取值都是防回退门禁失败）
// ---------------------------------------------------------------------------

const ALLOWED_STATUSES = new Set([
  'MCP_SUPERSET', 'EQUIVALENT', 'PARTIAL', 'GAP', 'INTENTIONAL_RESTRICTION', 'UNVERIFIED'
]);
const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2']);
const ALLOWED_EVIDENCE = new Set(['source-audit', 'automation', 'real-dev-verified', 'released']);
const ALLOWED_PROFILES = new Set([
  'safe', 'development', 'diagnostic-readonly', 'legacy-full',
  'development-workbench', 'business-readonly', 'operations-readonly'
]);
const ALLOWED_SYSTEM_ROLES = new Set(['DEV', 'QAS', 'PRD']);

// ---------------------------------------------------------------------------
// 3. 从本项目源码静态提取工具名全集（第一层防御；运行时验证在 Jest 测试）
// ---------------------------------------------------------------------------

/** 递归收集 src 下所有 .ts 文件路径（排除测试）。 */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 从源码提取 MCP 工具名：handler 定义的 `name: 'xxx'` 字面量 + 策略/profile 集合字面量。 */
function extractToolNames() {
  const names = new Set();
  for (const file of collectTsFiles(path.join(repoRoot, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    // handler 工具定义模式：name: 'toolName',
    for (const m of text.matchAll(/\bname:\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) names.add(m[1]);
  }
  // 兜底：ToolProfiles / ToolOperationPolicy 中的显式工具名集合（覆盖动态生成场景）
  for (const policyFile of ['src/config/ToolProfiles.ts', 'src/config/ToolOperationPolicy.ts']) {
    const text = fs.readFileSync(path.join(repoRoot, policyFile), 'utf8');
    for (const m of text.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)) names.add(m[1]);
  }
  return names;
}

const knownToolNames = extractToolNames();

/** 校验一组工具名全部存在于本项目源码。 */
function validateToolReferences(tools, rowId, fieldLabel) {
  for (const tool of tools) {
    if (!knownToolNames.has(tool)) {
      fail(`${fieldLabel} 引用了源码中不存在的工具 '${tool}'`, rowId);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 元数据与逐行 schema 校验
// ---------------------------------------------------------------------------

for (const field of ['schemaVersion', 'generatedAt', 'vspRevision', 'vspWorktreeState', 'projectRevision', 'projectWorktreeState']) {
  if (!matrix[field]) fail(`缺少元数据字段 '${field}'`);
}
if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
  fail("'rows' 必须是非空数组");
}

const seenIds = new Set();
for (const row of matrix.rows ?? []) {
  const id = row.id || '(missing id)';

  // —— 唯一 id 与 domain 一致性 ——
  if (seenIds.has(id)) fail(`重复的矩阵行 id '${id}'`);
  seenIds.add(id);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id)) fail(`id '${id}' 不符合 <domain>.<name> 命名（name 允许多级）`, id);
  if (!row.domain) fail(`缺少 domain`, id);
  else if (!id.startsWith(`${row.domain}.`)) fail(`domain '${row.domain}' 与 id 前缀不一致`, id);
  if (!row.task) fail(`缺少 task（用户任务一句话描述）`, id);

  // —— VSP 侧描述 ——
  if (!row.vsp || !row.vsp.surface) fail(`缺少 vsp.surface（VSP 调用面）`, id);
  if (!Array.isArray(row.vsp?.source) || row.vsp.source.length === 0) fail(`缺少 vsp.source（VSP 源文件引用）`, id);

  // —— 本项目映射 ——
  const mcp = row.mcp ?? {};
  const status = mcp.status;
  if (!ALLOWED_STATUSES.has(status)) fail(`未知状态 '${status}'`, id);

  const taskPath = Array.isArray(mcp.taskPath) ? mcp.taskPath : [];
  const profiles = Array.isArray(mcp.profiles) ? mcp.profiles : [];
  const roles = Array.isArray(mcp.systemRoles) ? mcp.systemRoles : [];
  validateToolReferences(taskPath, id, 'mcp.taskPath');
  for (const p of profiles) if (!ALLOWED_PROFILES.has(p)) fail(`未知 profile '${p}'`, id);
  for (const r of roles) if (!ALLOWED_SYSTEM_ROLES.has(r)) fail(`未知系统角色 '${r}'`, id);

  // EQUIVALENT / MCP_SUPERSET 必须给出完整任务路径，不得只凭状态宣称对齐
  if (status === 'EQUIVALENT' || status === 'MCP_SUPERSET') {
    if (taskPath.length === 0) fail(`${status} 行必须提供非空 mcp.taskPath`, id);
    if (profiles.length === 0) fail(`${status} 行必须提供非空 mcp.profiles`, id);
    if (roles.length === 0) fail(`${status} 行必须提供非空 mcp.systemRoles`, id);
  }
  // INTENTIONAL_RESTRICTION 必须写明限制理由与解除条件
  if (status === 'INTENTIONAL_RESTRICTION') {
    if (!mcp.restrictionReason) fail(`INTENTIONAL_RESTRICTION 行必须提供 mcp.restrictionReason`, id);
    if (!mcp.liftCondition) fail(`INTENTIONAL_RESTRICTION 行必须提供 mcp.liftCondition（解除条件）`, id);
  }
  // P0 缺口必须挂后续里程碑，防止无主缺口滞留
  if (row.priority === 'P0' && status === 'GAP' && !row.nextMilestone) {
    fail(`P0 GAP 行必须提供 nextMilestone`, id);
  }
  // PARTIAL 行要求写明缺口边界（理由字段复用 restrictionReason）
  if (status === 'PARTIAL' && !mcp.restrictionReason) {
    fail(`PARTIAL 行必须用 mcp.restrictionReason 说明未覆盖的部分`, id);
  }

  // —— 备选路径 ——
  for (const alt of Array.isArray(mcp.alternatePaths) ? mcp.alternatePaths : []) {
    if (!Array.isArray(alt.tools) || alt.tools.length === 0) fail(`alternatePaths 缺少 tools`, id);
    else validateToolReferences(alt.tools, id, 'alternatePaths.tools');
    for (const p of Array.isArray(alt.profiles) ? alt.profiles : []) {
      if (!ALLOWED_PROFILES.has(p)) fail(`alternatePaths 含未知 profile '${p}'`, id);
    }
    for (const r of Array.isArray(alt.systemRoles) ? alt.systemRoles : []) {
      if (!ALLOWED_SYSTEM_ROLES.has(r)) fail(`alternatePaths 含未知系统角色 '${r}'`, id);
    }
  }

  // —— 优先级、证据、里程碑 ——
  if (!ALLOWED_PRIORITIES.has(row.priority)) fail(`未知优先级 '${row.priority}'`, id);
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  if (evidence.length === 0) fail(`缺少 evidence（至少 source-audit）`, id);
  for (const e of evidence) if (!ALLOWED_EVIDENCE.has(e)) fail(`未知证据等级 '${e}'`, id);
}

// ---------------------------------------------------------------------------
// 5. 生成 Markdown 评审视图（唯一真源是 JSON；MD 由本脚本确定性渲染）
// ---------------------------------------------------------------------------

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderMarkdown(m) {
  const rows = m.rows;
  const count = (predicate) => rows.filter(predicate).length;
  const statuses = [...ALLOWED_STATUSES];
  const priorities = [...ALLOWED_PRIORITIES];

  const lines = [];
  lines.push('<!-- 本文件由 scripts/check-vsp-capability-parity.mjs 从同名 JSON 自动生成；禁止手工编辑。 -->');
  lines.push('');
  lines.push('# VSP 能力对齐矩阵（Wave 1）');
  lines.push('');
  lines.push('本矩阵回答一个问题：**VSP 用户可完成的 SAP 任务，本项目是否有等价任务路径**。');
  lines.push('唯一真源是 `vsp-capability-parity-matrix.json`；本文件是生成视图，任何修改都会被 `--check` 门禁拒绝。');
  lines.push('');
  lines.push('## 审计基线');
  lines.push('');
  lines.push('| 项目 | commit | 工作树状态 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| VSP（只读对照） | \`${m.vspRevision}\` | ${escapeCell(m.vspWorktreeState)} |`);
  lines.push(`| 本项目 | \`${m.projectRevision}\` | ${escapeCell(m.projectWorktreeState)} |`);
  lines.push('');
  lines.push(`生成日期：${m.generatedAt}；矩阵行数：${rows.length}。`);
  lines.push(`profile 别名：${escapeCell(m.profileAliases)}`);
  lines.push('');
  lines.push('## 状态与证据词汇');
  lines.push('');
  for (const [name, meaning] of Object.entries(m.statusVocabulary)) {
    lines.push(`- **${name}** — ${escapeCell(meaning)}`);
  }
  lines.push('');
  lines.push('证据等级：' + Object.entries(m.evidenceVocabulary).map(([k, v]) => `**${k}**=${escapeCell(v)}`).join('；') + '。');
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 优先级 | ' + statuses.join(' | ') + ' | 合计 |');
  lines.push('| --- | ' + statuses.map(() => '---').join(' | ') + ' | --- |');
  for (const p of priorities) {
    const cells = statuses.map(s => count(r => r.priority === p && r.mcp.status === s));
    lines.push(`| ${p} | ${cells.join(' | ')} | ${cells.reduce((a, b) => a + b, 0)} |`);
  }
  const totalCells = statuses.map(s => count(r => r.mcp.status === s));
  const aligned = count(r => r.mcp.status === 'MCP_SUPERSET' || r.mcp.status === 'EQUIVALENT');
  lines.push(`| 合计 | ${totalCells.join(' | ')} | ${rows.length} |`);
  lines.push('');
  lines.push(`计入完成率的行（MCP_SUPERSET + EQUIVALENT）：**${aligned}/${rows.length}**；所有数字均为源码审计结论，未经真实 SAP 验证。`);
  lines.push('');
  lines.push('## P0 缺口（防回退关注点）');
  lines.push('');
  const p0Gaps = rows.filter(r => r.priority === 'P0' && r.mcp.status === 'GAP');
  if (p0Gaps.length === 0) lines.push('（无）');
  else {
    lines.push('| id | 任务 | VSP surface | 后续里程碑 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of p0Gaps) {
      lines.push(`| \`${r.id}\` | ${escapeCell(r.task)} | ${escapeCell(r.vsp.surface)} | ${r.nextMilestone || '（未填）'} |`);
    }
  }
  lines.push('');
  lines.push('## 逐行矩阵');
  lines.push('');
  const domains = [...new Set(rows.map(r => r.domain))];
  for (const domain of domains) {
    lines.push(`### ${domain}`);
    lines.push('');
    lines.push('| id | 任务 | VSP surface | 状态 | 优先级 | 本项目任务路径 | profiles | roles |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows.filter(x => x.domain === domain)) {
      const tools = r.mcp.taskPath.length ? r.mcp.taskPath.map(t => `\`${t}\``).join('、') : '（无）';
      const profs = r.mcp.profiles.join(', ') || '（无）';
      const roles = r.mcp.systemRoles.join(', ') || '（无）';
      lines.push(`| \`${r.id}\` | ${escapeCell(r.task)} | ${escapeCell(r.vsp.surface)} | ${r.mcp.status} | ${r.priority} | ${tools} | ${escapeCell(profs)} | ${escapeCell(roles)} |`);
    }
    lines.push('');
  }
  lines.push('## 与 VSP 的有意差异（INTENTIONAL_RESTRICTION）');
  lines.push('');
  const restrictions = rows.filter(r => r.mcp.status === 'INTENTIONAL_RESTRICTION');
  if (restrictions.length === 0) lines.push('（无）');
  else {
    for (const r of restrictions) {
      lines.push(`- **\`${r.id}\`**（${r.priority}）：${escapeCell(r.mcp.restrictionReason)}`);
      lines.push(`  解除条件：${escapeCell(r.mcp.liftCondition)}`);
    }
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

const renderedMd = renderMarkdown(matrix);

if (checkOnly) {
  const existing = fs.existsSync(matrixMdPath) ? fs.readFileSync(matrixMdPath, 'utf8') : '';
  if (existing !== renderedMd) {
    fail('Markdown 与 JSON 不同步；请运行 `node scripts/check-vsp-capability-parity.mjs` 重新生成');
  }
} else {
  fs.writeFileSync(matrixMdPath, renderedMd, 'utf8');
}

// ---------------------------------------------------------------------------
// 6. 汇总输出
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error(`VSP 能力对齐矩阵校验失败（${errors.length} 个问题）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`VSP 能力对齐矩阵校验通过：${matrix.rows.length} 行；` +
  `MCP_SUPERSET=${matrix.rows.filter(r => r.mcp.status === 'MCP_SUPERSET').length}, ` +
  `EQUIVALENT=${matrix.rows.filter(r => r.mcp.status === 'EQUIVALENT').length}, ` +
  `PARTIAL=${matrix.rows.filter(r => r.mcp.status === 'PARTIAL').length}, ` +
  `GAP=${matrix.rows.filter(r => r.mcp.status === 'GAP').length}, ` +
  `INTENTIONAL_RESTRICTION=${matrix.rows.filter(r => r.mcp.status === 'INTENTIONAL_RESTRICTION').length}, ` +
  `UNVERIFIED=${matrix.rows.filter(r => r.mcp.status === 'UNVERIFIED').length}` +
  (checkOnly ? '；Markdown 已与 JSON 同步' : '；Markdown 已重新生成'));
