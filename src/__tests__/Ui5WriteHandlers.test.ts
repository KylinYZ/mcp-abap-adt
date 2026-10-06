import { Ui5WriteHandlers } from '../handlers/Ui5WriteHandlers';
import { Ui5WriteWorkflow } from '../safe/Ui5WriteWorkflow';
import { SafetyPolicy } from '../safe/SafetyPolicy';
import type { Ui5WriteClient } from '../adt/Ui5FilestoreApi';

/**
 * 受控 UI5 filestore 写入工具处理器单测（离线）：
 *   1. 三工具目录：schema 必填项/枚举与注解（apply 是唯一确认型写）；
 *   2. 分派：preview → workflow.preview；apply 缺 planId 拒；status 本地读；
 *   3. 原生确认：表单取消/拒绝时 POLICY_DENIED；支持 autoApprove 注入。
 */

function policy(): SafetyPolicy {
  return new SafetyPolicy({
    sapUrl: 'https://dev.example.com:44300',
    sapClient: '100',
    systemRole: 'DEV',
    allowedHosts: 'dev.example.com',
    allowedClients: '100',
    allowedNamespaces: 'Z,Y',
    auditPath: 'C:\\audit',
    toolProfile: 'development-workbench'
  });
}

/** 最小 client mock（app 存在、文件内容可读；delete 有真实副作用），workflow 全链可用。 */
function clientMock(): Ui5WriteClient {
  let fileDeleted = false;
  const notFound = () => Object.assign(new Error('404'), { status: 404 });
  return {
    ui5CreateApp: jest.fn(),
    ui5UploadFile: jest.fn(),
    ui5DeleteFile: jest.fn(async () => { fileDeleted = true; }),
    ui5DeleteApp: jest.fn(),
    ui5GetApp: jest.fn().mockResolvedValue({ appName: 'ZAPP', files: [{ path: '/index.html', type: 'file' }], feedEntries: 1 }),
    ui5GetFileContent: jest.fn(async () => {
      if (fileDeleted) throw notFound();
      return { appName: 'ZAPP', filePath: 'index.html', content: 'x', size: 1 };
    })
  } as unknown as Ui5WriteClient;
}

function elicit(action: string, decision?: string) {
  return jest.fn().mockResolvedValue({ action, content: decision ? { decision } : undefined });
}

function buildHandlers(elicitFn: jest.Mock, autoApprove?: () => boolean) {
  const workflow = new Ui5WriteWorkflow({ client: clientMock(), policy: policy(), audit: { append: jest.fn() } });
  const handlers = new Ui5WriteHandlers(workflow, {
    supportsFormElicitation: () => true,
    elicitInput: elicitFn as never,
    ...(autoApprove ? { autoApprove } : {}),
    planSummary: planId => {
      const plan = workflow.status(planId);
      return { kind: plan.kind, appName: plan.appName, filePath: plan.filePath, fileCount: plan.oldState.fileCount, systemHost: plan.systemHost, client: plan.client };
    }
  });
  return { workflow, handlers };
}

describe('Ui5WriteHandlers tool catalog', () => {
  it('exposes the preview/apply/status triple with correct annotations', () => {
    const { handlers } = buildHandlers(elicit('accept', 'apply'));
    const tools = handlers.getTools();
    expect(tools.map(t => t.name)).toEqual(['previewUi5Operation', 'applyUi5Operation', 'getUi5OperationStatus']);
    const preview = tools[0] as any;
    expect(preview.inputSchema.properties.kind.enum).toEqual(['create_app', 'upload_file', 'delete_file', 'delete_app']);
    expect(preview.inputSchema.required).toEqual(['kind', 'appName']);
    expect((tools[1] as any)._meta.approvalRequired).toBe(true);
    expect((tools[0] as any)._meta.approvalRequired).toBe(false);
    expect(handlers.supports('previewUi5Operation')).toBe(true);
    expect(handlers.supports('ui5ListApps')).toBe(false);
  });
});

describe('Ui5WriteHandlers dispatch and confirmation', () => {
  it('previews without confirmation and returns a plan id', async () => {
    const { handlers } = buildHandlers(elicit('accept', 'apply'));
    const result: any = await handlers.handle('previewUi5Operation', { kind: 'delete_file', appName: 'ZAPP', filePath: 'index.html' });
    expect(result.structuredContent.result.plan.status).toBe('PREVIEWED');
    expect(result.structuredContent.result.plan.ui5WritePlanId).toBeTruthy();
  });

  it('rejects apply without a plan id', async () => {
    const { handlers } = buildHandlers(elicit('accept', 'apply'));
    await expect(handlers.handle('applyUi5Operation', {})).rejects.toThrow(/requires ui5WritePlanId/);
  });

  it('denies the write when the user cancels the native confirmation', async () => {
    const { handlers } = buildHandlers(elicit('cancel'));
    const previewed: any = await handlers.handle('previewUi5Operation', { kind: 'delete_file', appName: 'ZAPP', filePath: 'index.html' });
    const planId = previewed.structuredContent.result.plan.ui5WritePlanId;
    await expect(handlers.handle('applyUi5Operation', { ui5WritePlanId: planId })).rejects.toThrow(/not confirmed by the user/);
  });

  it('applies once the user accepts the native confirmation', async () => {
    const { handlers } = buildHandlers(elicit('accept', 'apply'));
    const previewed: any = await handlers.handle('previewUi5Operation', { kind: 'delete_file', appName: 'ZAPP', filePath: 'index.html' });
    const planId = previewed.structuredContent.result.plan.ui5WritePlanId;
    const applied: any = await handlers.handle('applyUi5Operation', { ui5WritePlanId: planId });
    expect(applied.structuredContent.result.status).toBe('success');
  });

  it('skips the form when deployment auto-approve is configured', async () => {
    const elicitFn = elicit('cancel');
    const { handlers } = buildHandlers(elicitFn, () => true);
    const previewed: any = await handlers.handle('previewUi5Operation', { kind: 'delete_file', appName: 'ZAPP', filePath: 'index.html' });
    const applied: any = await handlers.handle('applyUi5Operation', { ui5WritePlanId: previewed.structuredContent.result.plan.ui5WritePlanId });
    expect(applied.structuredContent.result.status).toBe('success');
    expect(elicitFn).not.toHaveBeenCalled();
  });

  it('reads plan status locally without contacting SAP', async () => {
    const { handlers } = buildHandlers(elicit('accept', 'apply'));
    const previewed: any = await handlers.handle('previewUi5Operation', { kind: 'delete_file', appName: 'ZAPP', filePath: 'index.html' });
    const status: any = await handlers.handle('getUi5OperationStatus', { ui5WritePlanId: previewed.structuredContent.result.plan.ui5WritePlanId });
    expect(status.structuredContent.result.status).toBe('PREVIEWED');
    await expect(handlers.handle('getUi5OperationStatus', { ui5WritePlanId: 'missing' })).rejects.toThrow(/does not exist/);
  });
});
