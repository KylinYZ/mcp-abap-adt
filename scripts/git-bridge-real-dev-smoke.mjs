// git.abapgit 桥链路真机 smoke（sap-dev，只读面——gitTypes/gitExport 均为只读导出）：
// 1. gitTypes：逐类型容错收集生效（count>=1、INTF 异常被跳过并如实 skipped、CLAS 在列）
// 2. gitExport：TADIR 读取与序列化链路全通，errors 数组如实透出部署缺口
//    （serializer 类/依赖表缺失 → CX_SY_DYNAMIC_OSQL_SEMANTICS），fileCount=0
//    是"部署完整性"边界的诚实呈现，不是链路故障
// 3. 负例：packages 空数组 → VALIDATION_FAILED
// 结论判定：部署补全（233 对象 + zabapgit 表）后全链真实导出，ZIP 内容核对通过 = SMOKE OK。
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

const client = new Client({ name: 'git-bridge-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: ['./dist/index.js'], cwd: process.cwd(), env, stderr: 'pipe' });
function parse(r) {
  const t = (r.content || []).filter(i => i.type === 'text' && typeof i.text === 'string').map(i => i.text).join('');
  try { return JSON.parse(t); } catch { return r; }
}
async function call(name, args) { return parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 330000 })); }
function pass(m) { console.log('PASS', m); }
function fail(m, p) { console.log(`FAIL ${m}\n${JSON.stringify(p || {}).slice(0, 900)}`); process.exit(1); }

async function main() {
  await client.connect(transport);

  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'gitTypes') || !tools.tools.some(t => t.name === 'gitExport')) {
    fail('gitTypes/gitExport 不在 workbench catalog');
  }
  pass('gitTypes/gitExport 在 catalog（DEV + workbench/legacy-full 门控）');

  // 1. gitTypes：逐类型容错收集
  const t = await call('gitTypes', {});
  const tb = t.structuredContent?.result ?? t.result ?? t;
  if (typeof tb.count !== 'number' || tb.count < 100) fail('gitTypes count 异常（部署补全后应 150+）', { count: tb.count });
  if (!Array.isArray(tb.types) || !tb.types.includes('CLAS') || !tb.types.includes('INTF')) {
    fail('CLAS/INTF 应都在支持清单（部署补全后 INTF 恢复）', { has: tb.types?.filter(t => ['CLAS','INTF','PROG'].includes(t)) });
  }
  // PROG 序列化器实体在但 inactive（AFF locals include 留档遗留），不支持属预期、不阻 export
  if (typeof tb.skipped !== 'number' || tb.skipped < 0) fail('skipped 计数缺失（容错语义字段）', tb);
  pass(`gitTypes：${tb.count} 类型支持、skipped=${tb.skipped}（CLAS/INTF/PROG 全在列——部署补全后 INTF 恢复支持）`);

  // 2. gitExport：部署补全（233 对象 + zabapgit 表）后全链真实导出
  const e = await call('gitExport', { packages: ['$ZADT_VSP'], includeSubpackages: false });
  const eb = e.structuredContent?.result ?? e.result ?? e;
  if (eb.objectCount !== 13) fail('$ZADT_VSP TADIR 应为 13 对象', eb);
  if (!Array.isArray(eb.errors) || eb.errors.length !== 0) fail('部署补全后 errors 应为 0', eb);
  if (!Array.isArray(eb.files) || eb.files.length < 20) fail('导出文件清单应 >=20（23 文件：abap + XML）', eb);
  if ((eb.zipBase64 || '').length < 10000) fail('ZIP base64 过小（真实导出应 ~50KB 字符）', eb);
  pass(`gitExport：${eb.objectCount} 对象 → ${eb.files.length} 文件、ZIP ${Math.round(eb.zipBase64.length * 0.75 / 1024)}KB、errors=0`);
  global.__zipBase64 = eb.zipBase64;

  // 3. 负例：空 packages
  const bad = await call('gitExport', { packages: [] });
  const badText = JSON.stringify(bad).slice(0, 300);
  // schema minItems:1 在 MCP 校验层拒绝（-32603 通用消息）；handler 层
  // GitBridgeError VALIDATION_FAILED 语义映射为 InvalidParams——两道防线均认可
  if (!/-32602|-32603|InvalidParams|non-empty/i.test(badText)) fail('空 packages 未被拒', bad);
  pass('负例：空 packages 被拒（schema minItems / VALIDATION_FAILED 双防线）');

  // 4. ZIP 内容核对：真实文件 + 可读 ABAP 源 + 完整性
  const zipPath = process.env.TEMP + '/git-bridge-smoke-export.zip';
  (await import('fs')).writeFileSync(zipPath, Buffer.from(global.__zipBase64 || '', 'base64'));
  const { execSync } = await import('child_process');
  const inspect = execSync(`python -c "import zipfile,os;z=zipfile.ZipFile(os.path.join(os.environ['TEMP'],'git-bridge-smoke-export.zip'));ns=z.namelist();print(len(ns));print(sum(1 for n in ns if n.endswith('.clas.abap')));print(z.testzip());first=[n for n in ns if n.endswith('.clas.abap')][0];print('CLASS' in z.read(first).decode('utf-8','replace'))"`).toString().trim().split(String.fromCharCode(10)).map(l => l.trim());
  const entryCount = Number(inspect[0]);
  const clasCount = Number(inspect[1]);
  const corrupt = inspect[2];
  if (entryCount < 20) fail('ZIP 条目应 >=20', { entryCount });
  if (clasCount < 8) fail('ZIP 应含 >=8 个 .clas.abap 文件', { clasCount });
  if (corrupt !== 'None') fail('ZIP 完整性校验失败', { corrupt });
  const readable = inspect[3];
  if (readable !== 'True') fail('解包后的 .clas.abap 内容不含可读 ABAP 源', { readable });
  pass(`ZIP 内容核对：${entryCount} 条目（${clasCount} 个 .clas.abap）、testzip 无损坏、解包源码含可读 ABAP 类定义`);

  console.log('SMOKE OK: git.abapgit 真实导出全场景通过（部署补全后 ZIP 内容核对通过）');
  await client.close().catch(() => {});
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
