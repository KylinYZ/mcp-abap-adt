import type { BoundaryCheckInput, BoundaryReport } from './BoundaryCheckApi.js';

/**
 * ============================================================================
 * Health 聚合查询（矩阵 analysis.history 行 health 子操作——F 残项收编）
 * ============================================================================
 *
 * 语义对齐 VSP internal/mcp/handlers_health.go @9886d272（573 行）：
 * 包/对象的四信号健康快照（tests/atc/boundaries/staleness）+ 顶层 verdict +
 * notes。采集层用本项目已真机验证的原语组合（runUnitTest / createAtcRun +
 * atcWorklists / checkPackageBoundaries / revisions），聚合层逐行移植。
 *
 * 防缺陷语义（VSP 测试用例 pin 的两个坑，移植时保留）：
 *   1. "没查到问题"≠"查过没问题"——任何信号带 Unsearched/Note/ERROR 时，
 *      verdict 不得报 GOOD，只能报 UNKNOWN 并点名缺口（incomplete 语义）。
 *   2. tests 信号真正执行单测（有副作用），执行失败的信号是 ERROR 而非
 *      PASS——静默跳过会让"从没跑过"看起来和"全绿"一样。
 *
 * 与 VSP 的边界差异（如实声明）：
 *   - 对象级 boundaries 信号不产出（VSP 用图引擎对单对象源码做边界裁定，
 *     本项目包级证据链 checkPackageBoundaries 已真机验证、单对象裁定器无
 *     对等实现）——对象级 boundaries 恒 UNKNOWN + note 指向包级工具。
 *   - 包级测试类发现用名字启发式（含 TEST / LTH_ 前缀 / LCL_TEST 前缀，
 *     对齐 VSP graph.IsTestCaller 的对象名口径，不含 includeType 通道）。
 *   - 执行面：tests 信号运行用户测试代码——本 API 层不做门控，由工具层
 *     （analyzeHealth → advanced-mutation，workbench-only）把关。
 */

/** 单信号结果（状态词表按信号分组；details 携带证据数字）。 */
export interface HealthSignal {
  status: string
  details?: Record<string, unknown>
  /** 该信号没能查到的对象及原因——健康报告是最不能吞失败的地方。 */
  unsearched?: Array<{ object: string; reason: string }>
  /** 同一缺口的人读句子。 */
  note?: string
}

/** 顶层 verdict（BAD/WARN/UNKNOWN/GOOD）。 */
export interface HealthSummary {
  status: string
  headline: string
}

/** 分析范围（包或对象）。 */
export interface HealthScope {
  kind: 'package' | 'object'
  package?: string
  objectType?: string
  objectName?: string
}

/** health 快照（scope/summary/signals/notes 四段，notes 把缺口提到顶层）。 */
export interface HealthResult {
  scope: HealthScope
  summary: HealthSummary
  signals: Record<string, HealthSignal>
  notes?: string[]
}

/** 四信号的固定次序（verdict/notes 遍历次序稳定，不随对象键序漂移）。 */
const SIGNAL_ORDER = ['tests', 'atc', 'boundaries', 'staleness'] as const;

/** 信号是否"未拿到全部证据"——verdict 不得越过它报 GOOD。 */
export function signalIncomplete(signal: HealthSignal | undefined): boolean {
  if (!signal) return false;
  return (signal.unsearched?.length ?? 0) > 0 || Boolean(signal.note) || signal.status === 'ERROR';
}

/** 顶层 verdict（VSP handlers_health.go L505-532 summarizeHealth 逐行 port）。 */
export function summarizeHealth(signals: Record<string, HealthSignal>): HealthSummary {
  if (signals['tests']?.status === 'FAIL') {
    return { status: 'BAD', headline: 'Unit tests are failing' };
  }
  if (signals['boundaries']?.status === 'VIOLATIONS') {
    return { status: 'WARN', headline: 'Boundary violations detected' };
  }
  if (signals['atc']?.status === 'FINDINGS') {
    return { status: 'WARN', headline: 'ATC findings detected' };
  }
  if (signals['staleness']?.status === 'STALE') {
    return { status: 'WARN', headline: 'Object or package appears stale' };
  }
  // 走到这里说明没发现任何问题——但"没发现"有两种：本来就没有，和没查成。
  // 只有前者是好消息，而 GOOD 无法区分两者，所以有缺口时必须报 UNKNOWN。
  const gaps = incompleteSignalNames(signals);
  if (gaps.length > 0) {
    return {
      status: 'UNKNOWN',
      headline: `Nothing was found wrong, but ${gaps.join(' and ')} could not be checked in full — see notes`
    };
  }
  return { status: 'GOOD', headline: 'No major health issues detected' };
}

/** 按稳定次序列出未拿全证据的信号名（VSP L534-545 port）。 */
export function incompleteSignalNames(signals: Record<string, HealthSignal>): string[] {
  return SIGNAL_ORDER.filter(name => signalIncomplete(signals[name]));
}

/** 把每个信号的缺口提到报告顶层（VSP L547-559 healthNotes port）。 */
export function healthNotes(signals: Record<string, HealthSignal>): string[] {
  const notes: string[] = [];
  for (const name of SIGNAL_ORDER) {
    const signal = signals[name];
    if (!signal) continue;
    if (signal.note) {
      notes.push(`${name}: ${signal.note}`);
    } else if (signal.status === 'ERROR') {
      const message = typeof signal.details?.['message'] === 'string' ? signal.details['message'] : '';
      notes.push(`${name}: this check failed, so it is not evidence of health. ${message}`);
    }
  }
  return notes;
}

/** 组装完整结果（summary + notes 派生自 signals，单一事实源）。 */
export function assembleHealthResult(scope: HealthScope, signals: Record<string, HealthSignal>): HealthResult {
  const notes = healthNotes(signals);
  return {
    scope,
    summary: summarizeHealth(signals),
    signals,
    ...(notes.length > 0 ? { notes } : {})
  };
}

/** 陈旧度阈值（VSP stalenessFromTime：>365 天 STALE、>90 天 AGING）。 */
export function stalenessFromTime(lastChanged: Date, checked: number, now: Date = new Date()): HealthSignal {
  const ageDays = Math.floor((now.getTime() - lastChanged.getTime()) / (24 * 3600 * 1000));
  let status = 'ACTIVE';
  if (ageDays > 365) status = 'STALE';
  else if (ageDays > 90) status = 'AGING';
  return {
    status,
    details: { last_changed: lastChanged.toISOString(), age_days: ageDays, checked }
  };
}

/** 单测汇总（VSP summarizeUnitTests：类数/方法数/告警数）。 */
export function summarizeUnitTests(classes: Array<{ alerts?: unknown[]; testmethods?: Array<{ alerts?: unknown[] }> }>): {
  classes: number; methods: number; alerts: number;
} {
  let methods = 0;
  let alerts = 0;
  for (const cls of classes ?? []) {
    alerts += cls.alerts?.length ?? 0;
    for (const method of cls.testmethods ?? []) {
      methods++;
      alerts += method.alerts?.length ?? 0;
    }
  }
  return { classes: classes?.length ?? 0, methods, alerts };
}

/** ATC 汇总（VSP summarizeATC：priority 1=error 2=warning 其余 info）。 */
export function summarizeATC(worklist: { objects?: Array<{ findings?: Array<{ priority?: number }> }> }): {
  total: number; errors: number; warnings: number; infos: number;
} {
  let total = 0;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const object of worklist?.objects ?? []) {
    for (const finding of object.findings ?? []) {
      total++;
      if (finding.priority === 1) errors++;
      else if (finding.priority === 2) warnings++;
      else infos++;
    }
  }
  return { total, errors, warnings, infos };
}

/* ==========================================================================
 * 采集能力注入（handler 层绑定本项目已真机验证的 ADT 原语；本层可离线单测）
 * ========================================================================== */

/** 采集器所需的原语窄接口（全部来自既有已验证 API 面）。 */
export interface HealthCapability {
  /** 执行单测（对象 URL；返回 UnitTestClass[]——tests 信号是执行行为）。 */
  runUnitTest(url: string): Promise<Array<{ alerts?: unknown[]; testmethods?: Array<{ alerts?: unknown[] }> }>>
  /** 创建 ATC 运行并取 worklist id。 */
  createAtcRun(variant: string, mainUrl: string, maxResults: number): Promise<{ id?: string }>
  /** 读 ATC worklist。 */
  atcWorklists(runResultId: string): Promise<{ objects?: Array<{ findings?: Array<{ priority?: number }> }> }>
  /** 包边界只读检查（violations/crossedPackages/violatingObjects + partial 传播）。 */
  checkPackageBoundaries(input: BoundaryCheckInput): Promise<BoundaryReport>
  /** 版本历史（staleness 用首个版本日期）。 */
  revisions(objectUrl: string): Promise<Array<{ date: string }>>
  /** TADIR 枚举包内对象（kinds 过滤，有界）。 */
  listPackageObjects(packageName: string, kinds: string[], limit: number): Promise<Array<{ name: string; type: string }>>
  /** 单对象 ADT URL（tests/atc/staleness 对象级用；FUNC 需 parent 函数组）。 */
  objectUrl(objectType: string, objectName: string, parent?: string): string | undefined
}

const TEST_CLASS_LIMIT = 5;
const STALENESS_OBJECT_LIMIT = 10;

/** 测试类名字启发式（对齐 VSP graph.IsTestCaller 的对象名口径）。 */
export function isTestCaller(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.includes('TEST') || upper.startsWith('LCL_TEST') || upper.startsWith('LTH_');
}

/** ADT 异常统一转成 ERROR 信号（message 进 details，供 notes 顶层提示）。 */
function errorSignal(error: unknown): HealthSignal {
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'ERROR', details: { message: message.slice(0, 300) } };
}

/** 解析 revision 日期（不可解析的日期按 VSP 口径跳过，不算失败）。 */
function parseRevisionDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** 包级 tests 信号：枚举测试类（限 5），逐类执行；跑不了的进 unsearched。 */
export async function collectPackageTests(cap: HealthCapability, pkg: string): Promise<HealthSignal> {
  let candidates: Array<{ name: string; type: string }>;
  try {
    const objects = await cap.listPackageObjects(pkg, ['CLAS'], 200);
    candidates = objects.filter(object => isTestCaller(object.name));
  } catch (error) {
    return errorSignal(error);
  }
  if (candidates.length === 0) {
    return { status: 'NONE', details: { classes: 0 } };
  }
  const selected = candidates.slice(0, TEST_CLASS_LIMIT);
  const missed: Array<{ object: string; reason: string }> = [];
  let totalClasses = 0;
  let totalAlerts = 0;
  let ran = 0;
  for (const candidate of selected) {
    const url = cap.objectUrl('CLAS', candidate.name);
    if (!url) {
      missed.push({ object: `CLAS ${candidate.name}`, reason: 'no ADT URL' });
      continue;
    }
    try {
      const summary = summarizeUnitTests(await cap.runUnitTest(url));
      totalClasses += summary.classes;
      totalAlerts += summary.alerts;
      ran++;
    } catch (error) {
      // 跑不起来的测试不产生告警——而"无告警"从外面看与"全绿"一样，
      // 所以这里必须留下 unsearched，让 verdict 停在 UNKNOWN。
      missed.push({ object: `CLAS ${candidate.name}`, reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }
  // 对齐 VSP handlers_health.go 包级口径：有告警 FAIL > 无测试类执行 NONE >
  // 全部候选跑失败 UNKNOWN > PASS。ran>0 但 classes=0 意味着"跑了但什么测试
  // 都没执行"，报 NONE（没有测试）而非 PASS（全绿）。
  let status = 'PASS';
  if (totalClasses === 0) status = 'NONE';
  if (ran === 0) status = 'UNKNOWN';
  if (totalAlerts > 0) status = 'FAIL';
  const signal: HealthSignal = {
    status,
    details: { classes: totalClasses, alerts: totalAlerts, ran, candidates: candidates.length }
  };
  if (missed.length > 0) {
    signal.unsearched = missed;
    signal.note = `only ${ran} of ${selected.length} selected test classes actually ran (${candidates.length} test-like classes found); unrun classes are not evidence of passing tests.`;
  }
  return signal;
}

/** 对象级 tests 信号：直接执行该对象的单测。 */
export async function collectObjectTests(cap: HealthCapability, objectType: string, objectName: string, parent?: string): Promise<HealthSignal> {
  const url = cap.objectUrl(objectType, objectName, parent);
  if (!url) return { status: 'UNKNOWN', note: `object type ${objectType} has no tests URL in this port.` };
  try {
    const summary = summarizeUnitTests(await cap.runUnitTest(url));
    let status = 'PASS';
    if (summary.classes === 0) status = 'NONE';
    if (summary.alerts > 0) status = 'FAIL';
    return { status, details: { classes: summary.classes, methods: summary.methods, alerts: summary.alerts } };
  } catch (error) {
    return errorSignal(error);
  }
}

/** 包级/对象级 ATC 信号：创建运行 → 读 worklist → 汇总。 */
export async function collectAtcSignal(cap: HealthCapability, mainUrl: string, maxResults: number): Promise<HealthSignal> {
  try {
    const run = await cap.createAtcRun('', mainUrl, maxResults);
    if (!run?.id) {
      return { status: 'ERROR', details: { message: 'ATC run returned no worklist id.' } };
    }
    const worklist = await cap.atcWorklists(run.id);
    const summary = summarizeATC(worklist);
    return {
      status: summary.total > 0 ? 'FINDINGS' : 'CLEAN',
      details: { findings: summary.total, errors: summary.errors, warnings: summary.warnings, infos: summary.infos }
    };
  } catch (error) {
    return errorSignal(error);
  }
}

/** 包级 boundaries 信号：复用已真机验证的 checkPackageBoundaries。 */
export async function collectPackageBoundaries(cap: HealthCapability, pkg: string): Promise<HealthSignal> {
  try {
    const report: BoundaryReport = await cap.checkPackageBoundaries({ packageName: pkg, objectLimit: 30 });
    const violations = report.violations ?? 0;
    const signal: HealthSignal = {
      status: violations > 0 ? 'VIOLATIONS' : 'CLEAN',
      details: {
        analyzed_objects: report.analyzedObjects,
        violations,
        crossed_packages: report.crossedPackages ?? {},
        violating_objects: report.violatingObjects?.length ?? 0
      }
    };
    // 零行 CLEAN 是对空图的裁决——VSP pin 过这个坑（只含子包的包曾报
    // "CLEAN, 0 violations"）。analyzedObjects 为 0 时降为 UNKNOWN 并说明。
    if ((report.analyzedObjects ?? 0) === 0) {
      signal.status = 'UNKNOWN';
      signal.note = 'no source-bearing objects were read in this package, so there is no boundary verdict here — not a clean one.';
    }
    // partial 传播：边界报告的说明（动态调用未实现、截断等）原样上提，
    // 未决信息让 verdict 停在 UNKNOWN 而非 CLEAN。
    if (report.notes?.length) {
      signal.note = [signal.note, `boundary check notes: ${report.notes.join('; ')}`].filter(Boolean).join(' ');
    }
    return signal;
  } catch (error) {
    return errorSignal(error);
  }
}

/** 包级 staleness 信号：源码承载对象（限 10）取版本日期取最大者。 */
export async function collectPackageStaleness(cap: HealthCapability, pkg: string, now: Date = new Date()): Promise<HealthSignal> {
  let objects: Array<{ name: string; type: string }>;
  try {
    objects = await cap.listPackageObjects(pkg, ['CLAS', 'PROG', 'INTF'], STALENESS_OBJECT_LIMIT);
  } catch (error) {
    return errorSignal(error);
  }
  let newest: Date | undefined;
  let checked = 0;
  const missed: Array<{ object: string; reason: string }> = [];
  for (const object of objects.slice(0, STALENESS_OBJECT_LIMIT)) {
    const url = cap.objectUrl(object.type, object.name);
    if (!url) {
      missed.push({ object: `${object.type} ${object.name}`, reason: 'no ADT URL' });
      continue;
    }
    try {
      const revisions = await cap.revisions(url);
      if (revisions.length === 0) continue;
      const parsed = parseRevisionDate(revisions[0].date);
      if (!parsed) continue;
      if (!newest || parsed > newest) newest = parsed;
      checked++;
    } catch (error) {
      // 陈旧度是日期取最大：读不到历史的对象贡献不了日期，答案会偏旧，
      // 而"这个包两年没动过"恰恰是有人据此删代码的结论——必须 unsearched。
      missed.push({ object: `${object.type} ${object.name}`, reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }
  const note = missed.length > 0
    ? `staleness read ${checked} of ${objects.length} listed objects; unread histories make the "newest change" older than reality.`
    : undefined;
  if (!newest) {
    return { status: 'UNKNOWN', ...(missed.length > 0 ? { unsearched: missed } : {}), ...(note ? { note } : {}) };
  }
  const signal = stalenessFromTime(newest, checked, now);
  if (missed.length > 0) {
    signal.unsearched = missed;
    signal.note = [signal.note, note].filter(Boolean).join(' ');
  }
  return signal;
}

/** 对象级 staleness 信号。 */
export async function collectObjectStaleness(cap: HealthCapability, objectType: string, objectName: string, now: Date = new Date(), parent?: string): Promise<HealthSignal> {
  const url = cap.objectUrl(objectType, objectName, parent);
  if (!url) return { status: 'UNKNOWN', note: `object type ${objectType} has no revisions URL in this port.` };
  try {
    const revisions = await cap.revisions(url);
    if (revisions.length === 0) return { status: 'UNKNOWN' };
    const parsed = parseRevisionDate(revisions[0].date);
    if (!parsed) {
      return { status: 'ERROR', details: { message: `unparseable revision date ${revisions[0].date}` } };
    }
    return stalenessFromTime(parsed, 1, now);
  } catch (error) {
    return errorSignal(error);
  }
}

/** health 入参。 */
export interface HealthInput {
  /** 包名（与 objectType+objectName 二选一）。 */
  packageName?: string
  objectType?: string
  objectName?: string
  /** FUNC 对象的所属函数组。 */
  parent?: string
  /** staleness 判定用的当前时间（默认真实时钟；测试注入）。 */
  now?: Date
}

/** health 总入口：包级四信号或对象级三信号（boundaries 恒 UNKNOWN）。 */
export async function analyzeHealth(cap: HealthCapability, input: HealthInput): Promise<HealthResult> {
  const pkg = String(input?.packageName ?? '').trim().toUpperCase();
  const objectType = String(input?.objectType ?? '').trim().toUpperCase();
  const objectName = String(input?.objectName ?? '').trim().toUpperCase();
  if (!pkg && !(objectType && objectName)) {
    throw new Error('analyzeHealth: provide either packageName or objectType + objectName.');
  }
  const now = input?.now ?? new Date();
  // 四信号顺序执行（不并发）：所有采集共享同一个 stateful ADT 会话，SAP 对
  // 同会话请求排队处理——并发时慢信号（ATC 实测 262s）会把快信号拖到各自
  // 的 per-request 超时（2026-10-05 MCP 面实测四信号全 60s ERROR，直连无
  // per-request 超时才跑通）。串行后慢信号只拖慢总时长、不再误伤快信号。
  if (pkg) {
    // 包级：boundaries 复用包级证据链；VSP 口径 ATC maxResults=200
    const tests = await collectPackageTests(cap, pkg);
    const atc = await collectAtcSignal(cap, `/sap/bc/adt/packages/${pkg.toLowerCase()}`, 200);
    const boundaries = await collectPackageBoundaries(cap, pkg);
    const staleness = await collectPackageStaleness(cap, pkg, now);
    return assembleHealthResult({ kind: 'package', package: pkg }, { tests, atc, boundaries, staleness });
  }
  // 对象级：tests/atc/staleness 三信号；boundaries 无单对象裁定器，如实 UNKNOWN
  const objectUrl = cap.objectUrl(objectType, objectName, input.parent);
  const tests = await collectObjectTests(cap, objectType, objectName, input.parent);
  const atc = objectUrl
    ? await collectAtcSignal(cap, objectUrl, 100)
    : { status: 'UNKNOWN', note: `object type ${objectType} has no ATC URL in this port.` } as HealthSignal;
  const staleness = await collectObjectStaleness(cap, objectType, objectName, now, input.parent);
  const boundaries: HealthSignal = {
    status: 'UNKNOWN',
    note: 'single-object boundary adjudication is not implemented in this port; use checkPackageBoundaries for package-level boundary evidence.'
  };
  return assembleHealthResult({ kind: 'object', objectType, objectName }, { tests, atc, boundaries, staleness });
}
