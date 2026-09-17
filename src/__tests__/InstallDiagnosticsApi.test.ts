import {
  checkInstallPrerequisites,
  createInstallDiagnosticsClient
} from '../adt/InstallDiagnosticsApi.js';
import type { InstallDiagnosticsCapability } from '../adt/InstallDiagnosticsApi.js';

/**
 * InstallDiagnosticsApi 只读契约测试（mock 客户端，绝不连接真实 SAP）。
 * 断言四类内容：
 *   1. helper 发现：TADIR 有/无 ZADT_VSP% 记录两种路径；
 *   2. abapGit 状态分类：200/404/403/异常 → available/not_installed/forbidden/error；
 *   3. 本地运行时与边界 notes；
 *   4. 探测失败不中断整体报告。
 */

function clientMock(options: {
  tadirRows?: Record<string, unknown>[];
  gitStatus?: number;
  gitThrow?: Error;
  tadirFail?: Error;
}): InstallDiagnosticsCapability & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searchObject: jest.fn(async () => []),
    runQuery: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (options.tadirFail) throw options.tadirFail;
      return { values: options.tadirRows ?? [] };
    }),
    requestGitRepos: jest.fn(async () => {
      if (options.gitThrow) throw options.gitThrow;
      return { status: options.gitStatus ?? 200 };
    })
  } as unknown as InstallDiagnosticsCapability & { calls: string[] };
}

describe('checkInstallPrerequisites (install 前置只读 discovery)', () => {
  it('reports helper absent and abapGit available', async () => {
    const client = clientMock({ gitStatus: 200 });
    const result = await checkInstallPrerequisites(client);
    expect(result.zadtVspHelper.installed).toBe(false);
    expect(result.abapGit.status).toBe('available');
    expect(result.localRuntime.node).toContain('v');
    expect(result.notes[0]).toContain('never installs');
    // TADIR 模糊查询形态固定
    expect(client.calls[0]).toBe("SELECT obj_name, object FROM tadir WHERE obj_name LIKE 'ZADT_VSP%'");
  });

  it('reports helper objects and a forbidden abapGit service', async () => {
    const client = clientMock({
      tadirRows: [{ OBJ_NAME: 'ZADT_VSP_MAIN', OBJECT: 'CLAS' }],
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

describe('createInstallDiagnosticsClient binding', () => {
  it('exposes checkInstallPrerequisites over the injected capability', async () => {
    const client = clientMock({ gitStatus: 200 });
    const bound = createInstallDiagnosticsClient(client);
    const result = await bound.checkInstallPrerequisites();
    expect(result.abapGit.status).toBe('available');
  });
});
