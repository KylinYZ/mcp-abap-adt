/**
 * 原生确认流路由测试（0.9.0 v2 双栈形态）。
 *
 * 覆盖 MCP 两个协议 era 下的受控确认链：
 * - legacy（2025）：MRTR 确认经 v2 官方 legacyInputRequiredShim 自动转
 *   elicitation/create 服务器→客户端请求，客户端应答后 shim 驱动重入；
 * - modern（2026-07-28）：input_required 结果 + 客户端自动驱动重试。
 * 两种 era 下确认类代码路径完全一致（MRTR 引擎，src/lib/MrtrElicitation.ts）。
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ElicitRequestFormParams } from '../lib/McpErrorCompat.js';
import { AbapAdtServer } from '../index';
import { RepositoryObjectCreationHandlers } from '../handlers/RepositoryObjectCreationHandlers';
import { RepositoryCreationConfirmationChallengeStore } from '../safe/RepositoryCreationConfirmationChallengeStore';
import { McpFormRepositoryCreationConfirmationProvider } from '../safe/RepositoryCreationConfirmationProvider';
import { RepositoryObjectCreationRegistry } from '../safe/RepositoryObjectCreationRegistry';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';
import type { RepositoryCreationPlanView } from '../safe/repositoryCreationTypes';

const originalEnvironment = { ...process.env };

function configureServer(): AbapAdtServer {
  Object.assign(process.env, {
    SAP_URL: 'https://dev.example.test',
    SAP_USER: 'TEST_USER',
    SAP_PASSWORD: 'not-used',
    SAP_CLIENT: '300',
    SAP_LANGUAGE: 'EN',
    SAP_MCP_SYSTEM_ROLE: 'DEV',
    SAP_MCP_TOOL_PROFILE: 'development',
    SAP_MCP_CONFIRMATION_PROVIDER: 'mcp-form',
    SAP_MCP_ALLOWED_HOSTS: 'dev.example.test',
    SAP_MCP_ALLOWED_CLIENTS: '300',
    SAP_MCP_ALLOWED_NAMESPACES: 'Z,Y'
  });
  return new AbapAdtServer();
}

function makeClient(options?: { modern?: boolean }): Client {
  // modern era：versionNegotiation auto + 支持 2026-07-28（InMemoryTransport
  // 直连下由协议层按首条生命周期消息自识别 era）；默认为 legacy era。
  return new Client(
    { name: 'elicitation-test-client', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      ...(options?.modern
        ? { supportedProtocolVersions: ['2026-07-28', '2025-06-18'], versionNegotiation: { mode: 'auto' as const } }
        : {})
    }
  );
}

async function close(server: AbapAdtServer, client: Client): Promise<void> {
  await Promise.allSettled([server.close(), client.close()]);
  process.env = { ...originalEnvironment };
}

describe('native confirmation request routing (v2 dual-era MRTR)', () => {
  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('legacy era: returns the nested form response to the original tools/call and applies once', async () => {
    const server = configureServer();
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success', applied: true });
    const workflow = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: repositoryPlan }),
      status: jest.fn().mockReturnValue(repositoryPlan)
    };
    (server as any).repositoryObjectCreationHandlers = new RepositoryObjectCreationHandlers(
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { systemRole: 'DEV', toolProfile: 'development' },
      workflow,
      {
        provider: new McpFormRepositoryCreationConfirmationProvider(
          () => Boolean((server as any).currentClientCapabilities()?.elicitation?.form),
          (params: ElicitRequestFormParams, timeoutMs: number) => (server as any).elicitViaActiveRequest(params, timeoutMs)
        ),
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'in-memory-session',
        applyConfirmed
      }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    const send = serverTransport.send.bind(serverTransport);
    (serverTransport as any).send = async (message: JSONRPCMessage, options?: unknown) => {
      sent.push(message);
      return send(message, options as never);
    };
    const client = makeClient();
    client.setRequestHandler('elicitation/create', async request => {
      expect(request.params.mode).toBe('form');
      return { action: 'accept', content: { decision: 'apply' } };
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const preview = await client.callTool({
        name: 'previewRepositoryObjectCreation',
        arguments: {
          objectKind: 'DDIC_DOMAIN',
          name: 'ZZMCP_VT_DOM',
          description: 'Test domain',
          packageName: 'Z001',
          transportRequest: 'S4HK900009'
        }
      });
      expect(preview.structuredContent).toMatchObject({ status: 'preview' });
      const result = await client.callTool({
        name: 'applyRepositoryObjectCreation',
        arguments: { creationPlanId: 'plan-1' }
      });
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('"applied":true') })
      ]);
      expect(workflow.preview).toHaveBeenCalledTimes(1);
      expect(applyConfirmed).toHaveBeenCalledTimes(1);
      // shim 必须把确认转为标准 elicitation/create 服务器→客户端请求帧
      expect(sent.some(item => 'method' in item && item.method === 'elicitation/create')).toBe(true);
    } finally {
      await close(server, client);
    }
  });

  it('legacy era: does not apply when the client cancels the native form', async () => {
    const server = configureServer();
    const applyConfirmed = jest.fn();
    (server as any).repositoryObjectCreationHandlers = {
      supports: (toolName: string) => toolName === 'applyRepositoryObjectCreation',
      handle: async () => {
        const result = await (server as any).elicitViaActiveRequest(form(), 5_000);
        if (result.action === 'accept' && result.content?.decision === 'apply') applyConfirmed();
        return { content: [{ type: 'text', text: JSON.stringify({ action: result.action }) }] };
      }
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = makeClient();
    client.setRequestHandler('elicitation/create', async () => ({ action: 'cancel' }));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: 'applyRepositoryObjectCreation', arguments: { creationPlanId: 'plan-1' } });
      expect(applyConfirmed).not.toHaveBeenCalled();
    } finally {
      await close(server, client);
    }
  });

  it('legacy era: returns an error result for a malformed elicitation response without applying', async () => {
    const server = configureServer();
    const applyConfirmed = jest.fn();
    (server as any).repositoryObjectCreationHandlers = {
      supports: (toolName: string) => toolName === 'applyRepositoryObjectCreation',
      handle: async () => {
        const result = await (server as any).elicitViaActiveRequest(form(), 5_000);
        if (result.action === 'accept' && result.content?.decision === 'apply') applyConfirmed();
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success' }) }] };
      }
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = makeClient();
    // 畸形响应：缺少 action 判别字段，确认链必须按"未确认"处理
    client.setRequestHandler('elicitation/create', async () => ({ decision: 'apply' } as never));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'applyRepositoryObjectCreation', arguments: { creationPlanId: 'plan-1' } });
      expect(result).toMatchObject({ isError: true });
      expect(applyConfirmed).not.toHaveBeenCalled();
    } finally {
      await close(server, client);
    }
  });

  it('modern era (2026-07-28): confirmation completes via input_required auto-fulfilment', async () => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success', applied: true });
    const workflow = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', plan: repositoryPlan }),
      status: jest.fn().mockReturnValue(repositoryPlan)
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // modern era 必须经 serveStdio 的 era 决策层（discover 应答 + per-request
    // envelope 服务）；transport 选项挂 InMemoryTransport 等价生产 stdio 入口。
    // 与生产 main() 一致：实例在 factory 内构造（era 探测与正式连接各自 pin）。
    const handle = serveStdio(() => {
      const server = configureServer();
      (server as any).repositoryObjectCreationHandlers = new RepositoryObjectCreationHandlers(
        new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
        { systemRole: 'DEV', toolProfile: 'development' },
        workflow,
        {
          provider: new McpFormRepositoryCreationConfirmationProvider(
            () => Boolean((server as any).currentClientCapabilities()?.elicitation?.form),
            (params: ElicitRequestFormParams, timeoutMs: number) => (server as any).elicitViaActiveRequest(params, timeoutMs)
          ),
          challengeStore: new RepositoryCreationConfirmationChallengeStore(),
          sessionId: 'in-memory-session',
          applyConfirmed
        }
      );
      return server;
    }, { transport: serverTransport, onerror: () => undefined });
    const client = makeClient({ modern: true });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { decision: 'apply' } }));
    await client.connect(clientTransport);
    try {
      const preview = await client.callTool({
        name: 'previewRepositoryObjectCreation',
        arguments: {
          objectKind: 'DDIC_DOMAIN',
          name: 'ZZMCP_VT_DOM',
          description: 'Test domain',
          packageName: 'Z001',
          transportRequest: 'S4HK900009'
        }
      });
      expect(preview.structuredContent).toMatchObject({ status: 'preview' });
      // modern era：input_required 由 v2 client 自动驱动（确认 → 重试），
      // 单次 callTool 即完成确认与执行
      const result = await client.callTool({
        name: 'applyRepositoryObjectCreation',
        arguments: { creationPlanId: 'plan-1' }
      });
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('"applied":true') })
      ]);
      expect(applyConfirmed).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([handle.close(), client.close()]);
    }
  });
});

function form(): ElicitRequestFormParams {
  return {
    mode: 'form',
    message: 'Apply controlled repository creation?',
    requestedSchema: {
      type: 'object',
      properties: { decision: { type: 'string', enum: ['apply', 'cancel'] } },
      required: ['decision']
    }
  };
}

const repositoryPlan: RepositoryCreationPlanView = {
  creationPlanId: 'plan-1',
  createdAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2099-08-21T00:15:00.000Z',
  status: 'PREVIEWED',
  systemHost: 'dev.example.test',
  client: '300',
  sapUser: 'TEST_USER',
  systemRole: 'DEV',
  toolProfile: 'development',
  target: { objectKind: 'DDIC_DOMAIN', objectName: 'ZZMCP_VT_DOM', adtType: 'DOMA/DD', parentName: 'Z001' },
  transportRequest: 'S4HK900009',
  summary: 'Create DDIC domain ZZMCP_VT_DOM in package Z001.',
  payloadHash: 'cae28dc3b16437ac000000000000000000000000000000000000000000000000',
  payloadBytes: 100,
  stages: [],
  compensationLimits: []
};
