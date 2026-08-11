import { SafeAbapHandlers, selectProfileTools } from '../handlers/SafeAbapHandlers';

describe('SafeAbapHandlers', () => {
  it('exposes only the four approved high-level tools', () => {
    const handlers = new SafeAbapHandlers({} as never);
    const applyTool = handlers.getTools().find(tool => tool.name === 'applyAbapChange');

    expect(handlers.getTools().map(tool => tool.name)).toEqual([
      'inspectAbapObject',
      'previewAbapChange',
      'applyAbapChange',
      'getAbapChangeStatus'
    ]);
    expect(applyTool).toMatchObject({
      inputSchema: {
        required: ['changePlanId'],
        properties: {
          changePlanId: expect.any(Object),
          textConfirmation: expect.any(Object)
        }
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      _meta: { operationClass: 'mutating tenant', approvalRequired: true }
    });
    expect(applyTool?.inputSchema.properties).not.toHaveProperty('confirmedByUser');
  });

  it('keeps legacy tools hidden unless legacy-full is selected', () => {
    const handlers = new SafeAbapHandlers({} as never);
    const safeTools = handlers.getTools();
    const legacyTools = [{
      name: 'deleteObject',
      description: 'legacy',
      inputSchema: { type: 'object', properties: {} }
    }];

    expect(selectProfileTools('safe', safeTools, legacyTools)).toEqual(safeTools);
    expect(selectProfileTools('legacy-full', safeTools, legacyTools).map(tool => tool.name))
      .toEqual([...safeTools.map(tool => tool.name), 'deleteObject']);
  });
});
