import { createHash } from 'crypto';
import type { AbapObjectStructure, SearchResult, TransportInfo, TransportRequest } from '../adt/index.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { RepositoryObjectCleanupPlanStore } from './RepositoryObjectCleanupPlanStore.js';
import type { RepositoryObjectCreationRegistry } from './RepositoryObjectCreationRegistry.js';
import type { RepositoryCreationContext, RepositoryObjectKind } from './repositoryCreationTypes.js';
import type { RepositoryCleanupPlan, RepositoryCleanupPlanView, RepositoryCleanupResource } from './repositoryCleanupTypes.js';

interface RepositoryCleanupAdtClient {
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  objectStructure(objectUrl: string, version?: 'active' | 'inactive' | 'workingArea'): Promise<AbapObjectStructure>;
  transportInfo(objectUrl: string, devClass?: string, operation?: string): Promise<TransportInfo>;
  transportDetails(transportNumber: string): Promise<TransportRequest>;
  lock(objectUrl: string, accessMode?: string): Promise<{ LOCK_HANDLE: string }>;
  unLock(objectUrl: string, lockHandle: string): Promise<string>;
  deleteObject(objectUrl: string, lockHandle: string, transport?: string): Promise<void>;
}

class RepositoryCleanupOutcomeUnknownError extends Error {}

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
    const target = await this.resolveResource(objectKind, objectName, capability.adtType);
    const resources: RepositoryCleanupResource[] = [];

    // A root SAP object type owns its same-name node; freeze child-first deletion server-side.
    if (objectKind === 'SAP_OBJECT_TYPE') {
      const nodeCapability = this.registry.findByAdtType('NONT/NOT', this.context);
      if (nodeCapability && this.context.realDevValidationObjects?.includes('SAP_OBJECT_NODE_TYPE')) {
        const node = await this.findExact(objectName, 'NONT/NOT');
        if (node) resources.push(await this.resolveResource('SAP_OBJECT_NODE_TYPE', objectName, 'NONT/NOT', node));
      }
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
    this.assertValidationIdentity(previewed.target.objectKind, previewed.target.objectName);
    const plan = this.plans.begin(cleanupPlanId, this.context);
    const resources = [...(plan.resources || [])];
    try {
      for (const resource of resources) {
        await this.revalidateResource(resource);
        this.record(plan, 'IDENTITY_REVALIDATED', true, `${resource.objectKind} ${resource.objectName}`);
        await this.deleteResource(plan, resource);
        await this.assertAbsent(resource);
        this.record(plan, 'ABSENCE_VERIFIED', true, `${resource.objectKind} ${resource.objectName}`);
        await this.assertTransportClean(resource, plan.transportRequest);
        this.record(plan, 'TRANSPORT_CLEANUP_VERIFIED', true, `${resource.objectKind} ${resource.objectName}`);
      }
      const resultSummary = `Deleted and verified ${resources.map(resource => `${resource.objectKind} ${resource.objectName}`).join(', ')}.`;
      return { status: 'success', plan: this.plans.settle(plan.cleanupPlanId, 'COMPLETED', { resultSummary }) };
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
      : objectName.startsWith(prefix);
    if (!this.context.realDevValidationObjects?.includes(objectKind) || !nameMatches) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-policy', 'Cleanup accepts only the configured validation kinds and object-name prefix.');
    }
  }

  private async resolveResource(
    objectKind: RepositoryObjectKind,
    objectName: string,
    adtType: string,
    existing?: SearchResult
  ): Promise<RepositoryCleanupResource> {
    const result = existing || await this.findExact(objectName, adtType);
    if (!result) {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-search', `${objectKind} ${objectName} does not exist.`);
    }
    const packageName = String(result['adtcore:packageName'] || '').toUpperCase();
    if (packageName !== this.context.realDevValidationPackage) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-package', 'The object does not belong to the configured validation package.');
    }
    const objectUrl = result['adtcore:uri'];
    const structure = await this.client.objectStructure(objectUrl, 'active');
    const metadata = structure.metaData;
    if (String(metadata['adtcore:name'] || '').toUpperCase() !== objectName
      || String(metadata['adtcore:type'] || '').toUpperCase() !== adtType) {
      throw new SafeAbapError('STATE_DRIFT', 'cleanup-structure', 'SAP returned a different repository object identity.');
    }
    const info = await this.client.transportInfo(objectUrl, packageName, 'I');
    assertTransportOwnership(info, String(this.context.realDevValidationTransport || ''), objectName);
    const details = await this.client.transportDetails(String(this.context.realDevValidationTransport || ''));
    assertTransportOpen(details);
    return {
      objectKind,
      objectName,
      adtType,
      objectUrl,
      packageName,
      version: String(metadata['adtcore:version'] || ''),
      transportProgramId: String(info.PGMID || info.LOCKS?.OBJECT_KEY?.PGMID || ''),
      transportObjectType: String(info.OBJECT || info.LOCKS?.OBJECT_KEY?.OBJECT || ''),
      transportObjectName: String(info.OBJECTNAME || info.LOCKS?.OBJECT_KEY?.OBJ_NAME || objectName).toUpperCase()
    };
  }

  private async revalidateResource(resource: RepositoryCleanupResource): Promise<void> {
    const current = await this.resolveResource(resource.objectKind, resource.objectName, resource.adtType);
    if (JSON.stringify(current) !== JSON.stringify(resource)) {
      throw new SafeAbapError('STATE_DRIFT', 'cleanup-revalidate', 'Object identity, package, version, or transport changed after cleanup preview.');
    }
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

  private async assertTransportClean(resource: RepositoryCleanupResource, transportRequest: string): Promise<void> {
    const details = await this.client.transportDetails(transportRequest);
    assertTransportOpen(details);
    const entries = [...(details.objects || []), ...(details.tasks || []).flatMap(task => task.objects || [])];
    const matchingTypes = new Set([resource.transportObjectType, resource.adtType.split('/')[0]].map(item => item.toUpperCase()));
    const remaining = entries.filter(entry => (
      String(entry['tm:name'] || '').toUpperCase() === resource.transportObjectName
      && matchingTypes.has(String(entry['tm:type'] || '').toUpperCase())
    ));
    if (remaining.length > 0) {
      throw new SafeAbapError('VERIFICATION_FAILED', 'cleanup-transport', 'The validation transport still contains an object entry after cleanup.');
    }
  }

  private async findExact(objectName: string, adtType: string): Promise<SearchResult | undefined> {
    const candidates = await this.client.searchObject(objectName, adtType, 20);
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

function assertTransportOwnership(info: TransportInfo, transportRequest: string, objectName: string): void {
  const transportIds = [
    info.LOCKS?.HEADER?.TRKORR,
    ...(info.LOCKS?.TASKS || []).map(task => task.TRKORR),
    ...(info.TRANSPORTS || []).map(transport => transport.TRKORR)
  ].filter(Boolean).map(value => String(value).toUpperCase());
  const lockedObjectName = String(info.LOCKS?.OBJECT_KEY?.OBJ_NAME || info.OBJECTNAME || '').toUpperCase();
  if (!transportIds.includes(transportRequest) || (lockedObjectName && lockedObjectName !== objectName)) {
    throw new SafeAbapError('TRANSPORT_INVALID', 'cleanup-transport', 'The object is not owned by the configured validation transport.');
  }
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
