import { RepositoryObjectCreationConfirmation } from '../safe/RepositoryObjectCreationConfirmation';
import { RepositoryCreationConfirmationChallengeStore } from '../safe/RepositoryCreationConfirmationChallengeStore';
import type { RepositoryCreationConfirmationProvider } from '../safe/RepositoryCreationConfirmationProvider';

const plan = {
  creationPlanId: 'plan-1', createdAt: '2026-08-19T00:00:00.000Z', expiresAt: '2099-08-19T00:15:00.000Z',
  status: 'PREVIEWED' as const, systemHost: 'dev.example.test', client: '100', sapUser: 'TEST_USER', systemRole: 'DEV',
  toolProfile: 'development' as const, target: { objectKind: 'PROGRAM' as const, objectName: 'ZTEST', adtType: 'PROG/P' },
  summary: 'Create program', payloadHash: 'hash', payloadBytes: 10, stages: [], compensationLimits: []
};

describe('RepositoryObjectCreationConfirmation', () => {
  it('applies only after one accepted native form', async () => {
    const now = Date.parse('2026-08-25T00:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const provider = confirmationProvider('apply');
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed
      }
    );
    await expect(confirmation.confirmAndApply('plan-1')).resolves.toEqual({ status: 'success' });
    expect(applyConfirmed).toHaveBeenCalledTimes(1);
    expect(provider.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadFingerprint: 'hash',
        expiresAt: '2026-08-25T00:15:00.000Z'
      }),
      expect.objectContaining({ timeoutMs: 15 * 60 * 1000 })
    );
    nowSpy.mockRestore();
  });

  it('uses the remaining plan lifetime when it is shorter than the maximum', async () => {
    const now = Date.parse('2026-08-25T00:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const provider = confirmationProvider('cancel');
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue({ ...plan, expiresAt: new Date(now + 90_000).toISOString() }) },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed: jest.fn()
      }
    );

    await confirmation.confirmAndApply('plan-1');

    expect(provider.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: '2026-08-25T00:01:30.000Z' }),
      expect.objectContaining({ timeoutMs: 90_000 })
    );
    nowSpy.mockRestore();
  });

  it('fails closed without a reliable provider and declines without applying', async () => {
    const applyConfirmed = jest.fn();
    const unsupportedProvider: RepositoryCreationConfirmationProvider = {
      mode: 'mcp-app',
      confirm: jest.fn().mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'CONFIRMATION_UNSUPPORTED' }))
    };
    const unsupported = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider: unsupportedProvider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed
      }
    );
    await expect(unsupported.confirmAndApply('plan-1')).rejects.toMatchObject({ code: 'CONFIRMATION_CANCELLED' });

    const provider = confirmationProvider('cancel');
    const declined = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed
      }
    );
    await expect(declined.confirmAndApply('plan-1')).resolves.toMatchObject({ status: 'confirmation_declined' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('cancels a pending challenge when the outer request aborts', async () => {
    const controller = new AbortController();
    const provider: RepositoryCreationConfirmationProvider = {
      mode: 'windows-native',
      confirm: jest.fn().mockImplementation(async () => {
        controller.abort();
        return { action: 'apply', challengeId: 'ignored' };
      })
    };
    const applyConfirmed = jest.fn();
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed
      }
    );

    await expect(confirmation.confirmAndApply('plan-1', controller.signal)).rejects.toMatchObject({ code: 'CONFIRMATION_CANCELLED' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });

  it('allows only one concurrent confirmation for a plan', async () => {
    let resolveDecision!: (decision: { action: 'apply'; challengeId: string }) => void;
    const provider: RepositoryCreationConfirmationProvider = {
      mode: 'windows-native',
      confirm: jest.fn().mockImplementation(request => new Promise(resolve => {
        resolveDecision = resolve;
        (provider as any).challengeId = request.challengeId;
      }))
    };
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider,
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed
      }
    );

    const first = confirmation.confirmAndApply('plan-1');
    await expect(confirmation.confirmAndApply('plan-1')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    resolveDecision({ action: 'apply', challengeId: (provider as any).challengeId });
    await expect(first).resolves.toEqual({ status: 'success' });
    expect(applyConfirmed).toHaveBeenCalledTimes(1);
  });

  it('does not replay a consumed confirmation when apply returns an error', async () => {
    const applyConfirmed = jest.fn().mockRejectedValue(new Error('outer request disconnected'));
    const confirmation = new RepositoryObjectCreationConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider: confirmationProvider('apply'),
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'session-1',
        applyConfirmed
      }
    );

    await expect(confirmation.confirmAndApply('plan-1')).rejects.toThrow('outer request disconnected');
    await expect(confirmation.confirmAndApply('plan-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(applyConfirmed).toHaveBeenCalledTimes(1);
  });
});

function confirmationProvider(action: 'apply' | 'cancel'): RepositoryCreationConfirmationProvider & { confirm: jest.Mock } {
  return {
    mode: 'windows-native',
    confirm: jest.fn().mockImplementation(async request => ({ action, challengeId: request.challengeId }))
  };
}
