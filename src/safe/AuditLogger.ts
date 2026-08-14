import { promises as fs } from 'fs';
import path from 'path';
import { SafeAbapError, errorMessage } from './errors.js';

export interface AuditEvent {
  timestamp?: string;
  correlationId: string;
  changePlanId?: string;
  creationPlanId?: string;
  eventType: string;
  systemHost: string;
  client: string;
  systemRole: string;
  objectType?: string;
  objectName?: string;
  parentObject?: string;
  packageName?: string;
  activationTarget?: string;
  transportRequest?: string;
  originalHash?: string;
  targetHash?: string;
  verifiedSourceHash?: string;
  sourceMatchType?: string;
  rollbackVerifiedSourceHash?: string;
  rollbackSourceMatchType?: string;
  addedLines?: number;
  removedLines?: number;
  durationMs?: number;
  success: boolean;
  errorCode?: string;
  errorSummary?: string;
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
  compensationAttempted?: boolean;
  compensationSucceeded?: boolean;
  unlockSucceeded?: boolean;
  confirmationMode?: string;
  activationOutcome?: string;
  activationInactiveCount?: number;
  debugOperationPlanId?: string;
  debugOperationKind?: string;
  targetUser?: string;
  debuggeeId?: string;
  debugAuthHash?: string;
  operationHash?: string;
  oldValueHash?: string;
  newValueHash?: string;
  resultSummary?: string;
  operationPlanId?: string;
  advancedOperationKind?: string;
  inputHash?: string;
  driftHash?: string;
  recoveryHash?: string;
  verificationHash?: string;
  partialSuccess?: boolean;
  unknownOutcome?: boolean;
}

export class AuditLogger {
  readonly filePath: string;
  private directoryInitialization?: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(auditDirectory: string) {
    this.filePath = path.join(path.resolve(auditDirectory), 'abap-change-audit.jsonl');
  }

  append(event: AuditEvent): Promise<void> {
    const record = sanitizeRecord({ ...event, timestamp: event.timestamp || new Date().toISOString() });
    const write = this.writeTail.then(() => this.writeRecord(record));
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private async writeRecord(record: Record<string, unknown>): Promise<void> {
    try {
      await this.ensureDirectory();
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    } catch (error) {
      throw new SafeAbapError('AUDIT_FAILED', 'audit', `Failed to write the audit log: ${errorMessage(error)}`);
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.directoryInitialization) {
      this.directoryInitialization = fs.mkdir(path.dirname(this.filePath), { recursive: true }).then(() => undefined);
    }
    try {
      await this.directoryInitialization;
    } catch (error) {
      this.directoryInitialization = undefined;
      throw error;
    }
  }
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  // Confirmation phrases and verification codes are one-time secrets and must never reach disk.
  const forbidden = /password|passwd|pwd|cookie|authorization|lockhandle|source|diff|confirmationtext|textconfirmation|challenge|verificationcode|oldvalue|newvalue|variablevalue|debugvalue/i;
  const safeDiagnosticFields = new Set([
    'verifiedSourceHash',
    'sourceMatchType',
    'rollbackVerifiedSourceHash',
    'rollbackSourceMatchType',
    'oldValueHash',
    'newValueHash'
  ]);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => safeDiagnosticFields.has(key) || !forbidden.test(key))
      .map(([key, value]) => [key, typeof value === 'string' ? sanitizeValue(value) : value])
  );
}

function sanitizeValue(value: string): string {
  return value
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/(password|passwd|pwd|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}
