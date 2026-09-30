import { AbapChangeConfirmation, type AbapChangeConfirmationOptions } from '../safe/AbapChangeConfirmation';
import { AbapChangeWorkflow } from '../safe/AbapChangeWorkflow';
import { TransportCreationConfirmation } from '../safe/TransportCreationConfirmation';
import { DebugConfirmation } from '../safe/DebugConfirmation';
import { createRepositoryCreationConfirmationProvider } from '../safe/RepositoryCreationConfirmationProvider';
import { RepositoryCreationConfirmationChallengeStore } from '../safe/RepositoryCreationConfirmationChallengeStore';
import { RepositoryObjectCreationConfirmation } from '../safe/RepositoryObjectCreationConfirmation';
import type { ChangePlanView } from '../safe/types';
import type { ElicitResult } from '../lib/McpErrorCompat.js';

/**
 * SAP_MCP_CONFIRMATION_MODE=auto（部署配置预授权）专项覆盖：
 * - auto 开启时各确认链跳过人工表单（elicitInput 不被调用），apply 携带 confirmationMode='auto-config'；
 * - auto 不绕过 plan 状态机：非 PREVIEWED 的 plan 依旧拒绝；
 * - 未开启 autoApprove（默认 native）时行为与既有确认链完全一致。
 */

describe('Confirmation auto-approve (SAP_MCP_CONFIRMATION_MODE=auto)', () => {
  const changePlan: ChangePlanView = {
    changePlanId: 'plan-1',
    createdAt: '2026-08-11T12:00:00.000Z',
    expiresAt: '2099-08-11T12:15:00.000Z',
    status: 'PREVIEWED',
    systemHost: 'dev.example.com',
    client: '100',
    object: {
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      adtType: 'PROG/P',
      objectUrl: '/sap/bc/adt/programs/programs/ztest',
      sourceUrl: '/sap/bc/adt/programs/programs/ztest/source/main',
      lockUrl: '/sap/bc/adt/programs/programs/ztest',
      activationName: 'ZTEST',
      activationUrl: '/sap/bc/adt/programs/programs/ztest'
    },
    transportRequest: 'DEVK900001',
    originalHash: 'original-hash',
    targetHash: 'target-hash',
    diffSummary: { addedLines: 1, removedLines: 0, unchangedPrefixLines: 1, unchangedSuffixLines: 0 },
    syntaxMessages: [],
    stages: []
  };

  // 传输创建链确认表单需要 target.devClass/requestText 与属主信息
  const transportPlan = {
    transportCreationPlanId: 'tc-1',
    status: 'PREVIEWED' as const,
    createdAt: '2026-09-30T00:00:00.000Z',
    expiresAt: '2099-09-30T00:15:00.000Z',
    systemHost: 'dev.example.com',
    client: '100',
    sapUser: 'DEVUSER',
    target: { devClass: 'Z001', requestText: 'AI 全权模式 smoke' }
  };

  function createChangeSubject(autoApprove: (() => boolean) | undefined) {
    const workflow = {
      status: jest.fn().mockReturnValue(changePlan),
      apply: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const options: AbapChangeConfirmationOptions = {
      allowTextConfirmation: false,
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'apply' } } satisfies ElicitResult),
      autoApprove,
      applyConfirmed: undefined,
      createTextCode: () => '123456'
    };
    return {
      workflow,
      options,
      confirmation: new AbapChangeConfirmation(workflow as unknown as AbapChangeWorkflow, options)
    };
  }

  it('AbapChange: auto mode applies with confirmationMode=auto-config without elicitation', async () => {
    const { confirmation, workflow, options } = createChangeSubject(() => true);

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toEqual({ status: 'success' });
    expect(options.elicitInput).not.toHaveBeenCalled();
    expect(workflow.apply).toHaveBeenCalledWith({
      changePlanId: 'plan-1',
      confirmedByUser: true,
      confirmationMode: 'auto-config'
    });
  });

  it('AbapChange: auto mode still refuses an already-consumed plan', async () => {
    const { confirmation, workflow } = createChangeSubject(() => true);
    workflow.status.mockReturnValue({ ...changePlan, status: 'APPLYING' });

    await expect(confirmation.confirmAndApply('plan-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('AbapChange: default (no autoApprove) keeps the native elicitation flow', async () => {
    const { confirmation, workflow, options } = createChangeSubject(undefined);

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toEqual({ status: 'success' });
    expect(options.elicitInput).toHaveBeenCalledTimes(1);
    expect(workflow.apply).toHaveBeenCalledWith({
      changePlanId: 'plan-1',
      confirmedByUser: true,
      confirmationMode: 'elicitation'
    });
  });

  it('TransportCreation: auto mode runs the plan directly without elicitation', async () => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'created' });
    const elicitInput = jest.fn();
    const confirmation = new TransportCreationConfirmation(
      { status: () => transportPlan as never },
      { supportsFormElicitation: () => true, elicitInput, applyConfirmed, autoApprove: () => true }
    );

    await expect(confirmation.confirmAndRun('tc-1')).resolves.toEqual({ status: 'created' });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith('tc-1');
  });

  it('TransportCreation: default flow still requires an accepted form decision', async () => {
    const applyConfirmed = jest.fn();
    const confirmation = new TransportCreationConfirmation(
      { status: () => transportPlan as never },
      {
        supportsFormElicitation: () => true,
        elicitInput: jest.fn().mockResolvedValue({ action: 'decline' }),
        applyConfirmed
      }
    );

    await expect(confirmation.confirmAndRun('tc-1')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('Debug: auto mode applies the variable change with confirmationMode=auto-config', async () => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'applied' });
    const elicitInput = jest.fn();
    const workflow = {
      status: () => ({ status: 'PREVIEWED', operation: { kind: 'SET_VARIABLE' } }),
      currentAttach: () => ({ processId: 42 })
    };
    const confirmation = new DebugConfirmation(workflow as never, {
      supportsFormElicitation: () => true,
      elicitInput,
      applyConfirmed,
      autoApprove: () => true
    });

    await expect(confirmation.confirmAndApply('dbg-1', 'VARIABLE')).resolves.toEqual({ status: 'applied' });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith({
      debugOperationPlanId: 'dbg-1',
      confirmedByUser: true,
      confirmationMode: 'auto-config'
    });
  });

  it('provider factory: auto-approve returns an immediate apply decision without elicitation', async () => {
    const elicitInput = jest.fn();
    const provider = createRepositoryCreationConfirmationProvider({
      confirmationAutoApprove: true,
      supportsFormElicitation: () => true,
      elicitInput
    });

    expect(provider.mode).toBe('auto-config');
    await expect(provider.confirm({ challengeId: 'ch-1' } as never, { timeoutMs: 1_000 }))
      .resolves.toEqual({ action: 'apply', challengeId: 'ch-1' });
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it('provider factory: default keeps the mcp-form provider', () => {
    const provider = createRepositoryCreationConfirmationProvider({
      supportsFormElicitation: () => true,
      elicitInput: jest.fn()
    });
    expect(provider.mode).toBe('mcp-form');
  });

  it('repository creation chain: auto provider consumes the challenge and audits auto-config end to end', async () => {
    const planView = {
      creationPlanId: 'rc-1',
      status: 'PREVIEWED' as const,
      createdAt: '2026-09-30T00:00:00.000Z',
      expiresAt: '2099-09-30T00:15:00.000Z',
      systemHost: 'dev.example.com',
      client: '100',
      sapUser: 'DEVUSER',
      systemRole: 'DEV',
      toolProfile: 'development-workbench',
      summary: '创建 PROGRAM ZZ_AUTO_TEST',
      payloadHash: 'a'.repeat(64),
      transportRequest: 'DEVK900001',
      target: { objectKind: 'PROGRAM', objectName: 'ZZ_AUTO_TEST', parentName: '', packageName: 'Z001' }
    };
    const audit = jest.fn().mockResolvedValue(undefined);
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'created' });
    const elicitInput = jest.fn();
    const provider = createRepositoryCreationConfirmationProvider({
      confirmationAutoApprove: true,
      supportsFormElicitation: () => true,
      elicitInput
    });
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: () => planView as never },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'sess-1',
        applyConfirmed,
        audit
      }
    );

    await expect(confirmation.confirmAndApply('rc-1')).resolves.toEqual({ status: 'created' });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith('rc-1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      providerMode: 'auto-config',
      action: 'requested',
      challengeStatus: 'PENDING'
    }));
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      providerMode: 'auto-config',
      action: 'apply',
      challengeStatus: 'CONSUMED'
    }));
  });

  it('repository creation chain: auto provider still refuses a non-PREVIEWED plan', async () => {
    const planView = {
      creationPlanId: 'rc-1',
      status: 'APPLIED' as const,
      expiresAt: '2099-09-30T00:15:00.000Z',
      systemHost: 'dev.example.com',
      client: '100',
      sapUser: 'DEVUSER',
      systemRole: 'DEV',
      toolProfile: 'development-workbench',
      summary: '创建 PROGRAM ZZ_AUTO_TEST',
      payloadHash: 'a'.repeat(64),
      transportRequest: 'DEVK900001',
      target: { objectKind: 'PROGRAM', objectName: 'ZZ_AUTO_TEST', parentName: '', packageName: 'Z001' }
    };
    const provider = createRepositoryCreationConfirmationProvider({
      confirmationAutoApprove: true,
      supportsFormElicitation: () => true,
      elicitInput: jest.fn()
    });
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: () => planView as never },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'sess-1',
        applyConfirmed: jest.fn()
      }
    );

    await expect(confirmation.confirmAndApply('rc-1')).rejects.toMatchObject({ code: 'PLAN_NOT_EXECUTABLE' });
  });
});
