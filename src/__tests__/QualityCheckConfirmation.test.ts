import { QualityCheckConfirmation } from '../safe/QualityCheckConfirmation';

const plan = {
  qualityPlanId: 'quality-1', createdAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(),
  status: 'PREVIEWED' as const, systemHost: 'dev.example.test', client: '100', sapUser: 'DEVUSER',
  systemRole: 'DEV', toolProfile: 'development-workbench' as const, kind: 'ABAP_UNIT' as const,
  objects: [{ objectType: 'CLASS', objectName: 'ZCL_TEST', adtType: 'CLAS/OC' }],
  riskLevel: 'HARMLESS' as const, duration: 'SHORT' as const, timeoutSeconds: 60,
  stateHash: 'hash', stages: []
};

describe('QualityCheckConfirmation', () => {
  it('requires native form elicitation', async () => {
    const confirmation = new QualityCheckConfirmation({ status: () => plan }, {
      supportsFormElicitation: () => false,
      elicitInput: jest.fn(),
      runConfirmed: jest.fn()
    });
    await expect(confirmation.confirmAndRun('quality-1')).rejects.toMatchObject({ code: 'CONFIRMATION_UNSUPPORTED' });
  });

  it('runs only after one accepted native confirmation', async () => {
    const runConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const elicitInput = jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'run' } });
    const confirmation = new QualityCheckConfirmation({ status: () => plan }, {
      supportsFormElicitation: () => true, elicitInput, runConfirmed, now: () => 1_000
    });

    await expect(confirmation.confirmAndRun('quality-1')).resolves.toEqual({ status: 'success' });
    expect(runConfirmed).toHaveBeenCalledTimes(1);
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(elicitInput.mock.calls[0][0].message).toContain('Test code may have side effects');
  });

  it('does not run when confirmation is declined', async () => {
    const runConfirmed = jest.fn();
    const confirmation = new QualityCheckConfirmation({ status: () => plan }, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue({ action: 'decline' }),
      runConfirmed,
      now: () => 1_000
    });
    await expect(confirmation.confirmAndRun('quality-1')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(runConfirmed).not.toHaveBeenCalled();
  });
});
