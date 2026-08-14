import { AdvancedOperationPlanStore } from '../safe/AdvancedOperationPlanStore';
import type { CreateAdvancedOperationPlanInput } from '../safe/advancedTypes';

describe('AdvancedOperationPlanStore', () => {
  let now = 1_000;
  let nextId = 1;
  const context = {
    systemHost: 'DEV.EXAMPLE.COM',
    client: '100',
    systemRole: 'DEV',
    toolProfile: 'development' as const
  };

  function domainInput(secret = 'planned-secret'): CreateAdvancedOperationPlanInput {
    return {
      context,
      target: { objectType: 'DOMAIN', objectName: 'ZDOMAIN' },
      transport: 'DEVK900001',
      inputSummary: {
        title: 'Change ZDOMAIN',
        changedFields: ['outputInformation.length'],
        warning: 'Writes DDIC metadata'
      },
      currentStateSummary: { stateHash: 'current-hash', description: '1 field differs' },
      rollbackSupported: true,
      payload: {
        kind: 'SET_DOMAIN_PROPERTIES',
        objectUrl: '/sap/bc/adt/ddic/domains/zdomain',
        activationUrl: '/sap/bc/adt/ddic/domains/zdomain',
        lockHandle: 'LOCK-SECRET',
        input: {
          properties: {
            typeInformation: { datatype: 'CHAR', length: 20, decimals: 0 },
            outputInformation: { length: 20, signExists: false, lowercase: false, ampmFormat: false },
            valueInformation: { valueTableRef: secret, appendExists: false }
          },
          metaData: {
            name: 'ZDOMAIN', description: secret, language: 'EN', masterLanguage: 'EN',
            masterSystem: 'DEV', responsible: 'DEVUSER', packageName: 'ZPKG'
          }
        },
        drift: { currentHash: 'current-hash' },
        recovery: {
          properties: {
            typeInformation: { datatype: 'CHAR', length: 10, decimals: 0 },
            outputInformation: { length: 10, signExists: false, lowercase: false, ampmFormat: false }
          },
          metaData: {
            name: 'ZDOMAIN', description: 'old-secret', language: 'EN', masterLanguage: 'EN',
            masterSystem: 'DEV', responsible: 'DEVUSER', packageName: 'ZPKG'
          }
        },
        verification: { expectedHash: 'expected-hash' }
      }
    };
  }

  beforeEach(() => {
    now = 1_000;
    nextId = 1;
  });

  it('normalizes context, freezes payloads, and consumes a plan once', () => {
    const store = new AdvancedOperationPlanStore(100, () => now, () => 'plan-1');
    const input = domainInput();
    const plan = store.create(input);
    if (input.payload.kind !== 'SET_DOMAIN_PROPERTIES') throw new Error('Expected domain payload');
    input.payload.input.metaData.description = 'mutated-after-create';

    expect(plan.context.systemHost).toBe('dev.example.com');
    expect((plan.payload?.input as { metaData: { description: string } }).metaData.description).toBe('planned-secret');
    expect(store.beginApply('plan-1', { ...context, systemHost: 'dev.example.com' }).status).toBe('APPLYING');
    expect(() => store.beginApply('plan-1', context)).toThrow('already applying');
  });

  it('expires without exposing or retaining complete payload values', () => {
    const store = new AdvancedOperationPlanStore(100, () => now, () => 'plan-expired');
    const plan = store.create(domainInput('TOP-SECRET'));

    const previewView = JSON.stringify(store.view(plan.operationPlanId, context));
    expect(previewView).not.toContain('TOP-SECRET');
    expect(previewView).not.toContain('LOCK-SECRET');
    expect(previewView).toContain('inputHash');

    now += 100;
    expect(() => store.beginApply(plan.operationPlanId, context)).toThrow('expired');
    expect(plan.status).toBe('EXPIRED');
    expect(plan.payload).toBeUndefined();
  });

  it.each([
    { systemHost: 'other.example.com' },
    { client: '200' },
    { systemRole: 'QAS' },
    { toolProfile: 'legacy-full' as const }
  ])('rejects a plan used from a different bound context: %p', difference => {
    const store = new AdvancedOperationPlanStore(100, () => now, () => 'plan-context');
    store.create(domainInput());
    expect(() => store.beginApply('plan-context', { ...context, ...difference })).toThrow('current SAP context');
  });

  it.each([
    'APPLIED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'PARTIAL_SUCCESS', 'FAILED',
    'UNKNOWN_OUTCOME', 'EXPIRED', 'CANCELLED'
  ] as const)('purges complete private payload for terminal status %s', status => {
    const store = new AdvancedOperationPlanStore(100, () => now, () => `plan-${status}`);
    const plan = store.create(domainInput(`${status}-secret`));
    store.setStatus(plan.operationPlanId, status);
    const serialized = JSON.stringify(store.view(plan.operationPlanId));

    expect(plan.payload).toBeUndefined();
    expect(serialized).not.toContain(`${status}-secret`);
    expect(serialized).toContain('recoveryHash');
  });

  it('records bounded stage and result evidence without restoring private payload', () => {
    const store = new AdvancedOperationPlanStore(100, () => now, () => 'plan-result');
    const plan = store.create(domainInput());
    store.recordStage(plan.operationPlanId, { stage: 'verify', success: false, message: 'Hash mismatch' });
    store.recordResult(plan.operationPlanId, 'Verification failed', { code: 'VERIFY_FAILED', stage: 'verify', message: 'Hash mismatch' });

    expect(store.view(plan.operationPlanId)).toMatchObject({
      stages: [{ stage: 'verify', success: false, timestamp: new Date(now).toISOString() }],
      resultSummary: 'Verification failed',
      primaryError: { code: 'VERIFY_FAILED' }
    });
  });

  it('evicts terminal plans but never active plans at capacity', () => {
    const store = new AdvancedOperationPlanStore(100, () => now, () => `plan-${nextId++}`, 2);
    const terminal = store.create(domainInput());
    store.setStatus(terminal.operationPlanId, 'APPLIED');
    const active = store.create(domainInput());
    expect(store.create(domainInput()).operationPlanId).toBe('plan-3');
    expect(() => store.get(terminal.operationPlanId)).toThrow('not found');
    expect(store.get(active.operationPlanId).status).toBe('PREVIEWED');

    const full = new AdvancedOperationPlanStore(100, () => now, () => 'active-plan', 1);
    full.create(domainInput());
    expect(() => full.create(domainInput())).toThrow('capacity');
  });
});
