import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types';
import { AdvancedOperationConfirmation } from '../safe/AdvancedOperationConfirmation';
import type { AdvancedOperationKind, AdvancedOperationPlanView } from '../safe/advancedTypes';

describe('AdvancedOperationConfirmation', () => {
  const now = Date.parse('2026-08-14T00:00:00.000Z');

  function plan(operationKind: AdvancedOperationKind = 'SET_DOMAIN_PROPERTIES'): AdvancedOperationPlanView {
    return {
      operationPlanId: 'plan-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      expiresAt: '2026-08-14T00:10:00.000Z',
      status: 'PREVIEWED',
      systemHost: 'dev.example.com',
      client: '100',
      systemRole: 'DEV',
      toolProfile: 'development',
      operationKind,
      target: { objectType: 'DOMAIN', objectName: 'ZDOMAIN' },
      transport: 'DEVK900001',
      inputSummary: { title: 'Change ZDOMAIN', warning: 'Writes SAP' },
      currentStateSummary: { stateHash: 'hash', description: 'Current state' },
      payloadFingerprint: { inputHash: 'input', inputBytes: 100, driftHash: 'drift', driftBytes: 10 },
      rollbackSupported: true,
      stages: []
    };
  }

  it('applies only after one native acceptance', async () => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const elicitInput = jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'apply' } });
    const confirmation = new AdvancedOperationConfirmation({ status: () => plan() }, {
      supportsFormElicitation: () => true,
      elicitInput,
      applyConfirmed,
      now: () => now
    });

    await expect(confirmation.confirmAndApply('plan-1', 'DDIC')).resolves.toEqual({ status: 'success' });
    expect(applyConfirmed).toHaveBeenCalledWith('plan-1');
    expect(elicitInput).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'form',
      message: expect.stringContaining('DEVK900001')
    }), 10 * 60 * 1000);
  });

  it.each([
    { action: 'cancel' },
    { action: 'decline' },
    { action: 'accept', content: { decision: 'cancel' } }
  ])('does not consume or apply after cancellation or refusal: %p', async result => {
    const applyConfirmed = jest.fn();
    const confirmation = new AdvancedOperationConfirmation({ status: () => plan() }, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue(result),
      applyConfirmed,
      now: () => now
    });
    await expect(confirmation.confirmAndApply('plan-1', 'DDIC')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('treats native timeout as a decline and never writes', async () => {
    const applyConfirmed = jest.fn();
    const confirmation = new AdvancedOperationConfirmation({ status: () => plan() }, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, 'timeout')),
      applyConfirmed,
      now: () => now
    });
    await expect(confirmation.confirmAndApply('plan-1', 'DDIC')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('fails closed without native form support and has no text fallback', async () => {
    const confirmation = new AdvancedOperationConfirmation({ status: () => plan() }, {
      supportsFormElicitation: () => false,
      elicitInput: jest.fn(),
      applyConfirmed: jest.fn(),
      now: () => now
    });
    await expect(confirmation.confirmAndApply('plan-1', 'DDIC')).rejects.toThrow('text confirmation fallback is not supported');
  });

  it('rejects wrong apply families and consumed or expired plans before prompting', async () => {
    const elicitInput = jest.fn();
    const options = { supportsFormElicitation: () => true, elicitInput, applyConfirmed: jest.fn(), now: () => now };
    await expect(new AdvancedOperationConfirmation({ status: () => plan('CHANGE_PACKAGE') }, options)
      .confirmAndApply('plan-1', 'DDIC')).rejects.toThrow('applyPackageChange');
    await expect(new AdvancedOperationConfirmation({ status: () => ({ ...plan(), status: 'APPLIED' }) }, options)
      .confirmAndApply('plan-1', 'DDIC')).rejects.toThrow('already applied');
    await expect(new AdvancedOperationConfirmation({ status: () => ({ ...plan(), expiresAt: '2026-08-13T23:59:59.000Z' }) }, options)
      .confirmAndApply('plan-1', 'DDIC')).rejects.toThrow('expired');
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it('does not expose client exception details from a failed confirmation dialog', async () => {
    const confirmation = new AdvancedOperationConfirmation({ status: () => plan() }, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockRejectedValue(new Error('Authorization: SECRET')),
      applyConfirmed: jest.fn(),
      now: () => now
    });
    await expect(confirmation.confirmAndApply('plan-1', 'DDIC')).rejects.not.toThrow('SECRET');
  });
});
