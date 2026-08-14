import { SafeAdvancedHandlers } from '../handlers/SafeAdvancedHandlers';
import type { AdvancedOperationKind, AdvancedOperationPlanView, AdvancedOperationPreviewResult } from '../safe/advancedTypes';

describe('SafeAdvancedHandlers', () => {
  function plan(operationKind: AdvancedOperationKind = 'SET_DOMAIN_PROPERTIES'): AdvancedOperationPlanView {
    return {
      operationPlanId: 'plan-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      expiresAt: '2099-08-14T00:15:00.000Z',
      status: 'PREVIEWED',
      systemHost: 'dev.example.com', client: '100', systemRole: 'DEV', toolProfile: 'development',
      operationKind,
      target: { objectType: 'DOMAIN', objectName: 'ZDOMAIN' },
      transport: 'DEVK900001',
      inputSummary: { title: 'Change ZDOMAIN', changedFields: ['length'], warning: 'Writes SAP' },
      currentStateSummary: { stateHash: 'state', description: 'One field differs' },
      payloadFingerprint: { inputHash: 'input', inputBytes: 100, driftHash: 'drift', driftBytes: 10 },
      rollbackSupported: operationKind === 'SET_DOMAIN_PROPERTIES',
      stages: []
    };
  }

  function preview(operationKind?: AdvancedOperationKind): AdvancedOperationPreviewResult {
    return { status: 'preview', plan: plan(operationKind), confirmationRequired: true };
  }

  it('exposes exactly six bounded tools and apply accepts only a server plan ID', () => {
    const handlers = new SafeAdvancedHandlers({} as never, {
      supportsFormElicitation: () => false,
      elicitInput: jest.fn(),
      applyConfirmed: jest.fn()
    });
    const tools = handlers.getTools();

    expect(tools.map(tool => tool.name)).toEqual([
      'previewDdicPropertyChange', 'applyDdicPropertyChange',
      'previewPackageChange', 'applyPackageChange',
      'previewRapOperation', 'applyRapOperation'
    ]);
    for (const tool of tools) expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const tool of tools.filter(candidate => candidate.name.startsWith('apply'))) {
      expect(tool.inputSchema).toMatchObject({
        properties: { operationPlanId: expect.any(Object) },
        required: ['operationPlanId']
      });
      expect(Object.keys(tool.inputSchema.properties)).toEqual(['operationPlanId']);
      expect(tool.inputSchema.properties).not.toHaveProperty('textConfirmation');
      expect(tool).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        _meta: { operationClass: 'mutating tenant', approvalRequired: true }
      });
    }
    for (const tool of tools.filter(candidate => candidate.name.startsWith('preview'))) {
      expect(tool).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { operationClass: 'read-only tenant', approvalRequired: false }
      });
    }
  });

  it('routes three previews and only returns the bounded public plan view', async () => {
    const leaked = { ...preview(), privatePayload: 'FULL-RAP-CONTENT' } as AdvancedOperationPreviewResult;
    const workflow = {
      previewDdicPropertyChange: jest.fn().mockResolvedValue(leaked),
      previewPackageChange: jest.fn().mockResolvedValue(preview('CHANGE_PACKAGE')),
      previewRapOperation: jest.fn().mockResolvedValue(preview('RAP_GENERATE')),
      status: jest.fn()
    };
    const handlers = new SafeAdvancedHandlers(workflow, {
      supportsFormElicitation: () => false,
      elicitInput: jest.fn(),
      applyConfirmed: jest.fn()
    });

    const ddic = await handlers.handle('previewDdicPropertyChange', { operation: { kind: 'SET_DOMAIN_PROPERTIES' } });
    await handlers.handle('previewPackageChange', { objectName: 'ZCL_DEMO' });
    await handlers.handle('previewRapOperation', { operation: { kind: 'RAP_GENERATE' } });

    expect(workflow.previewDdicPropertyChange).toHaveBeenCalledTimes(1);
    expect(workflow.previewPackageChange).toHaveBeenCalledTimes(1);
    expect(workflow.previewRapOperation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ddic)).not.toContain('FULL-RAP-CONTENT');
    expect(ddic).toMatchObject({ content: [{ type: 'text' }], structuredContent: { status: 'preview', confirmationRequired: true } });
  });

  it('does not call the apply workflow until native confirmation is accepted', async () => {
    let accept!: (value: unknown) => void;
    const elicitation = new Promise(resolve => { accept = resolve; });
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const workflow = {
      previewDdicPropertyChange: jest.fn(), previewPackageChange: jest.fn(), previewRapOperation: jest.fn(),
      status: jest.fn().mockReturnValue(plan())
    };
    const handlers = new SafeAdvancedHandlers(workflow, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockReturnValue(elicitation),
      applyConfirmed
    });

    const pending = handlers.handle('applyDdicPropertyChange', { operationPlanId: 'plan-1' });
    await Promise.resolve();
    expect(applyConfirmed).not.toHaveBeenCalled();
    accept({ action: 'accept', content: { decision: 'apply' } });
    await expect(pending).resolves.toEqual({ status: 'success' });
    expect(applyConfirmed).toHaveBeenCalledWith('plan-1');
  });

  it.each([
    ['applyDdicPropertyChange', 'SET_DOMAIN_PROPERTIES'],
    ['applyPackageChange', 'CHANGE_PACKAGE'],
    ['applyRapOperation', 'RAP_PUBLISH_SERVICE']
  ] as const)('maps %s to the matching operation family', async (toolName, operationKind) => {
    const applyConfirmed = jest.fn().mockResolvedValue({ status: 'success' });
    const workflow = {
      previewDdicPropertyChange: jest.fn(), previewPackageChange: jest.fn(), previewRapOperation: jest.fn(),
      status: jest.fn().mockReturnValue(plan(operationKind))
    };
    const handlers = new SafeAdvancedHandlers(workflow, {
      supportsFormElicitation: () => true,
      elicitInput: jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'apply' } }),
      applyConfirmed
    });
    await handlers.handle(toolName, { operationPlanId: 'plan-1' });
    expect(applyConfirmed).toHaveBeenCalledWith('plan-1');
  });
});
