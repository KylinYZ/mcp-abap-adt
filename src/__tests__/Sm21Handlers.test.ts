import type { Dump } from 'abap-adt-api';
import { Sm21Handlers } from '../handlers/Sm21Handlers';
import type { Sm21Client, Sm21ReadRequest } from '../sm21/types';

const sm21Response = {
  logs: [{ timestamp: '20260813080000', instance: 'APP01', client: '100', user: 'DEV_USER', program: 'Z_ORDER_CREATE', tcode: 'ZORD', messageId: 'TH', severity: 'ERROR', process: '001', text: 'Terminated' }],
  hasMore: true, total: 101
};
const config = { timeZone: 'UTC', maxWindowHours: 24, defaultPageSize: 100, maxPageSize: 500 };

function resultPayload(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text);
}

describe('Sm21Handlers', () => {
  const client: Sm21Client = { read: jest.fn(async (_request: Sm21ReadRequest) => sm21Response) };
  const dumps = [{ id: 'dump-1', categories: [], links: [], text: 'Z_ORDER_CREATE DEV_USER', type: 'text' }] as Dump[];
  const adtClient = { dumps: jest.fn(async () => ({ href: '/dumps', title: 'Dumps', updated: new Date(), dumps })) };

  beforeEach(() => jest.clearAllMocks());

  it('returns a bounded SM21 page and an offset for the next page', async () => {
    const handler = new Sm21Handlers(client, config, adtClient);
    const result = resultPayload(await handler.handle('sm21Read', { fromDateTime: '2026-08-13T00:00:00Z', toDateTime: '2026-08-13T01:00:00Z', offset: 2 }));
    expect(result).toMatchObject({ status: 'success', source: 'SM21', nextOffset: 3, truncated: true, range: { timeZone: 'UTC' } });
    expect(client.read).toHaveBeenCalledWith(expect.objectContaining({ offset: 2, pageSize: 100 }));
    expect(adtClient.dumps).not.toHaveBeenCalled();
  });

  it('combines SM21 and ADT dump summaries without claiming causality', async () => {
    const handler = new Sm21Handlers(client, config, adtClient);
    const result = resultPayload(await handler.handle('analyzeRuntimeErrors', { fromDateTime: '2026-08-13T00:00:00Z', toDateTime: '2026-08-13T01:00:00Z', dumpQuery: 'Z_ORDER_CREATE' }));
    expect(adtClient.dumps).toHaveBeenCalledWith('Z_ORDER_CREATE');
    expect(result).toMatchObject({ status: 'success', source: 'SM21_AND_ST22' });
    expect((result.analysis as { limitations: string[] }).limitations.join(' ')).toContain('do not prove');
  });
});
