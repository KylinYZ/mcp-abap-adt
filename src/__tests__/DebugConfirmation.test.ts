import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types';
import { DebugConfirmation } from '../safe/DebugConfirmation';

describe('DebugConfirmation', () => {
  const plan = {
    debugOperationPlanId: 'plan-1',
    createdAt: '2026-08-14T00:00:00.000Z',
    expiresAt: '2099-08-14T00:15:00.000Z',
    status: 'PREVIEWED',
    systemHost: 'dev.example.com',
    client: '100',
    targetUser: 'DEVUSER',
    operation: { kind: 'ATTACH', debuggeeId: 'debuggee-1' },
    operationHash: 'hash',
    summary: 'Attach debuggee-1',
    risk: 'Controls a live debuggee'
  };

  it('applies only after native acceptance', async () => {
    const workflow = { status: jest.fn().mockReturnValue(plan) };
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const confirmation = new DebugConfirmation(workflow as never, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'apply' } }),
      applyConfirmed
    });
    await expect(confirmation.confirmAndApply('plan-1', 'OPERATION')).resolves.toEqual({ status: 'success' });
    expect(applyConfirmed).toHaveBeenCalledWith({ debugOperationPlanId: 'plan-1', confirmedByUser: true });
  });

  it.each([
    { action: 'cancel' },
    { action: 'accept', content: { decision: 'cancel' } }
  ])('does not consume a plan when confirmation is declined', async result => {
    const workflow = { status: jest.fn().mockReturnValue(plan) };
    const applyConfirmed = jest.fn();
    const confirmation = new DebugConfirmation(workflow as never, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue(result),
      applyConfirmed
    });
    await expect(confirmation.confirmAndApply('plan-1', 'OPERATION')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('treats native confirmation timeout as a decline', async () => {
    const workflow = { status: jest.fn().mockReturnValue(plan) };
    const applyConfirmed = jest.fn();
    const confirmation = new DebugConfirmation(workflow as never, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, 'timeout')),
      applyConfirmed
    });
    await expect(confirmation.confirmAndApply('plan-1', 'OPERATION')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('fails closed without form elicitation and offers no text fallback', async () => {
    const confirmation = new DebugConfirmation({ status: jest.fn().mockReturnValue(plan) } as never, {
      supportsFormElicitation: () => false,
      elicitInput: jest.fn()
    });
    await expect(confirmation.confirmAndApply('plan-1', 'OPERATION')).rejects.toThrow('text confirmation fallback is not supported');
  });

  it('keeps variable plans on the dedicated apply tool', async () => {
    const confirmation = new DebugConfirmation({
      status: jest.fn().mockReturnValue({ ...plan, operation: { kind: 'SET_VARIABLE' } })
    } as never, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn()
    });
    await expect(confirmation.confirmAndApply('plan-1', 'OPERATION')).rejects.toThrow('applyDebugVariableChange');
  });
});
