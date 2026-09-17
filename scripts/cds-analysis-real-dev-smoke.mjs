/**
 * CDS 依赖只读三端点真机 smoke（矩阵行 read.cds-analysis 的 cds-real-dev-smoke）。
 *
 * 目标：在专用 DEV 系统上验证三个只读 ADT 端点的真实可用性与响应解析：
 *   1. getCdsDependencies   —— CDS 依赖树
 *   2. getCdsImpactAnalysis —— CDS 反向影响
 *   3. getCdsElementInfo    —— CDS 元素元数据
 *
 * 安全边界：
 *   - 三个工具均为只读（GET / 无副作用 usageReferences 查询），对目标对象零副作用；
 *   - 目标对象优先搜索系统既有 DDLS（优先自建命名空间 Z*，缺失时允许显式传入），
 *     本脚本自身不创建任何对象；
 *   - 串行执行（server 默认 SAP_MCP_MAX_CONCURRENT_TOOLS=1）。
 *
 * 用法：node ./scripts/cds-analysis-real-dev-smoke.mjs <sap-dev.env路径> [DDLS对象名]
 */
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const environmentFile = process.argv[2];
const explicitObjectName = String(process.argv[3] || '').trim().toUpperCase();
if (!environmentFile) throw new Error('必须显式传入 sap-dev.env 路径；本脚本从不猜测凭据或目标配置。');

// elicit 自动应答：仅当确认消息包含预期关键词时才 accept，否则一律 cancel，
// 防止无人值守会话盲目批准任何意外弹出的确认框。
function attachElicitationGuard(client, expectedKeywords, decision) {
  client.setRequestHandler(ElicitRequestSchema, request => {
    const message = String(request.params?.message || '');
    const matched = expectedKeywords.some(keyword => message.includes(keyword));
    if (!matched) {
      process.stdout.write(`WARN elicitation 未匹配预期关键词，已自动取消：${message.slice(0, 120)}\n`);
      return { action: 'cancel' };
    }
    return { action: 'accept', content: { decision } };
  });
}

function parse(result) {
  const text = (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
  try { return JSON.parse(text); } catch { return {}; }
}

function assert(condition, message) {
  if (!condition) throw new Error(`SMOKE FAILED: ${message}`);
  process.stdout.write(`PASS ${message}\n`);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
Object.assign(childEnvironment, {
  SAP_MCP_ENV_FILE: resolve(environmentFile),
  SAP_MCP_LOG_LEVEL: 'warn'
});

const client = new Client(
  { name: 'cds-analysis-real-dev-smoke', version: '1.0.0' },
  // 声明 elicitation 能力：server 据此选择原生表单确认通道（本 smoke 全程只读，正常不会触发确认）
  { capabilities: { elicitation: {} } }
);
attachElicitationGuard(client, ['ZV', 'I_'], 'cancel');

async function findTargetDdls() {
  // 显式传入的对象名优先（调用方自行确保目标存在且可分析）
  if (explicitObjectName) return explicitObjectName;
  // 优先搜索自建命名空间的 DDLS（Z 开头），退而搜索标准接口视图 I*
  for (const query of ['Z*', 'I_*']) {
    const search = parse(await call('searchObject', { query, objType: 'DDLS/DDLSOURCE', max: 20 }));
    const names = (search.results || [])
      // searchObject 返回的名称字段是 adtcore:name（ADT 属性命名），兼容 name 兜底
      .map(item => String(item['adtcore:name'] || item.name || '').toUpperCase())
      .filter(name => /^[A-Z][A-Z0-9_]*$/.test(name));
    if (names.length > 0) {
      process.stdout.write(`INFO 使用搜索到的 DDLS 目标：${names[0]}（来源 query=${query}，共 ${names.length} 个候选）\n`);
      return names[0];
    }
  }
  throw new Error('系统中未搜索到可分析的 DDLS 对象；请显式传入对象名参数重试。');
}

async function main() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const tool of ['getCdsDependencies', 'getCdsImpactAnalysis', 'getCdsElementInfo']) {
    assert(names.has(tool), `${tool} 已出现在 DEV focused 运行时 catalog`);
  }

  const target = await findTargetDdls();
  assert(/^[A-Z][A-Z0-9_]{1,29}$/.test(target), `目标 DDLS 名称合法：${target}`);

  // —— 端点 1：依赖树 ——（handler 将结果包装为 {status:'success', result:{...}}）
  const deps = parse(await call('getCdsDependencies', { objectType: 'DDLS', objectName: target }));
  const depsBody = deps?.result || deps;
  assert(deps && !deps.error, `getCdsDependencies 成功返回（无错误）`);
  assert(depsBody.objectName === target, `getCdsDependencies 回显目标名 ${target}`);
  assert(Array.isArray(depsBody.dependencies), 'getCdsDependencies 返回 dependencies 数组');
  assert(depsBody.dependencies.length > 0, `getCdsDependencies 解析出真实上游依赖 ${depsBody.dependencies.length} 个（非空证明端点与解析均正确）`);
  process.stdout.write(`INFO ${target} 上游依赖：${JSON.stringify(depsBody.dependencies.slice(0, 3))}\n`);

  // —— 端点 2：反向影响 ——（下游为空是合法结果：新建/无消费者的 CDS 无 impactedObjects）
  const impact = parse(await call('getCdsImpactAnalysis', { objectType: 'DDLS', objectName: target }));
  const impactBody = impact?.result || impact;
  assert(impact && !impact.error, `getCdsImpactAnalysis 成功返回（无错误）`);
  assert(impactBody.objectName === target, `getCdsImpactAnalysis 回显目标名 ${target}`);
  assert(Array.isArray(impactBody.impactedObjects), 'getCdsImpactAnalysis 返回 impactedObjects 数组');
  process.stdout.write(`INFO ${target} 下游影响对象 ${impactBody.impactedObjects.length} 个\n`);

  // —— 端点 3：元素元数据 ——（目标系统不支持 v2 时优雅降级：空清单 + note 说明）
  const elements = parse(await call('getCdsElementInfo', { objectType: 'DDLS', objectName: target }));
  const elementsBody = elements?.result || elements;
  assert(elements && !elements.error, `getCdsElementInfo 成功返回（无错误，含系统不支持 v2 时的降级路径）`);
  assert(elementsBody.objectName === target, `getCdsElementInfo 回显目标名 ${target}`);
  assert(Array.isArray(elementsBody.elements), 'getCdsElementInfo 返回 elements 数组');
  if (elementsBody.elements.length > 0) {
    assert(elementsBody.elements[0].name, 'getCdsElementInfo 元素含 name 字段（v2 XML 解析正确）');
    process.stdout.write(`INFO ${target} 元素样例：${JSON.stringify(elementsBody.elements.slice(0, 3))}\n`);
  } else {
    assert(typeof elementsBody.note === 'string' && elementsBody.note.length > 0, 'getCdsElementInfo 空清单附有降级说明 note（老版系统合法场景）');
    process.stdout.write(`INFO ${target} 无元素清单：${elementsBody.note}\n`);
  }

  process.stdout.write('SMOKE OK: 三个 CDS 只读端点在真实 DEV 系统上全部验证通过（零副作用）\n');
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

try {
  await main();
} finally {
  await client.close();
}
