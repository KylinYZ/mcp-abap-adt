import { AdtHTTP, HttpClient, HttpClientOptions, session_types } from '../adt/index.js';

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
});
