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
      verifiedSourceHash: 'verified-hash',
      sourceMatchType: 'DIFFERENT',
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
    expect(record.verifiedSourceHash).toBe('verified-hash');
    expect(record.sourceMatchType).toBe('DIFFERENT');
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

  it('retains variable hashes but drops accidentally supplied runtime values', async () => {
    const logger = new AuditLogger(auditDirectory);
    await logger.append({
      correlationId: 'debug-plan-1',
      eventType: 'DEBUG_VARIABLE_APPLIED',
      systemHost: 'dev.example.com',
      client: '100',
      systemRole: 'DEV',
      targetUser: 'DEVUSER',
      oldValueHash: 'old-hash',
      newValueHash: 'new-hash',
      success: true,
      oldValue: 'old-secret',
      newValue: 'new-secret',
      variableValue: 'variable-secret'
    } as AuditEvent & Record<string, unknown>);

    const record = JSON.parse((await fs.readFile(logger.filePath, 'utf8')).trim());
    expect(record).toMatchObject({ oldValueHash: 'old-hash', newValueHash: 'new-hash' });
    expect(record).not.toHaveProperty('oldValue');
    expect(record).not.toHaveProperty('newValue');
    expect(record).not.toHaveProperty('variableValue');
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('serializes concurrent appends in call order with one directory initialization', async () => {
    const logger = new AuditLogger(auditDirectory);
    const mkdirSpy = jest.spyOn(fs, 'mkdir');
    const events = [1, 2, 3].map(sequence => ({
      correlationId: `plan-${sequence}`,
      eventType: 'STAGE',
      systemHost: 'dev.example.com',
      client: '100',
      systemRole: 'DEV',
      success: true
    } satisfies AuditEvent));

    await Promise.all(events.map(event => logger.append(event)));

    const lines = (await fs.readFile(logger.filePath, 'utf8')).trim().split('\n');
    expect(lines.map(line => JSON.parse(line).correlationId)).toEqual(['plan-1', 'plan-2', 'plan-3']);
    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    mkdirSpy.mockRestore();
  });

  it('recovers the append chain after a write failure', async () => {
    const logger = new AuditLogger(auditDirectory);
    const appendSpy = jest.spyOn(fs, 'appendFile')
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce();
    const event: AuditEvent = {
      correlationId: 'plan-1',
      eventType: 'STAGE',
      systemHost: 'dev.example.com',
      client: '100',
      systemRole: 'DEV',
      success: true
    };

    await expect(logger.append(event)).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    await expect(logger.append({ ...event, correlationId: 'plan-2' })).resolves.toBeUndefined();
    expect(appendSpy).toHaveBeenCalledTimes(2);
    appendSpy.mockRestore();
  });

  it('retries directory initialization after a mkdir failure', async () => {
    const logger = new AuditLogger(auditDirectory);
    const mkdirSpy = jest.spyOn(fs, 'mkdir')
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(undefined);
    const appendSpy = jest.spyOn(fs, 'appendFile').mockResolvedValue();
    const event: AuditEvent = {
      correlationId: 'plan-1',
      eventType: 'STAGE',
      systemHost: 'dev.example.com',
      client: '100',
      systemRole: 'DEV',
      success: true
    };

    await expect(logger.append(event)).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    await expect(logger.append(event)).resolves.toBeUndefined();
    expect(mkdirSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    mkdirSpy.mockRestore();
    appendSpy.mockRestore();
  });
});
