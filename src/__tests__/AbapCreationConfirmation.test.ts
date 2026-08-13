import { ErrorCode, McpError, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { AbapCreationConfirmation, type AbapCreationConfirmationOptions } from '../safe/AbapCreationConfirmation';
import { AbapObjectCreationWorkflow } from '../safe/AbapObjectCreationWorkflow';
import { SafeAbapError } from '../safe/errors';
import type { CreationPlanView } from '../safe/creationTypes';

describe('AbapCreationConfirmation', () => {
  const plan: CreationPlanView = {
    creationPlanId: 'creation-1',
    createdAt: '2026-08-13T12:00:00.000Z',
    expiresAt: '2099-08-13T12:15:00.000Z',
    status: 'PREVIEWED',
    systemHost: 'dev.example.com',
    client: '100',
    transportRequest: 'DEVK900001',
    objects: [{
      objectType: 'PROGRAM',
      objectName: 'ZTEST_CREATE',
      description: 'Creation test',
      packageName: 'ZTEST',
      objectUrl: '/sap/bc/adt/programs/programs/ztest_create',
      sourceHash: 'source-hash'
    }],
    stages: [],
    createdObjects: []
  };

  function createSubject(overrides: Partial<AbapCreationConfirmationOptions> = {}) {
    const workflow = {
      status: jest.fn().mockReturnValue(plan),
      apply: jest.fn().mockResolvedValue({ status: 'success' })
    };
    const options: AbapCreationConfirmationOptions = {
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
      confirmation: new AbapCreationConfirmation(workflow as unknown as AbapObjectCreationWorkflow, options)
    };
  }

  it('applies after the native creation form is accepted', async () => {
    const { confirmation, workflow, options } = createSubject();

    await expect(confirmation.confirmAndApply('creation-1')).resolves.toEqual({ status: 'success' });
    expect(options.elicitInput).toHaveBeenCalledWith({
      mode: 'form',
      message: '创建 PROGRAM ZTEST_CREATE · 传输 DEVK900001',
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            title: '请选择操作',
            oneOf: [
              { const: 'apply', title: '创建对象' },
              { const: 'cancel', title: '取消' }
            ]
          }
        },
        required: ['decision']
      }
    }, 15 * 60 * 1000);
    expect(workflow.apply).toHaveBeenCalledWith({
      creationPlanId: 'creation-1',
      confirmedByUser: true,
      confirmationMode: 'elicitation'
    });
  });

  it('does not apply when the native form is declined', async () => {
    const { confirmation, workflow } = createSubject({
      elicitInput: jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'cancel' } })
    });

    await expect(confirmation.confirmAndApply('creation-1')).resolves.toMatchObject({
      status: 'confirmation_declined',
      creationPlanId: 'creation-1',
      confirmationMode: 'elicitation'
    });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('treats a native confirmation timeout as cancellation', async () => {
    const { confirmation, workflow } = createSubject({
      elicitInput: jest.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))
    });

    await expect(confirmation.confirmAndApply('creation-1')).resolves.toMatchObject({
      status: 'confirmation_declined',
      reason: 'timeout'
    });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('returns and consumes an exact plan-bound text challenge', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false
    });

    await expect(confirmation.confirmAndApply('creation-1')).resolves.toMatchObject({
      status: 'confirmation_required',
      creationPlanId: 'creation-1',
      confirmationText: '确认创建 creation-1 验证码 123456'
    });
    await expect(confirmation.confirmAndApply('creation-1', '  确认创建 creation-1 验证码 123456  '))
      .resolves.toEqual({ status: 'success' });
    expect(workflow.apply).toHaveBeenCalledWith({
      creationPlanId: 'creation-1',
      confirmedByUser: true,
      confirmationMode: 'text-fallback'
    });
  });

  it('rejects an incorrect text challenge', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: true,
      supportsFormElicitation: () => false
    });
    await confirmation.confirmAndApply('creation-1');

    await expect(confirmation.confirmAndApply('creation-1', '确认创建 creation-1 验证码 654321'))
      .rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'confirmation' });
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('fails closed when no confirmation mechanism is available', async () => {
    const { confirmation, workflow } = createSubject({
      allowTextConfirmation: false,
      supportsFormElicitation: () => false
    });

    await expect(confirmation.confirmAndApply('creation-1')).rejects.toEqual(
      expect.objectContaining<Partial<SafeAbapError>>({
        code: 'CONFIRMATION_UNSUPPORTED',
        stage: 'confirmation'
      })
    );
    expect(workflow.apply).not.toHaveBeenCalled();
  });

  it('rejects a consumed creation plan before prompting', async () => {
    const { confirmation, workflow, options } = createSubject();
    workflow.status.mockReturnValue({ ...plan, status: 'APPLIED' });

    await expect(confirmation.confirmAndApply('creation-1')).rejects.toMatchObject({
      code: 'PLAN_ALREADY_CONSUMED',
      stage: 'plan'
    });
    expect(options.elicitInput).not.toHaveBeenCalled();
  });
});
