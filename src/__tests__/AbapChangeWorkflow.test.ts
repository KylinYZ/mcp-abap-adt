import { AbapChangeWorkflow, type AuditSink } from '../safe/AbapChangeWorkflow';
import { ChangePlanStore } from '../safe/ChangePlanStore';
import { SafetyPolicy } from '../safe/SafetyPolicy';
import type { ResolvedAbapObject, SafeAdtClient } from '../safe/types';

const object: ResolvedAbapObject = {
  objectType: 'PROGRAM',
  objectName: 'ZTEST',
  adtType: 'PROG/P',
  objectUrl: '/sap/bc/adt/programs/programs/ztest',
  sourceUrl: '/sap/bc/adt/programs/programs/ztest/source/main',
  lockUrl: '/sap/bc/adt/programs/programs/ztest',
  activationName: 'ZTEST',
  activationUrl: '/sap/bc/adt/programs/programs/ztest',
  packageName: 'ZPKG'
};

function policy(): SafetyPolicy {
  return new SafetyPolicy({
    sapUrl: 'https://dev.example.com:44300',
    sapClient: '100',
    systemRole: 'DEV',
    allowedHosts: 'dev.example.com',
    allowedClients: '100',
    allowedNamespaces: 'Z,Y',
    auditPath: 'C:\\audit',
    toolProfile: 'safe'
  });
}

function harness(options: {
  activationResults?: boolean[];
  successfulActivationTransforms?: Array<(source: string) => string>;
} = {}) {
  let source = 'REPORT ztest.';
  const calls: string[] = [];
  const activationResults = [...(options.activationResults || [true])];
  const successfulActivationTransforms = [...(options.successfulActivationTransforms || [])];
  const client: SafeAdtClient = {
    searchObject: jest.fn(),
    objectStructure: jest.fn(),
    mainPrograms: jest.fn(),
    transportInfo: jest.fn(async () => {
      calls.push('transportInfo');
      return { DEVCLASS: 'ZPKG', TRANSPORTS: [{ TRKORR: 'DEVK900001' }] } as never;
    }),
    transportDetails: jest.fn(async () => {
      calls.push('transportDetails');
      return { 'tm:status': 'D' } as never;
    }),
    getObjectSource: jest.fn(async () => {
      calls.push('getSource');
      return source;
    }),
    setObjectSource: jest.fn(async (_url, newSource) => {
      calls.push(newSource === 'REPORT ztest.' ? 'restoreSource' : 'writeSource');
      source = newSource;
    }),
    syntaxCheck: jest.fn(async () => {
      calls.push('syntaxCheck');
      return [];
    }),
    lock: jest.fn(async () => {
      calls.push('lock');
      return { LOCK_HANDLE: 'secret-lock' } as never;
    }),
    unLock: jest.fn(async () => {
      calls.push('unlock');
      return '';
    }),
    activate: jest.fn(async () => {
      calls.push('activate');
      const success = activationResults.shift() ?? true;
      if (success) source = (successfulActivationTransforms.shift() || (value => value))(source);
      return {
        success,
        messages: success ? [] : [{ shortText: 'Activation failed' }],
        inactive: success ? [] : [{}]
      } as never;
    })
  };
  const resolver = { resolve: jest.fn().mockResolvedValue(object) } as never;
  const auditEvents: unknown[] = [];
  const audit: AuditSink = { append: jest.fn(async event => { auditEvents.push(event); }) };
  const plans = new ChangePlanStore(900_000, () => 1_000, () => 'plan-1');
  const workflow = new AbapChangeWorkflow(client, resolver, policy(), plans, audit);
  return { workflow, client, plans, calls, auditEvents, getSource: () => source, setSource: (value: string) => { source = value; } };
}

describe('AbapChangeWorkflow', () => {
  it('returns complete source for an allow-listed object without auditing', async () => {
    const test = harness();

    const inspected = await test.workflow.inspect('PROGRAM', 'ZTEST');

    expect(inspected).toMatchObject({
      status: 'success',
      object,
      source: 'REPORT ztest.',
      totalLines: 1
    });
    expect(String(inspected.sourceHash)).toHaveLength(64);
    expect(test.calls).toEqual(['getSource']);
    expect(test.auditEvents).toEqual([]);
  });

  it('previews without locking or writing, then applies the exact plan once', async () => {
    const test = harness();
    const preview = await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });
    expect(preview).toMatchObject({ status: 'preview', confirmationRequired: true });
    expect(test.calls).not.toContain('lock');
    expect(test.calls).not.toContain('writeSource');

    await test.workflow.apply({ changePlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'elicitation' });
    expect(test.getSource()).toBe('REPORT ztest.\nWRITE / test.');
    expect(test.calls).toEqual([
      'transportInfo', 'transportDetails', 'getSource', 'syntaxCheck',
      'transportInfo', 'transportDetails', 'getSource', 'lock', 'writeSource',
      'syntaxCheck', 'unlock', 'activate', 'getSource'
    ]);
    expect(test.workflow.status('plan-1').status).toBe('APPLIED');
    await expect(test.workflow.apply({ changePlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'elicitation' }))
      .rejects.toThrow('already applied');
  });

  it('accepts SAP line-ending normalization without rolling back', async () => {
    const test = harness({ successfulActivationTransforms: [source => source.replace(/\n+$/, '')] });
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\r\nWRITE / test.\r\n',
      transportRequest: 'DEVK900001'
    });

    await expect(test.workflow.apply({
      changePlanId: 'plan-1',
      confirmedByUser: true,
      confirmationMode: 'elicitation'
    })).resolves.toMatchObject({ status: 'success' });

    expect(test.calls).not.toContain('restoreSource');
    expect(test.workflow.status('plan-1')).toMatchObject({
      status: 'APPLIED',
      sourceMatchType: 'LINE_ENDING_NORMALIZED'
    });
    expect(String(test.workflow.status('plan-1').verifiedSourceHash)).toHaveLength(64);
    expect(test.auditEvents).toContainEqual(expect.objectContaining({
      eventType: 'SOURCE_VERIFIED',
      sourceMatchType: 'LINE_ENDING_NORMALIZED',
      verifiedSourceHash: expect.any(String)
    }));
  });

  it('rolls back real content differences and exposes safe hash diagnostics', async () => {
    const test = harness({ successfulActivationTransforms: [source => `${source}\nWRITE / unexpected.`] });
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });

    let applyError: unknown;
    try {
      await test.workflow.apply({
        changePlanId: 'plan-1',
        confirmedByUser: true,
        confirmationMode: 'elicitation'
      });
    } catch (error) {
      applyError = error;
    }

    expect(applyError).toMatchObject({
      code: 'VERIFY_FAILED',
      details: {
        targetHash: expect.any(String),
        verifiedSourceHash: expect.any(String),
        sourceMatchType: 'DIFFERENT',
        plan: expect.objectContaining({ status: 'ROLLED_BACK' })
      }
    });

    expect(test.getSource()).toBe('REPORT ztest.');
    expect(test.workflow.status('plan-1')).toMatchObject({
      status: 'ROLLED_BACK',
      sourceMatchType: 'DIFFERENT',
      verifiedSourceHash: expect.any(String),
      rollbackSourceMatchType: 'EXACT',
      rollbackVerifiedSourceHash: expect.any(String)
    });
  });

  it('blocks source drift before acquiring a lock', async () => {
    const test = harness();
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });
    test.setSource('REPORT ztest.\nWRITE / other.');

    await expect(test.workflow.apply({ changePlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'elicitation' }))
      .rejects.toMatchObject({ code: 'SOURCE_DRIFT' });
    expect(test.calls).not.toContain('lock');
    expect(test.workflow.status('plan-1').status).toBe('FAILED');
  });

  it('rejects released or unavailable transports during preview', async () => {
    const released = harness();
    jest.mocked(released.client.transportDetails).mockResolvedValue({ 'tm:status': 'released' } as never);
    await expect(released.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    })).rejects.toThrow('already released');

    const unavailable = harness();
    jest.mocked(unavailable.client.transportInfo).mockResolvedValue({ DEVCLASS: 'ZPKG', TRANSPORTS: [] } as never);
    await expect(unavailable.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    })).rejects.toThrow('is not available');
  });

  it('restores original source and unlocks when activation fails', async () => {
    const test = harness({ activationResults: [false, true] });
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });

    await expect(test.workflow.apply({ changePlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'elicitation' }))
      .rejects.toMatchObject({ code: 'ACTIVATION_FAILED' });
    expect(test.getSource()).toBe('REPORT ztest.');
    expect(test.calls).toContain('restoreSource');
    expect(test.calls.filter(call => call === 'activate')).toHaveLength(2);
    expect(test.calls.filter(call => call === 'lock')).toHaveLength(2);
    expect(test.calls.filter(call => call === 'unlock')).toHaveLength(2);
    expect(test.calls.slice(-6)).toEqual([
      'activate', 'lock', 'restoreSource', 'unlock', 'activate', 'getSource'
    ]);
    expect(test.workflow.status('plan-1')).toMatchObject({
      status: 'ROLLED_BACK',
      rollbackAttempted: true,
      rollbackSucceeded: true,
      unlockSucceeded: true
    });
  });

  it('accepts line-ending normalization when verifying restored source', async () => {
    const test = harness({
      activationResults: [false, true],
      successfulActivationTransforms: [source => `${source}\r\n`]
    });
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });

    await expect(test.workflow.apply({
      changePlanId: 'plan-1',
      confirmedByUser: true,
      confirmationMode: 'elicitation'
    })).rejects.toMatchObject({ code: 'ACTIVATION_FAILED' });

    expect(test.workflow.status('plan-1')).toMatchObject({
      status: 'ROLLED_BACK',
      rollbackSucceeded: true,
      rollbackSourceMatchType: 'LINE_ENDING_NORMALIZED',
      rollbackVerifiedSourceHash: expect.any(String)
    });
  });

  it('classifies thrown activation errors and restores through a new lock', async () => {
    const test = harness();
    jest.mocked(test.client.activate).mockRejectedValueOnce(new Error('User is currently editing ZTEST'));
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });

    await expect(test.workflow.apply({ changePlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'elicitation' }))
      .rejects.toMatchObject({ code: 'ACTIVATION_FAILED', stage: 'activate' });
    expect(test.getSource()).toBe('REPORT ztest.');
    expect(test.calls.filter(call => call === 'lock')).toHaveLength(2);
    expect(test.calls.filter(call => call === 'unlock')).toHaveLength(2);
    expect(test.workflow.status('plan-1')).toMatchObject({
      status: 'ROLLED_BACK',
      primaryError: {
        code: 'ACTIVATION_FAILED',
        stage: 'activate'
      },
      rollbackAttempted: true,
      rollbackSucceeded: true,
      unlockSucceeded: true
    });
  });

  it('restores with the existing lock when the pre-activation unlock fails', async () => {
    const test = harness();
    jest.mocked(test.client.unLock).mockRejectedValueOnce(new Error('Unlock failed'));
    await test.workflow.preview({
      objectType: 'PROGRAM',
      objectName: 'ZTEST',
      newSource: 'REPORT ztest.\nWRITE / test.',
      transportRequest: 'DEVK900001'
    });

    await expect(test.workflow.apply({ changePlanId: 'plan-1', confirmedByUser: true, confirmationMode: 'elicitation' }))
      .rejects.toMatchObject({ code: 'UNLOCK_FAILED', stage: 'unlock' });
    expect(test.getSource()).toBe('REPORT ztest.');
    expect(test.calls.filter(call => call === 'lock')).toHaveLength(1);
    expect(test.client.unLock).toHaveBeenCalledTimes(2);
    expect(test.workflow.status('plan-1')).toMatchObject({
      status: 'ROLLED_BACK',
      rollbackAttempted: true,
      rollbackSucceeded: true,
      unlockSucceeded: true
    });
  });
});
