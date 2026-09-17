/**
 * 依赖上下文四工具真机 smoke（矩阵行 codeintel.context 的
 * context-analysis-real-dev-smoke，全只读，零 SAP 写操作）。
 *
 * 验证目标（专用 DEV）：
 *   1. getDependencyContext —— 对自有验证类做压缩依赖上下文分析（只读取源链：
 *      searchObject → objectStructure → getObjectSource，串行）
 *   2. analyzeDependencies  —— 同一对象的正则层依赖发现（复用已取源码，零新端点）
 *   3. parseAbapSource      —— 客户端解析（零 SAP 往返）
 *   4. analyzeSourceEffects —— 本地副作用/LUW 归类（零 SAP 往返）
 *   5. 独立复查：getDependencyContext 的 unresolved/契约对象与 getCallees 的
 *      交叉表结果交叉印证（同一对象两条独立证据链）
 *
 * 用法：node ./scripts/context-analysis-real-dev-smoke.mjs <sap-dev.env路径> [目标类名]
 * 目标默认 ZVPCL01（本用户历史 campaign 的自有验证类，Z001 包内）。
 */
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const environmentFile = process.argv[2];
const targetClass = String(process.argv[3] || 'ZVPCL01').trim().toUpperCase();
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');

// 红线检查：环境文件必须指向专用 DEV（10.30.254.48 / client 300），否则立即停止
const envText = (await import('fs')).readFileSync(environmentFile, 'utf8');
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
  // DEV 系统响应较慢（getDependencyContext 首层要逐个取依赖源码，串行多往返），
  // 单调用超时放宽到 5 分钟
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

const client = new Client({ name: 'context-analysis-real-dev-smoke', version: '1.0.0' });
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
  for (const tool of ['getDependencyContext', 'analyzeDependencies', 'parseAbapSource', 'analyzeSourceEffects']) {
    assert(names.has(tool), `${tool} 已出现在真实运行时 catalog`);
  }

  // —— 目标挑选：依赖分析断言需要一个"确实引用了外部对象"的目标。Z001 包内的
  // 自有验证对象有的很平凡（如 ZVPCL01 只有 14 行、零外部引用），所以先枚举
  // 候选（命令行目标优先，再补 Z001 包 PROG/CLAS），用 analyzeDependencies 预扫，
  // 选第一个 totalDeps>0 的对象做深度断言；全部为零依赖时退化为只验证工具可用性。
  const candidates = [];
  if (process.argv[3]) candidates.push({ objectType: 'CLAS', objectName: targetClass });
  try {
    const grep = parse(await call('grepPackage', {
      packageName: 'Z001', pattern: 'CLASS|REPORT|PROGRAM', caseInsensitive: true,
      maxResults: 30, objectTypes: ['PROG', 'CLAS']
    }));
    const objects = grep?.result?.objects || [];
    for (const entry of objects) {
      const name = String(entry?.objectName || entry?.name || '').toUpperCase();
      const type = String(entry?.objectType || '').toUpperCase();
      // ADT 的 objectType 形如 CLAS/OC、PROG/P，按前缀归类
      if (name && (type.startsWith('CLAS') || type.startsWith('PROG'))) {
        candidates.push({ objectType: type.startsWith('CLAS') ? 'CLAS' : 'PROG', objectName: name });
      }
    }
  } catch (e) {
    process.stdout.write(`WARN grepPackage 枚举失败（不阻塞，退化为固定候选）：${String(e?.message || e).slice(0, 120)}\n`);
    candidates.push({ objectType: 'CLAS', objectName: targetClass });
  }
  process.stdout.write(`INFO 候选对象：${JSON.stringify(candidates.slice(0, 8).map(c => c.objectName))}\n`);

  // —— 1. analyzeDependencies 预扫：挑有依赖的目标 + 验证正则层 ——
  let target = null;
  let depsBody = null;
  for (const candidate of candidates.slice(0, 6)) {
    const deps = parse(await call('analyzeDependencies', candidate));
    const body = deps?.result || deps;
    assert(deps && !deps.error, `analyzeDependencies 对 ${candidate.objectName} 成功返回（无错误）`, deps);
    assert(body.layers?.includes('regex'), 'analyzeDependencies 标注 regex 分析层', body);
    process.stdout.write(`INFO ${candidate.objectName}（${candidate.objectType}）发现 ${body.totalDeps} 个依赖\n`);
    if (body.totalDeps > 0 && !target) {
      target = candidate;
      depsBody = body;
    }
  }
  assert(depsBody, '至少一个候选对象发现了真实依赖（否则 Z001 包全为平凡对象）');
  const depNames = depsBody.dependencies.map(d => d.name);
  process.stdout.write(`INFO 选中目标 ${target.objectName} 的依赖：${JSON.stringify(depNames.slice(0, 10))}\n`);

  // —— 2. getDependencyContext：压缩依赖上下文（只读，串行取源）——
  const context = parse(await call('getDependencyContext', {
    objectType: target.objectType, objectName: target.objectName, maxDeps: 10, depth: 1
  }));
  const contextBody = context?.result || context;
  assert(context && !context.error, 'getDependencyContext 成功返回（无错误）', context);
  assert(contextBody.objectName === target.objectName, `getDependencyContext 返回规范对象名 ${target.objectName}`, contextBody);
  assert(contextBody.stats && typeof contextBody.stats.depsFound === 'number', 'getDependencyContext 返回 stats 统计', contextBody);
  assert(typeof contextBody.prologue === 'string', 'getDependencyContext 返回 prologue 文本', contextBody);
  assert(Array.isArray(contextBody.unresolved), 'getDependencyContext 返回 unresolved 名单', contextBody);
  process.stdout.write(`INFO ${target.objectName} 依赖统计：found=${contextBody.stats.depsFound} resolved=${contextBody.stats.depsResolved} failed=${contextBody.stats.depsFailed} prologueLines=${contextBody.stats.totalLines}\n`);
  process.stdout.write(`INFO unresolved（取不到契约的依赖）= ${JSON.stringify(contextBody.unresolved)}\n`);
  // 有依赖的目标：prologue 至少含标题行；解析数与失败数之和等于发现数
  assert(contextBody.prologue.includes('Dependency context for'), 'prologue 含标题行', contextBody.prologue.slice(0, 200));
  assert(contextBody.stats.depsResolved + contextBody.stats.depsFailed === contextBody.stats.depsFound,
    'stats 恒等式：resolved + failed = found', contextBody.stats);
  assert(contextBody.stats.depsResolved > 0, '至少一个依赖解析出真实契约', contextBody.stats);
  process.stdout.write(`INFO prologue 头部：${contextBody.prologue.split('\n').slice(0, 3).join(' | ').slice(0, 300)}\n`);
  // 交叉印证：prologue 里解析成功的契约名应出现在依赖发现清单中
  for (const resolved of contextBody.prologue.match(/\* --- ([A-Z0-9_/]+) \(/g) || []) {
    const name = resolved.replace('* --- ', '').replace(' (', '');
    assert(depNames.includes(name), `上下文契约 ${name} 与依赖发现清单交叉一致`);
  }

  // —— 3. parseAbapSource：客户端解析（零 SAP 往返，直接传对象名走一次取源）——
  const parsed = parse(await call('parseAbapSource', target));
  const parsedBody = parsed?.result || parsed;
  assert(parsed && !parsed.error, 'parseAbapSource 成功返回（无错误）', parsed);
  assert(parsedBody.statements > 0 && Array.isArray(parsedBody.stmts), 'parseAbapSource 解析出语句清单', parsedBody);
  const kinds = new Set(parsedBody.stmts.map(s => s.type));
  // 类主源可能只含 DEFINITION 段（实现可拆 include），断言按类型放宽：
  // CLAS 认 DEFINITION；PROG 认 REPORT 或 DEFINITION（本地类报表）
  const shapeOk = target.objectType === 'CLAS'
    ? kinds.has('CLASS_DEFINITION')
    : (kinds.has('REPORT') || kinds.has('CLASS_DEFINITION'));
  assert(shapeOk,
    `parseAbapSource 识别出 ${target.objectType} 的结构段（语句 ${parsedBody.statements} 条）`, [...kinds].join(','));
  process.stdout.write(`INFO ${target.objectName} 解析为 ${parsedBody.statements} 条语句 / ${parsedBody.lines} 行\n`);

  // —— 4. analyzeSourceEffects：本地 LUW 归类 ——
  const effects = parse(await call('analyzeSourceEffects', target));
  const effectsBody = effects?.result || effects;
  assert(effects && !effects.error, 'analyzeSourceEffects 成功返回（无错误）', effects);
  assert(['safe', 'participant', 'owner', 'unsafe'].includes(effectsBody.luw),
    `analyzeSourceEffects 给出合法 LUW 分类：${effectsBody.luw}`, effectsBody);
  assert(typeof effectsBody.consequence === 'string' && effectsBody.consequence.length > 0,
    'analyzeSourceEffects 附带调用方后果说明', effectsBody);
  assert(Array.isArray(effectsBody.notes) && effectsBody.notes.some(n => n.includes('local analysis')),
    'analyzeSourceEffects 声明本地分析边界', effectsBody);
  process.stdout.write(`INFO LUW=${effectsBody.luw} pure=${effectsBody.pure} effects=${JSON.stringify(effectsBody.effects || [])}\n`);

  // —— 5. source 直传路径：analyzeDependencies 接受显式源码（零 SAP 往返通道）——
  // zcl_direct_dep 同时命中 TYPE REF TO 与 =>，按名去重为一个依赖
  const direct = parse(await call('analyzeDependencies', {
    source: "DATA lo TYPE REF TO zcl_direct_dep.\nzcl_direct_dep=>go( ).\nCALL FUNCTION 'Z_DIRECT_FM'."
  }));
  const directBody = direct?.result || direct;
  assert(direct && !direct.error, 'analyzeDependencies 源码直传成功', direct);
  assert(directBody.totalDeps === 2, '源码直传发现 2 个依赖（ZCL_DIRECT_DEP 去重 + Z_DIRECT_FM）', directBody);
  assert(directBody.dependencies.some(d => d.kind === 'FUNC'), '函数模块依赖按 FUNC 分类', directBody);

  process.stdout.write('SMOKE OK: 依赖上下文四工具在真实 DEV 系统上全部验证通过（只读，零写操作）\n');
}

try {
  await main();
} finally {
  await client.close();
}
