import { randomUUID } from 'crypto';
import { SafeAbapError } from './errors.js';
import type { RepositoryCreationConfirmationProvider } from './RepositoryCreationConfirmationProvider.js';
import type { RepositoryCleanupPlanView } from './repositoryCleanupTypes.js';

const MAX_REPOSITORY_CLEANUP_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

interface RepositoryCleanupChallenge {
  challengeId: string;
  cleanupPlanId: string;
  status: 'PENDING' | 'CONSUMED' | 'CANCELLED';
  binding: string;
  expiresAt: number;
}

export interface RepositoryCleanupConfirmationAuditEvent {
  plan: RepositoryCleanupPlanView;
  providerMode: RepositoryCreationConfirmationProvider['mode'];
  action: 'requested' | 'apply' | 'cancel';
  challengeStatus: 'PENDING' | 'CONSUMED' | 'CANCELLED';
}

export interface RepositoryCleanupStatusReader {
  status(cleanupPlanId: string): RepositoryCleanupPlanView;
}

export interface RepositoryCleanupConfirmationOptions {
  provider: RepositoryCreationConfirmationProvider;
  sessionId: string;
  applyConfirmed: (cleanupPlanId: string) => Promise<Record<string, unknown>>;
  audit?: (event: RepositoryCleanupConfirmationAuditEvent) => Promise<void>;
}

export class RepositoryObjectCleanupConfirmation {
  private readonly challenges = new Map<string, RepositoryCleanupChallenge>();

  constructor(
    private readonly statusReader: RepositoryCleanupStatusReader,
    private readonly options: RepositoryCleanupConfirmationOptions
  ) {}

  async confirmAndApply(cleanupPlanId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const plan = this.statusReader.status(cleanupPlanId);
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'cleanup-confirmation', 'Only a PREVIEWED cleanup plan can be confirmed.');
    }
    if (signal?.aborted) throw cancelledError();
    const existing = [...this.challenges.values()].find(challenge => (
      challenge.cleanupPlanId === cleanupPlanId && challenge.status === 'PENDING'
    ));
    if (existing) {
      throw new SafeAbapError('CONFIRMATION_REQUIRED', 'cleanup-confirmation', 'A separate cleanup confirmation is already pending.');
    }
    const timeoutMs = Math.max(1, Math.min(
      MAX_REPOSITORY_CLEANUP_CONFIRMATION_TIMEOUT_MS,
      Date.parse(plan.expiresAt) - Date.now()
    ));
    const challenge: RepositoryCleanupChallenge = {
      challengeId: randomUUID(),
      cleanupPlanId,
      status: 'PENDING',
      binding: this.binding(plan),
      expiresAt: Date.now() + timeoutMs
    };
    this.challenges.set(challenge.challengeId, challenge);
    try {
      await this.audit(plan, 'requested', 'PENDING');
      const decision = await this.options.provider.confirm({
        challengeId: challenge.challengeId,
        creationPlanId: plan.cleanupPlanId,
        operation: 'cleanup',
        summary: plan.summary,
        objectKind: plan.target.objectKind,
        objectName: plan.target.objectName,
        packageName: plan.target.packageName,
        transportRequest: plan.transportRequest,
        payloadFingerprint: plan.payloadHash.slice(0, 16),
        expiresAt: new Date(challenge.expiresAt).toISOString()
      }, { timeoutMs, signal });
      if (signal?.aborted || decision.action === 'cancel') {
        challenge.status = 'CANCELLED';
        await this.audit(plan, 'cancel', 'CANCELLED');
        if (signal?.aborted) throw cancelledError();
        return { status: 'confirmation_declined', cleanupPlanId, confirmationMode: this.options.provider.mode };
      }
      const current = this.statusReader.status(cleanupPlanId);
      if (decision.challengeId !== challenge.challengeId
        || challenge.status !== 'PENDING'
        || challenge.expiresAt <= Date.now()
        || this.binding(current) !== challenge.binding) {
        challenge.status = 'CANCELLED';
        await this.audit(plan, 'cancel', 'CANCELLED');
        throw cancelledError();
      }
      // Cleanup authorization is consumed separately from creation and cannot authorize another plan.
      challenge.status = 'CONSUMED';
      await this.audit(plan, 'apply', 'CONSUMED');
      return this.options.applyConfirmed(cleanupPlanId);
    } catch (error) {
      if (challenge.status === 'PENDING') {
        challenge.status = 'CANCELLED';
        await this.audit(plan, 'cancel', 'CANCELLED');
      }
      if (error instanceof SafeAbapError) throw error;
      throw cancelledError();
    }
  }

  private binding(plan: RepositoryCleanupPlanView): string {
    return JSON.stringify({
      operation: 'cleanup',
      cleanupPlanId: plan.cleanupPlanId,
      payloadHash: plan.payloadHash,
      sessionId: this.options.sessionId,
      providerMode: this.options.provider.mode,
      systemHost: plan.systemHost,
      client: plan.client,
      sapUser: plan.sapUser,
      systemRole: plan.systemRole,
      toolProfile: plan.toolProfile,
      target: plan.target,
      transportRequest: plan.transportRequest,
      status: plan.status
    });
  }

  private audit(
    plan: RepositoryCleanupPlanView,
    action: RepositoryCleanupConfirmationAuditEvent['action'],
    challengeStatus: RepositoryCleanupConfirmationAuditEvent['challengeStatus']
  ): Promise<void> {
    return this.options.audit?.({ plan, providerMode: this.options.provider.mode, action, challengeStatus }) || Promise.resolve();
  }
}

function cancelledError(): SafeAbapError {
  return new SafeAbapError('CONFIRMATION_CANCELLED', 'cleanup-confirmation', 'Repository cleanup confirmation was cancelled or timed out.');
}
