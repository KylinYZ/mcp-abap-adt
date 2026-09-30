export interface SessionResilienceConfig {
  sessionRecovery: boolean;
  statelessReads: boolean;
  requireExternalCredential: boolean;
}

type Environment = Record<string, string | undefined>;

/** Parse the three rollout switches once at process startup. */
export function sessionResilienceConfigFromEnvironment(
  environment: Environment = process.env
): SessionResilienceConfig {
  return {
    sessionRecovery: booleanValue(environment, 'SAP_MCP_SESSION_RECOVERY', true),
    // 读域会话开关：read-only 类工具统一走 stateless 克隆会话（读域），
    // 与写域（主实例，按需 stateful）结构性隔离——读并发永远不会打在
    // stateful 会话上。分级读槽（SAP_MCP_MAX_READ_CONCURRENT_TOOLS>1）
    // 的安全性依赖本开关，因此默认开启；兼容旧行为可显式设 false
    //（此时读域退回主实例，读槽并发安全性由调用方自行保证）。
    statelessReads: booleanValue(environment, 'SAP_MCP_STATELESS_READS', true),
    requireExternalCredential: booleanValue(environment, 'SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL', false)
  };
}

function booleanValue(environment: Environment, name: string, fallback: boolean): boolean {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`${name} received '${raw}'; expected true or false.`);
}
