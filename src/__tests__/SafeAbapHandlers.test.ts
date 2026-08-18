import { SafeAbapHandlers, selectProfileTools } from '../handlers/SafeAbapHandlers';
import { READ_ONLY_LEGACY_TOOL_COUNT } from '../config/ToolProfiles';

describe('SafeAbapHandlers', () => {
  it('exposes only the seven approved high-level tools', () => {
    const handlers = new SafeAbapHandlers({} as never);
    const inspectTool = handlers.getTools().find(tool => tool.name === 'inspectAbapObject');
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
    expect(inspectTool).toMatchObject({
      inputSchema: {
        required: ['objectType', 'objectName'],
        properties: {
          startLine: { type: 'number', minimum: 1, maximum: 10_000_000, optional: true },
          maxLines: { type: 'number', minimum: 1, maximum: 1_000, optional: true }
        }
      }
    });
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

  it('dispatches optional inspect paging without changing the default object contract', async () => {
    const workflow = { inspect: jest.fn().mockResolvedValue({ status: 'success' }) };
    const handlers = new SafeAbapHandlers(workflow as never);

    await handlers.handle('inspectAbapObject', {
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      startLine: 301,
      maxLines: 300
    });
    await handlers.handle('inspectAbapObject', { objectType: 'PROGRAM', objectName: 'ZTEST' });

    expect(workflow.inspect).toHaveBeenNthCalledWith(1, 'PROGRAM', 'ZTEST', { startLine: 301, maxLines: 300 });
    expect(workflow.inspect).toHaveBeenNthCalledWith(2, 'PROGRAM', 'ZTEST', {
      startLine: undefined,
      maxLines: undefined
    });
  });

  it('does not silently drop malformed inspect paging on direct dispatch', async () => {
    const workflow = { inspect: jest.fn().mockRejectedValue(new Error('startLine must be a positive integer')) };
    const handlers = new SafeAbapHandlers(workflow as never);

    await expect(handlers.handle('inspectAbapObject', {
      objectType: 'PROGRAM', objectName: 'ZTEST', startLine: '301'
    })).rejects.toThrow('startLine');
    expect(workflow.inspect).toHaveBeenCalledWith('PROGRAM', 'ZTEST', {
      startLine: '301',
      maxLines: undefined
    });
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

  it('returns a directly renderable complete diff and machine-readable preview data', async () => {
    const preview = {
      status: 'preview',
      plan: {
        changePlanId: 'plan-1',
        object: { objectType: 'PROGRAM', objectName: 'ZTEST' },
        transportRequest: 'DEVK900001',
        diffSummary: { addedLines: 1, removedLines: 1 }
      },
      diff: '@@ -1,2 +1,2 @@\n REPORT ztest.\n-WRITE / old.\n+WRITE / new.',
      confirmationRequired: true
    };
    const workflow = {
      preview: jest.fn().mockResolvedValue(preview)
    };
    const handlers = new SafeAbapHandlers(workflow as never);

    await expect(handlers.handle('previewAbapChange', {
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / new.',
      transportRequest: 'DEVK900001'
    })).resolves.toEqual({
      content: [{
        type: 'text',
        text: expect.stringContaining('```diff\n@@ -1,2 +1,2 @@\n REPORT ztest.\n-WRITE / old.\n+WRITE / new.\n```')
      }],
      structuredContent: preview
    });

    const result = await handlers.handle('previewAbapChange', {
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / new.',
      transportRequest: 'DEVK900001'
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('下一步直接调用 `applyAbapChange`');
    expect(content[0].text).toContain('无需先在聊天中要求文字确认');
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

  it('keeps development and diagnostic profiles limited to approved read-only tools', () => {
    const safeTools = new SafeAbapHandlers({} as never).getTools();
    const legacyTools = [
      { name: 'dumps', description: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'setObjectSource', description: 'write', inputSchema: { type: 'object', properties: {} } }
    ];
    const safeDebugTools = [{ name: 'applyDebugOperation', description: 'safe debug', inputSchema: { type: 'object', properties: {} } }];
    expect(selectProfileTools('development', [], legacyTools, [], safeDebugTools).map(tool => tool.name))
      .toEqual(['applyDebugOperation', 'dumps']);
    expect(selectProfileTools('diagnostic-readonly', safeTools, legacyTools).map(tool => tool.name))
      .toEqual(['inspectAbapObject', 'dumps']);
    expect(selectProfileTools('safe', safeTools, legacyTools, [], safeDebugTools).map(tool => tool.name))
      .not.toContain('applyDebugOperation');
    expect(selectProfileTools('legacy-full', safeTools, legacyTools, [], safeDebugTools).map(tool => tool.name))
      .not.toContain('applyDebugOperation');
  });

  it('locks the documented development and diagnostic-readonly tool counts', () => {
    expect(READ_ONLY_LEGACY_TOOL_COUNT).toBe(91);
    const safeTools = Array.from({ length: 7 }, (_, index) => ({
      name: index === 0 ? 'inspectAbapObject' : `safe-${index}`,
      description: 'safe',
      inputSchema: { type: 'object', properties: {} }
    }));
    const safeDebugTools = Array.from({ length: 8 }, (_, index) => ({
      name: `debug-${index}`,
      description: 'debug',
      inputSchema: { type: 'object', properties: {} }
    }));
    const runtimeTools = Array.from({ length: 2 }, (_, index) => ({
      name: `runtime-${index}`,
      description: 'runtime',
      inputSchema: { type: 'object', properties: {} }
    }));
    const readOnlyNames = [
      'transportInfo', 'hasTransportConfig', 'transportConfigurations', 'getTransportConfiguration',
      'userTransports', 'transportsByConfig', 'systemUsers', 'transportReference', 'objectStructure',
      'searchObject', 'findObjectPath', 'objectTypes', 'classIncludes', 'classComponents', 'syntaxCheckCode',
      'syntaxCheckCdsUrl', 'codeCompletion', 'findDefinition', 'usageReferences', 'syntaxCheckTypes',
      'codeCompletionFull', 'codeCompletionElement', 'usageReferenceSnippets', 'fixProposals', 'fragmentMappings',
      'abapDocumentation', 'inactiveObjects', 'objectRegistrationInfo', 'validateNewObject', 'nodeContents',
      'mainPrograms', 'featureDetails', 'collectionFeatureDetails', 'findCollectionByUrl', 'loadTypes',
      'adtDiscovery', 'adtCoreDiscovery', 'adtCompatibiliyGraph', 'unitTestEvaluation',
      'unitTestOccurrenceMarkers', 'prettyPrinterSetting', 'prettyPrinter', 'gitRepos', 'gitExternalRepoInfo',
      'checkRepo', 'remoteRepoInfo', 'ddicElement', 'ddicRepositoryAccess', 'annotationDefinitions',
      'packageSearchHelp', 'bindingDetails', 'tableContents', 'runQuery', 'feeds', 'dumps', 'debuggerListeners',
      'debuggerStackTrace', 'debuggerVariables', 'debuggerChildVariables', 'atcCustomizing', 'atcCheckVariant',
      'atcWorklists', 'atcUsers', 'isProposalMessage', 'atcContactUri', 'tracesList', 'tracesListRequests',
      'tracesHitList', 'tracesDbAccess', 'tracesStatements', 'renameEvaluate', 'renamePreview',
      'extractMethodEvaluate', 'extractMethodPreview', 'revisions', 'healthcheck'
      , 'objectStructureElements', 'typeHierarchy', 'objectEnhancements', 'getDomainProperties',
      'getDataElementProperties', 'getTextElements', 'atcDocumentation', 'changePackagePreview',
      'rapGenValidateInitial', 'rapGenGetSchema', 'rapGenGetContent', 'rapGenGetUiConfig',
      'rapGenValidateContent', 'rapGenPreview', 'rapGenIsAvailable'
    ];
    const legacyTools = readOnlyNames.map(name => ({
      name,
      description: 'read-only',
      inputSchema: { type: 'object', properties: {} }
    }));

    expect(selectProfileTools('development', safeTools, legacyTools, runtimeTools, safeDebugTools)).toHaveLength(108);
    expect(selectProfileTools('diagnostic-readonly', safeTools, legacyTools, runtimeTools, safeDebugTools)).toHaveLength(94);
  });
});
