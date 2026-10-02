import { AbapChangeConfirmation, type AbapChangeConfirmationOptions } from '../safe/AbapChangeConfirmation';
import { AbapChangeWorkflow } from '../safe/AbapChangeWorkflow';
import { AbapCreationConfirmation, type AbapCreationConfirmationOptions } from '../safe/AbapCreationConfirmation';
import { AbapObjectCreationWorkflow } from '../safe/AbapObjectCreationWorkflow';
import { TransportCreationConfirmation } from '../safe/TransportCreationConfirmation';
import { TransportCleanupConfirmation } from '../safe/TransportCleanupConfirmation';
import { ObjectActivationConfirmation } from '../safe/ObjectActivationConfirmation';
import { QualityCheckConfirmation } from '../safe/QualityCheckConfirmation';
import { AdvancedOperationConfirmation } from '../safe/AdvancedOperationConfirmation';
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
    expect(applyConfirmed).toHaveBeenCalledWith('tc-1', 'auto-config');
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

  // ---------------------------------------------------------------------------
  // 一致性覆盖（交接任务 A1-1/A1-2）：全部确认类统一断言——
  //   1) autoApprove()=true 时绝不触碰 supportsFormElicitation / elicitInput
  //      （无 elicitation 能力的客户端在 auto 部署下也能完成全链 apply）；
  //   2) plan 状态校验先于短路执行（非 PREVIEWED 的 plan 照常拒绝）；
  //   3) apply 回调如实收到 confirmationMode='auto-config'（与审计一致）；
  //   4) native 模式（未注入 autoApprove）行为不变。
  // ---------------------------------------------------------------------------

  /** 远端未来时间：保证 plan 不过期。 */
  const future = '2099-09-30T00:15:00.000Z';

  it('AbapCreation: auto mode applies with auto-config even when the client has no elicitation', async () => {
    const workflow = {
      status: jest.fn().mockReturnValue({ status: 'PREVIEWED', creationPlanId: 'plan-1', expiresAt: future }),
      apply: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const options: AbapCreationConfirmationOptions = {
      allowTextConfirmation: false,
      supportsFormElicitation: jest.fn(() => false),
      elicitInput: jest.fn(),
      autoApprove: () => true,
      applyConfirmed: input => workflow.apply(input)
    };
    const confirmation = new AbapCreationConfirmation(workflow as unknown as AbapObjectCreationWorkflow, options);

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toEqual({ status: 'success' });
    expect(options.supportsFormElicitation).not.toHaveBeenCalled();
    expect(options.elicitInput).not.toHaveBeenCalled();
    expect(workflow.apply).toHaveBeenCalledWith({ creationPlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'auto-config' });
  });

  it('AbapCreation: auto mode still refuses an already-consumed plan', async () => {
    const workflow = {
      status: jest.fn().mockReturnValue({ status: 'APPLYING', creationPlanId: 'plan-1', expiresAt: future }),
      apply: jest.fn()
    };
    const confirmation = new AbapCreationConfirmation(workflow as unknown as AbapObjectCreationWorkflow, {
      allowTextConfirmation: false,
      supportsFormElicitation: () => false,
      elicitInput: jest.fn(),
      autoApprove: () => true
    });

    await expect(confirmation.confirmAndApply('plan-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  function createAdvancedSubject(status: string, autoApprove: (() => boolean) | undefined) {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'applied' });
    const elicitInput = jest.fn();
    const supportsFormElicitation = jest.fn(() => true);
    const confirmation = new AdvancedOperationConfirmation(
      // plan 视图只需 confirmation 层读取的 status/operationKind/expiresAt 字段
      { status: () => ({
        status,
        operationKind: 'SET_DATA_ELEMENT_PROPERTIES',
        expiresAt: future,
        systemHost: 'dev.example.com',
        client: '100',
        transport: 'S4HK900001',
        target: { objectType: 'DATA_ELEMENT', objectName: 'ZTEST_DTEL' },
        inputSummary: { title: 'Set data element properties' },
        currentStateSummary: {},
        payloadFingerprint: {},
        rollbackSupported: false
      }) as never },
      {
        supportsFormElicitation,
        elicitInput,
        autoApprove,
        applyConfirmed
      }
    );
    return { confirmation, applyConfirmed, elicitInput, supportsFormElicitation };
  }

  it('AdvancedOperation: auto mode applies with auto-config even when the client has no elicitation', async () => {
    const { confirmation, applyConfirmed, elicitInput, supportsFormElicitation } = createAdvancedSubject('PREVIEWED', () => true);
    // 部署级 auto 下客户端无 elicitation 能力也不允许报 CONFIRMATION_UNSUPPORTED
    (confirmation as unknown as { options: { supportsFormElicitation: () => boolean } }).options.supportsFormElicitation = jest.fn(() => false);

    await expect(confirmation.confirmAndApply('adv-1', 'DDIC')).resolves.toEqual({ status: 'applied' });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(supportsFormElicitation).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith('adv-1', 'auto-config');
  });

  it('AdvancedOperation: auto mode still refuses a consumed plan and a wrong family', async () => {
    const consumed = createAdvancedSubject('APPLIED', () => true);
    await expect(consumed.confirmation.confirmAndApply('adv-1', 'DDIC')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(consumed.applyConfirmed).not.toHaveBeenCalled();

    const wrongFamily = createAdvancedSubject('PREVIEWED', () => true);
    await expect(wrongFamily.confirmation.confirmAndApply('adv-1', 'RAP')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(wrongFamily.applyConfirmed).not.toHaveBeenCalled();
  });

  it('AdvancedOperation: native mode keeps elicitation and passes confirmationMode=elicitation', async () => {
    const { confirmation, applyConfirmed, elicitInput, supportsFormElicitation } = createAdvancedSubject('PREVIEWED', undefined);
    elicitInput.mockResolvedValue({ action: 'accept', content: { decision: 'apply' } });

    await expect(confirmation.confirmAndApply('adv-1', 'DDIC')).resolves.toEqual({ status: 'applied' });
    expect(supportsFormElicitation).toHaveBeenCalledTimes(1);
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(applyConfirmed).toHaveBeenCalledWith('adv-1', 'elicitation');
  });

  it('QualityCheck: auto mode runs with auto-config even when the client has no elicitation', async () => {
    const runConfirmed = jest.fn().mockResolvedValue({ status: 'completed' });
    const elicitInput = jest.fn();
    const supportsFormElicitation = jest.fn(() => false);
    const confirmation = new QualityCheckConfirmation(
      { status: () => ({ status: 'PREVIEWED', expiresAt: future, kind: 'ABAP_UNIT', systemHost: 'dev.example.com', client: '100', objects: [], riskLevel: 'HARMLESS', duration: 'SHORT' }) as never },
      { supportsFormElicitation, elicitInput, autoApprove: () => true, runConfirmed }
    );

    await expect(confirmation.confirmAndRun('q-1')).resolves.toEqual({ status: 'completed' });
    expect(supportsFormElicitation).not.toHaveBeenCalled();
    expect(elicitInput).not.toHaveBeenCalled();
    expect(runConfirmed).toHaveBeenCalledWith('q-1', 'auto-config');
  });

  it('QualityCheck: auto mode still refuses a consumed plan', async () => {
    const runConfirmed = jest.fn();
    const confirmation = new QualityCheckConfirmation(
      { status: () => ({ status: 'EXPIRED', expiresAt: '2000-01-01T00:00:00.000Z' }) as never },
      { supportsFormElicitation: () => false, elicitInput: jest.fn(), autoApprove: () => true, runConfirmed }
    );

    await expect(confirmation.confirmAndRun('q-1')).rejects.toMatchObject({ code: 'PLAN_EXPIRED' });
    expect(runConfirmed).not.toHaveBeenCalled();
  });

  it('QualityCheck: native mode keeps elicitation and passes confirmationMode=elicitation', async () => {
    const runConfirmed = jest.fn().mockResolvedValue({ status: 'completed' });
    const elicitInput = jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'run' } });
    const supportsFormElicitation = jest.fn(() => true);
    const confirmation = new QualityCheckConfirmation(
      { status: () => ({ status: 'PREVIEWED', expiresAt: future, kind: 'ABAP_UNIT', systemHost: 'dev.example.com', client: '100', objects: [], riskLevel: 'HARMLESS', duration: 'SHORT' }) as never },
      { supportsFormElicitation, elicitInput, runConfirmed }
    );

    await expect(confirmation.confirmAndRun('q-1')).resolves.toEqual({ status: 'completed' });
    expect(supportsFormElicitation).toHaveBeenCalledTimes(1);
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(runConfirmed).toHaveBeenCalledWith('q-1', 'elicitation');
  });

  function createActivationSubject(status: string, autoApprove: (() => boolean) | undefined) {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'completed' });
    const elicitInput = jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'activate' } });
    const supportsFormElicitation = jest.fn(() => true);
    const confirmation = new ObjectActivationConfirmation(
      { status: () => ({ status, expiresAt: future, objects: [] }) as never },
      { supportsFormElicitation, elicitInput, autoApprove, applyConfirmed }
    );
    return { confirmation, applyConfirmed, elicitInput, supportsFormElicitation };
  }

  it('ObjectActivation: auto mode applies with auto-config even when the client has no elicitation', async () => {
    const { confirmation, applyConfirmed, elicitInput, supportsFormElicitation } = createActivationSubject('PREVIEWED', () => true);

    await expect(confirmation.confirmAndRun('act-1')).resolves.toEqual({ status: 'completed' });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(supportsFormElicitation).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith('act-1', 'auto-config');
  });

  it('ObjectActivation: auto mode still refuses a consumed plan', async () => {
    const { confirmation, applyConfirmed } = createActivationSubject('RUNNING', () => true);

    await expect(confirmation.confirmAndRun('act-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('TransportCleanup: auto mode runs with auto-config even when the client has no elicitation', async () => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'cleaned' });
    const elicitInput = jest.fn();
    const supportsFormElicitation = jest.fn(() => false);
    const confirmation = new TransportCleanupConfirmation(
      { status: () => ({ status: 'PREVIEWED', expiresAt: future }) as never },
      { supportsFormElicitation, elicitInput, autoApprove: () => true, applyConfirmed }
    );

    await expect(confirmation.confirmAndRun('tc-1')).resolves.toEqual({ status: 'cleaned' });
    expect(supportsFormElicitation).not.toHaveBeenCalled();
    expect(elicitInput).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith('tc-1', 'auto-config');
  });

  it('TransportCleanup: auto mode still refuses a consumed plan', async () => {
    const applyConfirmed = jest.fn();
    const confirmation = new TransportCleanupConfirmation(
      { status: () => ({ status: 'APPLIED', expiresAt: future }) as never },
      { supportsFormElicitation: () => false, elicitInput: jest.fn(), autoApprove: () => true, applyConfirmed }
    );

    await expect(confirmation.confirmAndRun('tc-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('Debug: auto mode authorizes without touching form elicitation', async () => {
    const authorizeConfirmed = jest.fn().mockResolvedValue({ status: 'authorized' });
    const elicitInput = jest.fn();
    const supportsFormElicitation = jest.fn(() => false);
    const workflow = { currentAttach: () => ({ processId: 7 }) };
    const confirmation = new DebugConfirmation(workflow as never, {
      supportsFormElicitation,
      elicitInput,
      autoApprove: () => true,
      authorizeConfirmed
    });

    await expect(confirmation.confirmAndAuthorize('DEVUSER', 'dbg-1')).resolves.toEqual({ status: 'authorized' });
    expect(supportsFormElicitation).not.toHaveBeenCalled();
    expect(elicitInput).not.toHaveBeenCalled();
    expect(authorizeConfirmed).toHaveBeenCalledWith('DEVUSER', 'dbg-1');
  });

  it('Debug: auto mode still refuses a consumed plan before any apply', async () => {
    const applyConfirmed = jest.fn();
    const workflow = {
      status: () => ({ status: 'APPLIED', operation: { kind: 'SET_VARIABLE' }, expiresAt: future }),
      currentAttach: () => ({ processId: 7 })
    };
    const confirmation = new DebugConfirmation(workflow as never, {
      supportsFormElicitation: () => false,
      elicitInput: jest.fn(),
      autoApprove: () => true,
      applyConfirmed
    });

    await expect(confirmation.confirmAndApply('dbg-1', 'VARIABLE')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('TransportCreation: auto mode runs with auto-config even when the client has no elicitation', async () => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'created', confirmationMode: 'auto-config' });
    const elicitInput = jest.fn();
    const supportsFormElicitation = jest.fn(() => false);
    const confirmation = new TransportCreationConfirmation(
      { status: () => transportPlan as never },
      { supportsFormElicitation, elicitInput, autoApprove: () => true, applyConfirmed }
    );

    await expect(confirmation.confirmAndRun('tc-1')).resolves.toEqual({ status: 'created', confirmationMode: 'auto-config' });
    expect(supportsFormElicitation).not.toHaveBeenCalled();
    expect(elicitInput).not.toHaveBeenCalled();
    expect(applyConfirmed).toHaveBeenCalledWith('tc-1', 'auto-config');
  });

  it('TransportCreation: auto mode still refuses a consumed plan', async () => {
    const applyConfirmed = jest.fn();
    const confirmation = new TransportCreationConfirmation(
      { status: () => ({ ...transportPlan, status: 'RUNNING' }) as never },
      { supportsFormElicitation: () => false, elicitInput: jest.fn(), autoApprove: () => true, applyConfirmed }
    );

    await expect(confirmation.confirmAndRun('tc-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });
});
