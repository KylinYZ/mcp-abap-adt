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
    statelessReads: booleanValue(environment, 'SAP_MCP_STATELESS_READS', false),
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
