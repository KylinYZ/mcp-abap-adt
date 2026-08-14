import type { ADTClient } from '../adt/index.js';
import { ObjectHandlers } from '../handlers/ObjectHandlers';

describe('ObjectHandlers raw ADT additions', () => {
  it('declares and dispatches objectStructureElements as one bounded read', async () => {
    const client = { objectStructureElements: jest.fn().mockResolvedValue([{ name: 'METHOD' }]) };
    const handlers = new ObjectHandlers(client as unknown as ADTClient);
    const tool = handlers.getTools().find(candidate => candidate.name === 'objectStructureElements');

    expect(tool).toMatchObject({
      inputSchema: { required: ['objectUrl'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { operationClass: 'read-only tenant', approvalRequired: false }
    });
    await expect(handlers.handle('objectStructureElements', {
      objectUrl: '/sap/bc/adt/oo/classes/zcl_demo', version: 'active'
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
    expect(client.objectStructureElements).toHaveBeenCalledTimes(1);
    expect(client.objectStructureElements).toHaveBeenCalledWith('/sap/bc/adt/oo/classes/zcl_demo', 'active');
  });
});
