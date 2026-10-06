import type { HealthCapability } from '../adt/HealthApi';
import {
  analyzeHealth,
  assembleHealthResult,
  collectPackageTests,
  collectPackageStaleness,
  healthNotes,
  incompleteSignalNames,
  isTestCaller,
  signalIncomplete,
  stalenessFromTime,
  summarizeATC,
  summarizeHealth,
  summarizeUnitTests
} from '../adt/HealthApi';

/**
 * Health 聚合查询单测（离线 mock capability，绝不连接 SAP）。
 * 断言五类内容：
 *   1. verdict 语义：FAIL→BAD、VIOLATIONS/FINDINGS/STALE→WARN、全绿→GOOD；
 *   2. 防缺陷语义（VSP 测试 pin 的两个坑）：信号带 unsearched/note/ERROR 时
 *      verdict 停在 UNKNOWN 不得报 GOOD；"没跑成"的测试是 ERROR 不是 PASS；
 *   3. 采集器：包级 tests 限 5 逐类执行、跑不了进 unsearched；staleness 取
 *      最大日期、读不到历史的对象不贡献日期；boundaries 零行不是 CLEAN；
 *   4. 对象级三信号 + boundaries 如实 UNKNOWN；
 *   5. staleness 阈值（>365 STALE / >90 AGING）与汇总计数。
 */

function capability(overrides: Partial<HealthCapability> = {}): HealthCapability & Record<string, jest.Mock> {
  return {
    runUnitTest: jest.fn().mockResolvedValue([{ alerts: [], testmethods: [{ alerts: [] }] }]),
    createAtcRun: jest.fn().mockResolvedValue({ id: 'WL1' }),
    atcWorklists: jest.fn().mockResolvedValue({ objects: [] }),
    checkPackageBoundaries: jest.fn().mockResolvedValue({
      rootPackage: 'ZPKG', whitelist: [], analyzedObjects: 3, totalDeps: 2, entries: [],
      standard: 1, samePackage: 1, allowed: 0, violations: 0, dynamic: 0, unknown: 0,
      crossedPackages: {}, violatingObjects: [], notes: []
    }),
    revisions: jest.fn().mockResolvedValue([{ date: '2026-09-01T00:00:00.000Z' }]),
    listPackageObjects: jest.fn().mockResolvedValue([{ name: 'ZCL_TEST_A', type: 'CLAS' }]),
    objectUrl: jest.fn((objectType: string, objectName: string) => `/sap/bc/adt/oo/${objectType === 'CLAS' ? 'classes' : 'interfaces'}/${objectName.toLowerCase()}`),
    ...overrides
  } as never;
}

const NOW = new Date('2026-10-04T00:00:00.000Z');

describe('health verdict semantics (VSP summarizeHealth port)', () => {
  it('ranks FAIL over WARN and reports GOOD only for a clean full sweep', () => {
    const good = { tests: { status: 'PASS' }, atc: { status: 'CLEAN' }, boundaries: { status: 'CLEAN' }, staleness: { status: 'ACTIVE' } };
    expect(summarizeHealth(good)).toEqual({ status: 'GOOD', headline: 'No major health issues detected' });
    expect(summarizeHealth({ ...good, tests: { status: 'FAIL' } }).status).toBe('BAD');
    expect(summarizeHealth({ ...good, boundaries: { status: 'VIOLATIONS' } }).headline).toBe('Boundary violations detected');
    expect(summarizeHealth({ ...good, atc: { status: 'FINDINGS' } }).headline).toBe('ATC findings detected');
    expect(summarizeHealth({ ...good, staleness: { status: 'STALE' } }).headline).toBe('Object or package appears stale');
  });

  it('keeps the verdict at UNKNOWN when any signal could not be fully checked', () => {
    // 防缺陷核心：没查成不是没问题——unsearched/note/ERROR 都阻断 GOOD
    const good = { tests: { status: 'PASS' }, atc: { status: 'CLEAN' }, boundaries: { status: 'CLEAN' }, staleness: { status: 'ACTIVE' } };
    const withGap = { ...good, atc: { status: 'CLEAN', unsearched: [{ object: 'ZCL_X', reason: 'timeout' }] } };
    const verdict = summarizeHealth(withGap);
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.headline).toContain('atc');
    expect(summarizeHealth({ ...good, staleness: { status: 'ACTIVE', note: '2 of 10 read' } }).status).toBe('UNKNOWN');
    expect(summarizeHealth({ ...good, tests: { status: 'ERROR', details: { message: 'x' } } }).status).toBe('UNKNOWN');
    expect(incompleteSignalNames(withGap)).toEqual(['atc']);
    expect(signalIncomplete(good.atc)).toBe(false);
    // notes 把缺口提升到顶层（unsearched 只进 headline gap，显式 note 才上提）
    const notes = healthNotes({ ...withGap, atc: { status: 'CLEAN', note: '2 of 5 checks failed to start' } });
    expect(notes[0]).toContain('atc: 2 of 5 checks failed to start');
    expect(healthNotes(withGap)).toEqual([]);
  });

  it('reports BAD with notes when a test class never ran (VSP pinned defect)', () => {
    // VSP handlers_health_test.go 第一个用例：一个测试类没跑成，不得宣判健康
    const signals = {
      tests: { status: 'ERROR', details: { message: 'run failed' } },
      atc: { status: 'CLEAN' }, boundaries: { status: 'CLEAN' }, staleness: { status: 'ACTIVE' }
    };
    const result = assembleHealthResult({ kind: 'package', package: 'ZPKG' }, signals);
    expect(result.summary.status).toBe('UNKNOWN');
    expect(result.notes?.[0]).toContain('tests: this check failed');
  });
});

describe('health signal collectors (package level)', () => {
  it('runs at most 5 test classes and records unrun ones as unsearched', async () => {
    const cap = capability({
      listPackageObjects: jest.fn().mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => ({ name: `ZCL_TEST_${i}`, type: 'CLAS' }))
      ),
      runUnitTest: jest.fn()
        .mockResolvedValueOnce([{ alerts: [{ kind: 'assertion' }], testmethods: [{ alerts: [] }] }])
        .mockRejectedValue(new Error('run failed'))
    });
    const signal = await collectPackageTests(cap, 'ZPKG');
    expect(cap.runUnitTest).toHaveBeenCalledTimes(5); // 5 个候选全部尝试：1 成功 + 4 失败
    expect(signal.status).toBe('FAIL'); // 跑成的那类有 1 个告警 → FAIL 优先于 UNKNOWN
    expect(signal.details).toMatchObject({ classes: 1, alerts: 1, ran: 1, candidates: 8 });
    expect(signal.unsearched).toHaveLength(4);
    expect(signal.note).toContain('not evidence of passing tests');
    // FAIL 是实际发现（verdict BAD），unsearched 仍进 notes 保持可见
    expect(summarizeHealth({ tests: signal, atc: { status: 'CLEAN' }, boundaries: { status: 'CLEAN' }, staleness: { status: 'ACTIVE' } }).status).toBe('BAD');
  });

  it('reports FAIL when alerts exist even if other classes could not run', async () => {
    const cap = capability({
      listPackageObjects: jest.fn().mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => ({ name: `ZCL_TEST_${i}`, type: 'CLAS' }))
      ),
      runUnitTest: jest.fn()
        .mockResolvedValueOnce([{ alerts: [{ kind: 'assertion' }, { kind: 'assertion' }], testmethods: [] }])
        .mockRejectedValue(new Error('run failed'))
    });
    const signal = await collectPackageTests(cap, 'ZPKG');
    expect(signal.status).toBe('FAIL'); // 有告警即 FAIL（比 UNKNOWN 优先）
    expect(signal.unsearched).toHaveLength(4);
  });

  it('reports NONE when classes ran but executed no test class (VSP totalClasses==0)', async () => {
    // 真机形态（2026-10-05 sap-demo 包级端到端）：2 个候选真机执行、运行
    // 结果 0 类 0 告警——是"没有测试"（NONE），不是"全绿"（PASS）
    const cap = capability({
      listPackageObjects: jest.fn().mockResolvedValue([
        { name: 'ZCL_TEST_A', type: 'CLAS' }, { name: 'ZCL_TEST_B', type: 'CLAS' }
      ]),
      runUnitTest: jest.fn().mockResolvedValue([])
    });
    const signal = await collectPackageTests(cap, 'ZPKG');
    expect(signal.status).toBe('NONE');
    expect(signal.details).toMatchObject({ classes: 0, alerts: 0, ran: 2, candidates: 2 });
  });

  it('reports NONE when the package has no test-like classes', async () => {
    const cap = capability({ listPackageObjects: jest.fn().mockResolvedValue([{ name: 'ZCL_PROD', type: 'CLAS' }]) });
    expect((await collectPackageTests(cap, 'ZPKG')).status).toBe('NONE');
    expect(isTestCaller('ZCL_PROD')).toBe(false);
    expect(isTestCaller('ZCL_ORDER_TEST')).toBe(true);
    expect(isTestCaller('LTH_UTIL')).toBe(true);
  });

  it('maps the boundary report and refuses CLEAN on an empty scan', async () => {
    const cap = capability();
    const signals: any = {};
    const { analyzeHealth } = await import('../adt/HealthApi');
    const result = await analyzeHealth(cap, { packageName: 'ZPKG', now: NOW });
    Object.assign(signals, result.signals);
    expect(signals.boundaries.status).toBe('CLEAN');
    expect(signals.boundaries.details).toMatchObject({ analyzed_objects: 3, violations: 0, violating_objects: 0 });
    // 空扫描：analyzedObjects=0 → UNKNOWN 而非 CLEAN（VSP 空图防线）
    const emptyCap = capability({
      checkPackageBoundaries: jest.fn().mockResolvedValue({
        rootPackage: 'ZPKG', whitelist: [], analyzedObjects: 0, totalDeps: 0, entries: [],
        standard: 0, samePackage: 0, allowed: 0, violations: 0, dynamic: 0, unknown: 0,
        crossedPackages: {}, violatingObjects: [], notes: []
      })
    });
    const emptyResult = await analyzeHealth(emptyCap, { packageName: 'ZPKG', now: NOW });
    expect(emptyResult.signals.boundaries.status).toBe('UNKNOWN');
    expect(emptyResult.signals.boundaries.note).toContain('not a clean one');
    // 边界报告的 notes（截断/动态说明）上提为 note → verdict 不再 GOOD
    const notedCap = capability({
      checkPackageBoundaries: jest.fn().mockResolvedValue({
        rootPackage: 'ZPKG', whitelist: [], analyzedObjects: 3, totalDeps: 2, entries: [],
        standard: 1, samePackage: 1, allowed: 0, violations: 0, dynamic: 0, unknown: 0,
        crossedPackages: {}, violatingObjects: [], notes: ['only first 3 objects scanned']
      })
    });
    const notedResult = await analyzeHealth(notedCap, { packageName: 'ZPKG', now: NOW });
    expect(notedResult.signals.boundaries.note).toContain('boundary check notes');
    expect(notedResult.summary.status).toBe('UNKNOWN');
    void signals;
  });

  it('takes the newest revision for staleness and records unread histories', async () => {
    const cap = capability({
      listPackageObjects: jest.fn().mockResolvedValue([
        { name: 'ZCL_A', type: 'CLAS' }, { name: 'ZCL_B', type: 'CLAS' }
      ]),
      revisions: jest.fn()
        .mockResolvedValueOnce([{ date: '2026-09-20T00:00:00.000Z' }])
        .mockRejectedValueOnce(new Error('no history'))
    });
    const signal = await collectPackageStaleness(cap, 'ZPKG', NOW);
    // 陈旧度按最新日期：2026-09-20 距 2026-10-04 为 14 天 → ACTIVE
    expect(signal.status).toBe('ACTIVE');
    expect(signal.details).toMatchObject({ age_days: 14, checked: 1 });
    expect(signal.unsearched).toEqual([{ object: 'CLAS ZCL_B', reason: 'no history' }]);
    expect(signal.note).toContain('older than reality');
  });
});

describe('health object level', () => {
  it('returns three signals with boundaries UNKNOWN pointing to the package tool', async () => {
    const cap = capability();
    const result = await analyzeHealth(cap, { objectType: 'CLAS', objectName: 'ZCL_X', now: NOW });
    expect(result.scope).toEqual({ kind: 'object', objectType: 'CLAS', objectName: 'ZCL_X' });
    expect(result.signals.tests.status).toBe('PASS');
    expect(result.signals.atc.status).toBe('CLEAN');
    expect(result.signals.staleness.status).toBe('ACTIVE');
    expect(result.signals.boundaries.status).toBe('UNKNOWN');
    expect(result.signals.boundaries.note).toContain('checkPackageBoundaries');
    expect(result.summary.status).toBe('UNKNOWN'); // boundaries 缺口阻断 GOOD
  });

  it('rejects calls with neither package nor object identity', async () => {
    const cap = capability();
    await expect(analyzeHealth(cap, {})).rejects.toThrow(/provide either/);
  });
});

describe('health thresholds and summaries', () => {
  it('applies the 365/90 day staleness thresholds', () => {
    expect(stalenessFromTime(new Date('2026-10-01T00:00:00.000Z'), 1, NOW).status).toBe('ACTIVE');
    expect(stalenessFromTime(new Date('2026-05-01T00:00:00.000Z'), 1, NOW).status).toBe('AGING');
    expect(stalenessFromTime(new Date('2024-01-01T00:00:00.000Z'), 1, NOW).status).toBe('STALE');
  });

  it('counts unit test classes/methods/alerts and ATC priorities', () => {
    expect(summarizeUnitTests([
      { alerts: [{}], testmethods: [{ alerts: [] }, { alerts: [{}] }] },
      { alerts: [], testmethods: [{ alerts: [] }] }
    ])).toEqual({ classes: 2, methods: 3, alerts: 2 });
    expect(summarizeATC({
      objects: [
        { findings: [{ priority: 1 }, { priority: 2 }] },
        { findings: [{ priority: 3 }, { priority: undefined }] }
      ]
    })).toEqual({ total: 4, errors: 1, warnings: 1, infos: 2 });
  });
});
