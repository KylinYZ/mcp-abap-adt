import { AbapAdtServer } from '../index';
import {
  BUSINESS_READONLY_TOOL_NAMES,
  DEVELOPMENT_WORKBENCH_TOOL_NAMES,
  OPERATIONS_READONLY_TOOL_NAMES
} from '../config/ToolProfiles';
import { toolOperationClass } from '../config/ToolOperationPolicy';

const originalEnvironment = { ...process.env };

function catalog(profile: string, role = 'DEV'): Array<Record<string, unknown> & { name: string }> {
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
  return (new AbapAdtServer() as any).toolCatalog;
}

function bytes(tools: Array<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
}

describe('task-focused tool catalog budgets', () => {
  afterAll(() => {
    process.env = originalEnvironment;
  });

  it.each([
    ['development-workbench', DEVELOPMENT_WORKBENCH_TOOL_NAMES],
    ['business-readonly', BUSINESS_READONLY_TOOL_NAMES],
    ['operations-readonly', OPERATIONS_READONLY_TOOL_NAMES]
  ] as const)('uses the exact explicit %s allow-list', (profile, expected) => {
    const names = catalog(profile).map(tool => tool.name);
    expect(names).toEqual([...expected]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every task-focused catalog smaller than the broad profile it replaces', () => {
    const developmentBytes = bytes(catalog('development'));
    const diagnosticBytes = bytes(catalog('diagnostic-readonly'));

    expect(bytes(catalog('development-workbench'))).toBeLessThan(developmentBytes);
    expect(bytes(catalog('business-readonly'))).toBeLessThan(diagnosticBytes);
    expect(bytes(catalog('operations-readonly'))).toBeLessThan(diagnosticBytes);
  });

  it.each(['QAS', 'PRD', '', 'UNKNOWN'])('keeps task-focused non-DEV catalogs local/read-only for role %p', role => {
    for (const profile of ['development-workbench', 'business-readonly', 'operations-readonly']) {
      expect(catalog(profile, role).every(tool => ['local', 'read-only'].includes(String(toolOperationClass(tool.name)))))
        .toBe(true);
    }
  });
});
