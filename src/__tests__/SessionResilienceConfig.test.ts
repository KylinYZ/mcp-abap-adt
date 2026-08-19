import { sessionResilienceConfigFromEnvironment } from '../config/SessionResilienceConfig';

describe('session resilience configuration', () => {
  it('uses safe rollout defaults', () => {
    expect(sessionResilienceConfigFromEnvironment({})).toEqual({
      sessionRecovery: true,
      statelessReads: false,
      requireExternalCredential: false
    });
  });

  it('parses explicit flags and rejects invalid values', () => {
    expect(sessionResilienceConfigFromEnvironment({
      SAP_MCP_SESSION_RECOVERY: '0',
      SAP_MCP_STATELESS_READS: 'yes',
      SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL: 'false'
    })).toEqual({ sessionRecovery: false, statelessReads: true, requireExternalCredential: false });
    expect(() => sessionResilienceConfigFromEnvironment({ SAP_MCP_STATELESS_READS: 'sometimes' }))
      .toThrow('SAP_MCP_STATELESS_READS');
  });
});
