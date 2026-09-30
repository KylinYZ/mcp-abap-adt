import { sessionResilienceConfigFromEnvironment } from '../config/SessionResilienceConfig';

describe('session resilience configuration', () => {
  it('uses safe rollout defaults', () => {
    // 分级执行门：读域（stateless 克隆）默认开启——读槽并发的安全性依赖它
    expect(sessionResilienceConfigFromEnvironment({})).toEqual({
      sessionRecovery: true,
      statelessReads: true,
      requireExternalCredential: false
    });
  });

  it('parses explicit flags and rejects invalid values', () => {
    expect(sessionResilienceConfigFromEnvironment({
      SAP_MCP_SESSION_RECOVERY: '0',
      SAP_MCP_STATELESS_READS: 'no',
      SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL: 'false'
    })).toEqual({ sessionRecovery: false, statelessReads: false, requireExternalCredential: false });
    expect(() => sessionResilienceConfigFromEnvironment({ SAP_MCP_STATELESS_READS: 'sometimes' }))
      .toThrow('SAP_MCP_STATELESS_READS');
  });
});
