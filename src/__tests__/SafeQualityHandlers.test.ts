import { SafeQualityHandlers } from '../handlers/SafeQualityHandlers';

describe('SafeQualityHandlers', () => {
  it('exposes exactly three bounded quality tools', () => {
    const handlers = new SafeQualityHandlers({ preview: jest.fn(), status: jest.fn() } as never, {
      supportsFormElicitation: () => true, elicitInput: jest.fn(), runConfirmed: jest.fn()
    });
    expect(handlers.getTools()).toEqual([
      expect.objectContaining({ name: 'previewQualityCheck', annotations: expect.objectContaining({ readOnlyHint: true }) }),
      expect.objectContaining({ name: 'runQualityCheck', annotations: expect.objectContaining({ readOnlyHint: false }), _meta: expect.objectContaining({ approvalRequired: true }) }),
      expect.objectContaining({ name: 'getQualityCheckStatus', annotations: expect.objectContaining({ readOnlyHint: true }) })
    ]);
  });

  it('dispatches preview and status without invoking execution', async () => {
    const workflow = {
      preview: jest.fn().mockResolvedValue({ status: 'preview', confirmationRequired: true, plan: { qualityPlanId: 'quality-1' } }),
      status: jest.fn().mockReturnValue({ qualityPlanId: 'quality-1', status: 'PREVIEWED' })
    };
    const runConfirmed = jest.fn();
    const handlers = new SafeQualityHandlers(workflow as never, {
      supportsFormElicitation: () => true, elicitInput: jest.fn(), runConfirmed
    });

    await handlers.handle('previewQualityCheck', { kind: 'ABAP_UNIT', objects: [] });
    await handlers.handle('getQualityCheckStatus', { qualityPlanId: 'quality-1' });

    expect(workflow.preview).toHaveBeenCalledTimes(1);
    expect(workflow.status).toHaveBeenCalledWith('quality-1');
    expect(runConfirmed).not.toHaveBeenCalled();
  });
});
