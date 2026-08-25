import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type ElicitRequestFormParams,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
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

async function close(server: AbapAdtServer, client: Client): Promise<void> {
  await Promise.allSettled([server.close(), client.close()]);
  process.env = { ...originalEnvironment };
}

describe('native elicitation request routing', () => {
  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('returns the nested form response to the original tools/call and applies once', async () => {
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
          () => Boolean((server as any).getClientCapabilities()?.elicitation?.form),
          (params, timeoutMs) => (server as any).elicitInput(params, { timeout: timeoutMs })
        ),
        challengeStore: new RepositoryCreationConfirmationChallengeStore(),
        sessionId: 'in-memory-session',
        applyConfirmed
      }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => {
      sent.push(message);
      return send(message, options);
    };
    const client = new Client(
      { name: 'elicitation-test-client', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async request => {
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
      expect(sent.some(item => 'method' in item && item.method === 'elicitation/create')).toBe(true);
    } finally {
      await close(server, client);
    }
  });

  it('does not apply when the client cancels the native form', async () => {
    const server = configureServer();
    const applyConfirmed = jest.fn();
    (server as any).repositoryObjectCreationHandlers = {
      supports: (toolName: string) => toolName === 'applyRepositoryObjectCreation',
      handle: async () => {
        const result = await (server as any).elicitInput(form(), { timeout: 5_000 });
        if (result.action === 'accept' && result.content?.decision === 'apply') applyConfirmed();
        return { content: [{ type: 'text', text: JSON.stringify({ action: result.action }) }] };
      }
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'elicitation-test-client', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: 'applyRepositoryObjectCreation', arguments: { creationPlanId: 'plan-1' } });
      expect(applyConfirmed).not.toHaveBeenCalled();
    } finally {
      await close(server, client);
    }
  });

  it('returns an error result for a malformed elicitation response without applying', async () => {
    const server = configureServer();
    const applyConfirmed = jest.fn();
    (server as any).repositoryObjectCreationHandlers = {
      supports: (toolName: string) => toolName === 'applyRepositoryObjectCreation',
      handle: async () => {
        const result = await (server as any).elicitInput(form(), { timeout: 5_000 });
        if (result.action === 'accept' && result.content?.decision === 'apply') applyConfirmed();
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success' }) }] };
      }
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'elicitation-test-client', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ decision: 'apply' } as never));
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
