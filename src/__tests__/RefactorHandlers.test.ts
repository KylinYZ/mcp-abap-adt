import type { ADTClient } from '../adt/index.js';
import { RefactorHandlers } from '../handlers/RefactorHandlers';

describe('RefactorHandlers package change additions', () => {
  it('keeps preview read-only and execute explicitly high risk', () => {
    const handlers = new RefactorHandlers({} as ADTClient);
    const preview = handlers.getTools().find(tool => tool.name === 'changePackagePreview');
    const execute = handlers.getTools().find(tool => tool.name === 'changePackageExecute');

    expect(preview).toMatchObject({
      inputSchema: { required: ['refactoring', 'transport'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false }
    });
    expect(execute).toMatchObject({
      inputSchema: { required: ['refactoring'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    });
  });

  it('calls preview and execute exactly once with the preview object', async () => {
    const client = {
      changePackagePreview: jest.fn().mockResolvedValue({ preview: true }),
      changePackageExecute: jest.fn().mockResolvedValue({ executed: true })
    };
    const handlers = new RefactorHandlers(client as unknown as ADTClient);
    const refactoring = { oldPackage: 'ZOLD', newPackage: 'ZNEW' };

    await handlers.handle('changePackagePreview', { refactoring, transport: 'DEVK900001' });
    expect(client.changePackagePreview).toHaveBeenCalledWith(refactoring, 'DEVK900001');
    expect(client.changePackageExecute).not.toHaveBeenCalled();
    await handlers.handle('changePackageExecute', { refactoring });
    expect(client.changePackageExecute).toHaveBeenCalledWith(refactoring);
    expect(client.changePackageExecute).toHaveBeenCalledTimes(1);
  });
});
