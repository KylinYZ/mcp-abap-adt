import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AuditLogger, type AuditEvent } from '../safe/AuditLogger';

describe('AuditLogger', () => {
  let auditDirectory: string;

  beforeEach(async () => {
    auditDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sap-mcp-audit-'));
  });

  afterEach(async () => {
    await fs.rm(auditDirectory, { recursive: true, force: true });
  });

  it('appends JSONL without secrets, lock handles, diffs, or complete source', async () => {
    const logger = new AuditLogger(auditDirectory);
    // Extra fields model accidentally supplied sensitive data and must still be removed at the disk boundary.
    const event: AuditEvent & Record<string, unknown> = {
      correlationId: 'plan-1',
      changePlanId: 'plan-1',
      eventType: 'APPLY_FAILED',
      systemHost: 'dev.example.com',
      client: '100',
      systemRole: 'DEV',
      success: false,
      confirmationMode: 'text-fallback',
      errorSummary: 'Authorization: Basic dXNlcjpzZWNyZXQ= password=secret',
      password: 'secret',
      cookie: 'sap-contextid=secret',
      lockHandle: 'secret-lock',
      source: 'REPORT zsecret.',
      diff: '-old\n+new',
      confirmationText: '确认应用 plan-1 验证码 123456',
      textConfirmation: '确认应用 plan-1 验证码 123456',
      challenge: '123456',
      verificationCode: '123456'
    };

    await logger.append(event);

    const record = JSON.parse((await fs.readFile(logger.filePath, 'utf8')).trim());
    expect(record).toMatchObject({
      correlationId: 'plan-1',
      eventType: 'APPLY_FAILED',
      success: false,
      confirmationMode: 'text-fallback'
    });
    expect(record.errorSummary).toContain('Authorization=[REDACTED]');
    expect(record.errorSummary).toContain('password=[REDACTED]');
    expect(record).not.toHaveProperty('password');
    expect(record).not.toHaveProperty('cookie');
    expect(record).not.toHaveProperty('lockHandle');
    expect(record).not.toHaveProperty('source');
    expect(record).not.toHaveProperty('diff');
    expect(record).not.toHaveProperty('confirmationText');
    expect(record).not.toHaveProperty('textConfirmation');
    expect(record).not.toHaveProperty('challenge');
    expect(record).not.toHaveProperty('verificationCode');
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(JSON.stringify(record)).not.toContain('123456');
  });
});
