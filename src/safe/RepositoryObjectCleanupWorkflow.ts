import { createHash } from 'crypto';
import type { AbapObjectStructure, SearchResult, TransportInfo, TransportObject, TransportRequest } from '../adt/index.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { RepositoryObjectCleanupPlanStore } from './RepositoryObjectCleanupPlanStore.js';
import type { RepositoryObjectCreationRegistry } from './RepositoryObjectCreationRegistry.js';
import type { RepositoryCreationContext, RepositoryObjectKind } from './repositoryCreationTypes.js';
import type { RepositoryCleanupPlan, RepositoryCleanupPlanView, RepositoryCleanupResource } from './repositoryCleanupTypes.js';

interface RepositoryCleanupAdtClient {
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  objectStructure(objectUrl: string, version?: 'active' | 'inactive' | 'workingArea'): Promise<AbapObjectStructure>;
  getObjectSource(objectSourceUrl: string, options?: { version?: 'active' | 'inactive' | 'workingArea' }): Promise<string>;
  readControlledPackage(packageName: string): Promise<{ name: string; parentPackageName?: string }>;
  transportInfo(objectUrl: string, devClass?: string, operation?: string): Promise<TransportInfo>;
  transportDetails(transportNumber: string): Promise<TransportRequest>;
  lock(objectUrl: string, accessMode?: string): Promise<{ LOCK_HANDLE: string }>;
  unLock(objectUrl: string, lockHandle: string): Promise<string>;
  deleteObject(objectUrl: string, lockHandle: string, transport?: string): Promise<void>;
}

class RepositoryCleanupOutcomeUnknownError extends Error {}
type CleanupTransportDisposition = 'DELETION_ENTRY_VERIFIED' | 'NEUTRAL_ENTRIES_VERIFIED';

export class RepositoryObjectCleanupWorkflow {
  constructor(
    private readonly client: RepositoryCleanupAdtClient,
    private readonly registry: RepositoryObjectCreationRegistry,
    private readonly context: RepositoryCreationContext,
    private readonly plans: RepositoryObjectCleanupPlanStore
  ) {}

  async preview(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertValidationContext();
    const objectKind = String(request.objectKind || '').trim().toUpperCase() as RepositoryObjectKind;
    const objectName = repositoryName(request.name, 'name');
    const parentName = request.parentName === undefined ? undefined : repositoryName(request.parentName, 'parentName');
    this.assertValidationIdentity(objectKind, objectName, parentName);
    const capability = this.registry.describe(objectKind, this.context);
    const target = await this.resolveResource(objectKind, objectName, capability.adtType, undefined, parentName);
    const resources: RepositoryCleanupResource[] = [];

    // A root SAP object type owns its same-name node; freeze child-first deletion server-side.
    if (objectKind === 'SAP_OBJECT_TYPE') {
      const nodeCapability = this.registry.findByAdtType('NONT/NOT', this.context);
      if (nodeCapability && this.context.realDevValidationObjects?.includes('SAP_OBJECT_NODE_TYPE')) {
        const node = await this.findExact(objectName, 'NONT/NOT');
        if (node) resources.push(await this.resolveResource('SAP_OBJECT_NODE_TYPE', objectName, 'NONT/NOT', node));
      }
    }
    if (objectKind === 'CHANGE_DOCUMENT_OBJECT') {
      const generatedName = await this.readGeneratedChangeDocumentClass(target);
      const generated = await this.findExact(generatedName, 'CLAS/OC');
      if (!generated) {
        throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-generated', `Generated class ${generatedName} does not exist.`);
      }
      resources.push({
        ...(await this.resolveResource('ABAP_CLASS', generatedName, 'CLAS/OC', generated)),
        cleanupMode: 'CASCADE_VERIFY'
      });
    }
    if (objectKind === 'SERVICE_BINDING') {
      target.transportCompanionKeys = await this.resolveTransportCompanionKeys(target, ['G4BA']);
    }
    resources.push(target);
    const prepared = {
      target,
      resources,
      transportRequest: String(this.context.realDevValidationTransport || ''),
      dependencySummary: resources.map(resource => `${resource.objectKind} ${resource.objectName}`),
      summary: `Delete validation object${resources.length === 1 ? '' : 's'} ${resources.map(resource => `${resource.objectKind} ${resource.objectName}`).join(' -> ')}.`
    };
    const serialized = JSON.stringify(prepared);
    const plan = this.plans.create(this.context, prepared, {
      payloadHash: createHash('sha256').update(serialized).digest('hex'),
      payloadBytes: Buffer.byteLength(serialized, 'utf8')
    });
    return {
      status: 'preview',
      plan,
      review: {
        objectKind,
        objectName,
        packageName: target.packageName,
        transportRequest: prepared.transportRequest,
        cleanupOrder: plan.cleanupOrder
      },
      confirmationRequired: true
    };
  }

  status(cleanupPlanId: string): RepositoryCleanupPlanView {
    this.assertValidationContext();
    return this.plans.view(cleanupPlanId, this.context);
  }

  async apply(cleanupPlanId: string): Promise<Record<string, unknown>> {
    this.assertValidationContext();
    const previewed = this.plans.view(cleanupPlanId, this.context);
    this.assertValidationIdentity(previewed.target.objectKind, previewed.target.objectName, previewed.target.parentName);
    const plan = this.plans.begin(cleanupPlanId, this.context);
    const resources = [...(plan.resources || [])];
    try {
      for (const resource of resources) {
        await this.revalidateResource(resource);
        this.record(plan, 'IDENTITY_REVALIDATED', true, `${resource.objectKind} ${resource.objectName}`);
        if (resource.cleanupMode === 'CASCADE_VERIFY') continue;
        await this.deleteResource(plan, resource);
        await this.assertAbsent(resource);
        this.record(plan, 'ABSENCE_VERIFIED', true, `${resource.objectKind} ${resource.objectName}`);
      }
      for (const resource of resources.filter(item => item.cleanupMode === 'CASCADE_VERIFY')) {
        await this.assertAbsent(resource);
        this.record(plan, 'CASCADE_ABSENCE_VERIFIED', true, `${resource.objectKind} ${resource.objectName}`);
      }
      const dispositions: CleanupTransportDisposition[] = [];
      for (const resource of resources) {
        const disposition = await this.classifyTransportEvidence(resource, plan.transportRequest);
        dispositions.push(disposition);
        this.record(
          plan,
          disposition === 'DELETION_ENTRY_VERIFIED'
            ? 'TRANSPORT_DELETION_ENTRY_VERIFIED'
            : 'TRANSPORT_NEUTRAL_ENTRY_VERIFIED',
          true,
          `${resource.objectKind} ${resource.objectName}`
        );
      }
      if (new Set(dispositions).size !== 1) {
        throw new SafeAbapError(
          'VERIFICATION_FAILED',
          'cleanup-transport',
          'Repository cleanup transport evidence mixes deletion and neutral object entries.'
        );
      }
      const resultSummary = `Deleted and verified ${resources.map(resource => `${resource.objectKind} ${resource.objectName}`).join(', ')}.`;
      const transportDisposition = dispositions[0] || 'DELETION_ENTRY_VERIFIED';
      return {
        status: 'success',
        plan: this.plans.settle(
          plan.cleanupPlanId,
          transportDisposition === 'DELETION_ENTRY_VERIFIED' ? 'COMPLETED' : 'COMPLETED_LOCAL_ABSENCE',
          { resultSummary, transportDisposition }
        )
      };
    } catch (error) {
      if (error instanceof RepositoryCleanupOutcomeUnknownError) {
        const settled = this.plans.settle(plan.cleanupPlanId, 'OUTCOME_UNKNOWN', {
          primaryError: { code: 'UNKNOWN_OUTCOME', stage: 'cleanup-delete', message: errorMessage(error) }
        });
        throw new SafeAbapError('UNKNOWN_OUTCOME', 'cleanup-delete', 'The remote deletion outcome is unknown; no retry or parent deletion was attempted.', { plan: settled });
      }
      const safeError = error instanceof SafeAbapError
        ? error
        : new SafeAbapError('VERIFICATION_FAILED', 'cleanup', `Repository cleanup failed: ${errorMessage(error)}`);
      const settled = this.plans.settle(plan.cleanupPlanId, 'FAILED', {
        primaryError: { code: safeError.code, stage: safeError.stage, message: safeError.message }
      });
      throw new SafeAbapError(safeError.code, safeError.stage, safeError.message, { ...safeError.details, plan: settled });
    }
  }

  private assertValidationContext(): void {
    if (this.context.realDevValidationEnabled !== true
      || this.context.systemRole !== 'DEV'
      || !['development', 'development-workbench'].includes(this.context.toolProfile)
      || !this.context.realDevValidationPrefix
      || !this.context.realDevValidationPackage
      || !this.context.realDevValidationTransport) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-policy', 'Repository cleanup is available only during bounded DEV validation.');
    }
  }

  private assertValidationIdentity(objectKind: RepositoryObjectKind, objectName: string, parentName?: string): void {
    const prefix = String(this.context.realDevValidationPrefix || '');
    const nameMatches = objectKind === 'FUNCTION_GROUP_INCLUDE'
      ? Boolean(parentName?.startsWith(prefix) && objectName.startsWith('L'))
      : objectKind === 'DDIC_LOCK_OBJECT'
        ? objectName.startsWith(`E${prefix}`)
        : objectName.startsWith(prefix);
    if (!this.context.realDevValidationObjects?.includes(objectKind) || !nameMatches) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-policy', 'Cleanup accepts only the configured validation kinds and object-name prefix.');
    }
  }

  private async resolveResource(
    objectKind: RepositoryObjectKind,
    objectName: string,
    adtType: string,
    existing?: SearchResult,
    parentName?: string
  ): Promise<RepositoryCleanupResource> {
    const result = existing || await this.findExact(objectName, adtType);
    if (!result) {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-search', `${objectKind} ${objectName} does not exist.`);
    }
    let packageName = String(result['adtcore:packageName'] || '').toUpperCase();
    if (objectKind === 'PACKAGE') {
      const packageDocument = await this.client.readControlledPackage(objectName);
      if (packageDocument.name.toUpperCase() !== objectName
        || String(packageDocument.parentPackageName || '').toUpperCase() !== this.context.realDevValidationPackage) {
        throw new SafeAbapError('POLICY_DENIED', 'cleanup-package', 'The package is not a direct child of the configured validation package.');
      }
      const members = await this.client.searchObject(objectName, undefined, 200);
      const nonEmptyMembers = members.filter(item => (
        String(item['adtcore:name'] || '').toUpperCase() !== objectName
        && String(item['adtcore:packageName'] || '').toUpperCase() === objectName
      ));
      if (nonEmptyMembers.length > 0) {
        throw new SafeAbapError('POLICY_DENIED', 'cleanup-package', 'The package is not empty.');
      }
      packageName = objectName;
    } else if (packageName !== this.context.realDevValidationPackage) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-package', 'The object does not belong to the configured validation package.');
    }
    const objectUrl = result['adtcore:uri'];
    const structure = await this.client.objectStructure(objectUrl, 'active');
    const metadata = structure.metaData;
    if (String(metadata['adtcore:name'] || '').toUpperCase() !== objectName
      || String(metadata['adtcore:type'] || '').toUpperCase() !== adtType) {
      throw new SafeAbapError('STATE_DRIFT', 'cleanup-structure', 'SAP returned a different repository object identity.');
    }
    const transportPackage = objectKind === 'PACKAGE' ? this.context.realDevValidationPackage : packageName;
    const info = await this.client.transportInfo(objectUrl, transportPackage, 'I');
    assertTransportOwnership(info, String(this.context.realDevValidationTransport || ''), objectName, objectKind, parentName);
    const details = await this.client.transportDetails(String(this.context.realDevValidationTransport || ''));
    assertTransportOpen(details);
    const transportIdentityAliases = objectKind === 'FUNCTION_MODULE'
      ? transportLockKeyAlias(info)
      : undefined;
    return {
      objectKind,
      objectName,
      ...(parentName ? { parentName } : {}),
      adtType,
      objectUrl,
      packageName,
      version: String(metadata['adtcore:version'] || ''),
      transportProgramId: String(info.PGMID || info.LOCKS?.OBJECT_KEY?.PGMID || ''),
      transportObjectType: String(info.OBJECT || info.LOCKS?.OBJECT_KEY?.OBJECT || ''),
      transportObjectName: String(info.OBJECTNAME || info.LOCKS?.OBJECT_KEY?.OBJ_NAME || objectName).toUpperCase(),
      ...(transportIdentityAliases ? { transportIdentityAliases } : {})
    };
  }

  private async readGeneratedChangeDocumentClass(resource: RepositoryCleanupResource): Promise<string> {
    const structure = await this.client.objectStructure(resource.objectUrl, 'active');
    const source = (structure.links || []).find(link => (
      link.rel === 'http://www.sap.com/adt/relations/source'
      && String(link.type || '').split(';')[0].trim().toLowerCase() === 'application/json'
    ));
    if (!source?.href) {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-generated', 'Active Change Document Object did not expose its JSON source link.');
    }
    const contentUrl = new URL(source.href, `https://adt.invalid${resource.objectUrl}`).pathname;
    const content = await this.client.getObjectSource(contentUrl, { version: 'active' });
    let generatedObject = '';
    try {
      const parsed = JSON.parse(content) as { generalInformation?: { generatedObject?: unknown } };
      generatedObject = String(parsed.generalInformation?.generatedObject || '').toUpperCase();
    } catch {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-generated', 'Active Change Document Object JSON is unreadable.');
    }
    if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]{0,29}$/.test(generatedObject)) {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-generated', 'Active Change Document Object did not expose a valid generated class name.');
    }
    return generatedObject;
  }

  private async revalidateResource(resource: RepositoryCleanupResource): Promise<void> {
    const current = await this.resolveResource(
      resource.objectKind,
      resource.objectName,
      resource.adtType,
      undefined,
      resource.parentName
    );
    current.cleanupMode = resource.cleanupMode || 'DIRECT';
    if (resource.transportCompanionKeys?.length) {
      current.transportCompanionKeys = await this.resolveTransportCompanionKeys(
        current,
        resource.transportCompanionKeys.map(key => key.objectType)
      );
    }
    const frozen = { ...resource, cleanupMode: resource.cleanupMode || 'DIRECT' };
    if (stableJson(current) !== stableJson(frozen)) {
      throw new SafeAbapError('STATE_DRIFT', 'cleanup-revalidate', 'Object identity, package, version, or transport changed after cleanup preview.');
    }
  }

  private async resolveTransportCompanionKeys(
    resource: RepositoryCleanupResource,
    allowedTypes: string[]
  ): Promise<NonNullable<RepositoryCleanupResource['transportCompanionKeys']>> {
    const details = await this.client.transportDetails(String(this.context.realDevValidationTransport || ''));
    assertTransportOpen(details);
    const entries = [...(details.objects || []), ...(details.tasks || []).flatMap(task => task.objects || [])];
    const normalizedTypes = new Set(allowedTypes.map(item => item.toUpperCase()));
    const matches = entries.filter(entry => (
      String(entry['tm:name'] || '').toUpperCase() === resource.objectName
      && normalizedTypes.has(String(entry['tm:type'] || '').toUpperCase())
    ));
    if (matches.length !== allowedTypes.length) {
      throw new SafeAbapError(
        'VERIFICATION_FAILED',
        'cleanup-transport',
        'Repository cleanup could not freeze the expected generated transport companion keys.'
      );
    }
    return matches.map(entry => ({
      programId: String(entry['tm:pgmid'] || 'R3TR').toUpperCase(),
      objectType: String(entry['tm:type'] || '').toUpperCase(),
      objectName: String(entry['tm:name'] || '').toUpperCase()
    }));
  }

  private async deleteResource(plan: RepositoryCleanupPlan, resource: RepositoryCleanupResource): Promise<void> {
    let lockHandle = '';
    try {
      const lock = await this.client.lock(resource.objectUrl, 'MODIFY');
      lockHandle = String(lock.LOCK_HANDLE || '');
      if (!lockHandle) throw new SafeAbapError('LOCK_FAILED', 'cleanup-lock', 'SAP did not return a cleanup lock handle.');
      this.record(plan, 'OBJECT_LOCKED', true, `${resource.objectKind} ${resource.objectName}`);
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      throw new SafeAbapError('LOCK_FAILED', 'cleanup-lock', `Failed to lock the validation object: ${errorMessage(error)}`);
    }

    try {
      await this.client.deleteObject(resource.objectUrl, lockHandle, plan.transportRequest);
      this.record(plan, 'OBJECT_DELETED', true, `${resource.objectKind} ${resource.objectName}`);
    } catch (error) {
      // A failed DELETE can already have reached SAP; never replay it or continue with parent resources.
      try {
        await this.client.unLock(resource.objectUrl, lockHandle);
        this.record(plan, 'OBJECT_UNLOCKED_AFTER_DELETE_FAILURE', true, `${resource.objectKind} ${resource.objectName}`);
      } catch {
        this.record(plan, 'OBJECT_UNLOCK_AFTER_DELETE_FAILURE', false, `${resource.objectKind} ${resource.objectName}`);
      }
      throw new RepositoryCleanupOutcomeUnknownError(errorMessage(error));
    }
  }

  private async assertAbsent(resource: RepositoryCleanupResource): Promise<void> {
    if (await this.findExact(resource.objectName, resource.adtType)) {
      throw new SafeAbapError('VERIFICATION_FAILED', 'cleanup-absence', 'The deleted validation object is still present in SAP search.');
    }
  }

  private async classifyTransportEvidence(resource: RepositoryCleanupResource, transportRequest: string): Promise<CleanupTransportDisposition> {
    const details = await this.client.transportDetails(transportRequest);
    assertTransportOpen(details);
    const entries = [...(details.objects || []), ...(details.tasks || []).flatMap(task => task.objects || [])];
    const keyGroups = buildCleanupTransportKeyGroups(resource, [{
      programId: resource.transportProgramId || 'R3TR',
      objectType: resource.transportObjectType || resource.adtType.split('/')[0],
      objectName: resource.transportObjectName
    }, ...(resource.transportCompanionKeys || [])]);
    const dispositions = keyGroups.map(keys => classifyTransportKeyGroup(entries, keys));
    if (dispositions.every(item => item === 'DELETION_ENTRY_VERIFIED')) return 'DELETION_ENTRY_VERIFIED';
    if (dispositions.every(item => item === 'NEUTRAL_ENTRIES_VERIFIED')) return 'NEUTRAL_ENTRIES_VERIFIED';
    throw new SafeAbapError(
      'VERIFICATION_FAILED',
      'cleanup-transport',
      'Repository cleanup transport keys do not share one consistent deletion or neutral disposition.'
    );
  }

  private async findExact(objectName: string, adtType: string): Promise<SearchResult | undefined> {
    const searchType = adtType === 'FUGR/FF' || adtType === 'FUGR/I' ? undefined : adtType;
    const candidates = await this.client.searchObject(objectName, searchType, 20);
    const exact = candidates.filter(candidate => (
      String(candidate['adtcore:name'] || '').toUpperCase() === objectName
      && String(candidate['adtcore:type'] || '').toUpperCase() === adtType
    ));
    if (exact.length > 1) {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-search', 'SAP returned more than one exact repository object identity.');
    }
    return exact[0];
  }

  private record(plan: RepositoryCleanupPlan, stage: string, success: boolean, message?: string): void {
    this.plans.recordStage(plan.cleanupPlanId, stage, success, message);
  }
}

function classifyTransportKey(
  entries: TransportObject[],
  key: { programId: string; objectType: string; objectName: string }
): CleanupTransportDisposition {
  const matching = entries.filter(entry => (
    String(entry['tm:pgmid'] || 'R3TR').toUpperCase() === key.programId.toUpperCase()
    && String(entry['tm:type'] || '').toUpperCase() === key.objectType.toUpperCase()
    && String(entry['tm:name'] || '').toUpperCase() === key.objectName.toUpperCase()
  ));
  const deletions = matching.filter(entry => String(entry['tm:obj_func'] || '').toUpperCase() === 'D');
  if (deletions.length === 1) return 'DELETION_ENTRY_VERIFIED';
  if (deletions.length === 0
    && matching.length === 1
    && String(matching[0]['tm:obj_func'] || '') === '') {
    return 'NEUTRAL_ENTRIES_VERIFIED';
  }
  throw new SafeAbapError(
    'VERIFICATION_FAILED',
    'cleanup-transport',
    'The validation transport must retain exactly one matching deletion entry or one neutral same-transport entry after cleanup.'
  );
}

function buildCleanupTransportKeyGroups(
  resource: RepositoryCleanupResource,
  keys: Array<{ programId: string; objectType: string; objectName: string }>
): Array<Array<{ programId: string; objectType: string; objectName: string }>> {
  const groups: Array<Array<{ programId: string; objectType: string; objectName: string }>> = [];
  for (const key of keys) {
    groups.push(expandCleanupTransportKeyAliases(resource, key));
  }
  return groups;
}

function expandCleanupTransportKeyAliases(
  resource: RepositoryCleanupResource,
  key: { programId: string; objectType: string; objectName: string }
): Array<{ programId: string; objectType: string; objectName: string }> {
  const normalized = {
    programId: String(key.programId || '').toUpperCase(),
    objectType: String(key.objectType || '').toUpperCase(),
    objectName: String(key.objectName || '').toUpperCase()
  };
  const aliases = [normalized];
  if (resource.objectKind === 'FUNCTION_GROUP' || resource.objectKind === 'FUNCTION_MODULE') {
    const aliasProgramId = normalized.programId === 'R3TR'
      ? 'LIMU'
      : normalized.programId === 'LIMU'
        ? 'R3TR'
        : '';
    if (aliasProgramId) {
      aliases.push({ ...normalized, programId: aliasProgramId });
    }
  }
  if (resource.objectKind === 'FUNCTION_GROUP' && normalized.objectName) {
    const aliasName = normalized.objectName.startsWith('SAPL')
      ? normalized.objectName.slice(4)
      : `SAPL${normalized.objectName}`;
    if (aliasName && aliasName !== normalized.objectName) {
      aliases.push({ ...normalized, objectName: aliasName });
    }
    if (normalized.objectType === 'REPS') {
      aliases.push({ programId: 'R3TR', objectType: 'FUGR', objectName: normalized.objectName.startsWith('SAPL') ? aliasName : normalized.objectName });
    }
  }
  if (resource.objectKind === 'FUNCTION_MODULE' && resource.parentName) {
    aliases.push(...(resource.transportIdentityAliases || []));
  }
  return aliases;
}

function classifyTransportKeyGroup(
  entries: TransportObject[],
  keys: Array<{ programId: string; objectType: string; objectName: string }>
): CleanupTransportDisposition {
  const matching = entries.filter(entry => (
    keys.some(key => transportKeyMatches(entry, key))
  ));
  const deletions = matching.filter(entry => String(entry['tm:obj_func'] || '').toUpperCase() === 'D');
  if (deletions.length === 1) return 'DELETION_ENTRY_VERIFIED';
  if (deletions.length === 0
    && matching.length === 1
    && String(matching[0]['tm:obj_func'] || '') === '') {
    return 'NEUTRAL_ENTRIES_VERIFIED';
  }
  throw new SafeAbapError(
    'VERIFICATION_FAILED',
    'cleanup-transport',
    'The validation transport must retain exactly one matching deletion entry or one neutral same-transport entry after cleanup.'
  );
}

function transportKeyMatches(
  entry: TransportObject,
  key: { programId: string; objectType: string; objectName: string }
): boolean {
  return String(entry['tm:pgmid'] || 'R3TR').toUpperCase() === key.programId.toUpperCase()
    && String(entry['tm:type'] || '').toUpperCase() === key.objectType.toUpperCase()
    && String(entry['tm:name'] || '').toUpperCase() === key.objectName.toUpperCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertTransportOwnership(
  info: TransportInfo,
  transportRequest: string,
  objectName: string,
  objectKind?: RepositoryObjectKind,
  parentName?: string
): void {
  const transportIds = [
    info.LOCKS?.HEADER?.TRKORR,
    ...(info.LOCKS?.TASKS || []).map(task => task.TRKORR),
    ...(info.TRANSPORTS || []).map(transport => transport.TRKORR)
  ].filter(Boolean).map(value => String(value).toUpperCase());
  const lockedObjectName = String(info.LOCKS?.OBJECT_KEY?.OBJ_NAME || info.OBJECTNAME || '').toUpperCase();
  const normalizedObjectName = objectName.toUpperCase();
  const acceptedObjectNames = new Set([
    normalizedObjectName,
    `SAPL${normalizedObjectName}`
  ]);
  if (objectKind === 'FUNCTION_MODULE' && parentName) {
    acceptedObjectNames.add(`L${parentName.toUpperCase()}UXX`);
  }
  if (!transportIds.includes(transportRequest)
    || (lockedObjectName && !acceptedObjectNames.has(lockedObjectName))) {
    throw new SafeAbapError('TRANSPORT_INVALID', 'cleanup-transport', 'The object is not owned by the configured validation transport.');
  }
}

function transportLockKeyAlias(info: TransportInfo): Array<{ programId: string; objectType: string; objectName: string }> | undefined {
  const lockKey = info.LOCKS?.OBJECT_KEY;
  const programId = String(lockKey?.PGMID || '').toUpperCase();
  const objectType = String(lockKey?.OBJECT || '').toUpperCase();
  const objectName = String(lockKey?.OBJ_NAME || '').toUpperCase();
  if (!programId || !objectType || !objectName) return undefined;
  return [{ programId, objectType, objectName }];
}

function assertTransportOpen(details: TransportRequest): void {
  const status = String(details['tm:status'] || '').toUpperCase();
  if (status === 'R' || status.includes('RELEASE')) {
    throw new SafeAbapError('TRANSPORT_INVALID', 'cleanup-transport', 'The validation transport is already released.');
  }
}

function repositoryName(value: unknown, field: string): string {
  const normalized = String(value || '').trim().toUpperCase();
  if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]{0,127}$/.test(normalized)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'cleanup-input', `${field} must be a bounded ABAP repository name.`);
  }
  return normalized;
}
