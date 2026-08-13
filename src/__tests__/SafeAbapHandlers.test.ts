import { SafeAbapHandlers, selectProfileTools } from '../handlers/SafeAbapHandlers';

describe('SafeAbapHandlers', () => {
  it('exposes only the seven approved high-level tools', () => {
    const handlers = new SafeAbapHandlers({} as never);
    const applyTool = handlers.getTools().find(tool => tool.name === 'applyAbapChange');
    const previewCreationTool = handlers.getTools().find(tool => tool.name === 'previewAbapObjectCreation');
    const applyCreationTool = handlers.getTools().find(tool => tool.name === 'applyAbapObjectCreation');

    expect(handlers.getTools().map(tool => tool.name)).toEqual([
      'inspectAbapObject',
      'previewAbapChange',
      'applyAbapChange',
      'getAbapChangeStatus',
      'previewAbapObjectCreation',
      'applyAbapObjectCreation',
      'getAbapObjectCreationStatus'
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
    expect(previewCreationTool).toMatchObject({
      inputSchema: {
        required: ['objects', 'transportRequest'],
        properties: {
          objects: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: {
              type: 'object',
              required: ['objectType', 'objectName', 'description'],
              properties: expect.objectContaining({
                objectType: expect.any(Object),
                objectName: expect.any(Object),
                source: expect.any(Object)
              })
            },
            description: expect.any(String)
          },
          transportRequest: expect.any(Object)
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { operationClass: 'read-only tenant', approvalRequired: false }
    });
    expect(applyCreationTool).toMatchObject({
      inputSchema: {
        required: ['creationPlanId'],
        properties: {
          creationPlanId: expect.any(Object),
          textConfirmation: expect.any(Object)
        }
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      _meta: { operationClass: 'mutating tenant', approvalRequired: true }
    });
    expect(applyCreationTool?.inputSchema.properties).not.toHaveProperty('confirmedByUser');
  });

  it('dispatches creation preview, confirmation, and status to the creation workflow', async () => {
    const changeWorkflow = {} as never;
    const creationPlan = {
      creationPlanId: 'creation-1',
      createdAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2099-08-13T00:15:00.000Z',
      status: 'PREVIEWED',
      systemHost: 'dev.example.com',
      client: '100',
      transportRequest: 'DEVK900001',
      objects: [{
        objectType: 'PROGRAM',
        objectName: 'ZTEST_CREATE',
        description: 'test',
        packageName: 'ZTEST',
        objectUrl: '/sap/bc/adt/programs/programs/ztest_create',
        sourceHash: 'source-hash'
      }],
      stages: [],
      createdObjects: []
    };
    const creationWorkflow = {
      preview: jest.fn().mockResolvedValue({ status: 'preview' }),
      apply: jest.fn().mockResolvedValue({ status: 'success' }),
      status: jest.fn().mockReturnValue(creationPlan)
    };
    const handlers = new SafeAbapHandlers(
      changeWorkflow,
      undefined,
      creationWorkflow as never,
      {
        allowTextConfirmation: true,
        supportsFormElicitation: () => false,
        elicitInput: async () => { throw new Error('unavailable'); },
        createTextCode: () => '123456'
      }
    );
    const objects = [{
      objectType: 'PROGRAM',
      objectName: 'ZTEST_CREATE',
      description: 'test',
      packageName: 'ZTEST',
      source: 'REPORT ztest_create.'
    }];

    await expect(handlers.handle('previewAbapObjectCreation', {
      objects,
      transportRequest: 'DEVK900001'
    })).resolves.toEqual({ status: 'preview' });
    expect(creationWorkflow.preview).toHaveBeenCalledWith({ objects, transportRequest: 'DEVK900001' });

    await expect(handlers.handle('applyAbapObjectCreation', { creationPlanId: 'creation-1' }))
      .resolves.toMatchObject({
        status: 'confirmation_required',
        confirmationText: '确认创建 creation-1 验证码 123456'
      });
    expect(creationWorkflow.apply).not.toHaveBeenCalled();

    await expect(handlers.handle('getAbapObjectCreationStatus', { creationPlanId: 'creation-1' }))
      .resolves.toMatchObject({ status: 'success', plan: { creationPlanId: 'creation-1' } });
    expect(creationWorkflow.status).toHaveBeenCalledWith('creation-1');
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
