import { AdtHttpSm21Client, type AdtHttpRequestClient } from '../sm21/AdtHttpSm21Client';
import type { Sm21ReadRequest } from '../sm21/types';

const request: Sm21ReadRequest = {
  from: '20260813000000', to: '20260813010000', instances: ['APP01'], users: ['DEV_USER'], programs: ['Z_ORDER_CREATE'],
  tcodes: ['ZORD'], messageIds: ['TH'], severity: 'ERROR', offset: 4, pageSize: 20
};

describe('AdtHttpSm21Client', () => {
  it('uses the existing ADT HTTP session and maps the narrow JSON contract', async () => {
    const httpClient = { request: jest.fn(async () => ({ body: JSON.stringify({
      hasMore: true, total: 25,
      logs: [{ timestamp: '20260813080000', instance: 'APP01', client: '100', user: 'DEV_USER', program: 'Z_ORDER_CREATE', tcode: 'ZORD', messageId: 'TH', severity: 'ERROR', process: '001', text: 'Terminated' }]
    }) })) } as unknown as AdtHttpRequestClient;
    const result = await new AdtHttpSm21Client(httpClient).read(request);

    expect(httpClient.request).toHaveBeenCalledWith('/sap/bc/z-mcp/sm21', expect.objectContaining({
      method: 'GET', qs: expect.objectContaining({ from: request.from, pageSize: '20', users: 'DEV_USER' })
    }));
    expect(result).toEqual(expect.objectContaining({ hasMore: true, total: 25, logs: [expect.objectContaining({ program: 'Z_ORDER_CREATE' })] }));
  });

  it('rejects malformed service output without leaking it', async () => {
    const httpClient = { request: jest.fn(async () => ({ body: '<html>error</html>' })) } as unknown as AdtHttpRequestClient;
    await expect(new AdtHttpSm21Client(httpClient).read(request)).rejects.toThrow('invalid response');
  });
});
