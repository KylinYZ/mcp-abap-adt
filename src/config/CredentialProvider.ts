import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const MAX_CREDENTIAL_BYTES = 8 * 1024;

export type CredentialEnvironment = Record<string, string | undefined>;

export interface CredentialProvider {
  getPassword(): Promise<string>;
}

export type CredentialCommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string }>;

/** Resolve a password without ever putting it in an MCP tool argument or log. */
export async function resolveSapPassword(
  environment: CredentialEnvironment = process.env,
  warn: (message: string) => void = message => console.error(message),
  runner: CredentialCommandRunner = defaultRunner
): Promise<string> {
  const command = environment.SAP_MCP_CREDENTIAL_COMMAND?.trim();
  const requireExternal = parseBoolean(environment.SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL);
  if (command) {
    if (!path.isAbsolute(command)) {
      throw new Error('SAP_MCP_CREDENTIAL_COMMAND must be an absolute executable path.');
    }
    const target = environment.SAP_MCP_CREDENTIAL_TARGET?.trim();
    if (!target) throw new Error('SAP_MCP_CREDENTIAL_TARGET is required when an external credential command is configured.');
    return readExternalCredential(command, target, runner);
  }
  if (requireExternal) {
    throw new Error('SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL=true requires SAP_MCP_CREDENTIAL_COMMAND and SAP_MCP_CREDENTIAL_TARGET.');
  }
  const password = environment.SAP_PASSWORD?.trim();
  if (!password) throw new Error('SAP_PASSWORD is missing and no external credential provider is configured.');
  warn('WARNING: SAP_PASSWORD fallback is enabled; migrate to SAP_MCP_CREDENTIAL_COMMAND before production use.');
  return password;
}

export function externalCredentialProvider(
  command: string,
  target: string,
  runner: CredentialCommandRunner = defaultRunner
): CredentialProvider {
  if (!path.isAbsolute(command)) throw new Error('Credential command must be an absolute executable path.');
  if (!target.trim()) throw new Error('Credential target must not be empty.');
  return { getPassword: () => readExternalCredential(command, target, runner) };
}

export async function readExternalCredential(
  command: string,
  target: string,
  runner: CredentialCommandRunner = defaultRunner
): Promise<string> {
  try {
    const result = await runner(command, [target]);
    const stdout = String(result.stdout).replace(/\r?\n$/, '');
    if (stdout.includes('\n') || stdout.includes('\r')) {
      throw new Error('credential command must return exactly one line.');
    }
    const password = stdout.trim();
    if (!password) throw new Error('credential command returned an empty value.');
    return password;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('credential command')) throw error;
    throw new Error('external credential provider failed.');
  }
}

const defaultRunner: CredentialCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_CREDENTIAL_BYTES
  });
  return { stdout: String(result.stdout) };
};

function parseBoolean(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error('SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL must be true or false.');
}
