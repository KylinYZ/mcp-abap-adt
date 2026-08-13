import { ErrorCode, McpError, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { AbapChangeConfirmation, type AbapChangeConfirmationOptions } from '../safe/AbapChangeConfirmation';
import { AbapChangeWorkflow } from '../safe/AbapChangeWorkflow';
import { SafeAbapError } from '../safe/errors';
import type { ChangePlanView } from '../safe/types';

describe('AbapChangeConfirmation', () => {
  const plan: ChangePlanView = {
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
    diffSummary: {
      addedLines: 1,
      removedLines: 0,
      unchangedPrefixLines: 1,
      unchangedSuffixLines: 0
    },
    syntaxMessages: [],
    stages: []
  };

  function createSubject(overrides: Partial<AbapChangeConfirmationOptions> = {}) {
    const workflow = {
      status: jest.fn().mockReturnValue(plan),
      apply: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const options: AbapChangeConfirmationOptions = {
      allowTextConfirmation: false,
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue({
        action: 'accept',
        content: { decision: 'apply' }
      } satisfies ElicitResult),
      createTextCode: () => '123456',
      ...overrides
    };

    return {
      workflow,
      options,
      confirmation: new AbapChangeConfirmation(workflow as unknown as AbapChangeWorkflow, options)
    };
  }

  it('applies after the native form is accepted and checked', async () => {
    const { confirmation, workflow, options } = createSubject();

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toEqual({ status: 'success' });
    expect(options.elicitInput).toHaveBeenCalledWith({
      mode: 'form',
      message: '应用 ZTEST · 传输 DEVK900001 · +1/-0',
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            title: '请选择操作',
            oneOf: [
              { const: 'apply', title: '应用变更' },
              { const: 'cancel', title: '取消' }
            ]
          }
        },
        required: ['decision']
      }
    }, 15 * 60 * 1000);
    expect(workflow.apply).toHaveBeenCalledWith({
      changePlanId: 'plan-1',
      confirmedByUser: true,
      confirmationMode: 'elicitation'
    });
  });

  it.each([
    ['decline action', { action: 'decline' }],
    ['cancel action', { action: 'cancel' }],
    ['cancel option', { action: 'accept', content: { decision: 'cancel' } }],
    ['missing decision', { action: 'accept' }]
  ] as const)('does not apply for the native form %s', async (_caseName, result) => {
    const { confirmation, workflow } = createSubject({
      elicitInput: jest.fn().mockResolvedValue(result as ElicitResult)
    });

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toMatchObject({
      status: 'confirmation_declined',
      confirmationMode: 'elicitation'
    });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('uses native form elicitation and ignores a supplied text phrase', async () => {
    const { confirmation, workflow, options } = createSubject({ allowTextConfirmation: true });

    await confirmation.confirmAndApply('plan-1', 'incorrect text phrase');

    expect(options.elicitInput).toHaveBeenCalledTimes(1);
    expect(workflow.apply).toHaveBeenCalledWith(expect.objectContaining({ confirmationMode: 'elicitation' }));
  });

  it('fails closed when the native confirmation dialog cannot be created', async () => {
    const { confirmation, workflow } = createSubject({
      elicitInput: jest.fn().mockRejectedValue(new Error('client unavailable'))
    });

    await expect(confirmation.confirmAndApply('plan-1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      stage: 'confirmation'
    });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('treats a native confirmation timeout as a retryable cancellation', async () => {
    const { confirmation, workflow } = createSubject({
      elicitInput: jest.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))
    });

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toMatchObject({
      status: 'confirmation_declined',
      confirmationMode: 'elicitation',
      reason: 'timeout'
    });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('does not wait beyond the remaining change-plan lifetime', async () => {
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const { confirmation, workflow, options } = createSubject();
    workflow.status.mockReturnValue({
      ...plan,
      expiresAt: new Date(now + 30_000).toISOString()
    });

    try {
      await confirmation.confirmAndApply('plan-1');
      expect(options.elicitInput).toHaveBeenCalledWith(expect.any(Object), 30_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns a plan-bound text challenge before applying', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false
    });

    await expect(confirmation.confirmAndApply('plan-1')).resolves.toMatchObject({
      status: 'confirmation_required',
      confirmationRequired: true,
      changePlanId: 'plan-1',
      confirmationMode: 'text-fallback',
      confirmationText: '确认应用 plan-1 验证码 123456'
    });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('applies once the exact text challenge is returned', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false
    });
    await confirmation.confirmAndApply('plan-1');

    await expect(confirmation.confirmAndApply('plan-1', '  确认应用 plan-1 验证码 123456  '))
      .resolves.toEqual({ status: 'success' });
    expect(workflow.apply).toHaveBeenCalledWith({
      changePlanId: 'plan-1',
      confirmedByUser: true,
      confirmationMode: 'text-fallback'
    });
  });

  it('rejects an incorrect text challenge without applying', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false
    });
    await confirmation.confirmAndApply('plan-1');

    await expect(confirmation.confirmAndApply('plan-1', '确认应用 plan-1 验证码 654321'))
      .rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'confirmation' });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('lazily removes expired challenges before issuing a replacement', async () => {
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false
    });
    workflow.status
      .mockReturnValueOnce({ ...plan, expiresAt: new Date(now + 1).toISOString() })
      .mockReturnValueOnce({ ...plan, expiresAt: new Date(now + 60_000).toISOString() });

    try {
      await confirmation.confirmAndApply('plan-1');
      nowSpy.mockReturnValue(now + 2);
      await expect(confirmation.confirmAndApply('plan-1', '确认应用 plan-1 验证码 123456'))
        .resolves.toMatchObject({ status: 'confirmation_required' });
      expect(workflow.apply).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('replaces the previous challenge for the same plan', async () => {
    const createTextCode = jest.fn().mockReturnValueOnce('123456').mockReturnValueOnce('654321');
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false,
      createTextCode
    });

    await confirmation.confirmAndApply('plan-1');
    await confirmation.confirmAndApply('plan-1');
    await expect(confirmation.confirmAndApply('plan-1', '确认应用 plan-1 验证码 123456'))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(confirmation.confirmAndApply('plan-1', '确认应用 plan-1 验证码 654321'))
      .resolves.toEqual({ status: 'success' });
    expect(workflow.apply).toHaveBeenCalledTimes(1);
  });

  it('fails closed when form elicitation and text fallback are unavailable', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: false,
      supportsFormElicitation: () => false
    });

    await expect(confirmation.confirmAndApply('plan-1')).rejects.toEqual(expect.objectContaining<Partial<SafeAbapError>>({
      code: 'CONFIRMATION_UNSUPPORTED',
      stage: 'confirmation'
    }));
    expect(workflow.apply).not.toHaveBeenCalled();
  });
});
