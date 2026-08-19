import type { ADTClient, SessionEvent } from '../adt/index.js';
import { isSessionExpiredError } from '../adt/index.js';
import { toolOperationClass } from '../config/ToolOperationPolicy.js';
import { SafeAbapError } from '../safe/errors.js';

export type SessionHealthState =
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'explicitly-logged-out';

export interface SessionHealthSnapshot {
  mode: 'stateful';
  state: SessionHealthState;
  generation: number;
  sessionAgeSeconds?: number;
  lastKeepaliveAt?: string;
  lastReconnectAt?: string;
  lastErrorType?: string;
}

export interface SessionSupervisorOptions {
  enabled?: boolean;
  now?: () => number;
}

/**
 * Owns stateful-session recovery at the MCP tool boundary. It deliberately
 * knows the operation class so only read-only work can be replayed.
 */
export class SessionSupervisor {
  private readonly now: () => number;
  private readonly enabled: boolean;
  private reconnectPromise?: Promise<void>;
  private generation = 0;
  private explicitlyLoggedOut = false;
  private state: SessionHealthState = 'disconnected';
  private sessionStartedAt?: number;
  private lastKeepaliveAt?: number;
  private lastReconnectAt?: number;
  private lastErrorType?: string;

  constructor(
    private readonly client: ADTClient,
    options: SessionSupervisorOptions = {}
  ) {
    this.now = options.now || (() => Date.now());
    this.enabled = options.enabled !== false;
  }

  async execute<T>(toolName: string, operation: () => Promise<T>): Promise<T> {
    if (toolName === 'login') {
      this.explicitlyLoggedOut = false;
      const result = await operation();
      this.markConnected();
      return result;
    }
    if (toolName === 'logout') {
      this.explicitlyLoggedOut = true;
      try {
        return await operation();
      } finally {
        this.state = 'explicitly-logged-out';
        this.sessionStartedAt = undefined;
      }
    }

    const operationClass = toolOperationClass(toolName);
    const observedGeneration = this.generation;
    try {
      const result = await operation();
      if (operationClass && operationClass !== 'local' && this.client.loggedin) this.markConnected();
      return result;
    } catch (error) {
      if (!isSessionExpiredError(error)) throw error;
      this.markSessionFailure(error);

      if (operationClass === 'read-only' && this.enabled && !this.explicitlyLoggedOut) {
        await this.reconnectIfNeeded(observedGeneration);
        const result = await operation();
        this.markConnected();
        return result;
      }

      if (operationClass && operationClass !== 'local' && operationClass !== 'read-only') {
        throw new SafeAbapError(
          'REMOTE_RESULT_UNKNOWN',
          'session',
          'The SAP session expired during a non-replayable operation. Inspect the remote state before retrying.'
        );
      }
      throw error;
    }
  }

  handleEvent(event: SessionEvent): void {
    const timestamp = this.now();
    if (event.type === 'keepalive-success') {
      this.lastKeepaliveAt = timestamp;
      if (!this.explicitlyLoggedOut) this.state = 'connected';
      return;
    }
    if (event.type === 'keepalive-failure') {
      this.lastKeepaliveAt = timestamp;
      this.lastErrorType = event.errorType || 'request-failed';
      if (!this.explicitlyLoggedOut) this.state = 'degraded';
      return;
    }
    if (event.type === 'reconnect') {
      this.markConnected();
      this.lastReconnectAt = timestamp;
      return;
    }
    if (event.type === 'logout') {
      this.state = 'explicitly-logged-out';
      this.sessionStartedAt = undefined;
      return;
    }
    if (event.type === 'drop-session') {
      if (!this.explicitlyLoggedOut) this.state = 'disconnected';
    }
  }

  snapshot(): SessionHealthSnapshot {
    const timestamp = this.now();
    return {
      mode: 'stateful',
      state: this.state,
      generation: this.generation,
      ...(this.sessionStartedAt ? { sessionAgeSeconds: Math.max(0, Math.floor((timestamp - this.sessionStartedAt) / 1000)) } : {}),
      ...(this.lastKeepaliveAt ? { lastKeepaliveAt: new Date(this.lastKeepaliveAt).toISOString() } : {}),
      ...(this.lastReconnectAt ? { lastReconnectAt: new Date(this.lastReconnectAt).toISOString() } : {}),
      ...(this.lastErrorType ? { lastErrorType: this.lastErrorType } : {})
    };
  }

  private async reconnectIfNeeded(observedGeneration: number): Promise<void> {
    if (this.generation !== observedGeneration) return;
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.client.reconnect()
        .then(() => {
          this.generation += 1;
          this.markConnected();
          this.lastReconnectAt = this.now();
        })
        .catch(error => {
          this.state = 'disconnected';
          this.markSessionFailure(error);
          throw error;
        })
        .finally(() => {
          this.reconnectPromise = undefined;
        });
    }
    await this.reconnectPromise;
  }

  private markConnected(): void {
    if (this.explicitlyLoggedOut) return;
    this.state = 'connected';
    this.sessionStartedAt = this.sessionStartedAt || this.now();
    this.lastErrorType = undefined;
  }

  private markSessionFailure(error: unknown): void {
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? String((error as { status: number }).status)
      : undefined;
    this.lastErrorType = status ? `session-expired-${status}` : 'session-expired';
    if (!this.explicitlyLoggedOut) this.state = 'degraded';
  }
}
