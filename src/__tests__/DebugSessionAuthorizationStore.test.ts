import { DebugSessionAuthorizationStore } from '../safe/DebugSessionAuthorizationStore';

describe('DebugSessionAuthorizationStore', () => {
  let now = 1_000;
  let nextId = 1;
  const context = {
    systemHost: 'dev.example.com',
    client: '100',
    targetUser: 'DEVUSER',
    attachContext: {
      debuggeeId: 'debuggee-1',
      debugSessionId: 'debug-session-1',
      debuggeeSessionId: 'debuggee-session-1',
      serverName: 'server-1',
      processId: 123
    }
  };

  it('expires authorization after the configured TTL', () => {
    const store = new DebugSessionAuthorizationStore(100, () => now, () => 'auth-1');
    store.create(context);
    expect(store.getActive('auth-1', context).status).toBe('ACTIVE');
    now += 100;
    expect(() => store.getActive('auth-1', context)).toThrow('expired');
    expect(store.view('auth-1').status).toBe('EXPIRED');
  });

  it('rejects a changed debuggee or attach session context', () => {
    const store = new DebugSessionAuthorizationStore(100, () => now, () => 'auth-context');
    store.create(context);
    expect(() => store.getActive('auth-context', {
      ...context,
      attachContext: { ...context.attachContext, debuggeeId: 'debuggee-2' }
    })).toThrow('attach context');
    expect(() => store.getActive('auth-context', {
      ...context,
      attachContext: { ...context.attachContext, debugSessionId: 'debug-session-2' }
    })).toThrow('attach context');
  });

  it('revokes explicitly and when the attach context changes', () => {
    const store = new DebugSessionAuthorizationStore(100, () => now, () => `auth-${nextId++}`);
    const first = store.create(context);
    store.revoke(first.authorizationId);
    expect(store.view(first.authorizationId)).toMatchObject({ status: 'REVOKED', revokeReason: 'USER_REVOKED' });

    const second = store.create(context);
    store.revokeForAttachChange({
      ...context,
      attachContext: { ...context.attachContext, debuggeeId: 'debuggee-2' }
    });
    expect(store.view(second.authorizationId)).toMatchObject({ status: 'REVOKED', revokeReason: 'ATTACH_CONTEXT_CHANGED' });
  });

  it('re-authorizing the same target revokes the previous authorization', () => {
    const store = new DebugSessionAuthorizationStore(100, () => now, () => `auth-${nextId++}`, 1);
    const first = store.create(context);
    const second = store.create(context);
    expect(() => store.view(first.authorizationId)).toThrow('not found');
    expect(store.getActive(second.authorizationId, context).status).toBe('ACTIVE');
  });

  it('evicts inactive records but rejects capacity when all entries are active', () => {
    const store = new DebugSessionAuthorizationStore(100, () => now, () => `auth-${nextId++}`, 1);
    const first = store.create(context);
    store.revoke(first.authorizationId);
    const second = store.create(context);
    expect(() => store.view(first.authorizationId)).toThrow('not found');
    expect(store.getActive(second.authorizationId, context).status).toBe('ACTIVE');

    expect(() => store.create({
      ...context,
      targetUser: 'OTHER',
      attachContext: { ...context.attachContext, debuggeeId: 'debuggee-2' }
    })).toThrow('capacity');
  });
});
