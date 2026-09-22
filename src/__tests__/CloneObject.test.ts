/**
 * 受控对象克隆三件套测试：ADT 协议函数（改名/读源）、工作流
 * （plan 冻结/确认/委托创建链/未知终结）、handler 工具面。
 * HTTP 与受控创建链全部 mock，不连接 SAP。
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  cloneSourceUrl, readCloneSource, renameCloneDeclarations
} from '../adt/CloneObjectApi';
import { CloneObjectWorkflow } from '../safe/CloneObjectWorkflow';
import { SafeAbapError } from '../safe/errors';
import { CloneObjectHandlers } from '../handlers/CloneObjectHandlers';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

const PROGRAM_SOURCE = (name: string) => `REPORT ${name.toLowerCase()}.\nWRITE / 'demo'.`;
const CLASS_SOURCE = (name: string) =>
  `CLASS ${name.toLowerCase()} DEFINITION PUBLIC FINAL.\nENDCLASS.\nCLASS ${name.toLowerCase()} IMPLEMENTATION.\nENDCLASS.`;
const INTERFACE_SOURCE = (name: string) => `INTERFACE ${name.toLowerCase()}.\nENDINTERFACE.`;

function makeHttp(bodyByType: Record<string, string>) {
  return {
    request: jest.fn(async (url: string) => ({
      status: 200,
      body: bodyByType[url] ?? '',
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    }))
  };
}

describe('CloneObjectApi protocol functions', () => {
  it('maps object types to ADT source URLs server-side', () => {
    expect(cloneSourceUrl('PROGRAM', ' Z_Src ')).toBe('/sap/bc/adt/programs/programs/z_src/source/main');
    expect(cloneSourceUrl('ABAP_CLASS', 'Z_Cls')).toBe('/sap/bc/adt/oo/classes/z_cls/source/main');
    expect(cloneSourceUrl('ABAP_INTERFACE', 'Z_If')).toBe('/sap/bc/adt/oo/interfaces/z_if/source/main');
  });

  it('renames the REPORT declaration (VSP CloneObject PROGRAM semantics)', () => {
    const renamed = renameCloneDeclarations(PROGRAM_SOURCE('zvold'), 'PROGRAM', 'ZVOLD', 'ZVNEW');
    expect(renamed).toBe('REPORT ZVNEW.\nWRITE / \'demo\'.');
  });

  it('renames both CLASS DEFINITION and IMPLEMENTATION declarations', () => {
    const renamed = renameCloneDeclarations(CLASS_SOURCE('zvold'), 'ABAP_CLASS', 'ZVOLD', 'ZVNEW');
    expect(renamed).not.toContain('zvold');
    expect((renamed.match(/ZVNEW/gi) || []).length).toBe(2);
  });

  it('renames the INTERFACE declaration case-insensitively', () => {
    const renamed = renameCloneDeclarations(INTERFACE_SOURCE('ZvOld'), 'ABAP_INTERFACE', 'ZVOLD', 'ZVNEW');
    expect(renamed).toBe('INTERFACE ZVNEW.\nENDINTERFACE.');
  });

  it('rejects sources whose declaration count does not match the expectation', () => {
    expect(() => renameCloneDeclarations('WRITE / \'no declaration\'.', 'PROGRAM', 'ZVOLD', 'ZVNEW'))
      .toThrow(/expected exactly 1/);
    expect(() => renameCloneDeclarations(`REPORT ZVOLD.\nREPORT ZVOLD.`, 'PROGRAM', 'ZVOLD', 'ZVNEW'))
      .toThrow(/expected exactly 1/);
    expect(() => renameCloneDeclarations(CLASS_SOURCE('zvold').replace(/\nENDCLASS\.[\s\S]*$/, ''), 'ABAP_CLASS', 'ZVOLD', 'ZVNEW'))
      .toThrow(/expected exactly 2/);
  });

  it('reads source over the resolved URL and rejects non-2xx responses', async () => {
    const http = makeHttp({ '/sap/bc/adt/programs/programs/z_ok/source/main': PROGRAM_SOURCE('z_ok') });
    await expect(readCloneSource(http as never, 'PROGRAM', 'Z_OK')).resolves.toBe(PROGRAM_SOURCE('z_ok'));
    const failing = { request: jest.fn(async () => ({ status: 404, body: 'not found', headers: {} })) };
    await expect(readCloneSource(failing as never, 'PROGRAM', 'Z_MISSING')).rejects.toThrow(/HTTP 404/);
  });
});

describe('CloneObjectWorkflow', () => {
  const policy = {
    systemHost: 'dev.test', client: '300', sapUser: 'DEVUSER', systemRole: 'DEV',
    toolProfile: 'development-workbench', planTtlMs: 15 * 60 * 1000
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };

  function makeWorkflow(httpBody: string, creation?: {
    preview?: jest.Mock; apply?: jest.Mock; status?: jest.Mock
  }) {
    const http = makeHttp({ '/sap/bc/adt/programs/programs/zvsrc/source/main': httpBody });
    const delegate = {
      preview: creation?.preview ?? jest.fn().mockResolvedValue({ status: 'preview', plan: { creationPlanId: 'CP-1' } }),
      apply: creation?.apply ?? jest.fn().mockResolvedValue({ status: 'success', plan: { status: 'APPLIED' } }),
      status: creation?.status ?? jest.fn().mockReturnValue({ status: 'APPLIED' })
    };
    const workflow = new CloneObjectWorkflow({ http: http as never, creation: delegate as never, policy: policy as never, audit }, 15 * 60 * 1000);
    return { workflow, delegate, http };
  }

  it('freezes a preview plan with source snapshot, rename, and payload hash', async () => {
    const { workflow, delegate } = makeWorkflow(PROGRAM_SOURCE('zvsrc'));
    const result = await workflow.preview({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    expect(result.status).toBe('preview');
    const plan = (result as { plan: Record<string, unknown> }).plan;
    expect(plan).toMatchObject({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001',
      description: 'Copy of ZVSRC', declarationChanges: 1
    });
    expect(String(plan.sourceUrl)).toContain('/programs/zvsrc/source/main');
    expect(String(plan.payloadHash)).toMatch(/^[a-f0-9]{64}$/);
    // 委托链在 preview 阶段绝不触碰
    expect(delegate.preview).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CLONE_PREVIEW_CREATED' }));
  });

  it('delegates apply to the controlled creation chain with the renamed frozen source', async () => {
    const { workflow, delegate } = makeWorkflow(PROGRAM_SOURCE('zvsrc'));
    const preview = await workflow.preview({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as { plan: { clonePlanId: string } }).plan.clonePlanId;
    const applied = await workflow.applyConfirmed(planId);
    expect(applied.status).toBe('success');
    // 创建链收到 objectKind=PROGRAM 与改名后的源码
    const previewRequest = delegate.preview.mock.calls[0][0] as Record<string, unknown>;
    expect(previewRequest).toMatchObject({ objectKind: 'PROGRAM', name: 'ZVDST', packageName: 'Z001', transportRequest: 'S4HK900009' });
    expect(String(previewRequest.source)).toBe('REPORT ZVDST.\nWRITE / \'demo\'.');
    expect(delegate.apply).toHaveBeenCalledWith('CP-1');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CLONE_COMPLETED', success: true }));
  });

  it('rejects applying the same plan twice', async () => {
    const { workflow } = makeWorkflow(PROGRAM_SOURCE('zvsrc'));
    const preview = await workflow.preview({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as { plan: { clonePlanId: string } }).plan.clonePlanId;
    await workflow.applyConfirmed(planId);
    await expect(workflow.applyConfirmed(planId)).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
  });

  it('terminates with UNKNOWN_OUTCOME when the creation chain reports an unknown write', async () => {
    const failingApply = jest.fn().mockRejectedValue(
      Object.assign(new Error('unknown'), { code: 'UNKNOWN_OUTCOME', isSafeAbapError: false })
    );
    // 模拟受控创建链抛 SafeAbapError('UNKNOWN_OUTCOME')
    const { SafeAbapError } = await import('../safe/errors');
    const applyUnknown = jest.fn().mockImplementation(() => {
      throw new SafeAbapError('UNKNOWN_OUTCOME', 'apply', 'The remote write outcome is unknown.');
    });
    const { workflow } = makeWorkflow(PROGRAM_SOURCE('zvsrc'), { apply: applyUnknown });
    const preview = await workflow.preview({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as { plan: { clonePlanId: string } }).plan.clonePlanId;
    await expect(workflow.applyConfirmed(planId)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CLONE_UNKNOWN', unknownOutcome: true }));
    // 终态后不可重试
    await expect(workflow.applyConfirmed(planId)).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    void failingApply;
  });

  it('marks FAILED and rethrows when the creation chain fails deterministically', async () => {
    const { SafeAbapError } = await import('../safe/errors');
    const applyFailed = jest.fn().mockImplementation(() => {
      throw new SafeAbapError('REMOTE_WRITE_FAILED', 'apply', 'Creation failed.');
    });
    const { workflow } = makeWorkflow(PROGRAM_SOURCE('zvsrc'), { apply: applyFailed });
    const preview = await workflow.preview({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as { plan: { clonePlanId: string } }).plan.clonePlanId;
    await expect(workflow.applyConfirmed(planId)).rejects.toMatchObject({ code: 'REMOTE_WRITE_FAILED' });
    expect(workflow.status(planId).status).toBe('FAILED');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CLONE_FAILED', success: false }));
  });

  it('rejects preview inputs: bad type, same names, bad transport, unreadable source', async () => {
    const { workflow } = makeWorkflow(PROGRAM_SOURCE('zvsrc'));
    await expect(workflow.preview({ objectType: 'DATABASE_TABLE' as never, sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(workflow.preview({ objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVSRC', packageName: 'Z001', transport: 'S4HK900009' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(workflow.preview({ objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'SHORT' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const emptyHttp = makeHttp({});
    const emptyWorkflow = new CloneObjectWorkflow({ http: emptyHttp as never, creation: makeWorkflow('', {}).delegate as never, policy: policy as never, audit });
    await expect(emptyWorkflow.preview({ objectType: 'PROGRAM', sourceName: 'ZVMISS', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects context-mismatched plan access (replay across profiles)', async () => {
    // 同一 policy 对象原地改 profile：plan 的上下文快照在 preview 时冻结，
    // apply/status 时按当前 policy 上下文比对——跨 profile 重放必须拒绝。
    const mutablePolicy = { ...policy };
    const { workflow } = makeWorkflow(PROGRAM_SOURCE('zvsrc'));
    (workflow as unknown as { deps: { policy: unknown } }).deps.policy = mutablePolicy;
    const preview = await workflow.preview({
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as { plan: { clonePlanId: string } }).plan.clonePlanId;
    mutablePolicy.toolProfile = 'development';
    expect(() => workflow.status(planId)).toThrow(/different SAP context/);
    expect(() => workflow.status(planId)).toThrow(SafeAbapError);
  });
});

describe('CloneObjectHandlers', () => {
  const policy = {
    systemHost: 'dev.test', client: '300', sapUser: 'DEVUSER', systemRole: 'DEV',
    toolProfile: 'development-workbench', planTtlMs: 15 * 60 * 1000
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };

  function makeHandlers(supportsElicitation = true, accept = true) {
    const http = makeHttp({ '/sap/bc/adt/programs/programs/zvsrc/source/main': PROGRAM_SOURCE('zvsrc') });
    const delegate = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { creationPlanId: 'CP-1' } }),
      apply: jest.fn().mockResolvedValue({ status: 'success' }),
      status: jest.fn().mockReturnValue({ status: 'APPLIED' })
    };
    const workflow = new CloneObjectWorkflow({ http: http as never, creation: delegate as never, policy: policy as never, audit });
    const confirmation = {
      supportsFormElicitation: () => supportsElicitation,
      elicitInput: jest.fn(async (_params: ElicitRequestFormParams, _timeout: number): Promise<ElicitResult> =>
        accept ? { action: 'accept', content: { decision: 'apply' } } : { action: 'cancel' })
    };
    return { handlers: new CloneObjectHandlers(workflow, confirmation), workflow, confirmation, delegate };
  }

  it('exposes exactly three tools with correct annotations', () => {
    const { handlers } = makeHandlers();
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['previewCloneObject', 'applyCloneObject', 'getCloneObjectStatus']);
    expect(tools.find(t => t.name === 'applyCloneObject')?._meta.operationClass).toBe('mutating tenant');
    expect(tools.find(t => t.name === 'previewCloneObject')?._meta.operationClass).toBe('read-only tenant');
    expect(tools.find(t => t.name === 'getCloneObjectStatus')?._meta.operationClass).toBe('local-only');
  });

  it('preview/apply/status roundtrip and confirmation gate', async () => {
    const { handlers } = makeHandlers();
    const preview = await handlers.handle('previewCloneObject', {
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as any).structuredContent.result.plan.clonePlanId as string;
    expect(planId).toBeTruthy();
    const applied = await handlers.handle('applyCloneObject', { clonePlanId: planId });
    expect((applied as any).structuredContent.result.status).toBe('success');
    const status = await handlers.handle('getCloneObjectStatus', { clonePlanId: planId });
    expect((status as any).structuredContent.result.status).toBe('SUCCEEDED');
  });

  it('rejects apply without elicitation support or with cancel decision', async () => {
    const unsupported = makeHandlers(false);
    const preview = await unsupported.handlers.handle('previewCloneObject', {
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as any).structuredContent.result.plan.clonePlanId as string;
    await expect(unsupported.handlers.handle('applyCloneObject', { clonePlanId: planId }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_UNSUPPORTED' });

    const cancelled = makeHandlers(true, false);
    const preview2 = await cancelled.handlers.handle('previewCloneObject', {
      objectType: 'PROGRAM', sourceName: 'ZVSRC', targetName: 'ZVDST', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId2 = (preview2 as any).structuredContent.result.plan.clonePlanId as string;
    await expect(cancelled.handlers.handle('applyCloneObject', { clonePlanId: planId2 }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('requires clonePlanId and rejects unknown tools', async () => {
    const { handlers } = makeHandlers();
    await expect(handlers.handle('applyCloneObject', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('nopeTool', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
