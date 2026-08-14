import { randomBytes } from 'crypto';
import { SafeAbapError } from './errors.js';
import type {
  DebugAttachContext,
  DebugSessionAuthorization,
  DebugSessionAuthorizationView
} from './debugTypes.js';

export interface DebugAuthorizationContext {
  systemHost: string;
  client: string;
  targetUser: string;
  attachContext: DebugAttachContext;
}

export class DebugSessionAuthorizationStore {
  private readonly authorizations = new Map<string, DebugSessionAuthorization>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => randomBytes(16).toString('hex'),
    private readonly maxEntries: number = 100
  ) {}

  create(context: DebugAuthorizationContext): DebugSessionAuthorization {
    this.cleanupExpired();
    this.revokeForTarget(context.systemHost, context.client, context.targetUser, 'REAUTHORIZED');
    this.evictInactive();
    if (this.authorizations.size >= this.maxEntries) {
      throw new SafeAbapError('PLAN_CAPACITY_FULL', 'debug-authorization', 'Debug session authorization capacity is full.');
    }

    const createdAt = this.now();
    const authorization: DebugSessionAuthorization = {
      authorizationId: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'ACTIVE',
      systemHost: context.systemHost,
      client: context.client,
      targetUser: normalizeUser(context.targetUser),
      attachContext: { ...context.attachContext }
    };
    this.authorizations.set(authorization.authorizationId, authorization);
    return authorization;
  }

  getActive(authorizationId: string, context: DebugAuthorizationContext): DebugSessionAuthorization {
    this.cleanupExpired();
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) {
      throw new SafeAbapError('AUTHORIZATION_NOT_FOUND', 'debug-authorization', 'Debug session authorization was not found.');
    }
    if (authorization.status !== 'ACTIVE') {
      throw new SafeAbapError('AUTHORIZATION_EXPIRED', 'debug-authorization', `Debug session authorization is ${authorization.status.toLowerCase()}.`);
    }
    if (!sameContext(authorization, context)) {
      throw new SafeAbapError('POLICY_DENIED', 'debug-authorization', 'Debug session authorization does not match the current attach context.');
    }
    return authorization;
  }

  revoke(authorizationId: string, reason = 'USER_REVOKED'): DebugSessionAuthorization {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) {
      throw new SafeAbapError('AUTHORIZATION_NOT_FOUND', 'debug-authorization', 'Debug session authorization was not found.');
    }
    if (authorization.status === 'ACTIVE') this.markRevoked(authorization, reason);
    return authorization;
  }

  revokeForAttachChange(context: DebugAuthorizationContext): void {
    for (const authorization of this.authorizations.values()) {
      if (authorization.status === 'ACTIVE' && !sameContext(authorization, context)) {
        this.markRevoked(authorization, 'ATTACH_CONTEXT_CHANGED');
      }
    }
  }

  revokeForTarget(systemHost: string, client: string, targetUser: string, reason = 'ATTACH_CONTEXT_CHANGED'): void {
    const normalizedUser = normalizeUser(targetUser);
    for (const authorization of this.authorizations.values()) {
      if (
        authorization.status === 'ACTIVE'
        && authorization.systemHost === systemHost
        && authorization.client === client
        && authorization.targetUser === normalizedUser
      ) {
        this.markRevoked(authorization, reason);
      }
    }
  }

  view(authorizationId: string): DebugSessionAuthorizationView {
    this.cleanupExpired();
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) {
      throw new SafeAbapError('AUTHORIZATION_NOT_FOUND', 'debug-authorization', 'Debug session authorization was not found.');
    }
    return {
      authorizationId: authorization.authorizationId,
      createdAt: new Date(authorization.createdAt).toISOString(),
      expiresAt: new Date(authorization.expiresAt).toISOString(),
      status: authorization.status,
      revokedAt: authorization.revokedAt === undefined ? undefined : new Date(authorization.revokedAt).toISOString(),
      revokeReason: authorization.revokeReason,
      systemHost: authorization.systemHost,
      client: authorization.client,
      targetUser: authorization.targetUser,
      attachContext: { ...authorization.attachContext }
    };
  }

  private cleanupExpired(): void {
    const timestamp = this.now();
    for (const authorization of this.authorizations.values()) {
      if (authorization.status === 'ACTIVE' && timestamp >= authorization.expiresAt) {
        authorization.status = 'EXPIRED';
        authorization.revokedAt = timestamp;
        authorization.revokeReason = 'TTL_EXPIRED';
      }
    }
  }

  private evictInactive(): void {
    while (this.authorizations.size >= this.maxEntries) {
      const removable = [...this.authorizations.values()]
        .filter(authorization => authorization.status !== 'ACTIVE')
        .sort((left, right) => (left.revokedAt || left.createdAt) - (right.revokedAt || right.createdAt))[0];
      if (!removable) return;
      this.authorizations.delete(removable.authorizationId);
    }
  }

  private markRevoked(authorization: DebugSessionAuthorization, reason: string): void {
    authorization.status = 'REVOKED';
    authorization.revokedAt = this.now();
    authorization.revokeReason = reason;
  }
}

function sameContext(authorization: DebugSessionAuthorization, context: DebugAuthorizationContext): boolean {
  const expected = context.attachContext;
  const actual = authorization.attachContext;
  return authorization.systemHost === context.systemHost
    && authorization.client === context.client
    && authorization.targetUser === normalizeUser(context.targetUser)
    && actual.debuggeeId === expected.debuggeeId
    && actual.debugSessionId === expected.debugSessionId
    && actual.debuggeeSessionId === expected.debuggeeSessionId
    && actual.serverName === expected.serverName
    && actual.processId === expected.processId;
}

function normalizeUser(value: string): string {
  return String(value || '').trim().toUpperCase();
}
