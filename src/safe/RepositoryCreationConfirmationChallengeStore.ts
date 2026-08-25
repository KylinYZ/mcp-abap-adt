import { randomUUID } from 'crypto';
import { SafeAbapError } from './errors.js';
import type { RepositoryCreationPlanView } from './repositoryCreationTypes.js';

export type RepositoryCreationConfirmationProviderMode = 'mcp-form' | 'mcp-app' | 'windows-native';
export type RepositoryCreationConfirmationChallengeStatus = 'PENDING' | 'CONSUMED' | 'CANCELLED' | 'EXPIRED';

export interface RepositoryCreationConfirmationChallenge {
  challengeId: string;
  creationPlanId: string;
  status: RepositoryCreationConfirmationChallengeStatus;
  createdAt: number;
  expiresAt: number;
}

interface StoredChallenge extends RepositoryCreationConfirmationChallenge {
  payloadHash: string;
  sessionId: string;
  systemHost: string;
  client: string;
  sapUser: string;
  systemRole: string;
  toolProfile: string;
  objectKind: string;
  objectName: string;
  parentName: string;
  packageName: string;
  transportRequest: string;
  providerMode: RepositoryCreationConfirmationProviderMode;
}

export class RepositoryCreationConfirmationChallengeStore {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly planChallenges = new Map<string, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(
    plan: RepositoryCreationPlanView,
    sessionId: string,
    providerMode: RepositoryCreationConfirmationProviderMode,
    expiresAt: number
  ): RepositoryCreationConfirmationChallenge {
    this.releaseInactivePlanChallenge(plan.creationPlanId);
    const existingId = this.planChallenges.get(plan.creationPlanId);
    if (existingId) {
      const existing = this.challenges.get(existingId);
      if (existing?.status === 'PENDING') {
        throw new SafeAbapError('CONFIRMATION_REQUIRED', 'confirmation', 'A confirmation is already pending for this creation plan.');
      }
      if (existing?.status === 'CONSUMED') {
        throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'confirmation', 'This creation plan confirmation was already consumed. Create a fresh preview.');
      }
    }

    const createdAt = this.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      throw new SafeAbapError('PLAN_EXPIRED', 'confirmation', 'The repository creation plan expired before confirmation could start.');
    }
    const challenge: StoredChallenge = {
      challengeId: randomUUID(),
      creationPlanId: plan.creationPlanId,
      status: 'PENDING',
      createdAt,
      expiresAt,
      payloadHash: plan.payloadHash,
      sessionId,
      systemHost: plan.systemHost,
      client: plan.client,
      sapUser: plan.sapUser,
      systemRole: plan.systemRole,
      toolProfile: plan.toolProfile,
      objectKind: plan.target.objectKind,
      objectName: plan.target.objectName,
      parentName: plan.target.parentName || '',
      packageName: plan.target.packageName || plan.target.parentName || '',
      transportRequest: plan.transportRequest || '',
      providerMode
    };
    this.challenges.set(challenge.challengeId, challenge);
    this.planChallenges.set(plan.creationPlanId, challenge.challengeId);
    return publicChallenge(challenge);
  }

  consume(
    challengeId: string,
    plan: RepositoryCreationPlanView,
    sessionId: string,
    providerMode: RepositoryCreationConfirmationProviderMode
  ): RepositoryCreationConfirmationChallenge {
    const challenge = this.requirePending(challengeId);
    if (!matchesBinding(challenge, plan, sessionId, providerMode)) {
      throw new SafeAbapError('CONFIRMATION_CANCELLED', 'confirmation', 'The confirmation no longer matches the current creation plan and SAP session.');
    }
    // This synchronous transition is the single authorization consumption point.
    challenge.status = 'CONSUMED';
    return publicChallenge(challenge);
  }

  cancel(challengeId: string): RepositoryCreationConfirmationChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.status !== 'PENDING') return challenge ? publicChallenge(challenge) : undefined;
    challenge.status = 'CANCELLED';
    this.planChallenges.delete(challenge.creationPlanId);
    return publicChallenge(challenge);
  }

  status(challengeId: string): RepositoryCreationConfirmationChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return undefined;
    this.expire(challenge);
    return publicChallenge(challenge);
  }

  clear(): void {
    for (const challenge of this.challenges.values()) {
      if (challenge.status === 'PENDING') challenge.status = 'CANCELLED';
    }
    this.planChallenges.clear();
    this.challenges.clear();
  }

  private requirePending(challengeId: string): StoredChallenge {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      throw new SafeAbapError('CONFIRMATION_CANCELLED', 'confirmation', 'The confirmation challenge was not found.');
    }
    this.expire(challenge);
    if (challenge.status !== 'PENDING') {
      throw new SafeAbapError('CONFIRMATION_CANCELLED', 'confirmation', `The confirmation challenge is ${challenge.status.toLowerCase()}.`);
    }
    return challenge;
  }

  private releaseInactivePlanChallenge(creationPlanId: string): void {
    const challengeId = this.planChallenges.get(creationPlanId);
    if (!challengeId) return;
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      this.planChallenges.delete(creationPlanId);
      return;
    }
    this.expire(challenge);
    if (challenge.status === 'CANCELLED' || challenge.status === 'EXPIRED') {
      this.planChallenges.delete(creationPlanId);
    }
  }

  private expire(challenge: StoredChallenge): void {
    if (challenge.status === 'PENDING' && challenge.expiresAt <= this.now()) {
      challenge.status = 'EXPIRED';
      this.planChallenges.delete(challenge.creationPlanId);
    }
  }
}

function matchesBinding(
  challenge: StoredChallenge,
  plan: RepositoryCreationPlanView,
  sessionId: string,
  providerMode: RepositoryCreationConfirmationProviderMode
): boolean {
  return plan.status === 'PREVIEWED'
    && challenge.creationPlanId === plan.creationPlanId
    && challenge.payloadHash === plan.payloadHash
    && challenge.sessionId === sessionId
    && challenge.systemHost === plan.systemHost
    && challenge.client === plan.client
    && challenge.sapUser === plan.sapUser
    && challenge.systemRole === plan.systemRole
    && challenge.toolProfile === plan.toolProfile
    && challenge.objectKind === plan.target.objectKind
    && challenge.objectName === plan.target.objectName
    && challenge.parentName === (plan.target.parentName || '')
    && challenge.packageName === (plan.target.packageName || plan.target.parentName || '')
    && challenge.transportRequest === (plan.transportRequest || '')
    && challenge.providerMode === providerMode;
}

function publicChallenge(challenge: StoredChallenge): RepositoryCreationConfirmationChallenge {
  return {
    challengeId: challenge.challengeId,
    creationPlanId: challenge.creationPlanId,
    status: challenge.status,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt
  };
}
