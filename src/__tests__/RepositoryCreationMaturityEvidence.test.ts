import {
  REPOSITORY_CREATION_MATURITY_EVIDENCE,
  validateRepositoryCreationMaturityEvidence,
  type RepositoryCreationMaturityEvidenceManifest
} from '../safe/RepositoryCreationMaturityEvidence';
import { RepositoryObjectCreationRegistry } from '../safe/RepositoryObjectCreationRegistry';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';

const verifiedProgram = {
  ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'PROGRAM')!,
  maturity: 'REAL_DEV_VERIFIED' as const
};

describe('Repository creation maturity evidence gate', () => {
  it('loads all verified records and freezes historical unresolved identities', () => {
    const evidence = validateRepositoryCreationMaturityEvidence(
      INITIAL_REPOSITORY_CREATION_CAPABILITIES,
      REPOSITORY_CREATION_MATURITY_EVIDENCE
    );

    expect(evidence.size).toBe(28);
    expect(evidence.get('DDIC_STRUCTURE')).toMatchObject({
      objectName: 'ZVPSTR06', adtType: 'TABL/DS',
      create: { status: 'APPLIED' }, cleanup: { status: 'COMPLETED' },
      transport: { objectEntryVerified: true, deletionEntryVerified: true },
      absence: { searchAbsent: true }
    });
    expect(evidence.get('DDIC_DOMAIN')).toMatchObject({
      objectName: 'ZVPD02', adtType: 'DOMA/DD',
      create: { status: 'APPLIED' }, cleanup: { status: 'COMPLETED' },
      transport: { objectEntryVerified: true, deletionEntryVerified: true },
      absence: { searchAbsent: true }
    });
    expect(evidence.get('DATA_ELEMENT')).toMatchObject({
      objectName: 'ZVPDE01', adtType: 'DTEL/DE',
      create: { status: 'APPLIED' }, cleanup: { status: 'COMPLETED' },
      transport: { objectEntryVerified: true, deletionEntryVerified: true },
      absence: { searchAbsent: true }
    });
    expect(evidence.get('DDIC_TABLE_TYPE')).toMatchObject({
      objectName: 'ZVPTT01', adtType: 'TTYP/DA',
      create: { status: 'APPLIED' }, cleanup: { status: 'COMPLETED' },
      transport: { objectEntryVerified: true, deletionEntryVerified: true },
      absence: { searchAbsent: true }
    });
    expect(evidence.get('DATABASE_TABLE')).toMatchObject({
      objectName: 'ZVPTAB02', adtType: 'TABL/DT',
      create: { status: 'APPLIED' }, cleanup: { status: 'COMPLETED' },
      transport: { objectEntryVerified: true, deletionEntryVerified: true },
      absence: { searchAbsent: true }
    });
    for (const objectKind of [
      'CDS_DATA_DEFINITION', 'CDS_ACCESS_CONTROL', 'CDS_METADATA_EXTENSION',
      'SERVICE_DEFINITION', 'BEHAVIOR_DEFINITION', 'SERVICE_BINDING'
    ] as const) {
      expect(evidence.get(objectKind)).toMatchObject({
        create: { status: 'APPLIED', preCreationAbsent: true },
        transport: { cleanupMode: 'SAME_OPEN_TRANSPORT_REMOVED', neutralEntriesVerified: true },
        cleanup: { status: 'FAILED_AFTER_ABSENCE', objectDeleted: true },
        absence: { searchAbsent: true, generatedResourcesAbsent: true }
      });
    }
    expect(evidence.get('CHANGE_DOCUMENT_OBJECT')).toMatchObject({
      objectName: 'ZVPCHDO05', adtType: 'CHDO/CHD',
      create: { status: 'APPLIED', preCreationAbsent: true },
      transport: { cleanupMode: 'SAME_OPEN_TRANSPORT_REMOVED', neutralEntriesVerified: true },
      cleanup: { status: 'COMPLETED_LOCAL_ABSENCE', objectDeleted: true },
      absence: { searchAbsent: true, generatedResourcesAbsent: true }
    });
    expect(evidence.get('FUNCTION_MODULE')).toMatchObject({
      objectName: 'ZVPFM11C', adtType: 'FUGR/FF',
      transport: { parentScope: { parentObjectName: 'ZVPFG11', cleanupStatus: 'COMPLETED_LOCAL_ABSENCE', neutralEntryVerified: true } },
      cleanup: { status: 'FAILED_AFTER_ABSENCE', objectDeleted: true, failureStage: 'cleanup-transport' },
      absence: { searchAbsent: true, generatedResourcesAbsent: true }
    });
    expect(evidence.get('FUNCTION_GROUP_INCLUDE')).toMatchObject({
      objectName: 'LZVPFGI13001', adtType: 'FUGR/I',
      transport: { parentScope: { parentObjectName: 'ZVPFGI13', cleanupStatus: 'COMPLETED_LOCAL_ABSENCE', neutralEntryVerified: true } },
      cleanup: { status: 'FAILED_AFTER_ABSENCE', objectDeleted: true, failureStage: 'cleanup-transport' },
      absence: { searchAbsent: true, generatedResourcesAbsent: true }
    });
    for (const objectKind of [
      'PROGRAM', 'MESSAGE_CLASS', 'LOGICAL_EXTERNAL_SCHEMA', 'NUMBER_RANGE_OBJECT',
      'CDS_TYPE', 'CDS_ASPECT', 'SAP_OBJECT_TYPE', 'SAP_OBJECT_NODE_TYPE'
    ] as const) {
      expect(evidence.get(objectKind)).toMatchObject({
        create: { status: 'APPLIED' }, cleanup: { status: 'COMPLETED' },
        transport: { objectEntryVerified: true, deletionEntryVerified: true },
        absence: { searchAbsent: true }
      });
    }
    expect(REPOSITORY_CREATION_MATURITY_EVIDENCE.unresolvedValidationIdentities).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectKind: 'DATA_ELEMENT', objectName: 'ZVDE1', status: 'OUTCOME_UNKNOWN' }),
      expect.objectContaining({ objectKind: 'ABAP_INTERFACE', objectName: 'ZVIF3', status: 'OUTCOME_UNKNOWN' }),
      expect.objectContaining({ objectKind: 'MESSAGE_CLASS', objectName: 'ZVMSG2', status: 'COMPENSATION_FAILED' }),
      expect.objectContaining({ objectKind: 'CHANGE_DOCUMENT_OBJECT', objectName: 'ZVPCHDO04', status: 'CLEANUP_VERIFICATION_FAILED' })
    ]));
  });

  it('rejects REAL_DEV_VERIFIED without complete checked-in evidence', () => {
    expect(() => new RepositoryObjectCreationRegistry([verifiedProgram], {
      schemaVersion: 2, records: [], unresolvedValidationIdentities: []
    })).toThrow('no complete maturity evidence');
  });

  it('accepts an independently created, read, transported, cleaned, and absence-verified identity', () => {
    const manifest = evidenceManifest();
    const registry = new RepositoryObjectCreationRegistry([verifiedProgram], manifest);

    expect(registry.list({ systemRole: 'DEV', toolProfile: 'development' })).toEqual([
      expect.objectContaining({ objectKind: 'PROGRAM', maturity: 'REAL_DEV_VERIFIED', writable: true })
    ]);
  });

  it('accepts complete same-open-transport removal evidence', () => {
    const manifest = evidenceManifest();
    const evidence = manifest.records[0];
    evidence.create.preCreationAbsent = true;
    evidence.transport.cleanupMode = 'SAME_OPEN_TRANSPORT_REMOVED';
    evidence.transport.neutralEntriesVerified = true;
    evidence.transport.transportOpenAtCreate = true;
    evidence.transport.transportOpenAtCleanup = true;
    delete evidence.transport.deletionEntryVerified;
    evidence.cleanup.status = 'FAILED_AFTER_ABSENCE';
    evidence.cleanup.objectDeleted = true;
    evidence.cleanup.failureStage = 'cleanup-transport';
    evidence.absence.generatedResourcesAbsent = true;

    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], manifest)).not.toThrow();
  });

  it.each([
    'preCreationAbsent',
    'neutralEntriesVerified',
    'transportOpenAtCreate',
    'transportOpenAtCleanup',
    'objectDeleted',
    'generatedResourcesAbsent'
  ])('rejects incomplete same-open-transport evidence without %s', missing => {
    const manifest = evidenceManifest();
    const evidence = manifest.records[0] as any;
    evidence.create.preCreationAbsent = true;
    evidence.transport = {
      ...evidence.transport,
      cleanupMode: 'SAME_OPEN_TRANSPORT_REMOVED',
      neutralEntriesVerified: true,
      transportOpenAtCreate: true,
      transportOpenAtCleanup: true
    };
    delete evidence.transport.deletionEntryVerified;
    evidence.cleanup = {
      ...evidence.cleanup,
      status: 'FAILED_AFTER_ABSENCE',
      objectDeleted: true,
      failureStage: 'cleanup-transport'
    };
    evidence.absence.generatedResourcesAbsent = true;
    delete evidence.create[missing];
    delete evidence.transport[missing];
    delete evidence.cleanup[missing];
    delete evidence.absence[missing];

    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], manifest)).toThrow(
      'Same-open-transport maturity evidence is incomplete'
    );
  });

  it('rejects a historical neutral cleanup that failed outside cleanup-transport', () => {
    const manifest = evidenceManifest();
    const evidence = manifest.records[0] as any;
    evidence.create.preCreationAbsent = true;
    evidence.transport = {
      ...evidence.transport,
      cleanupMode: 'SAME_OPEN_TRANSPORT_REMOVED',
      neutralEntriesVerified: true,
      transportOpenAtCreate: true,
      transportOpenAtCleanup: true
    };
    delete evidence.transport.deletionEntryVerified;
    evidence.cleanup = { ...evidence.cleanup, status: 'FAILED_AFTER_ABSENCE', objectDeleted: true };
    evidence.absence.generatedResourcesAbsent = true;

    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], manifest)).toThrow(
      'fail only at cleanup-transport'
    );
  });

  it('requires parent function-group transport evidence for function-group child kinds', () => {
    const includeCapability = {
      ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'FUNCTION_GROUP_INCLUDE')!,
      maturity: 'REAL_DEV_VERIFIED' as const
    };
    const manifest = evidenceManifest();
    const evidence = manifest.records[0] as any;
    evidence.objectKind = 'FUNCTION_GROUP_INCLUDE';
    evidence.adtType = 'FUGR/I';
    evidence.objectName = 'LZVPFGI13001';
    evidence.create.preCreationAbsent = true;
    evidence.transport = {
      ...evidence.transport,
      cleanupMode: 'SAME_OPEN_TRANSPORT_REMOVED',
      neutralEntriesVerified: true,
      transportOpenAtCreate: true,
      transportOpenAtCleanup: true
    };
    delete evidence.transport.deletionEntryVerified;
    evidence.cleanup = {
      ...evidence.cleanup,
      status: 'FAILED_AFTER_ABSENCE',
      objectDeleted: true,
      failureStage: 'cleanup-transport'
    };
    evidence.absence.generatedResourcesAbsent = true;

    expect(() => validateRepositoryCreationMaturityEvidence([includeCapability], manifest)).toThrow(
      'FUNCTION_GROUP_INCLUDE maturity evidence requires parent function-group transport evidence'
    );

    evidence.transport.parentScope = {
      parentObjectName: 'ZVPFGI13',
      cleanupPlanId: 'parent-cleanup-plan',
      cleanupStatus: 'COMPLETED_LOCAL_ABSENCE',
      neutralEntryVerified: true,
      evidenceRef: 'docs/evidence/function-group-include.md#parent'
    };

    expect(() => validateRepositoryCreationMaturityEvidence([includeCapability], manifest)).not.toThrow();
  });

  it.each(['create', 'readback', 'transport', 'cleanup', 'absence'])(
    'fails closed when %s lifecycle evidence is missing',
    phase => {
      const manifest = evidenceManifest();
      delete (manifest.records[0] as unknown as Record<string, unknown>)[phase];

      expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], manifest)).toThrow(`${phase} evidence`);
    }
  );

  it('rejects unresolved historical identities without mutating their original plan status', () => {
    const manifest = evidenceManifest();
    manifest.unresolvedValidationIdentities = [{
      objectKind: 'PROGRAM', objectName: manifest.records[0].objectName,
      planId: 'historical-unknown-plan', status: 'OUTCOME_UNKNOWN', evidenceRef: 'BLOCKED.md#REMOTE_UNKNOWN-TEST'
    }];
    const before = JSON.stringify(manifest);

    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], manifest)).toThrow('unresolved validation identity');
    expect(JSON.stringify(manifest)).toBe(before);
    expect(manifest.unresolvedValidationIdentities[0].status).toBe('OUTCOME_UNKNOWN');
  });

  it('rejects mismatched ADT types, reused plan IDs, and unverified transport cleanup', () => {
    const wrongType = evidenceManifest();
    wrongType.records[0].adtType = 'DOMA/DD';
    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], wrongType)).toThrow('ADT type mismatch');

    const samePlan = evidenceManifest();
    samePlan.records[0].cleanup.planId = samePlan.records[0].create.planId;
    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], samePlan)).toThrow('independent creation and cleanup');

    const missingDeletionEntry = evidenceManifest();
    (missingDeletionEntry.records[0].transport as { deletionEntryVerified: boolean }).deletionEntryVerified = false;
    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], missingDeletionEntry)).toThrow('deletion transport');

    const weakFingerprint = evidenceManifest();
    weakFingerprint.records[0].target.fingerprint = 'dev-client-300';
    expect(() => validateRepositoryCreationMaturityEvidence([verifiedProgram], weakFingerprint)).toThrow('SHA-256');
  });
});

function evidenceManifest(): RepositoryCreationMaturityEvidenceManifest {
  return {
    schemaVersion: 2,
    unresolvedValidationIdentities: [],
    records: [{
      evidenceId: 'program-evidence-1', objectKind: 'PROGRAM', adtType: 'PROG/P', objectName: 'ZVPROG_FRESH',
      create: { planId: 'fresh-create-plan', status: 'APPLIED', evidenceRef: 'docs/evidence/program-create.md' },
      readback: { status: 'ACTIVE_VERIFIED', evidenceRef: 'docs/evidence/program-readback.md' },
      transport: {
        request: 'S4HK900009', packageName: 'Z001', objectEntryVerified: true, deletionEntryVerified: true,
        evidenceRef: 'docs/evidence/program-transport.md'
      },
      cleanup: { planId: 'fresh-cleanup-plan', status: 'COMPLETED', evidenceRef: 'docs/evidence/program-cleanup.md' },
      absence: { searchAbsent: true, evidenceRef: 'docs/evidence/program-absence.md' },
      target: {
        host: 'dev.example.test', client: '300', systemRole: 'DEV',
        fingerprint: 'a'.repeat(64), verifiedAt: '2026-08-25T00:00:00.000Z'
      },
      normalizations: ['SAP-generated trailing newline']
    }]
  };
}
