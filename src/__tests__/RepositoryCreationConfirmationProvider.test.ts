import { RepositoryCreationConfirmationChallengeStore } from '../safe/RepositoryCreationConfirmationChallengeStore';
import {
  McpFormRepositoryCreationConfirmationProvider,
  WindowsNativeRepositoryCreationConfirmationProvider,
  createRepositoryCreationConfirmationProvider,
  type RepositoryCreationConfirmationRequest
} from '../safe/RepositoryCreationConfirmationProvider';
import type { RepositoryCreationPlanView } from '../safe/repositoryCreationTypes';

const plan: RepositoryCreationPlanView = {
  creationPlanId: 'plan-1',
  createdAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2026-08-21T00:15:00.000Z',
  status: 'PREVIEWED',
  systemHost: 'dev.example.test',
  client: '300',
  sapUser: 'TEST_USER',
  systemRole: 'DEV',
  toolProfile: 'development',
  target: { objectKind: 'DDIC_DOMAIN', objectName: 'ZZMCP_VT_DOM', adtType: 'DOMA/DD', parentName: 'Z001', packageName: 'Z001' },
  transportRequest: 'S4HK900009',
  summary: 'Create DDIC domain ZZMCP_VT_DOM in package Z001.',
  payloadHash: 'cae28dc3b16437ac000000000000000000000000000000000000000000000000',
  payloadBytes: 100,
  stages: [],
  compensationLimits: []
};

const request: RepositoryCreationConfirmationRequest = {
  challengeId: 'challenge-123456',
  creationPlanId: plan.creationPlanId,
  summary: plan.summary,
  objectKind: plan.target.objectKind,
  objectName: plan.target.objectName,
  packageName: plan.target.parentName,
  transportRequest: plan.transportRequest,
  payloadFingerprint: plan.payloadHash.slice(0, 16),
  expiresAt: plan.expiresAt
};

describe('RepositoryCreationConfirmationChallengeStore', () => {
  it('binds one challenge to the plan, provider, session, and SAP context', () => {
    const store = new RepositoryCreationConfirmationChallengeStore(() => 1_000);
    const challenge = store.create(plan, 'session-1', 'windows-native', 2_000);

    expect(() => store.consume(challenge.challengeId, { ...plan, payloadHash: 'changed' }, 'session-1', 'windows-native'))
      .toThrow(expect.objectContaining({ code: 'CONFIRMATION_CANCELLED' }));
    expect(() => store.consume(challenge.challengeId, {
      ...plan, target: { ...plan.target, packageName: 'ZOTHER' }
    }, 'session-1', 'windows-native')).toThrow(expect.objectContaining({ code: 'CONFIRMATION_CANCELLED' }));
    expect(() => store.consume(challenge.challengeId, plan, 'session-2', 'windows-native'))
      .toThrow(expect.objectContaining({ code: 'CONFIRMATION_CANCELLED' }));
    expect(store.consume(challenge.challengeId, plan, 'session-1', 'windows-native').status).toBe('CONSUMED');
    expect(() => store.consume(challenge.challengeId, plan, 'session-1', 'windows-native'))
      .toThrow(expect.objectContaining({ code: 'CONFIRMATION_CANCELLED' }));
    expect(() => store.create(plan, 'session-1', 'windows-native', 2_000))
      .toThrow(expect.objectContaining({ code: 'PLAN_ALREADY_CONSUMED' }));
  });

  it('expires or cancels pending challenges without granting authorization', () => {
    let now = 1_000;
    const store = new RepositoryCreationConfirmationChallengeStore(() => now);
    const expired = store.create(plan, 'session-1', 'windows-native', 1_500);
    now = 1_500;
    expect(store.status(expired.challengeId)?.status).toBe('EXPIRED');
    const replacement = store.create(plan, 'session-1', 'windows-native', 2_000);
    expect(store.cancel(replacement.challengeId)?.status).toBe('CANCELLED');
    expect(store.create(plan, 'session-1', 'windows-native', 2_000).status).toBe('PENDING');
  });
});

describe('repository creation confirmation providers', () => {
  it('accepts only one exact bounded Windows helper response', async () => {
    const apply = new WindowsNativeRepositoryCreationConfirmationProvider(async () =>
      JSON.stringify({ challengeId: request.challengeId, action: 'apply' })
    );
    await expect(apply.confirm(request, { timeoutMs: 1_000 })).resolves.toEqual({
      challengeId: request.challengeId,
      action: 'apply'
    });

    for (const output of [
      '{"action":"apply"}',
      JSON.stringify({ challengeId: 'wrong', action: 'apply' }),
      JSON.stringify({ challengeId: request.challengeId, action: 'Apply' }),
      `${JSON.stringify({ challengeId: request.challengeId, action: 'apply' })}\nextra`,
      `${JSON.stringify({ challengeId: request.challengeId, action: 'apply' })}\n\n`,
      JSON.stringify({ challengeId: request.challengeId, action: 'apply', confirmed: true })
    ]) {
      const malformed = new WindowsNativeRepositoryCreationConfirmationProvider(async () => output);
      await expect(malformed.confirm(request, { timeoutMs: 1_000 })).rejects.toThrow();
    }
  });

  it('maps strict MCP form decisions and rejects malformed accepted content', async () => {
    const elicitInput = jest.fn(async () => ({ action: 'accept' as const, content: { decision: 'apply' } }));
    const apply = new McpFormRepositoryCreationConfirmationProvider(
      () => true,
      elicitInput
    );
    await expect(apply.confirm(request, { timeoutMs: 1_000 })).resolves.toEqual({
      action: 'apply',
      challengeId: request.challengeId
    });
    expect(elicitInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('有效期至：2026-08-21 08:15:00 UTC+08:00') }),
      1_000
    );

    const malformed = new McpFormRepositoryCreationConfirmationProvider(
      () => true,
      async () => ({ action: 'accept', content: { decision: 'Apply' } })
    );
    await expect(malformed.confirm(request, { timeoutMs: 1_000 })).rejects.toThrow('malformed');
  });

  it('renders cleanup as an explicit destructive action instead of creation', async () => {
    const runner = jest.fn(async (_requestLine: string) => JSON.stringify({ challengeId: request.challengeId, action: 'cancel' }));
    const cleanup = new WindowsNativeRepositoryCreationConfirmationProvider(runner);
    await cleanup.confirm({ ...request, operation: 'cleanup' }, { timeoutMs: 10_000 });
    const requestLine = String(runner.mock.calls[0][0]);
    expect(requestLine).toContain('SAP 验证对象删除确认');
    expect(requestLine).toContain('确认删除');
    expect(requestLine).not.toContain('"confirmButtonText":"确认创建"');
  });

  it('prefers MCP form for auto on Windows and keeps native fallback available', async () => {
    const common = {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn(),
      windowsRunner: jest.fn()
    };
    expect(createRepositoryCreationConfirmationProvider({ ...common, platform: 'win32', environment: {} }).mode)
      .toBe('mcp-form');
    const nativeFallback = createRepositoryCreationConfirmationProvider({
      ...common,
      supportsFormElicitation: () => false,
      platform: 'win32',
      environment: {}
    });
    expect(nativeFallback.mode).toBe('windows-native');
    expect(createRepositoryCreationConfirmationProvider({ ...common, platform: 'linux', environment: {} }).mode)
      .toBe('mcp-form');
    const app = createRepositoryCreationConfirmationProvider({
      ...common,
      platform: 'win32',
      environment: { SAP_MCP_CONFIRMATION_PROVIDER: 'mcp-app' }
    });
    await expect(app.confirm(request, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'CONFIRMATION_UNSUPPORTED' });
  });
});
