/**
 * 只读 FM allowlist 门控测试（对应 src/rfc/allowlist.ts）。
 *
 * 覆盖：默认最小白名单、白名单内放行、白名单外结构化拒绝（错误码
 * RF_CALL_NOT_ALLOWED 出现在 message 与 code 中）、受控扩展注入、
 * 非法扩展条目拒绝。纯内存，无网络 IO。
 */

import { createDefaultFmAllowlist, DEFAULT_READONLY_FM_ALLOWLIST, FmAllowlist } from '../rfc/allowlist';
import { isRfcError, RfcError } from '../rfc/errors';

describe('RfcAllowlist default gating', () => {
  it('starts with the minimal default allowlist', () => {
    const allowlist = createDefaultFmAllowlist();
    expect(allowlist.size).toBe(3);
    expect(allowlist.entries()).toEqual(['RFC_PING', 'RFC_READ_TABLE', 'RFC_SYSTEM_INFO']);
    expect(DEFAULT_READONLY_FM_ALLOWLIST).toEqual(['RFC_SYSTEM_INFO', 'RFC_PING', 'RFC_READ_TABLE']);
  });

  it('allows FM names inside the whitelist case-insensitively', () => {
    const allowlist = createDefaultFmAllowlist();
    expect(allowlist.isAllowed('RFC_PING')).toBe(true);
    expect(allowlist.isAllowed('rfc_read_table')).toBe(true); // 大小写不敏感
    expect(allowlist.isAllowed('RFC_SYSTEM_INFO')).toBe(true);
  });

  it('rejects FM names outside the whitelist with a structured error', () => {
    const allowlist = createDefaultFmAllowlist();
    expect(allowlist.isAllowed('BAPI_MATERIAL_GET_DETAIL')).toBe(false);
    expect(() => allowlist.assertAllowed('Z_EVIL_FM')).toThrow(RfcError);
    try {
      allowlist.assertAllowed('Z_EVIL_FM');
      throw new Error('expected RF_CALL_NOT_ALLOWED');
    } catch (error) {
      expect(isRfcError(error)).toBe(true);
      const rfcError = error as RfcError;
      // 错误码与原因必须同时出现在机器字段与人类可读 message 中。
      expect(rfcError.code).toBe('RF_CALL_NOT_ALLOWED');
      expect(rfcError.message).toContain('RF_CALL_NOT_ALLOWED');
      expect(rfcError.message).toContain('Z_EVIL_FM');
      expect(rfcError.details).toMatchObject({ functionName: 'Z_EVIL_FM', reason: 'not-in-readonly-allowlist' });
    }
  });

  it('treats non-string input as denied', () => {
    const allowlist = createDefaultFmAllowlist();
    expect(allowlist.isAllowed(undefined)).toBe(false);
    expect(allowlist.isAllowed(42)).toBe(false);
    expect(allowlist.isAllowed(null)).toBe(false);
    expect(() => allowlist.assertAllowed(undefined)).toThrow(RfcError);
  });
});

describe('RfcAllowlist extension', () => {
  it('accepts controlled extensions on top of the defaults', () => {
    const allowlist = new FmAllowlist(['Z_MY_READONLY_FM']);
    expect(allowlist.isAllowed('Z_MY_READONLY_FM')).toBe(true);
    // 默认条目仍然保留。
    expect(allowlist.isAllowed('RFC_PING')).toBe(true);
    expect(allowlist.size).toBe(4);
  });

  it('normalizes extension entries to upper case', () => {
    const allowlist = new FmAllowlist(['z_lowercase_fm']);
    expect(allowlist.isAllowed('Z_LOWERCASE_FM')).toBe(true);
  });

  it('deduplicates entries', () => {
    const allowlist = new FmAllowlist(['RFC_PING', 'RFC_PING']);
    expect(allowlist.size).toBe(3);
  });

  it('rejects malformed extension entries instead of widening silently', () => {
    expect(() => new FmAllowlist(['not a valid fm name!'])).toThrow(RfcError);
    expect(() => new FmAllowlist([''])).toThrow(RfcError);
  });

  it('keeps separate allowlists independent', () => {
    const a = new FmAllowlist(['Z_A_FM']);
    const b = new FmAllowlist(['Z_B_FM']);
    expect(a.isAllowed('Z_B_FM')).toBe(false);
    expect(b.isAllowed('Z_A_FM')).toBe(false);
  });
});
