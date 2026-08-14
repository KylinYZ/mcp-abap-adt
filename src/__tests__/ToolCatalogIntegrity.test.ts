import { AbapAdtServer } from '../index';
import {
  CONTROLLED_ADVANCED_MUTATION_TOOL_NAMES,
  RAW_ADVANCED_MUTATION_TOOL_NAMES,
  toolOperationClass
} from '../config/ToolOperationPolicy';

const originalEnvironment = { ...process.env };

function configureServer(role: string, profile: string): AbapAdtServer {
  Object.assign(process.env, {
    SAP_URL: 'https://dev.example.test',
    SAP_USER: 'TEST_USER',
    SAP_PASSWORD: 'not-used',
    SAP_CLIENT: '100',
    SAP_LANGUAGE: 'EN',
    SAP_MCP_SYSTEM_ROLE: role,
    SAP_MCP_TOOL_PROFILE: profile,
    SAP_MCP_ALLOWED_HOSTS: 'dev.example.test',
    SAP_MCP_ALLOWED_CLIENTS: '100',
    SAP_MCP_ALLOWED_NAMESPACES: 'Z,Y'
  });
  return new AbapAdtServer();
}

describe('tool catalog integrity and raw advanced role policy', () => {
  afterAll(() => {
    process.env = originalEnvironment;
  });

  it.each([
    ['safe', 7],
    ['development', 114],
    ['diagnostic-readonly', 94],
    ['legacy-full', 157]
  ])('locks the DEV %s catalog at %i unique tools', (profile, expected) => {
    const server = configureServer('DEV', profile);
    const catalog = (server as any).toolCatalog as Array<{ name: string }>;
    expect(catalog).toHaveLength(expected);
    expect(new Set(catalog.map(tool => tool.name))).toHaveProperty('size', expected);
  });

  it.each(['QAS', 'PRD', '', 'UNKNOWN'])('hides and rejects raw advanced writes for role %p', async role => {
    const server = configureServer(role, 'legacy-full');
    const catalog = (server as any).toolCatalog as Array<{ name: string }>;
    const client = (server as any).adtClient;
    client.setDomainProperties = jest.fn();

    expect(catalog.map(tool => tool.name)).toEqual(expect.not.arrayContaining([...RAW_ADVANCED_MUTATION_TOOL_NAMES]));
    await expect((server as any).dispatchTool('setDomainProperties', {
      domainUrl: '/domain', properties: {}, metaData: {}, lockHandle: 'lock'
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(client.setDomainProperties).not.toHaveBeenCalled();
  });

  it.each(['QAS', 'PRD', '', 'UNKNOWN'])('limits every profile to local/read-only tools for role %p', role => {
    for (const profile of ['safe', 'development', 'diagnostic-readonly', 'legacy-full']) {
      const server = configureServer(role, profile);
      const catalog = (server as any).toolCatalog as Array<{ name: string }>;
      expect(catalog.every(tool => ['local', 'read-only'].includes(String(toolOperationClass(tool.name))))).toBe(true);
      expect(catalog.map(tool => tool.name)).toEqual(expect.not.arrayContaining([
        ...RAW_ADVANCED_MUTATION_TOOL_NAMES,
        ...CONTROLLED_ADVANCED_MUTATION_TOOL_NAMES
      ]));
    }
  });

  it.each(['QAS', 'PRD', '', 'UNKNOWN'])('rejects hidden controlled apply before confirmation for role %p', async role => {
    const server = configureServer(role, 'development');
    const advancedHandlers = (server as any).safeAdvancedHandlers;
    const handle = jest.spyOn(advancedHandlers, 'handle');

    await expect((server as any).dispatchTool('applyRapOperation', { operationPlanId: 'forged-plan' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects controlled advanced operations in DEV diagnostic-readonly', async () => {
    const server = configureServer('DEV', 'diagnostic-readonly');
    const advancedHandlers = (server as any).safeAdvancedHandlers;
    const handle = jest.spyOn(advancedHandlers, 'handle');

    await expect((server as any).dispatchTool('applyDdicPropertyChange', { operationPlanId: 'forged-plan' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(handle).not.toHaveBeenCalled();
  });
});
