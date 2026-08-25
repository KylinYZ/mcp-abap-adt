import { RepositoryObjectCleanupConfirmation } from '../safe/RepositoryObjectCleanupConfirmation';
import type { RepositoryCreationConfirmationProvider } from '../safe/RepositoryCreationConfirmationProvider';

const plan = {
  cleanupPlanId: 'cleanup-1', createdAt: '2026-08-25T00:00:00.000Z', expiresAt: '2099-08-25T00:15:00.000Z',
  status: 'PREVIEWED' as const, systemHost: 'dev.example.test', client: '300', sapUser: 'TEST_USER', systemRole: 'DEV',
  toolProfile: 'development' as const,
  target: {
    objectKind: 'PROGRAM' as const, objectName: 'ZVPROG2', adtType: 'PROG/P', objectUrl: '/programs/zvprog2',
    packageName: 'Z001', version: 'active', transportProgramId: 'R3TR', transportObjectType: 'PROG', transportObjectName: 'ZVPROG2'
  },
  transportRequest: 'S4HK900009', dependencySummary: ['PROGRAM ZVPROG2'], summary: 'Delete validation program.',
  payloadHash: 'abcdef0123456789', payloadBytes: 20, cleanupOrder: [{ objectKind: 'PROGRAM' as const, objectName: 'ZVPROG2', adtType: 'PROG/P' }], stages: []
};

describe('RepositoryObjectCleanupConfirmation', () => {
  it('requires an independent cleanup confirmation and applies once', async () => {
    const provider = providerFor('apply');
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const confirmation = new RepositoryObjectCleanupConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      { provider, sessionId: 'cleanup-session', applyConfirmed }
    );

    await expect(confirmation.confirmAndApply('cleanup-1')).resolves.toEqual({ status: 'success' });
    expect(provider.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'cleanup', creationPlanId: 'cleanup-1' }),
      expect.any(Object)
    );
    expect(applyConfirmed).toHaveBeenCalledTimes(1);
  });

  it('does not apply after cancel, malformed provider failure, or abort', async () => {
    const applyConfirmed = jest.fn();
    const cancelled = new RepositoryObjectCleanupConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      { provider: providerFor('cancel'), sessionId: 'cleanup-session', applyConfirmed }
    );
    await expect(cancelled.confirmAndApply('cleanup-1')).resolves.toMatchObject({ status: 'confirmation_declined' });

    const malformed = new RepositoryObjectCleanupConfirmation(
      { status: jest.fn().mockReturnValue(plan) },
      {
        provider: { mode: 'windows-native', confirm: jest.fn().mockRejectedValue(new Error('malformed')) },
        sessionId: 'cleanup-session', applyConfirmed
      }
    );
    await expect(malformed.confirmAndApply('cleanup-1')).rejects.toMatchObject({ code: 'CONFIRMATION_CANCELLED' });
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.confirmAndApply('cleanup-1', controller.signal)).rejects.toMatchObject({ code: 'CONFIRMATION_CANCELLED' });
    expect(applyConfirmed).not.toHaveBeenCalled();
  });
});

function providerFor(action: 'apply' | 'cancel'): RepositoryCreationConfirmationProvider & { confirm: jest.Mock } {
  return {
    mode: 'windows-native',
    confirm: jest.fn(async request => ({ action, challengeId: request.challengeId }))
  };
}
