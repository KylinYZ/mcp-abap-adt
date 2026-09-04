import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  REPOSITORY_OBJECT_KINDS,
  type RepositoryCreationCapabilityDefinition,
  type RepositoryObjectKind
} from './repositoryCreationTypes.js';

export interface RepositoryCreationMaturityEvidenceRecord {
  evidenceId: string;
  objectKind: RepositoryObjectKind;
  adtType: string;
  objectName: string;
  create: { planId: string; status: 'APPLIED'; preCreationAbsent?: true; evidenceRef: string };
  readback: { status: 'ACTIVE_VERIFIED' | 'FINAL_VERIFIED'; evidenceRef: string };
  transport: {
    request: string;
    packageName: string;
    objectEntryVerified: true;
    cleanupMode?: 'DELETION_PROPAGATED' | 'SAME_OPEN_TRANSPORT_REMOVED';
    deletionEntryVerified?: true;
    neutralEntriesVerified?: true;
    transportOpenAtCreate?: true;
    transportOpenAtCleanup?: true;
    parentScope?: {
      parentObjectName: string;
      cleanupPlanId: string;
      cleanupStatus: 'COMPLETED' | 'COMPLETED_LOCAL_ABSENCE';
      neutralEntryVerified: true;
      evidenceRef: string;
    };
    evidenceRef: string;
  };
  cleanup: {
    planId: string;
    status: 'COMPLETED' | 'COMPLETED_LOCAL_ABSENCE' | 'FAILED_AFTER_ABSENCE';
    objectDeleted?: true;
    failureStage?: 'cleanup-transport';
    evidenceRef: string;
  };
  absence: { searchAbsent: true; generatedResourcesAbsent?: true; evidenceRef: string };
  target: {
    host: string;
    client: string;
    systemRole: 'DEV';
    fingerprint: string;
    verifiedAt: string;
  };
  normalizations: string[];
}

export interface UnresolvedRepositoryValidationIdentity {
  objectKind: RepositoryObjectKind;
  objectName: string;
  planId: string;
  status: 'OUTCOME_UNKNOWN' | 'COMPENSATION_FAILED' | 'CLEANUP_VERIFICATION_FAILED';
  evidenceRef: string;
}

export interface RepositoryCreationMaturityEvidenceManifest {
  schemaVersion: 2;
  records: RepositoryCreationMaturityEvidenceRecord[];
  unresolvedValidationIdentities: UnresolvedRepositoryValidationIdentity[];
}

const MANIFEST_PATH = resolve(
  __dirname,
  '../../docs/evidence/repository-creation-maturity-evidence.json'
);

export const REPOSITORY_CREATION_MATURITY_EVIDENCE = loadRepositoryCreationMaturityEvidence();

export function loadRepositoryCreationMaturityEvidence(
  path = MANIFEST_PATH
): RepositoryCreationMaturityEvidenceManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Repository creation maturity evidence could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifestShape(value);
}

export function validateRepositoryCreationMaturityEvidence(
  capabilities: RepositoryCreationCapabilityDefinition[],
  manifest: RepositoryCreationMaturityEvidenceManifest
): Map<RepositoryObjectKind, RepositoryCreationMaturityEvidenceRecord> {
  const validated = validateManifestShape(manifest);
  const capabilitiesByKind = new Map(capabilities.map(capability => [capability.objectKind, capability]));
  const recordsByKind = new Map<RepositoryObjectKind, RepositoryCreationMaturityEvidenceRecord>();
  const evidenceIds = new Set<string>();
  const unresolvedIdentities = new Set<string>();
  for (const identity of validated.unresolvedValidationIdentities) {
    const key = `${identity.objectKind}:${identity.objectName}`;
    if (unresolvedIdentities.has(key)) throw new Error(`Duplicate unresolved validation identity ${key}.`);
    unresolvedIdentities.add(key);
  }

  for (const record of validated.records) {
    const capability = capabilitiesByKind.get(record.objectKind);
    if (!capability) throw new Error(`Maturity evidence references unregistered kind ${record.objectKind}.`);
    if (recordsByKind.has(record.objectKind)) {
      throw new Error(`Maturity evidence contains duplicate kind ${record.objectKind}.`);
    }
    if (evidenceIds.has(record.evidenceId)) throw new Error(`Duplicate maturity evidence ID ${record.evidenceId}.`);
    if (capability.adtType !== record.adtType) {
      throw new Error(`Maturity evidence ADT type mismatch for ${record.objectKind}.`);
    }
    if (capability.maturity !== 'REAL_DEV_VERIFIED') {
      throw new Error(`Maturity evidence exists for ${record.objectKind} before the capability is REAL_DEV_VERIFIED.`);
    }
    if (unresolvedIdentities.has(`${record.objectKind}:${record.objectName}`)) {
      throw new Error(`Maturity evidence reuses unresolved validation identity ${record.objectKind} ${record.objectName}.`);
    }
    recordsByKind.set(record.objectKind, record);
    evidenceIds.add(record.evidenceId);
  }

  for (const capability of capabilities) {
    if (capability.maturity === 'REAL_DEV_VERIFIED' && !recordsByKind.has(capability.objectKind)) {
      throw new Error(`REAL_DEV_VERIFIED capability ${capability.objectKind} has no complete maturity evidence.`);
    }
  }
  return recordsByKind;
}

function validateManifestShape(value: unknown): RepositoryCreationMaturityEvidenceManifest {
  const manifest = record(value, 'Maturity evidence manifest');
  if (manifest.schemaVersion !== 2) throw new Error('Maturity evidence schemaVersion must be 2.');
  if (!Array.isArray(manifest.records) || !Array.isArray(manifest.unresolvedValidationIdentities)) {
    throw new Error('Maturity evidence records and unresolvedValidationIdentities must be arrays.');
  }
  const records = manifest.records.map(validateEvidenceRecord);
  const unresolvedValidationIdentities = manifest.unresolvedValidationIdentities.map(validateUnresolvedIdentity);
  return { schemaVersion: 2, records, unresolvedValidationIdentities };
}

function validateEvidenceRecord(value: unknown): RepositoryCreationMaturityEvidenceRecord {
  const item = record(value, 'Maturity evidence record');
  const create = record(item.create, 'create evidence');
  const readback = record(item.readback, 'readback evidence');
  const transport = record(item.transport, 'transport evidence');
  const cleanup = record(item.cleanup, 'cleanup evidence');
  const absence = record(item.absence, 'absence evidence');
  const target = record(item.target, 'target evidence');
  const objectKind = repositoryObjectKind(item.objectKind);
  const objectName = repositoryName(item.objectName, 'objectName');
  const adtType = boundedString(item.adtType, 'adtType', 40).toUpperCase();
  if (!/^[A-Z0-9_]+\/[A-Z0-9_]+$/.test(adtType)) throw new Error('Maturity evidence adtType is invalid.');
  if (create.status !== 'APPLIED') throw new Error('Maturity evidence create status must be APPLIED.');
  if (!['ACTIVE_VERIFIED', 'FINAL_VERIFIED'].includes(String(readback.status))) {
    throw new Error('Maturity evidence readback status must be ACTIVE_VERIFIED or FINAL_VERIFIED.');
  }
  if (transport.objectEntryVerified !== true || absence.searchAbsent !== true) {
    throw new Error('Maturity evidence creation transport and absence checks must be explicitly true.');
  }
  const cleanupMode = transport.cleanupMode === undefined
    ? 'DELETION_PROPAGATED'
    : String(transport.cleanupMode);
  if (!['DELETION_PROPAGATED', 'SAME_OPEN_TRANSPORT_REMOVED'].includes(cleanupMode)) {
    throw new Error('Maturity evidence cleanup transport mode is invalid.');
  }
  const parentScope = transport.parentScope === undefined ? undefined : record(transport.parentScope, 'transport.parentScope');
  const parentScopedTransportKinds = new Set<RepositoryObjectKind>(['FUNCTION_MODULE', 'FUNCTION_GROUP_INCLUDE']);
  if (parentScopedTransportKinds.has(objectKind) && !parentScope) {
    throw new Error(`${objectKind} maturity evidence requires parent function-group transport evidence.`);
  }
  if (parentScope && !parentScopedTransportKinds.has(objectKind)) {
    throw new Error('Parent transport evidence is supported only for function-group child maturity evidence.');
  }
  if (cleanupMode === 'DELETION_PROPAGATED') {
    if (transport.deletionEntryVerified !== true || cleanup.status !== 'COMPLETED') {
      throw new Error('Deletion-propagated maturity evidence requires completed cleanup and verified deletion transport.');
    }
  } else {
    if (create.preCreationAbsent !== true
      || transport.neutralEntriesVerified !== true
      || transport.transportOpenAtCreate !== true
      || transport.transportOpenAtCleanup !== true
      || cleanup.objectDeleted !== true
      || absence.generatedResourcesAbsent !== true
      || !['COMPLETED_LOCAL_ABSENCE', 'FAILED_AFTER_ABSENCE'].includes(String(cleanup.status))) {
      throw new Error('Same-open-transport maturity evidence is incomplete.');
    }
    if (cleanup.status === 'FAILED_AFTER_ABSENCE' && cleanup.failureStage !== 'cleanup-transport') {
      throw new Error('Historical same-open-transport cleanup must fail only at cleanup-transport.');
    }
  }
  if (create.planId === cleanup.planId) {
    throw new Error('Maturity evidence requires independent creation and cleanup plan identifiers.');
  }
  const normalizedParentScope = parentScope ? {
    parentObjectName: repositoryName(parentScope.parentObjectName, 'transport.parentScope.parentObjectName'),
    cleanupPlanId: boundedString(parentScope.cleanupPlanId, 'transport.parentScope.cleanupPlanId', 128),
    cleanupStatus: String(parentScope.cleanupStatus) as 'COMPLETED' | 'COMPLETED_LOCAL_ABSENCE',
    neutralEntryVerified: true as const,
    evidenceRef: evidenceRef(parentScope.evidenceRef)
  } : undefined;
  if (normalizedParentScope && (normalizedParentScope.cleanupPlanId === cleanup.planId
    || !['COMPLETED', 'COMPLETED_LOCAL_ABSENCE'].includes(normalizedParentScope.cleanupStatus)
    || !normalizedParentScope.neutralEntryVerified)) {
    throw new Error(`${objectKind} parent transport evidence is incomplete.`);
  }
  if (target.systemRole !== 'DEV' || !/^\d{3}$/.test(String(target.client || ''))) {
    throw new Error('Maturity evidence target must be an explicit DEV client.');
  }
  if (!Array.isArray(item.normalizations) || item.normalizations.some(value => typeof value !== 'string' || value.length > 240)) {
    throw new Error('Maturity evidence normalizations must be bounded strings.');
  }
  const verifiedAt = boundedString(target.verifiedAt, 'verifiedAt', 40);
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new Error('Maturity evidence verifiedAt must be an ISO timestamp.');
  const transportRequest = boundedString(transport.request, 'transport.request', 20).toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(transportRequest)) throw new Error('Maturity evidence transport request must contain ten uppercase characters.');
  const targetFingerprint = boundedString(target.fingerprint, 'target.fingerprint', 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(targetFingerprint)) throw new Error('Maturity evidence target fingerprint must be a SHA-256 value.');
  return {
    evidenceId: boundedString(item.evidenceId, 'evidenceId', 128),
    objectKind,
    adtType,
    objectName,
    create: {
      planId: boundedString(create.planId, 'create.planId', 128),
      status: 'APPLIED',
      ...(create.preCreationAbsent === true ? { preCreationAbsent: true } : {}),
      evidenceRef: evidenceRef(create.evidenceRef)
    },
    readback: {
      status: readback.status as 'ACTIVE_VERIFIED' | 'FINAL_VERIFIED',
      evidenceRef: evidenceRef(readback.evidenceRef)
    },
    transport: {
      request: transportRequest,
      packageName: repositoryName(transport.packageName, 'transport.packageName'),
      objectEntryVerified: true,
      cleanupMode: cleanupMode as 'DELETION_PROPAGATED' | 'SAME_OPEN_TRANSPORT_REMOVED',
      ...(transport.deletionEntryVerified === true ? { deletionEntryVerified: true } : {}),
      ...(transport.neutralEntriesVerified === true ? { neutralEntriesVerified: true } : {}),
      ...(transport.transportOpenAtCreate === true ? { transportOpenAtCreate: true } : {}),
      ...(transport.transportOpenAtCleanup === true ? { transportOpenAtCleanup: true } : {}),
      ...(normalizedParentScope ? { parentScope: normalizedParentScope } : {}),
      evidenceRef: evidenceRef(transport.evidenceRef)
    },
    cleanup: {
      planId: boundedString(cleanup.planId, 'cleanup.planId', 128),
      status: cleanup.status as RepositoryCreationMaturityEvidenceRecord['cleanup']['status'],
      ...(cleanup.objectDeleted === true ? { objectDeleted: true } : {}),
      ...(cleanup.failureStage === 'cleanup-transport' ? { failureStage: 'cleanup-transport' as const } : {}),
      evidenceRef: evidenceRef(cleanup.evidenceRef)
    },
    absence: {
      searchAbsent: true,
      ...(absence.generatedResourcesAbsent === true ? { generatedResourcesAbsent: true } : {}),
      evidenceRef: evidenceRef(absence.evidenceRef)
    },
    target: {
      host: boundedString(target.host, 'target.host', 255).toLowerCase(),
      client: String(target.client),
      systemRole: 'DEV',
      fingerprint: targetFingerprint,
      verifiedAt
    },
    normalizations: [...item.normalizations] as string[]
  };
}

function validateUnresolvedIdentity(value: unknown): UnresolvedRepositoryValidationIdentity {
  const item = record(value, 'Unresolved validation identity');
  const status = String(item.status || '');
  if (!['OUTCOME_UNKNOWN', 'COMPENSATION_FAILED', 'CLEANUP_VERIFICATION_FAILED'].includes(status)) {
    throw new Error('Unresolved validation identity status is invalid.');
  }
  return {
    objectKind: repositoryObjectKind(item.objectKind),
    objectName: repositoryName(item.objectName, 'unresolved.objectName'),
    planId: boundedString(item.planId, 'unresolved.planId', 128),
    status: status as UnresolvedRepositoryValidationIdentity['status'],
    evidenceRef: evidenceRef(item.evidenceRef)
  };
}

function repositoryObjectKind(value: unknown): RepositoryObjectKind {
  const objectKind = boundedString(value, 'objectKind', 64).toUpperCase() as RepositoryObjectKind;
  if (!REPOSITORY_OBJECT_KINDS.includes(objectKind)) {
    throw new Error(`Maturity evidence objectKind ${objectKind} is not registered.`);
  }
  return objectKind;
}

function repositoryName(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 128).toUpperCase();
  if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(normalized)) {
    throw new Error(`${field} is not a valid repository name.`);
  }
  return normalized;
}

function evidenceRef(value: unknown): string {
  const reference = boundedString(value, 'evidenceRef', 512);
  if (/^https?:/i.test(reference) || reference.includes('..')) {
    throw new Error('Maturity evidence references must be repository-local paths or stable evidence IDs.');
  }
  return reference;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a non-empty bounded string.`);
  }
  return value.trim();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
