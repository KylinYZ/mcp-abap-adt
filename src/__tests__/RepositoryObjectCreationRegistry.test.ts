import { RepositoryObjectCreationRegistry } from '../safe/RepositoryObjectCreationRegistry';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';
import type { RepositoryCreationCapabilityDefinition } from '../safe/repositoryCreationTypes';
import type { RepositoryCreationMaturityEvidenceManifest } from '../safe/RepositoryCreationMaturityEvidence';

const developmentContext = { systemRole: 'DEV', toolProfile: 'development' as const };

function verifiedProgram(): RepositoryCreationCapabilityDefinition {
  return {
    ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'PROGRAM')!,
    maturity: 'REAL_DEV_VERIFIED'
  };
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

describe('RepositoryObjectCreationRegistry', () => {
  it('lists stable sorted capabilities without exposing mutable registry state', () => {
    const registry = new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES);
    const first = registry.list(developmentContext);
    const second = registry.list(developmentContext);

    expect(first.map(capability => capability.objectKind)).toEqual([
      'ABAP_CLASS', 'ABAP_INTERFACE', 'BEHAVIOR_DEFINITION', 'CDS_ACCESS_CONTROL',
      'CDS_ANNOTATION_DEFINITION', 'CDS_ASPECT', 'CDS_DATA_DEFINITION', 'CDS_ENTITY_BUFFER', 'CDS_METADATA_EXTENSION', 'CDS_TYPE', 'CHANGE_DOCUMENT_OBJECT',
      'DATA_ELEMENT', 'DATABASE_TABLE', 'DDIC_DOMAIN', 'DDIC_LOCK_OBJECT', 'DDIC_STRUCTURE', 'DDIC_TABLE_TYPE', 'DDIC_TYPE_GROUP', 'FUNCTION_GROUP', 'FUNCTION_GROUP_INCLUDE', 'FUNCTION_MODULE', 'LOGICAL_EXTERNAL_SCHEMA', 'MESSAGE_CLASS', 'NUMBER_RANGE_OBJECT',
      'PACKAGE', 'PROGRAM', 'PROGRAM_INCLUDE', 'SAP_OBJECT_NODE_TYPE', 'SAP_OBJECT_TYPE', 'SERVICE_BINDING', 'SERVICE_DEFINITION'
    ]);
    expect(first).toEqual(second);
    first[0].evidenceSources.length = 0;
    expect(registry.list(developmentContext)[0].evidenceSources.length).toBeGreaterThan(0);
  });

  it('rejects duplicate object kinds and ADT types', () => {
    const definition = verifiedProgram();
    expect(() => new RepositoryObjectCreationRegistry([definition, definition]))
      .toThrow("Repository creation kind 'PROGRAM' is already registered.");
    expect(() => new RepositoryObjectCreationRegistry([
      definition,
      { ...definition, objectKind: 'PACKAGE' }
    ])).toThrow("Repository creation ADT type 'PROG/P' is already registered.");
  });

  it('fails closed for unknown kinds and supports normalized ADT lookup', () => {
    const registry = new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES);
    expect(() => registry.describe('unknown', developmentContext))
      .toThrow("Repository creation kind 'UNKNOWN' is not registered.");
    expect(registry.findByAdtType(' tabl/dt ', developmentContext)).toMatchObject({
      objectKind: 'DATABASE_TABLE', adtType: 'TABL/DT'
    });
  });

  it('requires target availability, REAL_DEV_VERIFIED, DEV, and an approved profile for writable=true', () => {
    const registry = new RepositoryObjectCreationRegistry([verifiedProgram()], verifiedProgramEvidence());

    expect(registry.list(developmentContext)[0]).toMatchObject({ writable: true, available: true });
    expect(registry.list({ systemRole: 'QAS', toolProfile: 'development' })[0]).toMatchObject({
      writable: false,
      unavailableReason: 'Write support requires SAP_MCP_SYSTEM_ROLE=DEV.'
    });
    expect(registry.list({ systemRole: 'DEV', toolProfile: 'safe' })[0]).toMatchObject({
      writable: false,
      unavailableReason: 'Write support requires the development or development-workbench profile.'
    });

    const unavailable = new RepositoryObjectCreationRegistry([{
      ...verifiedProgram(), targetAvailable: false, targetUnavailableReason: 'Required ADT resource is missing.'
    }], verifiedProgramEvidence());
    expect(unavailable.list(developmentContext)[0]).toMatchObject({
      available: false, writable: false, unavailableReason: 'Required ADT resource is missing.'
    });
  });

  it('enables only evidence-backed kinds and keeps all others non-writable', () => {
    const registry = new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES);
    const capabilities = registry.list(developmentContext);

    expect(capabilities).toHaveLength(31);
    expect(capabilities.filter(capability => capability.writable).map(capability => capability.objectKind)).toEqual([
      'ABAP_INTERFACE',
      'BEHAVIOR_DEFINITION', 'CDS_ACCESS_CONTROL', 'CDS_ASPECT', 'CDS_DATA_DEFINITION',
      'CDS_METADATA_EXTENSION', 'CDS_TYPE', 'CHANGE_DOCUMENT_OBJECT', 'DATA_ELEMENT', 'DATABASE_TABLE', 'DDIC_DOMAIN', 'DDIC_TABLE_TYPE',
      'DDIC_TYPE_GROUP', 'FUNCTION_GROUP', 'FUNCTION_GROUP_INCLUDE', 'FUNCTION_MODULE', 'LOGICAL_EXTERNAL_SCHEMA', 'MESSAGE_CLASS', 'NUMBER_RANGE_OBJECT', 'PACKAGE', 'PROGRAM',
      'PROGRAM_INCLUDE', 'SAP_OBJECT_NODE_TYPE', 'SAP_OBJECT_TYPE', 'SERVICE_BINDING', 'SERVICE_DEFINITION'
    ]);
    expect(capabilities.find(capability => capability.objectKind === 'DDIC_DOMAIN')).toMatchObject({
      adtType: 'DOMA/DD', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'DATA_ELEMENT')).toMatchObject({
      adtType: 'DTEL/DE', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'DDIC_TABLE_TYPE')).toMatchObject({
      adtType: 'TTYP/DA', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'DATABASE_TABLE')).toMatchObject({
      adtType: 'TABL/DT', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'DDIC_STRUCTURE')).toMatchObject({
      adtType: 'TABL/DS', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'CDS_METADATA_EXTENSION')).toMatchObject({
      adtType: 'DDLX/EX', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'BEHAVIOR_DEFINITION')).toMatchObject({
      adtType: 'BDEF/BDO', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'CDS_ANNOTATION_DEFINITION')).toMatchObject({
      adtType: 'DDLA/ADF', maturity: 'AUTOMATION_VERIFIED', available: true, writable: false
    });
    expect(capabilities.find(capability => capability.objectKind === 'SERVICE_DEFINITION')).toMatchObject({
      adtType: 'SRVD/SRV', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'SERVICE_BINDING')).toMatchObject({
      adtType: 'SRVB/SVB', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'LOGICAL_EXTERNAL_SCHEMA')).toMatchObject({
      adtType: 'DESD/TYP', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'NUMBER_RANGE_OBJECT')).toMatchObject({
      adtType: 'NROB/NRO', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'SAP_OBJECT_TYPE')).toMatchObject({
      adtType: 'RONT/ROT', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'CHANGE_DOCUMENT_OBJECT')).toMatchObject({
      adtType: 'CHDO/CHD', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
    expect(capabilities.find(capability => capability.objectKind === 'SAP_OBJECT_NODE_TYPE')).toMatchObject({
      adtType: 'NONT/NOT', maturity: 'REAL_DEV_VERIFIED', available: true, writable: true
    });
  });
});
