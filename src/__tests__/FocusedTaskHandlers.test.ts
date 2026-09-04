import { FocusedTaskHandlers } from '../handlers/FocusedTaskHandlers';

describe('FocusedTaskHandlers', () => {
  it('publishes the task entry points and returns local help without SAP access', async () => {
    const callTool = jest.fn();
    const handlers = new FocusedTaskHandlers(callTool, () => ({ status: 'healthy' }));
    expect(handlers.getTools().map(tool => tool.name)).toEqual(['sap', 'sapDoctor']);
    const result = await handlers.handle('sap', { action: 'help' });
    expect(callTool).not.toHaveBeenCalled();
    expect((result as any).structuredContent.result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'read' }),
      expect.objectContaining({ action: 'diagnose' })
    ]));
  });

  it.each([
    ['read', 'inspectAbapObject', { objectType: 'CLASS', objectName: 'ZCL_TEST' }],
    ['search', 'searchObject', { query: 'ZCL_*' }],
    ['table', 'describeClassicTable', { tableName: 'T000' }],
    ['edit', 'previewAbapChange', { objectType: 'PROGRAM', objectName: 'ZTEST', newSource: 'REPORT ztest.' }],
    ['create', 'previewAbapObjectCreation', { objects: [{ objectType: 'PROGRAM', objectName: 'ZTEST' }] }],
    ['debug', 'debuggerStackTrace', {}],
    ['transport', 'transportInfo', { objectUrl: '/sap/bc/adt/oo/classes/zcl_test' }]
  ])('delegates %s to %s', async (action, delegatedTool, params) => {
    const delegatedResult = delegatedTool === 'previewAbapChange'
      ? { structuredContent: { status: 'preview', plan: { changePlanId: 'plan-1' }, diff: 'diff' } }
      : { structuredContent: { status: 'success', result: { ok: true } } };
    const callTool = jest.fn().mockResolvedValue(delegatedResult);
    const handlers = new FocusedTaskHandlers(callTool, () => ({}));
    const result = await handlers.handle('sap', { action, params });
    expect(callTool).toHaveBeenCalledWith(delegatedTool, params);
    expect((result as any).structuredContent.result.delegatedTool).toBe(delegatedTool);
    if (delegatedTool === 'previewAbapChange') {
      expect((result as any).structuredContent.result.result.plan.changePlanId).toBe('plan-1');
    }
  });

  it('runs a bounded doctor check and reports the next step', async () => {
    const callTool = jest.fn().mockResolvedValue({ structuredContent: {
      result: {
        sapConnectionVerified: true,
        capabilities: {
          adtDiscovery: { status: 'CONFIRMED' },
          feeds: { status: 'CONFIRMED' },
          objectTypes: { status: 'CONFIRMED' }
        }
      }
    } });
    const handlers = new FocusedTaskHandlers(callTool, () => ({ status: 'healthy', configuredTarget: { host: 'dev', client: '100', toolProfile: 'focused', systemRole: 'DEV' } }));
    const result = await handlers.handle('sapDoctor');
    expect(callTool).toHaveBeenCalledWith('inspectSapSystem', {});
    expect((result as any).structuredContent.result.status).toBe('READY');
  });

  it('automatically routes diagnose by the supplied evidence shape', async () => {
    const callTool = jest.fn().mockResolvedValue({ structuredContent: { result: { ok: true } } });
    const handlers = new FocusedTaskHandlers(callTool, () => ({}));
    await handlers.handle('sap', { action: 'diagnose', params: { objectName: 'ZCL_TEST', objectType: 'CLASS' } });
    expect(callTool).toHaveBeenCalledWith('inspectAbapObject', { objectName: 'ZCL_TEST', objectType: 'CLASS' });
  });

  it('rejects unsupported actions', async () => {
    const handlers = new FocusedTaskHandlers(jest.fn(), () => ({}));
    await expect(handlers.handle('sap', { action: 'delete' })).rejects.toThrow('sap action must be one of');
  });
});
