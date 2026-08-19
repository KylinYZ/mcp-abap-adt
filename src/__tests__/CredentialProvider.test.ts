import { externalCredentialProvider, readExternalCredential, resolveSapPassword } from '../config/CredentialProvider';

const runner = async (_command: string, _args: string[]) => ({ stdout: 'secret-value\n' });

describe('CredentialProvider', () => {
  it('accepts one-line output from an external provider without logging it', async () => {
    const provider = externalCredentialProvider('C:\\tools\\credential.exe', 'sap-dev', runner);
    await expect(provider.getPassword()).resolves.toBe('secret-value');
  });

  it('rejects multi-line and empty output', async () => {
    await expect(readExternalCredential('C:\\tools\\credential.exe', 'sap-dev', async () => ({ stdout: 'a\nb' })))
      .rejects.toThrow('exactly one line');
    await expect(readExternalCredential('C:\\tools\\credential.exe', 'sap-dev', async () => ({ stdout: '  ' })))
      .rejects.toThrow('empty value');
  });

  it('supports the development fallback and can require external credentials', async () => {
    const warn = jest.fn();
    await expect(resolveSapPassword({ SAP_PASSWORD: 'legacy' }, warn)).resolves.toBe('legacy');
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(resolveSapPassword({ SAP_PASSWORD: 'legacy', SAP_MCP_REQUIRE_EXTERNAL_CREDENTIAL: 'true' }, warn))
      .rejects.toThrow('requires SAP_MCP_CREDENTIAL_COMMAND');
  });
});
