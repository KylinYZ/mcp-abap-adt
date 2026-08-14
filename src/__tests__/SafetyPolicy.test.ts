import { SafeAbapError } from '../safe/errors';
import { SafetyPolicy, parseToolProfile } from '../safe/SafetyPolicy';

describe('SafetyPolicy', () => {
  const validOptions = {
    sapUrl: 'https://dev.example.com:44300',
    sapClient: '100',
    sapUser: 'DEVUSER',
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

  it('allows diagnostic source reads in QAS and PRD but never mutations', () => {
    for (const systemRole of ['QAS', 'PRD']) {
      const policy = new SafetyPolicy({ ...validOptions, systemRole, toolProfile: 'diagnostic-readonly', auditPath: undefined });
      expect(() => policy.assertReadAllowed('Z_TEST_PROGRAM')).not.toThrow();
      expect(() => policy.assertMutationAllowed('Z_TEST_PROGRAM')).toThrow('Source mutations require');
    }
  });

  it('allows development-profile source reads outside DEV but keeps mutations DEV-only', () => {
    const policy = new SafetyPolicy({ ...validOptions, systemRole: 'QAS', toolProfile: 'development', auditPath: undefined });
    expect(() => policy.assertReadAllowed('Z_TEST_PROGRAM')).not.toThrow();
    expect(() => policy.assertMutationAllowed('Z_TEST_PROGRAM')).toThrow('Source mutations require');
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
    expect(parseToolProfile('development')).toBe('development');
    expect(parseToolProfile('diagnostic-readonly')).toBe('diagnostic-readonly');
    expect(() => parseToolProfile('unsafe')).toThrow('Unsupported SAP_MCP_TOOL_PROFILE');
  });

  it('allows DEV debug control for the current SAP user by default', () => {
    const policy = new SafetyPolicy({ ...validOptions, toolProfile: 'development' });
    expect(policy.assertDebugControlAllowed('devuser')).toBe('DEVUSER');
    expect(policy.debugAuthTtlMs).toBe(900_000);
    expect(policy.allowedDebugUsers).toEqual(new Set(['DEVUSER']));
  });

  it('supports multiple explicitly allow-listed debug users', () => {
    const policy = new SafetyPolicy({
      ...validOptions,
      toolProfile: 'development',
      allowedDebugUsers: 'devuser, tester, SUPPORT'
    });
    expect(policy.assertDebugControlAllowed('tester')).toBe('TESTER');
    expect(policy.allowedDebugUsers).toEqual(new Set(['DEVUSER', 'TESTER', 'SUPPORT']));
  });

  it('rejects debug users outside the default or explicit allow-list', () => {
    const policy = new SafetyPolicy({ ...validOptions, toolProfile: 'development' });
    expect(() => policy.assertDebugControlAllowed('OTHER')).toThrow('SAP_MCP_ALLOWED_DEBUG_USERS');
  });

  it.each([
    ['QAS', 'development'],
    ['PRD', 'development'],
    ['DEV', 'safe'],
    ['DEV', 'diagnostic-readonly']
  ])('rejects debug control for role %s and profile %s', (systemRole, toolProfile) => {
    const policy = new SafetyPolicy({ ...validOptions, systemRole, toolProfile });
    expect(() => policy.assertDebugControlAllowed('DEVUSER')).toThrow(SafeAbapError);
  });

  it('requires the audit path and allowed SAP target for debug control', () => {
    const withoutAudit = new SafetyPolicy({ ...validOptions, toolProfile: 'development', auditPath: undefined });
    expect(() => withoutAudit.assertDebugControlAllowed('DEVUSER')).toThrow('SAP_MCP_AUDIT_PATH');

    const wrongHost = new SafetyPolicy({ ...validOptions, toolProfile: 'development', allowedHosts: 'other.example.com' });
    expect(() => wrongHost.assertDebugControlAllowed('DEVUSER')).toThrow('SAP_MCP_ALLOWED_HOSTS');

    const wrongClient = new SafetyPolicy({ ...validOptions, toolProfile: 'development', allowedClients: '200' });
    expect(() => wrongClient.assertDebugControlAllowed('DEVUSER')).toThrow('SAP_MCP_ALLOWED_CLIENTS');
  });

  it('validates the debug authorization TTL', () => {
    expect(new SafetyPolicy({ ...validOptions, debugAuthTtlSeconds: '60' }).debugAuthTtlMs).toBe(60_000);
    expect(() => new SafetyPolicy({ ...validOptions, debugAuthTtlSeconds: '59' })).toThrow('SAP_MCP_DEBUG_AUTH_TTL_SECONDS');
    expect(() => new SafetyPolicy({ ...validOptions, debugAuthTtlSeconds: '3601' })).toThrow('SAP_MCP_DEBUG_AUTH_TTL_SECONDS');
  });
});
