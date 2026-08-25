import { ADTClient, AdtHTTP, HttpClient, HttpClientOptions, session_types } from '../adt/index.js';

const ok = (headers: Record<string, string> = {}) => ({
  body: '',
  status: 200,
  statusText: 'OK',
  headers
});

describe('ADT session lifecycle', () => {
  test('logout clears local state even when the remote logoff fails', async () => {
    const events: string[] = [];
    const httpClient: HttpClient = {
      request: async () => {
        throw new Error('SAP unavailable');
      }
    };
    const http = new AdtHTTP(httpClient, 'USER', 'PASSWORD', '001', 'EN', {
      sessionEventCallback: event => events.push(event.type)
    });
    http.stateful = session_types.stateful;

    await expect(http.logout()).rejects.toThrow('SAP unavailable');
    expect(http.stateful).toBe(session_types.stateful);
    expect(http.loggedin).toBe(false);
    expect(events).toEqual(['logout']);
  });

  test('dropSession restores the configured session mode', async () => {
    const requests: HttpClientOptions[] = [];
    const httpClient: HttpClient = {
      request: async options => {
        requests.push(options);
        return ok({ 'x-csrf-token': 'token' });
      }
    };
    const http = new AdtHTTP(httpClient, 'USER', 'PASSWORD', '001', 'EN');
    http.stateful = session_types.stateful;

    await http.dropSession();
    expect(http.stateful).toBe(session_types.stateful);
    expect(http.loggedin).toBe(false);
    expect(requests[0].headers?.['X-sap-adt-sessiontype']).toBe(session_types.stateless);
  });

  test('message class shell creation uses the stateless clone without changing the primary session', async () => {
    const requests: HttpClientOptions[] = [];
    const httpClient: HttpClient = {
      request: async options => {
        requests.push(options);
        return ok({ 'x-csrf-token': 'token' });
      }
    };
    const client = new ADTClient('https://dev.example.test', 'USER', 'PASSWORD', '300', 'EN');
    client.stateful = session_types.stateful;
    const clone = client.statelessClone;
    (clone as unknown as { h: { httpclient: HttpClient } }).h.httpclient = httpClient;

    await client.createObjectStateless({
      objtype: 'MSAG/N', name: 'ZMSG', parentName: 'Z001', description: 'Messages',
      parentPath: '/sap/bc/adt/packages/z001', transport: 'S4HK900009', contentType: 'application/xml'
    });

    const createRequest = requests.find(request => request.method === 'POST' && request.url === '/sap/bc/adt/messageclass');
    expect(createRequest?.headers?.['X-sap-adt-sessiontype']).toBe(session_types.stateless);
    expect(client.stateful).toBe(session_types.stateful);
    expect(clone.stateful).toBe(session_types.stateless);
  });
});
