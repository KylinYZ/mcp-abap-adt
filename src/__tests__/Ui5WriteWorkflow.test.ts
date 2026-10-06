import { Ui5WriteWorkflow, type Ui5WriteInput } from '../safe/Ui5WriteWorkflow';
import { SafetyPolicy } from '../safe/SafetyPolicy';
import type { AuditSink } from '../safe/AbapChangeWorkflow';
import type { Ui5WriteClient } from '../adt/Ui5FilestoreApi';

/**
 * 受控 UI5 filestore 写入工作流单测（离线 mock，绝不连接 SAP）。
 * 断言五类内容：
 *   1. preview 校验：kind 白名单、包名/内容上限、存在性 fail-closed
 *      （create 已存在拒、delete 目标缺失拒、upload 目标应用缺失拒）；
 *   2. plan 冻结：oldState 快照、内容 hash、transport 大写、TTL、上下文绑定；
 *   3. apply 状态机：PLAN_NOT_FOUND / 跨上下文拒绝 / PLAN_ALREADY_CONSUMED；
 *   4. apply 执行 + readback：四 kind 成功路径、readback 不符 VERIFICATION_FAILED、
 *      同值短路、漂移 STATE_DRIFT（写未发出）、请求后异常 UNKNOWN_OUTCOME；
 *   5. 审计事件伴随（preview/completed/failed/unknown/sameValue）。
 */

function policy(): SafetyPolicy {
  return new SafetyPolicy({
    sapUrl: 'https://dev.example.com:44300',
    sapClient: '100',
    systemRole: 'DEV',
    allowedHosts: 'dev.example.com',
    allowedClients: '100',
    allowedNamespaces: 'Z,Y',
    auditPath: 'C:\\audit',
    toolProfile: 'development-workbench'
  });
}

/** 构造 404 形态错误（AdtException 携带 status 的等价物）。 */
function notFound(): Error {
  return Object.assign(new Error('Request failed with status code 404'), { status: 404 });
}

/** 记录型 client mock：读操作由内存 filestore 模型驱动，写操作可注入失败。 */
function clientHarness(initial: {
  apps?: Record<string, Array<{ path: string; type: string }>>;
  files?: Record<string, string>;
} = {}) {
  const apps: Record<string, Array<{ path: string; type: string }>> = JSON.parse(JSON.stringify(initial.apps ?? {}));
  const files: Record<string, string> = { ...initial.files };
  const calls: string[] = [];
  const client = {
    ui5CreateApp: jest.fn(async (input: { appName: string }) => {
      calls.push(`create:${input.appName}`);
      apps[input.appName] = [];
    }),
    ui5UploadFile: jest.fn(async (input: { appName: string; filePath: string; content: string }) => {
      calls.push(`upload:${input.appName}/${input.filePath}`);
      files[`${input.appName}/${input.filePath}`] = input.content;
    }),
    ui5DeleteFile: jest.fn(async (input: { appName: string; filePath: string }) => {
      calls.push(`deleteFile:${input.appName}/${input.filePath}`);
      delete files[`${input.appName}/${input.filePath}`];
    }),
    ui5DeleteApp: jest.fn(async (input: { appName: string }) => {
      calls.push(`deleteApp:${input.appName}`);
      delete apps[input.appName];
      for (const key of Object.keys(files)) {
        if (key.startsWith(`${input.appName}/`)) delete files[key];
      }
    }),
    ui5GetApp: jest.fn(async (input: { appName: string }) => {
      const tree = apps[input.appName];
      if (!tree) throw notFound();
      return { appName: input.appName, files: tree, feedEntries: tree.length };
    }),
    ui5GetFileContent: jest.fn(async (input: { appName: string; filePath: string }) => {
      const content = files[`${input.appName}/${input.filePath}`];
      if (content === undefined) throw notFound();
      return { appName: input.appName, filePath: input.filePath, content, size: Buffer.byteLength(content, 'utf8') };
    })
  };
  return { client: client as unknown as Ui5WriteClient, raw: client, apps, files, calls };
}

function harness(clientOptions?: Parameters<typeof clientHarness>[0]) {
  const { client, calls, raw } = clientHarness(clientOptions);
  const audit = { append: jest.fn().mockResolvedValue(undefined) } as unknown as AuditSink & { append: jest.Mock };
  const workflow = new Ui5WriteWorkflow({ client, policy: policy(), audit });
  return { workflow, audit, calls, raw };
}

const BASE_INPUT: Ui5WriteInput = { kind: 'upload_file', appName: 'ZAPP_SIMPLE', filePath: 'WebContent/index.html', content: '<h1>hi</h1>' };

/** upload/delete 类用例的最小预置应用（BASE_INPUT 的目标应用必须已存在）。 */
const APP_WITH_FILE = { apps: { ZAPP_SIMPLE: [{ path: '/WebContent/index.html', type: 'file' }] } };

describe('Ui5WriteWorkflow preview validation (fail-closed)', () => {
  it('rejects unknown kind and malformed names before any SAP call', async () => {
    const { workflow, calls } = harness();
    await expect(workflow.preview({ ...BASE_INPUT, kind: 'drop_table' as never })).rejects.toThrow(/kind must be one of/);
    await expect(workflow.preview({ ...BASE_INPUT, appName: 'z; drop' })).rejects.toThrow(/not a UI5 BSP application name/);
    expect(calls).toEqual([]);
  });

  it('enforces the namespace allowlist via SafetyPolicy', async () => {
    const { workflow } = harness();
    await expect(workflow.preview({ ...BASE_INPUT, appName: '/SAM4U/DASHBRD' })).rejects.toThrow(/outside the allowed namespaces/);
  });

  it('create_app requires a package and refuses an existing app', async () => {
    const { workflow } = harness({ apps: { ZAPP_SIMPLE: [] } });
    await expect(workflow.preview({ kind: 'create_app', appName: 'ZNEW', packageName: '' })).rejects.toThrow(/not a valid package name/);
    await expect(workflow.preview({ kind: 'create_app', appName: 'ZAPP_SIMPLE', packageName: 'ZPKG' })).rejects.toThrow(/already exists/);
  });

  it('upload_file requires content, enforces the size cap, and refuses a missing app', async () => {
    const { workflow } = harness();
    await expect(workflow.preview({ kind: 'upload_file', appName: 'ZAPP_SIMPLE', filePath: 'a.txt', content: '' })).rejects.toThrow(/content is required/);
    await expect(workflow.preview({ kind: 'upload_file', appName: 'ZAPP_SIMPLE', filePath: 'a.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) })).rejects.toThrow(/byte limit/);
    await expect(workflow.preview({ kind: 'upload_file', appName: 'ZMISSING', filePath: 'a.txt', content: 'x' })).rejects.toThrow(/does not exist/);
  });

  it('delete_file and delete_app refuse missing targets', async () => {
    const { workflow } = harness({ apps: { ZAPP_SIMPLE: [] } });
    await expect(workflow.preview({ kind: 'delete_file', appName: 'ZAPP_SIMPLE', filePath: 'gone.txt' })).rejects.toThrow(/does not exist/);
    await expect(workflow.preview({ kind: 'delete_app', appName: 'ZMISSING' })).rejects.toThrow(/does not exist/);
  });

  it('rejects path traversal before any SAP call', async () => {
    const { workflow, calls } = harness({ apps: { ZAPP_SIMPLE: [] } });
    await expect(workflow.preview({ kind: 'delete_file', appName: 'ZAPP_SIMPLE', filePath: '../secret.txt' })).rejects.toThrow(/path traversal/);
    expect(calls).toEqual([]);
  });
});

describe('Ui5WriteWorkflow preview freezes the plan', () => {
  it('captures oldState, content hash, uppercase transport and TTL fields', async () => {
    const { workflow } = harness({
      apps: { ZAPP_SIMPLE: [{ path: '/.project', type: 'file' }, { path: '/WebContent/index.html', type: 'file' }] },
      files: { 'ZAPP_SIMPLE/WebContent/index.html': '<h1>old</h1>' }
    });
    const result: any = await workflow.preview({ ...BASE_INPUT, content: '<h1>new</h1>', transport: 's4hk900010' });
    expect(result.status).toBe('preview');
    expect(result.confirmationRequired).toBe(true);
    const plan = result.plan;
    expect(plan.kind).toBe('upload_file');
    expect(plan.appName).toBe('ZAPP_SIMPLE');
    expect(plan.transport).toBe('S4HK900010');
    expect(plan.oldState).toMatchObject({ appExists: true, fileCount: 2, fileExists: true, fileSize: 12 });
    expect(plan.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.contentBytes).toBe(12);
    expect(plan.createdAt).toBeTruthy();
    expect(plan.expiresAt > plan.createdAt).toBe(true);
    // 对外视图不回显内容全文
    expect(JSON.stringify(plan)).not.toContain('<h1>new</h1>');
    // plan 内容 hash 与给定内容一致
    const { createHash } = await import('crypto');
    expect(plan.contentSha256).toBe(createHash('sha256').update(JSON.stringify('<h1>new</h1>')).digest('hex'));
  });

  it('delete_app freezes the tree size as impact evidence', async () => {
    const { workflow } = harness({
      apps: { ZAPP_SIMPLE: [{ path: '/.project', type: 'file' }, { path: '/WebContent', type: 'folder' }] }
    });
    const result: any = await workflow.preview({ kind: 'delete_app', appName: 'ZAPP_SIMPLE' });
    expect(result.plan.oldState.fileCount).toBe(2);
  });
});

describe('Ui5WriteWorkflow apply state machine', () => {
  it('rejects unknown plans, foreign contexts and consumed plans', async () => {
    const { workflow } = harness(APP_WITH_FILE);
    await expect(workflow.applyConfirmed('nope')).rejects.toThrow(/does not exist/);
    const previewed: any = await workflow.preview(BASE_INPUT);
    // 伪造跨上下文：换 systemHost 后 apply 必须拒绝
    const foreign = new Ui5WriteWorkflow({
      client: clientHarness().client,
      policy: new SafetyPolicy({
        sapUrl: 'https://other.example.com:44300',
        sapClient: '200',
        systemRole: 'DEV',
        allowedHosts: 'other.example.com',
        allowedClients: '200',
        allowedNamespaces: 'Z,Y',
        auditPath: 'C:\\audit',
        toolProfile: 'development-workbench'
      }),
      audit: { append: jest.fn() }
    });
    // apply 仅接受本 server 实例生成的 planId（plan store 是实例内存态，
    // 重启/换环境后 planId 自然失效——PLAN_NOT_FOUND 即防线）
    await expect(foreign.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/does not exist/);
    // status 是本地读取，不触发 SAP
    expect(workflow.status(previewed.plan.ui5WritePlanId).status).toBe('PREVIEWED');
    // 二次 apply：PLAN_ALREADY_CONSUMED
    await workflow.applyConfirmed(previewed.plan.ui5WritePlanId);
    await expect(workflow.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/already succeeded/);
  });

  it('executes create_app and verifies existence on readback', async () => {
    const { workflow, calls, audit } = harness();
    const previewed: any = await workflow.preview({ kind: 'create_app', appName: 'ZNEW', packageName: 'ZPKG', description: 'demo' });
    const applied = await workflow.applyConfirmed(previewed.plan.ui5WritePlanId);
    expect(applied.status).toBe('success');
    expect(applied.sameValue).toBe(false);
    expect(calls).toContain('create:ZNEW');
    expect(workflow.status(previewed.plan.ui5WritePlanId).status).toBe('SUCCEEDED');
    const eventTypes = audit.append.mock.calls.map((c: any[]) => c[0].eventType);
    expect(eventTypes).toContain('UI5_WRITE_PREVIEW_CREATED');
    expect(eventTypes).toContain('UI5_WRITE_COMPLETED');
  });

  it('executes upload_file and fails VERIFICATION on readback mismatch', async () => {
    const { workflow, raw } = harness(APP_WITH_FILE);
    const previewed: any = await workflow.preview(BASE_INPUT);
    // 漂移复核读旧值照常；readback（第二次）返回被篡改内容
    (raw.ui5GetFileContent as jest.Mock).mockImplementationOnce((raw.ui5GetFileContent as jest.Mock).getMockImplementation()!);
    raw.ui5GetFileContent.mockImplementationOnce(async (input: any) => ({
      appName: input.appName, filePath: input.filePath, content: 'tampered', size: 8
    }));
    await expect(workflow.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/readback does not match/);
    expect(workflow.status(previewed.plan.ui5WritePlanId).status).toBe('FAILED');
  });

  it('executes delete_file and delete_app with readback', async () => {
    const { workflow, calls } = harness({
      apps: { ZAPP_SIMPLE: [{ path: '/.project', type: 'file' }] },
      files: { 'ZAPP_SIMPLE/.project': '{}' }
    });
    const file: any = await workflow.preview({ kind: 'delete_file', appName: 'ZAPP_SIMPLE', filePath: '.project' });
    await workflow.applyConfirmed(file.plan.ui5WritePlanId);
    expect(calls).toContain('deleteFile:ZAPP_SIMPLE/.project');

    const app: any = await workflow.preview({ kind: 'delete_app', appName: 'ZAPP_SIMPLE' });
    await workflow.applyConfirmed(app.plan.ui5WritePlanId);
    expect(calls).toContain('deleteApp:ZAPP_SIMPLE');
  });

  it('short-circuits same-value uploads without executing a write', async () => {
    const { workflow, raw, calls, audit } = harness({
      ...APP_WITH_FILE,
      files: { 'ZAPP_SIMPLE/WebContent/index.html': '<h1>hi</h1>' }
    });
    const previewed: any = await workflow.preview(BASE_INPUT);
    const applied = await workflow.applyConfirmed(previewed.plan.ui5WritePlanId);
    expect(applied.sameValue).toBe(true);
    expect(raw.ui5UploadFile).not.toHaveBeenCalled();
    expect(calls.filter(c => c.startsWith('upload:'))).toEqual([]);
    expect(audit.append.mock.calls.map((c: any[]) => c[0].eventType)).toContain('UI5_WRITE_SAME_VALUE');
  });

  it('rejects STATE_DRIFT before writing when the file vanished after preview', async () => {
    const { workflow, raw, calls } = harness({
      ...APP_WITH_FILE,
      files: { 'ZAPP_SIMPLE/WebContent/index.html': '<h1>old</h1>' }
    });
    // preview 时文件存在（内容不同，避免同值短路）
    const previewed: any = await workflow.preview({ ...BASE_INPUT, content: '<h1>new</h1>' });
    // preview 之后文件被他人删除：readState 走 404
    raw.ui5GetFileContent.mockImplementationOnce(async () => { throw notFound(); });
    await expect(workflow.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/existed at preview but is gone/);
    expect(calls.filter(c => c.startsWith('upload:'))).toEqual([]);
    expect(workflow.status(previewed.plan.ui5WritePlanId).status).toBe('FAILED');
  });

  it('marks UNKNOWN_OUTCOME when the write request fails mid-flight', async () => {
    const { workflow, raw, audit } = harness(APP_WITH_FILE);
    const previewed: any = await workflow.preview(BASE_INPUT);
    raw.ui5UploadFile.mockImplementationOnce(async () => { throw new Error('socket hang up'); });
    await expect(workflow.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/outcome is unknown/);
    expect(workflow.status(previewed.plan.ui5WritePlanId).status).toBe('UNKNOWN_OUTCOME');
    expect(audit.append.mock.calls.map((c: any[]) => c[0].eventType)).toContain('UI5_WRITE_UNKNOWN');
    // 终结语义：UNKNOWN 后不可重试
    await expect(workflow.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/already unknown_outcome/);
  });

  it('expires plans past the TTL', async () => {
    let now = 1_000_000;
    const { client } = clientHarness(APP_WITH_FILE);
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const workflow = new Ui5WriteWorkflow({ client, policy: policy(), audit, now: () => now });
    const previewed: any = await workflow.preview(BASE_INPUT);
    now += 16 * 60 * 1000; // 越过默认 15 分钟 TTL
    await expect(workflow.applyConfirmed(previewed.plan.ui5WritePlanId)).rejects.toThrow(/expired/);
    expect(workflow.status(previewed.plan.ui5WritePlanId).status).toBe('EXPIRED');
  });
});
