import { AdtErrorException } from '../adt/index.js';
import { SessionSupervisor } from '../lib/SessionSupervisor.js';
import { SafeAbapError } from '../safe/errors.js';
import type { ADTClient } from '../adt/index.js';

function expired(status = 401): AdtErrorException {
  return AdtErrorException.create(status, {}, '', status === 400 ? 'Session timed out' : 'Unauthorized');
}

function fakeClient(reconnect: jest.Mock, loggedin = true): ADTClient {
  return { reconnect, loggedin } as unknown as ADTClient;
}

describe('SessionSupervisor', () => {
  test('reconnects once and replays a read operation once', async () => {
    const reconnect = jest.fn().mockResolvedValue(undefined);
    const supervisor = new SessionSupervisor(fakeClient(reconnect));
    let attempts = 0;

    await expect(supervisor.execute('searchObject', async () => {
      attempts += 1;
      if (attempts === 1) throw expired();
      return { ok: true };
    })).resolves.toEqual({ ok: true });

    expect(attempts).toBe(2);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().generation).toBe(1);
  });

  test('coalesces concurrent read recovery into one login', async () => {
    let release!: () => void;
    const reconnect = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const supervisor = new SessionSupervisor(fakeClient(reconnect));
    let firstCalls = 0;
    let secondCalls = 0;

    const first = supervisor.execute('searchObject', async () => {
      firstCalls += 1;
      if (firstCalls === 1) throw expired();
      return 'first';
    });
    const second = supervisor.execute('objectStructure', async () => {
      secondCalls += 1;
      if (secondCalls === 1) throw expired();
      return 'second';
    });

    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  test('never replays a mutating operation after session expiry', async () => {
    const reconnect = jest.fn().mockResolvedValue(undefined);
    const supervisor = new SessionSupervisor(fakeClient(reconnect));
    let attempts = 0;

    await expect(supervisor.execute('setObjectSource', async () => {
      attempts += 1;
      throw expired();
    })).rejects.toMatchObject<Partial<SafeAbapError>>({ code: 'REMOTE_RESULT_UNKNOWN' });

    expect(attempts).toBe(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  test('explicit logout blocks automatic recovery', async () => {
    const reconnect = jest.fn().mockResolvedValue(undefined);
    const supervisor = new SessionSupervisor(fakeClient(reconnect));
    await supervisor.execute('logout', async () => undefined);

    await expect(supervisor.execute('searchObject', async () => {
      throw expired();
    })).rejects.toBeInstanceOf(AdtErrorException);
    expect(reconnect).not.toHaveBeenCalled();
    expect(supervisor.snapshot().state).toBe('explicitly-logged-out');
  });

  test('records keepalive degradation without exposing raw errors', () => {
    const supervisor = new SessionSupervisor(fakeClient(jest.fn()));
    supervisor.handleEvent({ type: 'keepalive-failure', status: 400, errorType: 'session-expired' });
    expect(supervisor.snapshot()).toMatchObject({ state: 'degraded', lastErrorType: 'session-expired' });
  });
});
