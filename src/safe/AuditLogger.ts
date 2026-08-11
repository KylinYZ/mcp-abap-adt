import { promises as fs } from 'fs';
import path from 'path';
import { SafeAbapError, errorMessage } from './errors.js';

export interface AuditEvent {
  timestamp?: string;
  correlationId: string;
  changePlanId?: string;
  eventType: string;
  systemHost: string;
  client: string;
  systemRole: string;
  objectType?: string;
  objectName?: string;
  parentObject?: string;
  activationTarget?: string;
  transportRequest?: string;
  originalHash?: string;
  targetHash?: string;
  addedLines?: number;
  removedLines?: number;
  durationMs?: number;
  success: boolean;
  errorCode?: string;
  errorSummary?: string;
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
  unlockSucceeded?: boolean;
  confirmationMode?: string;
}

export class AuditLogger {
  readonly filePath: string;

  constructor(auditDirectory: string) {
    this.filePath = path.join(path.resolve(auditDirectory), 'abap-change-audit.jsonl');
  }

  async append(event: AuditEvent): Promise<void> {
    const record = sanitizeRecord({ ...event, timestamp: event.timestamp || new Date().toISOString() });
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    } catch (error) {
      throw new SafeAbapError('AUDIT_FAILED', 'audit', `Failed to write the audit log: ${errorMessage(error)}`);
    }
  }
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  // Confirmation phrases and verification codes are one-time secrets and must never reach disk.
  const forbidden = /password|passwd|pwd|cookie|authorization|lockhandle|source|diff|confirmationtext|textconfirmation|challenge|verificationcode/i;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !forbidden.test(key))
      .map(([key, value]) => [key, typeof value === 'string' ? sanitizeValue(value) : value])
  );
}

function sanitizeValue(value: string): string {
  return value
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/(password|passwd|pwd|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}
