import { RepositoryObjectCreationPlanStore } from '../safe/RepositoryObjectCreationPlanStore';
import { RepositoryObjectCreationRegistry } from '../safe/RepositoryObjectCreationRegistry';
import {
  RepositoryCreationOutcomeUnknownError,
  RepositoryObjectCreationWorkflow
} from '../safe/RepositoryObjectCreationWorkflow';
import { SafeAbapError } from '../safe/errors';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';
import type { RepositoryObjectCreationAdapter } from '../safe/repositoryCreationTypes';
import type { RepositoryCreationMaturityEvidenceManifest } from '../safe/RepositoryCreationMaturityEvidence';

const context = {
  systemHost: 'dev.example.test', client: '100', sapUser: 'TEST_USER',
  systemRole: 'DEV', toolProfile: 'development' as const
};

function registry(): RepositoryObjectCreationRegistry {
  return new RepositoryObjectCreationRegistry([{
    ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'PROGRAM')!,
    maturity: 'REAL_DEV_VERIFIED'
  }], verifiedProgramEvidence());
}

function unverifiedProgramRegistry(): RepositoryObjectCreationRegistry {
  return new RepositoryObjectCreationRegistry([{
    ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'PROGRAM')!,
    maturity: 'AUTOMATION_VERIFIED'
  }], { schemaVersion: 2, records: [], unresolvedValidationIdentities: [] });
}

function verifiedProgramEvidence(): RepositoryCreationMaturityEvidenceManifest {
  return {
    schemaVersion: 2,
    unresolvedValidationIdentities: [],
    records: [{
      evidenceId: 'program-evidence-1', objectKind: 'PROGRAM', adtType: 'PROG/P', objectName: 'ZVPROG_NEW',
      create: { planId: 'create-plan', status: 'APPLIED', evidenceRef: 'docs/evidence/program-create.md' },
      readback: { status: 'ACTIVE_VERIFIED', evidenceRef: 'docs/evidence/program-readback.md' },
      transport: { request: 'S4HK900009', packageName: 'Z001', objectEntryVerified: true, deletionEntryVerified: true, evidenceRef: 'docs/evidence/program-transport.md' },
      cleanup: { planId: 'cleanup-plan', status: 'COMPLETED', evidenceRef: 'docs/evidence/program-cleanup.md' },
      absence: { searchAbsent: true, evidenceRef: 'docs/evidence/program-absence.md' },
      target: {
        host: 'dev.example.test', client: '300', systemRole: 'DEV',
        fingerprint: 'a'.repeat(64), verifiedAt: '2026-08-25T00:00:00.000Z'
      },
      normalizations: []
    }]
  };
}

function adapter(execute: RepositoryObjectCreationAdapter['execute'], targetName = 'ZTEST'): RepositoryObjectCreationAdapter {
  return {
    objectKind: 'PROGRAM',
    prepare: jest.fn().mockResolvedValue({
      target: { objectKind: 'PROGRAM', objectName: targetName, adtType: 'PROG/P', parentName: 'Z001', packageName: 'Z001' },
      transportRequest: 'DEVK900001', summary: `Create ${targetName}`, payload: { source: 'REPORT ztest.' },
      review: { source: 'REPORT ztest.' },
      compensationLimits: ['Only owned objects may be deleted.']
    }),
    execute
  };
}

describe('RepositoryObjectCreationWorkflow', () => {
  it('freezes a plan and executes it exactly once', async () => {
    const execute = jest.fn().mockImplementation(async (_plan, recordStage) => {
      recordStage('CREATE_SHELL', true, 'Created');
      return { resultSummary: 'Created ZTEST', actualResources: [{ type: 'PROG/P', name: 'ZTEST' }] };
    });
    const workflow = new RepositoryObjectCreationWorkflow(
      registry(), context, new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'plan-1'), [adapter(execute)]
    );
    const preview = await workflow.preview({ objectKind: 'PROGRAM', name: 'ZTEST' }) as any;
    expect(preview).toMatchObject({ status: 'preview', confirmationRequired: true, plan: { creationPlanId: 'plan-1' } });
    await expect(workflow.apply('plan-1')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    await expect(workflow.apply('plan-1')).rejects.toMatchObject({ code: 'PLAN_ALREADY_CONSUMED' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never retries or compensates an unknown remote outcome', async () => {
    const execute = jest.fn().mockRejectedValue(new RepositoryCreationOutcomeUnknownError('timeout after write'));
    const controlledAdapter = adapter(execute);
    controlledAdapter.compensate = jest.fn();
    const workflow = new RepositoryObjectCreationWorkflow(
      registry(), context, new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'plan-1'), [controlledAdapter]
    );
    await workflow.preview({ objectKind: 'PROGRAM', name: 'ZTEST' });
    await expect(workflow.apply('plan-1')).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controlledAdapter.compensate).not.toHaveBeenCalled();
    expect(workflow.status('plan-1')).toMatchObject({ status: 'OUTCOME_UNKNOWN' });
  });

  it('keeps only validated source mismatch metadata after compensation', async () => {
    const controlledAdapter = adapter(jest.fn().mockRejectedValue(new SafeAbapError(
      'SOURCE_VERIFY_FAILED', 'verify', 'Source mismatch', {
        sourceMatchType: 'DIFFERENT', secret: 'not-safe',
        mismatch: {
          expectedHash: 'a'.repeat(64), actualHash: 'b'.repeat(64),
          expectedLineCount: 2, actualLineCount: 3, firstMismatchLine: 2,
          expectedLineBytes: 12, actualLineBytes: 0,
          expectedLineHash: 'c'.repeat(64), actualLineHash: 'd'.repeat(64),
          source: 'not-safe'
        }
      }
    )));
    controlledAdapter.compensate = jest.fn().mockResolvedValue(true);
    const workflow = new RepositoryObjectCreationWorkflow(
      registry(), context, new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'plan-1'), [controlledAdapter]
    );
    await workflow.preview({ objectKind: 'PROGRAM', name: 'ZTEST' });

    await expect(workflow.apply('plan-1')).rejects.toMatchObject({ code: 'REMOTE_WRITE_FAILED' });
    const status = workflow.status('plan-1');
    expect(status).toMatchObject({
      status: 'COMPENSATED',
      primaryError: { details: { sourceMatchType: 'DIFFERENT', mismatch: { firstMismatchLine: 2, actualLineBytes: 0 } } }
    });
    expect(JSON.stringify(status)).not.toContain('not-safe');
  });

  it('allows read-only preview but rejects apply until real DEV verification', async () => {
    const controlledAdapter = adapter(jest.fn());
    const workflow = new RepositoryObjectCreationWorkflow(
      unverifiedProgramRegistry(),
      context,
      new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'plan-1'),
      [controlledAdapter]
    );
    await expect(workflow.preview({ objectKind: 'PROGRAM', name: 'ZTEST' })).resolves.toMatchObject({
      review: { source: 'REPORT ztest.' }, plan: { status: 'PREVIEWED' }
    });
    await expect(workflow.apply('plan-1')).rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'capability' });
    expect(workflow.status('plan-1')).toMatchObject({ status: 'PREVIEWED' });
    expect(controlledAdapter.execute).not.toHaveBeenCalled();
  });

  it('allows only an explicitly scoped REAL_DEV validation plan below verified maturity', async () => {
    const execute = jest.fn().mockResolvedValue({ resultSummary: 'Created validation object', actualResources: [{ type: 'PROG/P', name: 'ZZMCP_VT_TEST' }] });
    const validationContext = {
      ...context,
      realDevValidationEnabled: true,
      realDevValidationObjects: ['PROGRAM'],
      realDevValidationPrefix: 'ZZMCP_VT_',
      realDevValidationPackage: 'Z001',
      realDevValidationTransport: 'DEVK900001'
    };
    const workflow = new RepositoryObjectCreationWorkflow(
      unverifiedProgramRegistry(),
      validationContext,
      new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'plan-1'),
      [adapter(execute, 'ZZMCP_VT_TEST')]
    );
    await workflow.preview({ objectKind: 'PROGRAM', name: 'ZZMCP_VT_TEST', packageName: 'Z001', transportRequest: 'DEVK900001' });
    await expect(workflow.apply('plan-1')).resolves.toMatchObject({ status: 'success', plan: { status: 'APPLIED' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a REAL_DEV validation preview outside the configured prefix', async () => {
    const workflow = new RepositoryObjectCreationWorkflow(
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      { ...context, realDevValidationEnabled: true, realDevValidationObjects: ['PROGRAM'], realDevValidationPrefix: 'ZZMCP_VT_', realDevValidationPackage: 'Z001', realDevValidationTransport: 'DEVK900001' },
      new RepositoryObjectCreationPlanStore(60_000),
      [adapter(jest.fn())]
    );
    await expect(workflow.preview({ objectKind: 'PROGRAM', name: 'ZOTHER', packageName: 'Z001', transportRequest: 'DEVK900001' })).rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'validation' });
  });

  it('accepts E plus the configured prefix for DDIC lock object validation', async () => {
    const lockCapability = {
      ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'DDIC_LOCK_OBJECT')!,
      maturity: 'CONTROLLED_IMPLEMENTED' as const
    };
    const execute = jest.fn().mockResolvedValue({
      resultSummary: 'Created lock object', actualResources: [{ type: 'ENQU/DL', name: 'EZVLOCK3' }]
    });
    const lockAdapter: RepositoryObjectCreationAdapter = {
      objectKind: 'DDIC_LOCK_OBJECT',
      prepare: jest.fn().mockResolvedValue({
        target: { objectKind: 'DDIC_LOCK_OBJECT', objectName: 'EZVLOCK3', adtType: 'ENQU/DL', parentName: 'Z001' },
        transportRequest: 'DEVK900001', summary: 'Create EZVLOCK3', payload: {}, review: {}, compensationLimits: []
      }),
      execute
    };
    const validationContext = {
      ...context, realDevValidationEnabled: true, realDevValidationObjects: ['DDIC_LOCK_OBJECT'],
      realDevValidationPrefix: 'ZV', realDevValidationPackage: 'Z001', realDevValidationTransport: 'DEVK900001'
    };
    const workflow = new RepositoryObjectCreationWorkflow(
      new RepositoryObjectCreationRegistry([lockCapability], { schemaVersion: 2, records: [], unresolvedValidationIdentities: [] }),
      validationContext,
      new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'lock-plan'),
      [lockAdapter]
    );

    await workflow.preview({ objectKind: 'DDIC_LOCK_OBJECT', name: 'EZVLOCK3', packageName: 'Z001', transportRequest: 'DEVK900001' });
    await expect(workflow.apply('lock-plan')).resolves.toMatchObject({ status: 'success' });
    await expect(workflow.preview({ objectKind: 'DDIC_LOCK_OBJECT', name: 'ZVLOCK3', packageName: 'Z001', transportRequest: 'DEVK900001' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'validation' });
  });

  it('validates a function-group include by prefixed parent and frozen package', async () => {
    const execute = jest.fn().mockResolvedValue({
      resultSummary: 'Created include', actualResources: [{ type: 'FUGR/I', name: 'LZVFG1Z01' }]
    });
    const includeAdapter: RepositoryObjectCreationAdapter = {
      objectKind: 'FUNCTION_GROUP_INCLUDE',
      prepare: jest.fn().mockResolvedValue({
        target: {
          objectKind: 'FUNCTION_GROUP_INCLUDE', objectName: 'LZVFG1Z01', adtType: 'FUGR/I',
          parentName: 'ZVFG1', packageName: 'Z001'
        },
        transportRequest: 'DEVK900001', summary: 'Create include LZVFG1Z01', payload: { suffix: 'Z01' },
        review: { parentFunctionGroup: 'ZVFG1', suffix: 'Z01' }, compensationLimits: []
      }),
      execute
    };
    const validationContext = {
      ...context,
      realDevValidationEnabled: true,
      realDevValidationObjects: ['FUNCTION_GROUP_INCLUDE'],
      realDevValidationPrefix: 'ZV',
      realDevValidationPackage: 'Z001',
      realDevValidationTransport: 'DEVK900001'
    };
    const workflow = new RepositoryObjectCreationWorkflow(
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      validationContext,
      new RepositoryObjectCreationPlanStore(60_000, () => 1_000, () => 'include-plan'),
      [includeAdapter]
    );

    await expect(workflow.preview({
      objectKind: 'FUNCTION_GROUP_INCLUDE', name: 'Z01', parentFunctionGroup: 'ZVFG1',
      transportRequest: 'DEVK900001'
    })).resolves.toMatchObject({ plan: { target: { objectName: 'LZVFG1Z01', packageName: 'Z001' } } });
    await expect(workflow.apply('include-plan')).rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'validation' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a function-group include outside the configured parent prefix', async () => {
    const includeAdapter: RepositoryObjectCreationAdapter = {
      objectKind: 'FUNCTION_GROUP_INCLUDE', prepare: jest.fn(), execute: jest.fn()
    };
    const workflow = new RepositoryObjectCreationWorkflow(
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      {
        ...context, realDevValidationEnabled: true, realDevValidationObjects: ['FUNCTION_GROUP_INCLUDE'],
        realDevValidationPrefix: 'ZV', realDevValidationPackage: 'Z001', realDevValidationTransport: 'DEVK900001'
      },
      new RepositoryObjectCreationPlanStore(60_000),
      [includeAdapter]
    );

    await expect(workflow.preview({
      objectKind: 'FUNCTION_GROUP_INCLUDE', name: 'Z01', parentFunctionGroup: 'ZOTHER',
      transportRequest: 'DEVK900001'
    })).rejects.toMatchObject({ code: 'POLICY_DENIED', stage: 'validation' });
    expect(includeAdapter.prepare).not.toHaveBeenCalled();
  });

  it('rejects preview when an automated capability has no registered adapter', async () => {
    const workflow = new RepositoryObjectCreationWorkflow(
      new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES),
      context,
      new RepositoryObjectCreationPlanStore(60_000)
    );

    await expect(workflow.preview({ objectKind: 'CDS_ANNOTATION_DEFINITION', name: 'ZI_TEST' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', stage: 'adapter'
    });
  });

  it('returns a sanitized preview error instead of an opaque internal failure', async () => {
    const failingAdapter = adapter(jest.fn());
    failingAdapter.prepare = jest.fn().mockRejectedValue(new Error('password=secret target schema rejected'));
    const workflow = new RepositoryObjectCreationWorkflow(
      registry(), context, new RepositoryObjectCreationPlanStore(60_000), [failingAdapter]
    );

    await expect(workflow.preview({ objectKind: 'PROGRAM', name: 'ZTEST' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', stage: 'preview', message: expect.stringContaining('password=[REDACTED]')
    });
  });
});
