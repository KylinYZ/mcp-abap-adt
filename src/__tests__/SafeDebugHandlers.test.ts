import { SafeDebugHandlers } from '../handlers/SafeDebugHandlers';

describe('SafeDebugHandlers', () => {
  it('exposes exactly eight high-level safe debug tools', () => {
    const handlers = new SafeDebugHandlers({} as never);
    expect(handlers.getTools().map(tool => tool.name)).toEqual([
      'previewDebugOperation',
      'applyDebugOperation',
      'getDebugOperationStatus',
      'authorizeDebugSession',
      'executeDebugCommand',
      'previewDebugVariableChange',
      'applyDebugVariableChange',
      'revokeDebugSession'
    ]);
    expect(handlers.getTools().find(tool => tool.name === 'applyDebugOperation')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
      _meta: { operationClass: 'mutating tenant', approvalRequired: true }
    });
    expect(handlers.getTools().find(tool => tool.name === 'applyDebugOperation')?.inputSchema.properties)
      .not.toHaveProperty('textConfirmation');
  });

  it('renders variable previews without exposing raw values', async () => {
    const preview = {
      status: 'preview',
      plan: {
        debugOperationPlanId: 'plan-1',
        targetUser: 'DEVUSER',
        summary: 'Modify LV_SECRET',
        risk: 'Changes runtime state',
        operation: {
          kind: 'SET_VARIABLE',
          oldValueHash: 'old-hash',
          newValueHash: 'new-hash',
          oldValueSummary: '<redacted:10 bytes>',
          newValueSummary: '<redacted:10 bytes>'
        }
      }
    };
    const workflow = { previewVariableChange: jest.fn().mockResolvedValue(preview) };
    const handlers = new SafeDebugHandlers(workflow as never);
    const result = await handlers.handle('previewDebugVariableChange', {
      authorizationId: 'auth-1',
      targetUser: 'DEVUSER',
      variableName: 'LV_SECRET',
      newValue: 'new-secret'
    });
    expect(JSON.stringify(result)).not.toContain('new-secret');
    expect(result).toMatchObject({ structuredContent: preview });
  });
});
