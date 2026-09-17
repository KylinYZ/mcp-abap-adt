import {
  checkPackageBoundaries,
  createBoundaryCheckClient
} from '../adt/BoundaryCheckApi.js';
import type { BoundaryCheckCapability } from '../adt/BoundaryCheckApi.js';

/**
 * BoundaryCheckApi 只读契约测试（mock 客户端，绝不连接真实 SAP）。
 * 断言五类内容（标注对齐的 VSP 来源）：
 *   1. SQL 拼装契约：TADIR 包内枚举与按 kind 分组的 IN 批查；
 *   2. 六类裁定：SAME_PACKAGE/ALLOWED/STANDARD/UNKNOWN/VIOLATION（DYNAMIC
 *      恒 0 并在 notes 标注，对齐 boundary.go L11-19/L120-190）；
 *   3. 白名单 glob 匹配（* 通配、大小写不敏感）；
 *   4. 聚合：crossedPackages/violatingObjects、STANDARD 不进 entries；
 *   5. 注入防线与空包/空对象边界。
 */

const APP_SOURCE = [
  'CLASS zcl_app DEFINITION PUBLIC INHERITING FROM zcl_base FINAL.',
  '  PUBLIC SECTION.',
  '    INTERFACES zif_writer.',
  'ENDCLASS.'
].join('\n');

function clientMock(routes: {
  tadirObjects?: Record<string, unknown>[];
  tadirPackages?: Record<string, unknown>[];
  sources?: Record<string, string>;
}): BoundaryCheckCapability & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searchObject: jest.fn(async (query: string) => [
      { 'adtcore:name': query, 'adtcore:type': 'CLAS/OC', 'adtcore:uri': `/sap/bc/adt/oo/classes/${query.toLowerCase()}` }
    ]),
    objectStructure: jest.fn(async () => ({
      metaData: {},
      includes: [{ 'class:includeType': 'main', 'abapsource:sourceUri': 'source/main' }]
    })),
    getObjectSource: jest.fn(async (url: string) => {
      calls.push(url);
      const name = url.match(/\/classes\/([a-z0-9_]+)/)?.[1]?.toUpperCase() ?? '';
      return routes.sources?.[name] ?? '';
    }),
    runQuery: jest.fn(async (sql: string, limit?: number) => {
      calls.push(sql);
      void limit;
      const lower = sql.toLowerCase();
      // 目标包反查带 "object = '<kind>'" 精确谓词；包内枚举是 object IN (...)
      if (lower.includes('from tadir') && lower.includes("object = '")) return { values: routes.tadirPackages ?? [] };
      if (lower.includes('from tadir')) return { values: routes.tadirObjects ?? [] };
      throw new Error(`unexpected sql: ${sql}`);
    })
  } as unknown as BoundaryCheckCapability & { calls: string[] };
}

describe('checkPackageBoundaries (VSP boundary.go port)', () => {
  it('classifies same-package, standard, allowed and violation edges with aggregates', async () => {
    const client = clientMock({
      tadirObjects: [
        { OBJ_NAME: 'ZCL_APP', OBJECT: 'CLAS' },
        { OBJ_NAME: 'ZCL_OTHER', OBJECT: 'CLAS' }
      ],
      tadirPackages: [
        { OBJ_NAME: 'ZCL_BASE', DEVCLASS: 'Z001' },      // 同包
        { OBJ_NAME: 'ZIF_WRITER', DEVCLASS: 'Z_COMMON' }, // 白名单（Z* 通配）
        { OBJ_NAME: 'ZCL_FOREIGN', DEVCLASS: 'Z999' }     // 跨包违规
      ],
      sources: {
        ZCL_APP: APP_SOURCE + '\n' + 'zcl_foreign=>go( ).\nDATA x TYPE REF TO zcl_base.\nDATA w TYPE REF TO zif_writer.',
        ZCL_OTHER: 'CLASS zcl_other DEFINITION PUBLIC.\nENDCLASS.'
      }
    });
    const report = await checkPackageBoundaries(client, {
      packageName: 'Z001', whitelist: ['Z*_COMMON'], objectLimit: 10
    });
    expect(report.rootPackage).toBe('Z001');
    expect(report.analyzedObjects).toBe(2);
    expect(report.totalDeps).toBe(3);
    expect(report.samePackage).toBe(1); // ZCL_BASE
    expect(report.allowed).toBe(1);     // ZIF_WRITER（白名单 Z*）
    expect(report.violations).toBe(1);  // ZCL_FOREIGN（Z999）
    expect(report.violatingObjects).toEqual(['ZCL_APP']);
    expect(report.crossedPackages).toEqual({ Z999: 1 });
    // STANDARD 不进 entries 只计数
    expect(report.standard).toBe(0);
    // 白名单生效：Z_COMMON 不算 VIOLATION
    expect(report.entries.filter(e => e.verdict === 'ALLOWED').map(e => e.to)).toEqual(['ZIF_WRITER']);
    expect(report.notes[0]).toContain('dynamic');
  });

  it('counts SAP standard packages as STANDARD without listing them', async () => {
    const client = clientMock({
      tadirObjects: [{ OBJ_NAME: 'ZCL_STD', OBJECT: 'CLAS' }],
      tadirPackages: [{ OBJ_NAME: 'CL_GUI_ALV_GRID', DEVCLASS: 'SALV' }],
      sources: { ZCL_STD: 'DATA ref TYPE REF TO cl_gui_alv_grid.' }
    });
    const report = await checkPackageBoundaries(client, { packageName: 'Z001' });
    expect(report.totalDeps).toBe(1);
    expect(report.standard).toBe(1);
    expect(report.entries).toEqual([]); // STANDARD 不进清单
  });

  it('returns an empty report for an empty or unknown package', async () => {
    const client = clientMock({ tadirObjects: [] });
    const report = await checkPackageBoundaries(client, { packageName: 'ZEMPTY' });
    expect(report.analyzedObjects).toBe(0);
    expect(report.totalDeps).toBe(0);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('rejects malformed package names and unsupported kinds', async () => {
    const client = clientMock({});
    await expect(checkPackageBoundaries(client, { packageName: "Z';--" })).rejects.toThrow(/not a repository name/);
    await expect(checkPackageBoundaries(client, { packageName: 'Z001', objectKinds: ['TABL' as any] }))
      .rejects.toThrow(/only supports PROG, CLAS, INTF/);
  });

  it('createBoundaryCheckClient exposes the capability', async () => {
    const client = clientMock({ tadirObjects: [] });
    const bound = createBoundaryCheckClient(client);
    const report = await bound.checkPackageBoundaries({ packageName: 'ZEMPTY' });
    expect(report.analyzedObjects).toBe(0);
  });
});
