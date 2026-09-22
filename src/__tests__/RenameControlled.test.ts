/**
 * 受控对象重命名三件套测试：工作流（plan 冻结/确认/克隆+清理双委托/
 * PARTIAL_RENAME 防御语义/未知终结）、handler 工具面。
 * HTTP、克隆工作流与清理工作流全部 mock，不连接 SAP。
 */
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { RenameControlledWorkflow } from '../safe/RenameControlledWorkflow';
import { RenameControlledHandlers } from '../handlers/RenameControlledHandlers';
import { SafeAbapError } from '../safe/errors';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

const PROGRAM_SOURCE = (name: string) => `REPORT ${name.toLowerCase()}.\nWRITE / 'demo'.`;

function makeHttp(body: string) {
  return {
    request: jest.fn(async (url: string) => ({
      status: 200,
      body: body.includes('source/main') ? body : body,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    }))
  };
}

describe('RenameControlledWorkflow', () => {
  const policy = {
    systemHost: 'dev.test', client: '300', sapUser: 'DEVUSER', systemRole: 'DEV',
    toolProfile: 'development-workbench', planTtlMs: 15 * 60 * 1000
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };

  interface Delegates {
    clonePreview?: jest.Mock; cloneApply?: jest.Mock;
    cleanupPreview?: jest.Mock; cleanupApply?: jest.Mock;
  }

  function makeWorkflow(delegates: Delegates = {}) {
    const http = makeHttp(PROGRAM_SOURCE('zvold'));
    const clone = {
      preview: delegates.clonePreview ?? jest.fn().mockResolvedValue({ status: 'preview', plan: { clonePlanId: 'CL-1' } }),
      applyConfirmed: delegates.cloneApply ?? jest.fn().mockResolvedValue({ status: 'success', creation: {} })
    };
    const cleanup = {
      preview: delegates.cleanupPreview ?? jest.fn().mockResolvedValue({ status: 'preview', plan: { cleanupPlanId: 'CU-1' } }),
      apply: delegates.cleanupApply ?? jest.fn().mockResolvedValue({ status: 'success' }),
      status: jest.fn().mockReturnValue({ status: 'APPLIED' })
    };
    const workflow = new RenameControlledWorkflow({
      http: http as never, clone: clone as never, cleanup: cleanup as never,
      policy: policy as never, audit
    });
    return { workflow, clone, cleanup };
  }

  async function previewPlan(workflow: RenameControlledWorkflow) {
    const result = await workflow.preview({
      objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001', transport: 'S4HK900009'
    });
    return (result as { plan: import('../safe/RenameControlledWorkflow').RenameObjectPlanView }).plan;
  }

  it('freezes a preview plan with snapshot identity and zero write-side calls', async () => {
    const { workflow, clone, cleanup } = makeWorkflow();
    const plan = await previewPlan(workflow);
    expect(plan).toMatchObject({
      objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001',
      description: 'Renamed from ZVOLD', declarationChanges: 1
    });
    expect(String(plan.oldObjectUrl)).toBe('/sap/bc/adt/programs/programs/zvold');
    expect(String(plan.payloadHash)).toMatch(/^[a-f0-9]{64}$/);
    expect(clone.preview).not.toHaveBeenCalled();
    expect(cleanup.preview).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RENAME_PREVIEW_CREATED' }));
  });

  it('applies by delegating to the clone workflow first and the cleanup workflow second', async () => {
    const { workflow, clone, cleanup } = makeWorkflow();
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId);
    expect(applied.status).toBe('success');
    // 克隆侧收到旧名→新名与冻结描述
    const cloneRequest = clone.preview.mock.calls[0][0] as Record<string, unknown>;
    expect(cloneRequest).toMatchObject({
      objectType: 'PROGRAM', sourceName: 'ZVOLD', targetName: 'ZVNEW',
      packageName: 'Z001', transport: 'S4HK900009', description: 'Renamed from ZVOLD'
    });
    expect(clone.applyConfirmed).toHaveBeenCalledWith('CL-1');
    // 清理侧删除旧对象（objectKind=PROGRAM + name=ZVOLD）
    const cleanupRequest = cleanup.preview.mock.calls[0][0] as Record<string, unknown>;
    expect(cleanupRequest).toEqual({ objectKind: 'PROGRAM', name: 'ZVOLD' });
    expect(cleanup.apply).toHaveBeenCalledWith('CU-1');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RENAME_COMPLETED', success: true }));
  });

  it('keeps both objects and reports PARTIAL_RENAME when the cleanup side fails', async () => {
    const { workflow } = makeWorkflow({
      cleanupApply: jest.fn().mockRejectedValue(new Error('delete refused: dependencies exist'))
    });
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId) as Record<string, any>;
    // 防御语义：返回 partial（不抛错），新对象保留旧对象保留，guidance 明确
    expect(applied.status).toBe('partial');
    expect(applied.plan.status).toBe('PARTIAL_RENAME');
    expect(applied.cleanupError).toContain('dependencies exist');
    expect(applied.guidance).toContain('ZVNEW');
    expect(applied.guidance).toContain('manually');
    expect(workflow.status(plan.renamePlanId).status).toBe('PARTIAL_RENAME');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RENAME_PARTIAL', success: false }));
  });

  it('upgrades to SUCCEEDED via absence recheck when the delete landed but transport evidence failed', async () => {
    // 实测形态：删除已生效（旧对象源码读取返回非 2xx——该环境实测为 500 带
    // 本地化消息，按状态码而非消息文本判定），清理链后置传输证据校验失败
    //（子任务聚合形态 key 组零匹配）。缺席复核作为独立只读证据收敛 SUCCEEDED。
    const absentHttp = {
      request: jest.fn()
        // preview 读源成功
        .mockImplementationOnce(async () => ({ status: 200, body: PROGRAM_SOURCE('zvold'), headers: {} }))
        // 缺席复核：非 2xx HTTP 响应（该环境删除后形态）
        .mockImplementationOnce(async () => ({ status: 500, body: '没有找到角色', headers: {} }))
    };
    const clone = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { clonePlanId: 'CL-1' } }),
      applyConfirmed: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const cleanup = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { cleanupPlanId: 'CU-1' } }),
      apply: jest.fn().mockRejectedValue(new SafeAbapError('VERIFICATION_FAILED', 'cleanup-transport',
        'The validation transport must retain exactly one matching deletion entry or one neutral same-transport entry after cleanup.')),
      status: jest.fn().mockReturnValue({ status: 'FAILED' })
    };
    const workflow = new RenameControlledWorkflow({
      http: absentHttp as never, clone: clone as never, cleanup: cleanup as never,
      policy: policy as never, audit
    });
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId) as Record<string, any>;
    expect(applied.status).toBe('success');
    expect(applied.deleteVerifiedBy).toBe('absence-recheck');
    expect(workflow.status(plan.renamePlanId).status).toBe('SUCCEEDED');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RENAME_COMPLETED', success: true }));
  });

  it('stays PARTIAL when the cleanup fails and the old object is still readable', async () => {
    // 删除未生效（旧对象仍可读）→ 不允许用缺席复核掩盖，保守走 PARTIAL
    const { workflow } = makeWorkflow({
      cleanupApply: jest.fn().mockRejectedValue(new SafeAbapError('VERIFICATION_FAILED', 'cleanup-transport',
        'The validation transport must retain exactly one matching deletion entry.'))
    });
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId) as Record<string, any>;
    expect(applied.status).toBe('partial');
    expect(applied.plan.status).toBe('PARTIAL_RENAME');
  });

  it('upgrades to SUCCEEDED when absence recheck sees the ADT-client error shape (err field)', async () => {
    // 本项目 ADT 客户端把非 2xx 转成 AdtErrorException（状态码在 err 字段而非
    // status，消息可能本地化）——缺席复核必须兼容该形态。
    const adtShapeHttp = {
      request: jest.fn()
        .mockImplementationOnce(async () => ({ status: 200, body: PROGRAM_SOURCE('zvold'), headers: {} }))
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error('没有找到角色'), { err: 500 });
        })
    };
    const clone = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { clonePlanId: 'CL-1' } }),
      applyConfirmed: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const cleanup = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { cleanupPlanId: 'CU-1' } }),
      apply: jest.fn().mockRejectedValue(new SafeAbapError('VERIFICATION_FAILED', 'cleanup-transport', 'evidence gap')),
      status: jest.fn().mockReturnValue({ status: 'FAILED' })
    };
    const workflow = new RenameControlledWorkflow({
      http: adtShapeHttp as never, clone: clone as never, cleanup: cleanup as never,
      policy: policy as never, audit
    });
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId) as Record<string, any>;
    expect(applied.status).toBe('success');
    expect(applied.deleteVerifiedBy).toBe('absence-recheck');
  });

  it('stays PARTIAL when the absence recheck hits lock conflict (object may remain)', async () => {
    // 409 锁冲突：对象可能仍在（ENQ 残留），不判缺席，保守走 PARTIAL
    const conflictHttp = {
      request: jest.fn()
        .mockImplementationOnce(async () => ({ status: 200, body: PROGRAM_SOURCE('zvold'), headers: {} }))
        .mockImplementationOnce(async () => ({ status: 409, body: 'locked', headers: {} }))
    };
    const clone = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { clonePlanId: 'CL-1' } }),
      applyConfirmed: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const cleanup = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { cleanupPlanId: 'CU-1' } }),
      apply: jest.fn().mockRejectedValue(new SafeAbapError('VERIFICATION_FAILED', 'cleanup-transport', 'evidence gap')),
      status: jest.fn().mockReturnValue({ status: 'FAILED' })
    };
    const workflow = new RenameControlledWorkflow({
      http: conflictHttp as never, clone: clone as never, cleanup: cleanup as never,
      policy: policy as never, audit
    });
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId) as Record<string, any>;
    expect(applied.status).toBe('partial');
  });

  it('stays PARTIAL when the absence recheck itself errors (unknown absence)', async () => {
    // 缺席复核通道网络层异常（无 status）→ 保守走 PARTIAL，不得盲判
    const flakyHttp = {
      request: jest.fn()
        // preview 读源成功
        .mockImplementationOnce(async () => ({ status: 200, body: PROGRAM_SOURCE('zvold'), headers: {} }))
        // 缺席复核异常
        .mockRejectedValueOnce(new Error('connection reset'))
    };
    const clone = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { clonePlanId: 'CL-1' } }),
      applyConfirmed: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const cleanup = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { cleanupPlanId: 'CU-1' } }),
      apply: jest.fn().mockRejectedValue(new SafeAbapError('VERIFICATION_FAILED', 'cleanup-transport', 'evidence gap')),
      status: jest.fn().mockReturnValue({ status: 'FAILED' })
    };
    const workflow = new RenameControlledWorkflow({
      http: flakyHttp as never, clone: clone as never, cleanup: cleanup as never,
      policy: policy as never, audit
    });
    const plan = await previewPlan(workflow);
    const applied = await workflow.applyConfirmed(plan.renamePlanId) as Record<string, any>;
    expect(applied.status).toBe('partial');
  });

  it('terminates with UNKNOWN_OUTCOME when the clone side reports an unknown write', async () => {
    const { workflow } = makeWorkflow({
      cloneApply: jest.fn().mockImplementation(() => {
        throw new SafeAbapError('UNKNOWN_OUTCOME', 'apply', 'The remote write outcome is unknown.');
      })
    });
    const plan = await previewPlan(workflow);
    await expect(workflow.applyConfirmed(plan.renamePlanId)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    // 终态后不可重试；清理侧绝不触碰
    await expect(workflow.applyConfirmed(plan.renamePlanId)).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RENAME_UNKNOWN', unknownOutcome: true }));
  });

  it('marks FAILED and rethrows when the clone side fails deterministically', async () => {
    const { workflow, cleanup } = makeWorkflow({
      cloneApply: jest.fn().mockImplementation(() => {
        throw new SafeAbapError('REMOTE_WRITE_FAILED', 'apply', 'Creation failed.');
      })
    });
    const plan = await previewPlan(workflow);
    await expect(workflow.applyConfirmed(plan.renamePlanId)).rejects.toMatchObject({ code: 'REMOTE_WRITE_FAILED' });
    expect(workflow.status(plan.renamePlanId).status).toBe('FAILED');
    // 创建失败时绝不删除旧对象（旧对象是唯一存活副本）
    expect(cleanup.preview).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RENAME_FAILED', success: false }));
  });

  it('rejects preview inputs: bad type, same names, bad transport, empty source', async () => {
    const { workflow } = makeWorkflow();
    await expect(workflow.preview({ objectType: 'DATABASE_TABLE' as never, oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001', transport: 'S4HK900009' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(workflow.preview({ objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVOLD', packageName: 'Z001', transport: 'S4HK900009' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(workflow.preview({ objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001', transport: 'SHORT' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const emptyHttp = makeHttp('');
    const emptyWorkflow = new RenameControlledWorkflow({
      http: emptyHttp as never, clone: makeWorkflow().clone as never, cleanup: makeWorkflow().cleanup as never,
      policy: policy as never, audit
    });
    await expect(emptyWorkflow.preview({ objectType: 'PROGRAM', oldName: 'ZVMISS', newName: 'ZVNEW', packageName: 'Z001', transport: 'S4HK900009' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects context-mismatched plan access (replay across profiles)', async () => {
    const mutablePolicy = { ...policy };
    const { workflow } = makeWorkflow();
    (workflow as unknown as { deps: { policy: unknown } }).deps.policy = mutablePolicy;
    const plan = await previewPlan(workflow);
    mutablePolicy.toolProfile = 'development';
    expect(() => workflow.status(plan.renamePlanId)).toThrow(SafeAbapError);
    expect(() => workflow.status(plan.renamePlanId)).toThrow(/different SAP context/);
  });
});

describe('RenameControlledHandlers', () => {
  const policy = {
    systemHost: 'dev.test', client: '300', sapUser: 'DEVUSER', systemRole: 'DEV',
    toolProfile: 'development-workbench', planTtlMs: 15 * 60 * 1000
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };

  function makeHandlers(supportsElicitation = true, accept = true) {
    const http = makeHttp(PROGRAM_SOURCE('zvold'));
    const clone = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { clonePlanId: 'CL-1' } }),
      applyConfirmed: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const cleanup = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: { cleanupPlanId: 'CU-1' } }),
      apply: jest.fn().mockResolvedValue({ status: 'success' }),
      status: jest.fn().mockReturnValue({ status: 'APPLIED' })
    };
    const workflow = new RenameControlledWorkflow({
      http: http as never, clone: clone as never, cleanup: cleanup as never, policy: policy as never, audit
    });
    const confirmation = {
      supportsFormElicitation: () => supportsElicitation,
      elicitInput: jest.fn(async (_params: ElicitRequestFormParams, _timeout: number): Promise<ElicitResult> =>
        accept ? { action: 'accept', content: { decision: 'apply' } } : { action: 'cancel' })
    };
    return { handlers: new RenameControlledHandlers(workflow, confirmation), confirmation };
  }

  it('exposes exactly three tools with correct annotations (apply is destructive)', () => {
    const { handlers } = makeHandlers();
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['previewControlledRename', 'applyControlledRename', 'getControlledRenameStatus']);
    expect(tools.find(t => t.name === 'applyControlledRename')?._meta.operationClass).toBe('mutating tenant');
    expect(tools.find(t => t.name === 'applyControlledRename')?.annotations.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === 'previewControlledRename')?._meta.operationClass).toBe('read-only tenant');
    expect(tools.find(t => t.name === 'getControlledRenameStatus')?._meta.operationClass).toBe('local-only');
  });

  it('preview/apply/status roundtrip with confirmation', async () => {
    const { handlers } = makeHandlers();
    const preview = await handlers.handle('previewControlledRename', {
      objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as any).structuredContent.result.plan.renamePlanId as string;
    expect(planId).toBeTruthy();
    const applied = await handlers.handle('applyControlledRename', { renamePlanId: planId });
    expect((applied as any).structuredContent.result.status).toBe('success');
    const status = await handlers.handle('getControlledRenameStatus', { renamePlanId: planId });
    expect((status as any).structuredContent.result.status).toBe('SUCCEEDED');
  });

  it('rejects apply without elicitation support or with cancel decision', async () => {
    const unsupported = makeHandlers(false);
    const preview = await unsupported.handlers.handle('previewControlledRename', {
      objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId = (preview as any).structuredContent.result.plan.renamePlanId as string;
    await expect(unsupported.handlers.handle('applyControlledRename', { renamePlanId: planId }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_UNSUPPORTED' });

    const cancelled = makeHandlers(true, false);
    const preview2 = await cancelled.handlers.handle('previewControlledRename', {
      objectType: 'PROGRAM', oldName: 'ZVOLD', newName: 'ZVNEW', packageName: 'Z001', transport: 'S4HK900009'
    });
    const planId2 = (preview2 as any).structuredContent.result.plan.renamePlanId as string;
    await expect(cancelled.handlers.handle('applyControlledRename', { renamePlanId: planId2 }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('requires renamePlanId and rejects unknown tools', async () => {
    const { handlers } = makeHandlers();
    await expect(handlers.handle('applyControlledRename', {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handlers.handle('nopeTool', {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });
});
