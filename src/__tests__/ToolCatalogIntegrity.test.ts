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
    ['development', 124],
    ['diagnostic-readonly', 99],
    ['legacy-full', 161],
    ['development-workbench', 87],
    ['business-readonly', 17],
    ['operations-readonly', 40]
  ])('locks the DEV %s catalog at %i unique tools', (profile, expected) => {
    const server = configureServer('DEV', profile);
    const catalog = (server as any).toolCatalog as Array<{ name: string }>;
    expect(catalog).toHaveLength(expected);
    expect(new Set(catalog.map(tool => tool.name))).toHaveProperty('size', expected);
  });

  it.each([
    'safe', 'development', 'diagnostic-readonly', 'legacy-full',
    'development-workbench', 'business-readonly', 'operations-readonly'
  ])('publishes complete runtime safety metadata for DEV %s', profile => {
    const catalog = (configureServer('DEV', profile) as any).toolCatalog as Array<Record<string, any>>;
    for (const tool of catalog) {
      expect(tool.annotations).toEqual(expect.objectContaining({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean)
      }));
      expect(tool._meta).toEqual(expect.objectContaining({
        operationClass: expect.stringMatching(/^(local-only|read-only tenant|mutating tenant)$/),
        approvalRequired: expect.any(Boolean)
      }));
      expect(tool.annotations.readOnlyHint).toBe(tool._meta.operationClass !== 'mutating tenant');
      if (tool._meta.operationClass === 'local-only') expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it('exposes high-level reads in compatible non-safe profiles only', () => {
    const expected = ['readRuntimeDumps', 'describeClassicTable', 'inspectSapSystem', 'getAbapMemberSource'];
    expect((configureServer('DEV', 'safe') as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .toEqual(expect.not.arrayContaining(expected));
    for (const profile of ['development', 'diagnostic-readonly', 'legacy-full']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(expected));
    }
    expect((configureServer('DEV', 'development-workbench') as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .toEqual(expect.arrayContaining(expected));
    expect((configureServer('DEV', 'business-readonly') as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .toEqual(expect.arrayContaining(['inspectSapSystem', 'describeClassicTable']));
    expect((configureServer('DEV', 'operations-readonly') as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .toEqual(expect.arrayContaining(['inspectSapSystem', 'readRuntimeDumps']));
  });

  it('exposes direct URL source reads only in development and diagnostic profiles', () => {
    for (const profile of ['development', 'diagnostic-readonly', 'legacy-full', 'development-workbench']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).toContain('getObjectSource');
    }
    for (const profile of ['safe', 'business-readonly', 'operations-readonly']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).not.toContain('getObjectSource');
    }
  });

  it('exposes repository creation capabilities only in DEV development profiles', () => {
    const expected = [
      'listRepositoryObjectCreationCapabilities', 'describeRepositoryObjectCreation',
      'previewRepositoryObjectCreation', 'applyRepositoryObjectCreation', 'getRepositoryObjectCreationStatus'
    ];
    for (const profile of ['development', 'development-workbench']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(expected));
    }
    for (const profile of ['safe', 'diagnostic-readonly', 'legacy-full', 'business-readonly', 'operations-readonly']) {
      const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.not.arrayContaining(expected));
    }
  });

  it.each(['QAS', 'PRD', '', 'UNKNOWN'])('hides and rejects repository creation capabilities for role %p', async role => {
    const server = configureServer(role, 'development');
    const handlers = (server as any).repositoryObjectCreationHandlers;
    const handle = jest.spyOn(handlers, 'handle');

    expect((server as any).toolCatalog.map((tool: { name: string }) => tool.name))
      .not.toContain('listRepositoryObjectCreationCapabilities');
    await expect((server as any).dispatchTool('listRepositoryObjectCreationCapabilities', {}))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('exposes validation cleanup only while the bounded validation switch is complete', () => {
    Object.assign(process.env, {
      SAP_MCP_REAL_DEV_VALIDATION: 'true',
      SAP_MCP_REAL_DEV_VALIDATION_OBJECTS: 'PROGRAM',
      SAP_MCP_REAL_DEV_VALIDATION_PREFIX: 'ZV',
      SAP_MCP_REAL_DEV_VALIDATION_PACKAGE: 'Z001',
      SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT: 'S4HK900009'
    });
    try {
      for (const profile of ['development', 'development-workbench']) {
        const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
        expect(names).toEqual(expect.arrayContaining([
          'previewRepositoryObjectCleanup', 'applyRepositoryObjectCleanup', 'getRepositoryObjectCleanupStatus'
        ]));
      }
      for (const profile of ['safe', 'diagnostic-readonly', 'legacy-full', 'business-readonly', 'operations-readonly']) {
        const names = (configureServer('DEV', profile) as any).toolCatalog.map((tool: { name: string }) => tool.name);
        expect(names).not.toContain('previewRepositoryObjectCleanup');
      }
    } finally {
      delete process.env.SAP_MCP_REAL_DEV_VALIDATION;
      delete process.env.SAP_MCP_REAL_DEV_VALIDATION_OBJECTS;
      delete process.env.SAP_MCP_REAL_DEV_VALIDATION_PREFIX;
      delete process.env.SAP_MCP_REAL_DEV_VALIDATION_PACKAGE;
      delete process.env.SAP_MCP_REAL_DEV_VALIDATION_TRANSPORT;
    }
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
    for (const profile of [
      'safe', 'development', 'diagnostic-readonly', 'legacy-full',
      'development-workbench', 'business-readonly', 'operations-readonly'
    ]) {
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

  it('rejects direct calls to read tools hidden by a task-focused profile', async () => {
    const server = configureServer('DEV', 'business-readonly');
    const client = (server as any).adtClient;
    client.dumps = jest.fn();

    await expect((server as any).dispatchTool('readRuntimeDumps', {
      from: '2026-08-17T00:00:00+08:00', to: '2026-08-17T01:00:00+08:00'
    })).rejects.toMatchObject({ code: -32601 });
    expect(client.dumps).not.toHaveBeenCalled();
  });
});
