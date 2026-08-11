import { SafeAbapError } from '../safe/errors';
import { SafetyPolicy, parseToolProfile } from '../safe/SafetyPolicy';

describe('SafetyPolicy', () => {
  const validOptions = {
    sapUrl: 'https://dev.example.com:44300',
    sapClient: '100',
    systemRole: 'DEV',
    allowedHosts: 'dev.example.com',
    allowedClients: '100',
    allowedNamespaces: 'Z,Y',
    planTtlSeconds: '900',
    auditPath: 'C:\\audit',
    toolProfile: 'safe'
  };

  it('accepts an allow-listed development target', () => {
    const policy = new SafetyPolicy(validOptions);
    expect(() => policy.assertReadAllowed('z_test_program')).not.toThrow();
    expect(() => policy.assertMutationAllowed('z_test_program')).not.toThrow();
    expect(policy.systemHost).toBe('dev.example.com');
    expect(policy.toolProfile).toBe('safe');
    expect(policy.allowTextConfirmation).toBe(false);
  });

  it('enables text confirmation fallback only for an explicit true value', () => {
    expect(new SafetyPolicy({ ...validOptions, allowTextConfirmation: 'true' }).allowTextConfirmation).toBe(true);
    expect(new SafetyPolicy({ ...validOptions, allowTextConfirmation: 'false' }).allowTextConfirmation).toBe(false);
  });

  it('allows guarded source reads without requiring an audit directory', () => {
    const policy = new SafetyPolicy({ ...validOptions, auditPath: undefined });
    expect(() => policy.assertReadAllowed('Z_TEST_PROGRAM')).not.toThrow();
    expect(() => policy.assertMutationAllowed('Z_TEST_PROGRAM')).toThrow('SAP_MCP_AUDIT_PATH');
  });

  it('fails closed when the system role is not DEV', () => {
    const policy = new SafetyPolicy({ ...validOptions, systemRole: 'QAS' });
    expect(() => policy.assertMutationAllowed('Z_TEST_PROGRAM')).toThrow(SafeAbapError);
  });

  it('rejects objects outside configured namespaces', () => {
    const policy = new SafetyPolicy(validOptions);
    expect(() => policy.assertMutationAllowed('SAPMZ_STANDARD')).toThrow('outside the allowed namespaces');
  });

  it('requires an existing ten-character transport number', () => {
    const policy = new SafetyPolicy(validOptions);
    expect(policy.assertTransportFormat('devk900001')).toBe('DEVK900001');
    expect(() => policy.assertTransportFormat('$TMP')).toThrow(SafeAbapError);
  });

  it('rejects local or unknown packages for source changes', () => {
    const policy = new SafetyPolicy(validOptions);
    expect(() => policy.assertTransportablePackage('$TMP')).toThrow('local package $TMP');
    expect(() => policy.assertTransportablePackage(undefined)).toThrow('local package $TMP');
    expect(policy.assertTransportablePackage('zpkg')).toBe('ZPKG');
  });

  it('rejects unknown tool profiles', () => {
    expect(parseToolProfile()).toBe('safe');
    expect(parseToolProfile('legacy-full')).toBe('legacy-full');
    expect(() => parseToolProfile('unsafe')).toThrow('Unsupported SAP_MCP_TOOL_PROFILE');
  });
});
