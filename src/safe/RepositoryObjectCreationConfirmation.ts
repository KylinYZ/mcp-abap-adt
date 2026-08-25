import { SafeAbapError } from './errors.js';
import { RepositoryCreationConfirmationChallengeStore } from './RepositoryCreationConfirmationChallengeStore.js';
import type { RepositoryCreationConfirmationProvider } from './RepositoryCreationConfirmationProvider.js';
import type { RepositoryCreationPlanView } from './repositoryCreationTypes.js';

const MAX_REPOSITORY_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

export interface RepositoryCreationConfirmationAuditEvent {
  plan: RepositoryCreationPlanView;
  providerMode: RepositoryCreationConfirmationProvider['mode'];
  action: 'requested' | 'apply' | 'cancel';
  challengeStatus: 'PENDING' | 'CONSUMED' | 'CANCELLED';
}

export interface RepositoryCreationStatusReader {
  status(creationPlanId: string): RepositoryCreationPlanView;
}

export interface RepositoryCreationConfirmationOptions {
  provider: RepositoryCreationConfirmationProvider;
  challengeStore: RepositoryCreationConfirmationChallengeStore;
  sessionId: string;
  applyConfirmed: (creationPlanId: string) => Promise<Record<string, unknown>>;
  audit?: (event: RepositoryCreationConfirmationAuditEvent) => Promise<void>;
}

export class RepositoryObjectCreationConfirmation {
  constructor(
    private readonly statusReader: RepositoryCreationStatusReader,
    private readonly options: RepositoryCreationConfirmationOptions
  ) {}

  async confirmAndApply(creationPlanId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const plan = this.statusReader.status(creationPlanId);
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'confirmation', 'Only a PREVIEWED repository creation plan can be confirmed.');
    }
    if (signal?.aborted) throw cancelledError();
    // A confirmation may use the full review window, but it must never outlive the immutable plan.
    const timeoutMs = Math.max(1, Math.min(
      MAX_REPOSITORY_CONFIRMATION_TIMEOUT_MS,
      Date.parse(plan.expiresAt) - Date.now()
    ));
    const expiresAt = Date.now() + timeoutMs;
    const challenge = this.options.challengeStore.create(
      plan,
      this.options.sessionId,
      this.options.provider.mode,
      expiresAt
    );
    try {
      await this.audit(plan, 'requested', 'PENDING');
    } catch (error) {
      this.options.challengeStore.cancel(challenge.challengeId);
      throw error;
    }
    let decision;
    try {
      decision = await this.options.provider.confirm({
        challengeId: challenge.challengeId,
        creationPlanId: plan.creationPlanId,
        summary: plan.summary,
        objectKind: plan.target.objectKind,
        objectName: plan.target.objectName,
        packageName: plan.target.packageName || plan.target.parentName,
        transportRequest: plan.transportRequest,
        payloadFingerprint: plan.payloadHash.slice(0, 16),
        expiresAt: new Date(expiresAt).toISOString()
      }, { timeoutMs, signal });
    } catch (error) {
      this.options.challengeStore.cancel(challenge.challengeId);
      await this.audit(plan, 'cancel', 'CANCELLED');
      if (error instanceof SafeAbapError && error.code === 'CONFIRMATION_UNSUPPORTED') throw error;
      throw cancelledError();
    }
    if (signal?.aborted) {
      this.options.challengeStore.cancel(challenge.challengeId);
      await this.audit(plan, 'cancel', 'CANCELLED');
      throw cancelledError();
    }
    if (decision.action === 'cancel') {
      this.options.challengeStore.cancel(challenge.challengeId);
      await this.audit(plan, 'cancel', 'CANCELLED');
      return { status: 'confirmation_declined', creationPlanId, confirmationMode: this.options.provider.mode };
    }
    try {
      const currentPlan = this.statusReader.status(creationPlanId);
      this.options.challengeStore.consume(
        decision.challengeId,
        currentPlan,
        this.options.sessionId,
        this.options.provider.mode
      );
    } catch (error) {
      this.options.challengeStore.cancel(challenge.challengeId);
      await this.audit(plan, 'cancel', 'CANCELLED');
      throw error;
    }
    await this.audit(plan, 'apply', 'CONSUMED');
    return this.options.applyConfirmed(creationPlanId);
  }

  private audit(
    plan: RepositoryCreationPlanView,
    action: RepositoryCreationConfirmationAuditEvent['action'],
    challengeStatus: RepositoryCreationConfirmationAuditEvent['challengeStatus']
  ): Promise<void> {
    return this.options.audit?.({
      plan,
      providerMode: this.options.provider.mode,
      action,
      challengeStatus
    }) || Promise.resolve();
  }
}

function cancelledError(): SafeAbapError {
  return new SafeAbapError('CONFIRMATION_CANCELLED', 'confirmation', 'Repository creation confirmation was cancelled or timed out.');
}
