import { RepositoryObjectCreationRegistry } from '../safe/RepositoryObjectCreationRegistry';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';
import type { RepositoryCreationCapabilityDefinition } from '../safe/repositoryCreationTypes';

const developmentContext = { systemRole: 'DEV', toolProfile: 'development' as const };

function verifiedProgram(): RepositoryCreationCapabilityDefinition {
  return {
    ...INITIAL_REPOSITORY_CREATION_CAPABILITIES.find(capability => capability.objectKind === 'PROGRAM')!,
    maturity: 'REAL_DEV_VERIFIED'
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
    const registry = new RepositoryObjectCreationRegistry([verifiedProgram()]);

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
    }]);
    expect(unavailable.list(developmentContext)[0]).toMatchObject({
      available: false, writable: false, unavailableReason: 'Required ADT resource is missing.'
    });
  });

  it('keeps all automated initial kinds visible but non-writable before real DEV verification', () => {
    const registry = new RepositoryObjectCreationRegistry(INITIAL_REPOSITORY_CREATION_CAPABILITIES);
    const capabilities = registry.list(developmentContext);

    expect(capabilities).toHaveLength(31);
    expect(capabilities.every(capability => capability.writable === false)).toBe(true);
    expect(capabilities.find(capability => capability.objectKind === 'DATABASE_TABLE')).toMatchObject({
      maturity: 'AUTOMATION_VERIFIED',
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'DDIC_STRUCTURE')).toMatchObject({
      adtType: 'TABL/DS', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'CDS_METADATA_EXTENSION')).toMatchObject({
      adtType: 'DDLX/EX', maturity: 'AUTOMATION_VERIFIED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'BEHAVIOR_DEFINITION')).toMatchObject({
      adtType: 'BDEF/BDO', maturity: 'AUTOMATION_VERIFIED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'CDS_ANNOTATION_DEFINITION')).toMatchObject({
      adtType: 'DDLA/ADF', maturity: 'AUTOMATION_VERIFIED', available: true, writable: false
    });
    expect(capabilities.find(capability => capability.objectKind === 'SERVICE_DEFINITION')).toMatchObject({
      adtType: 'SRVD/SRV', maturity: 'AUTOMATION_VERIFIED', available: true, writable: false
    });
    expect(capabilities.find(capability => capability.objectKind === 'LOGICAL_EXTERNAL_SCHEMA')).toMatchObject({
      adtType: 'DESD/TYP', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'NUMBER_RANGE_OBJECT')).toMatchObject({
      adtType: 'NROB/NRO', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'SAP_OBJECT_TYPE')).toMatchObject({
      adtType: 'RONT/ROT', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'SAP_OBJECT_NODE_TYPE')).toMatchObject({
      adtType: 'NONT/NOT', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
    expect(capabilities.find(capability => capability.objectKind === 'CHANGE_DOCUMENT_OBJECT')).toMatchObject({
      adtType: 'CHDO/CHD', maturity: 'CONTROLLED_IMPLEMENTED', available: true, writable: false,
      unavailableReason: expect.stringContaining('REAL_DEV_VERIFIED')
    });
  });
});
