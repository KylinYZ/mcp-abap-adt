import type { ADTClient } from '../adt/index.js';
import { AtcHandlers } from '../handlers/AtcHandlers';

describe('AtcHandlers raw ADT additions', () => {
  it('reads ATC documentation from the exact URI', async () => {
    const client = { atcDocumentation: jest.fn().mockResolvedValue('<html>Help</html>') };
    const handlers = new AtcHandlers(client as unknown as ADTClient);
    const tool = handlers.getTools().find(candidate => candidate.name === 'atcDocumentation');

    expect(tool).toMatchObject({
      inputSchema: { required: ['docUri'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false }
    });
    await handlers.handle('atcDocumentation', { docUri: '/sap/bc/adt/atc/doc/1' });
    expect(client.atcDocumentation).toHaveBeenCalledWith('/sap/bc/adt/atc/doc/1');
  });
});
