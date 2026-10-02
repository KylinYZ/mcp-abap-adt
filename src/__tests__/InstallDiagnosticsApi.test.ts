import {
  checkInstallPrerequisites,
  createInstallDiagnosticsClient
} from '../adt/InstallDiagnosticsApi.js';
import type { InstallDiagnosticsCapability } from '../adt/InstallDiagnosticsApi.js';

/**
 * InstallDiagnosticsApi 只读契约测试（mock 客户端，绝不连接真实 SAP）。
 * 断言内容：
 *   1. helper 发现：TADIR 有/无 ZADT_VSP% 记录两种路径；
 *   2. F2 深化：激活状态核验（SEOCLSRC/REPOSRC）与 APC/SICF 服务面探测、
 *      人可读 readiness 结论（service_face_missing = 当前 sap-demo 的真实状态）；
 *   3. abapGit 状态分类：200/404/403/异常 → available/not_installed/forbidden/error；
 *   4. 本地运行时与边界 notes；
 *   5. 探测失败不中断整体报告。
 */

function clientMock(options: {
  tadirRows?: Record<string, unknown>[];
  /** SEOCLSRC 返回行（激活状态核验）。 */
  seoclsrcRows?: Record<string, unknown>[];
  /** REPOSRC 返回行。 */
  reposrcRows?: Record<string, unknown>[];
  /** 激活表查询失败（核验降级 UNKNOWN）。 */
  activationQueryFail?: Error;
  gitStatus?: number;
  gitThrow?: Error;
  tadirFail?: Error;
  /** APC 服务面探测：直接返回的状态码。 */
  apcStatus?: number;
  /** APC 服务面探测：抛出的异常（可带 status）。 */
  apcThrow?: Error;
}): InstallDiagnosticsCapability & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searchObject: jest.fn(async () => []),
    runQuery: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (options.tadirFail && /tadir/i.test(sql)) throw options.tadirFail;
      if (options.activationQueryFail && /seoclsrc|reposrc/i.test(sql)) throw options.activationQueryFail;
      if (/seoclsrc/i.test(sql)) return { values: options.seoclsrcRows ?? [] };
      if (/reposrc/i.test(sql)) return { values: options.reposrcRows ?? [] };
      return { values: options.tadirRows ?? [] };
    }),
    requestGitRepos: jest.fn(async () => {
      if (options.gitThrow) throw options.gitThrow;
      return { status: options.gitStatus ?? 200 };
    }),
    requestApcService: jest.fn(async () => {
      if (options.apcThrow) throw options.apcThrow;
      return { status: options.apcStatus ?? 200 };
    })
  } as unknown as InstallDiagnosticsCapability & { calls: string[] };
}

describe('checkInstallPrerequisites (install 前置只读 discovery)', () => {
  it('reports helper absent and abapGit available', async () => {
    const client = clientMock({ gitStatus: 200 });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.installed).toBe(false);
    expect(result.zadtVspHelper.readiness?.state).toBe('not_installed');
    expect(result.abapGit.status).toBe('available');
    expect(result.localRuntime.node).toContain('v');
    expect(result.notes[0]).toContain('never installs');
    // TADIR 模糊查询形态固定
    expect(client.calls[0]).toBe("SELECT obj_name, object FROM tadir WHERE obj_name LIKE 'ZADT_VSP%'");
  });

  it('reports helper objects and a forbidden abapGit service', async () => {
    const client = clientMock({
      tadirRows: [{ OBJ_NAME: 'ZADT_VSP_MAIN', OBJECT: 'CLAS' }],
      seoclsrcRows: [{ CLSNAM: 'ZADT_VSP_MAIN', STATE: 'A' }],
      apcStatus: 400,
      gitStatus: 403
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.installed).toBe(true);
    expect(result.zadtVspHelper.objects).toEqual([{ name: 'ZADT_VSP_MAIN', type: 'CLAS' }]);
    expect(result.abapGit.status).toBe('forbidden');
  });

  it('classifies 404 as not_installed and a thrown 403 as forbidden', async () => {
    const notInstalled = clientMock({ gitStatus: 404 });
    expect((await checkInstallPrerequisites(notInstalled)).abapGit.status).toBe('not_installed');

    const forbiddenByThrow = clientMock({ gitThrow: Object.assign(new Error('Forbidden'), { status: 403 }) });
    expect((await checkInstallPrerequisites(forbiddenByThrow)).abapGit.status).toBe('forbidden');
  });

  it('keeps the report flowing when single probes fail', async () => {
    const client = clientMock({
      tadirFail: new Error('TADIR locked'),
      gitThrow: new Error('network down')
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.installed).toBe(false);
    expect(result.zadtVspHelper.detail).toContain('TADIR locked');
    expect(result.abapGit.status).toBe('error');
    expect(result.abapGit.detail).toContain('network down');
  });
});

describe('checkInstallPrerequisites F2 深化（激活状态 + APC/SICF 服务面）', () => {
  it('reports service_face_missing when objects are active but the APC face answers 404 (current sap-demo state)', async () => {
    const client = clientMock({
      tadirRows: [
        { OBJ_NAME: 'ZADT_VSP_UTILS', OBJECT: 'CLAS' },
        { OBJ_NAME: 'ZADT_VSP_APC_HANDLER', OBJECT: 'CLAS' }
      ],
      seoclsrcRows: [
        { CLSNAM: 'ZADT_VSP_UTILS', STATE: 'A' },
        { CLSNAM: 'ZADT_VSP_APC_HANDLER', STATE: 'A' }
      ],
      apcStatus: 404
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.activation).toMatchObject({ verified: true, activeCount: 2, notActive: [] });
    expect(result.zadtVspHelper.serviceFace?.state).toBe('not_configured');
    expect(result.zadtVspHelper.readiness?.state).toBe('service_face_missing');
    expect(result.zadtVspHelper.readiness?.detail).toContain('SAPC');
    expect(result.zadtVspHelper.readiness?.detail).toContain('SICF');
  });

  it('reports ready when objects are active and the APC face exists (non-404 response)', async () => {
    const client = clientMock({
      tadirRows: [{ OBJ_NAME: 'ZADT_VSP_MAIN', OBJECT: 'CLAS' }],
      seoclsrcRows: [{ CLSNAM: 'ZADT_VSP_MAIN', STATE: 'A' }],
      // APC handler 对普通 GET 回 400/405 均属"服务面存在"
      apcStatus: 400
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.serviceFace?.state).toBe('configured');
    expect(result.zadtVspHelper.readiness?.state).toBe('ready');
  });

  it('recognizes the thrown "does not exist" APC response as not_configured', async () => {
    const client = clientMock({
      tadirRows: [{ OBJ_NAME: 'ZADT_VSP_MAIN', OBJECT: 'CLAS' }],
      seoclsrcRows: [{ CLSNAM: 'ZADT_VSP_MAIN', STATE: 'A' }],
      apcThrow: Object.assign(new Error('Resource does not exist'), { status: 404 })
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.serviceFace?.state).toBe('not_configured');
    expect(result.zadtVspHelper.readiness?.state).toBe('service_face_missing');
  });

  it('reports inactive_objects when a class has no active SEOCLSRC row', async () => {
    const client = clientMock({
      tadirRows: [
        { OBJ_NAME: 'ZADT_VSP_UTILS', OBJECT: 'CLAS' },
        { OBJ_NAME: 'ZADT_VSP_APC_HANDLER', OBJECT: 'CLAS' }
      ],
      // 只有 UTILS 有激活版本；APC_HANDLER 未激活
      seoclsrcRows: [{ CLSNAM: 'ZADT_VSP_UTILS', STATE: 'A' }],
      apcStatus: 400
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.activation?.activeCount).toBe(1);
    expect(result.zadtVspHelper.activation?.notActive).toEqual([
      { name: 'ZADT_VSP_APC_HANDLER', type: 'CLAS', state: 'INACTIVE' }
    ]);
    expect(result.zadtVspHelper.readiness?.state).toBe('inactive_objects');
    expect(result.zadtVspHelper.readiness?.detail).toContain('ZADT_VSP_APC_HANDLER');
  });

  it('verifies PROG activation via REPOSRC and marks unsupported types UNKNOWN', async () => {
    const client = clientMock({
      tadirRows: [
        { OBJ_NAME: 'ZADT_VSP_TOOL', OBJECT: 'PROG' },
        { OBJ_NAME: 'ZADT_VSP_MAIN', OBJECT: 'TABL' }
      ],
      reposrcRows: [{ PROGNAME: 'ZADT_VSP_TOOL', R3STATE: 'A' }],
      apcStatus: 400
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.activation?.activeCount).toBe(1);
    expect(result.zadtVspHelper.activation?.notActive).toEqual([
      { name: 'ZADT_VSP_MAIN', type: 'TABL', state: 'UNKNOWN' }
    ]);
    // TABL 的 UNKNOWN 不阻塞：激活对象计数齐全 + 服务面在 → ready
    expect(result.zadtVspHelper.readiness?.state).toBe('ready');
  });

  it('downgrades to unknown readiness when activation tables are unreadable', async () => {
    const client = clientMock({
      tadirRows: [{ OBJ_NAME: 'ZADT_VSP_MAIN', OBJECT: 'CLAS' }],
      activationQueryFail: new Error('datapreview session budget exhausted'),
      apcStatus: 400
    });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.activation?.verified).toBe(false);
    expect(result.zadtVspHelper.readiness?.state).toBe('unknown');
  });

  it('skips activation and service probes when nothing is installed', async () => {
    const client = clientMock({ apcStatus: 404 });
    await checkInstallPrerequisites(client);
    // 无 TADIR 记录：不应发出 seoclsrc/reposrc 查询，也不应探测 APC 服务面
    expect(client.calls.filter(sql => /seoclsrc|reposrc/i.test(sql))).toEqual([]);
    expect(client.requestApcService).not.toHaveBeenCalled();
  });
});

describe('createInstallDiagnosticsClient binding', () => {
  it('exposes checkInstallPrerequisites over the injected capability', async () => {
    const client = clientMock({ gitStatus: 200 });
    const bound = createInstallDiagnosticsClient(client);
    const result = await bound.checkInstallPrerequisites();
    expect(result.abapGit.status).toBe('available');
  });
});
