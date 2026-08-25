import { WindowsNativeRepositoryCreationConfirmationProvider } from '../safe/RepositoryCreationConfirmationProvider';

describe('Windows repository creation confirmation protocol', () => {
  it('sends only bounded display data to the helper runner', async () => {
    let requestLine = '';
    let timeoutMs = 0;
    const provider = new WindowsNativeRepositoryCreationConfirmationProvider(async (line, timeout) => {
      requestLine = line;
      timeoutMs = timeout;
      const request = JSON.parse(line);
      return `${JSON.stringify({ challengeId: request.challengeId, action: 'cancel' })}\n`;
    });

    await expect(provider.confirm({
      challengeId: 'challenge-123456',
      creationPlanId: 'plan-1',
      summary: 'No SAP connection.',
      objectKind: 'DDIC_DOMAIN',
      objectName: 'ZZMCP_VT_DOM',
      packageName: 'Z001',
      transportRequest: 'S4HK900009',
      payloadFingerprint: 'cae28dc3b16437ac',
      expiresAt: '2099-08-21T00:15:00.000Z'
    }, { timeoutMs: 2_000 })).resolves.toEqual({ action: 'cancel', challengeId: 'challenge-123456' });

    expect(timeoutMs).toBe(2_000);
    expect(requestLine.endsWith('\n')).toBe(true);
    expect(requestLine).not.toContain('SAP_PASSWORD');
    expect(requestLine).not.toContain('credential');
    expect(JSON.parse(requestLine)).toEqual(expect.objectContaining({
      challengeId: 'challenge-123456',
      title: 'SAP 受控创建确认',
      message: expect.stringContaining('请确认是否在 SAP DEV 中创建以下对象'),
      summary: 'No SAP connection.',
      objectKind: 'DDIC_DOMAIN',
      objectName: 'ZZMCP_VT_DOM',
      packageName: 'Z001',
      transportRequest: 'S4HK900009',
      payloadFingerprint: 'cae28dc3b16437ac',
      expiresAt: '2099-08-21 08:15:00 UTC+08:00',
      timeoutSeconds: 1
    }));
  });

  it('treats helper timeout as cancellation', async () => {
    const provider = new WindowsNativeRepositoryCreationConfirmationProvider(async (_line, timeoutMs) => {
      await new Promise((_, reject) => setTimeout(() => reject(new Error('Windows confirmation timed out.')), timeoutMs));
      return '';
    });
    await expect(provider.confirm({
      challengeId: 'challenge-123456',
      creationPlanId: 'plan-1',
      summary: 'No SAP connection.',
      objectKind: 'DDIC_DOMAIN',
      objectName: 'ZZMCP_VT_DOM',
      payloadFingerprint: 'cae28dc3b16437ac',
      expiresAt: '2099-08-21T00:15:00.000Z'
    }, { timeoutMs: 5 })).rejects.toThrow('timed out');
  });
});
