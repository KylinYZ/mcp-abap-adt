import { createHash } from 'crypto';
import type { AbapObjectStructure, SearchResult, TransportInfo, TransportObject, TransportRequest } from '../adt/index.js';
import { SafeAbapError, errorMessage } from './errors.js';
import type { RepositoryObjectCleanupPlanStore } from './RepositoryObjectCleanupPlanStore.js';
import type { RepositoryObjectCreationRegistry } from './RepositoryObjectCreationRegistry.js';
import type { RepositoryCreationContext, RepositoryCreationPlanStatus, RepositoryObjectKind } from './repositoryCreationTypes.js';
import type {
  RepositoryCleanupPlan, RepositoryCleanupPlanView, RepositoryCleanupResource,
  RepositoryCleanupRecoveryProvenance
} from './repositoryCleanupTypes.js';

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

/** 失败创建计划查询的窄视图（RepositoryObjectCreationPlanStore.view 结构兼容）。 */
export interface RecoverableCreationPlanLookup {
  view(creationPlanId: string, context: RepositoryCreationContext): {
    status: RepositoryCreationPlanStatus;
    target: { objectKind: RepositoryObjectKind; objectName: string; parentName?: string };
    primaryError?: { code?: string };
  };
}

/** 可恢复的失败创建计划状态：半成品可能残留的终态。
 *  PREVIEWED/APPLYING 未产生对象；APPLIED 是成功创建（清理由普通清理承担）；
 *  COMPENSATED 已自愈；EXPIRED 未执行——均不可作为恢复依据。 */
const RECOVERABLE_CREATION_STATUSES: ReadonlySet<RepositoryCreationPlanStatus> = new Set([
  'FAILED', 'OUTCOME_UNKNOWN', 'COMPENSATION_FAILED'
]);

class RepositoryCleanupOutcomeUnknownError extends Error {}
type CleanupTransportDisposition = 'DELETION_ENTRY_VERIFIED' | 'NEUTRAL_ENTRIES_VERIFIED' | 'NO_TRANSPORT_ENTRY_VERIFIED';

export class RepositoryObjectCleanupWorkflow {
  constructor(
    private readonly client: RepositoryCleanupAdtClient,
    private readonly registry: RepositoryObjectCreationRegistry,
    private readonly context: RepositoryCreationContext,
    private readonly plans: RepositoryObjectCleanupPlanStore,
    private readonly creationPlans?: RecoverableCreationPlanLookup
  ) {}

  async preview(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertCleanupContext();
    const objectKind = String(request.objectKind || '').trim().toUpperCase() as RepositoryObjectKind;
    const objectName = repositoryName(request.name, 'name');
    const parentName = request.parentName === undefined ? undefined : repositoryName(request.parentName, 'parentName');
    this.assertValidationIdentity(objectKind, objectName, parentName);
    // recover-failed-create：显式绑定一次失败的创建计划（可选）。绑定成功才允许
    // 对半成品做 inactive 容错解析；来源不明对象依旧拒绝（结果未知即停止）。
    const recovery = this.bindRecoveryPlan(request.creationPlanId, objectKind, objectName, parentName);
    const capability = this.registry.describe(objectKind, this.context);
    const target = await this.resolveResource(
      objectKind, objectName, capability.adtType, undefined, parentName,
      recovery ? { allowInactiveFallback: true } : undefined
    );
    const resources: RepositoryCleanupResource[] = [];

    // A root SAP object type owns its same-name node; freeze child-first deletion server-side.
    if (objectKind === 'SAP_OBJECT_TYPE') {
      const nodeCapability = this.registry.findByAdtType('NONT/NOT', this.context);
      if (nodeCapability) {
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
      summary: `Delete SAP object${resources.length === 1 ? '' : 's'} ${resources.map(resource => `${resource.objectKind} ${resource.objectName}`).join(' -> ')}.`,
      ...(recovery ? { recoveryOf: recovery } : {})
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
        cleanupOrder: plan.cleanupOrder,
        ...(recovery ? { recoveryOf: recovery } : {})
      },
      confirmationRequired: true
    };
  }

  /** 绑定恢复来源计划：必须存在于本地 plan 记录、处于可恢复失败态、且清理目标
   *  与计划目标完全一致。三个条件把"来源不明的半成品"挡在门外。 */
  private bindRecoveryPlan(
    creationPlanId: unknown,
    objectKind: RepositoryObjectKind,
    objectName: string,
    parentName?: string
  ): RepositoryCleanupRecoveryProvenance | undefined {
    if (creationPlanId === undefined || creationPlanId === null || creationPlanId === '') return undefined;
    const planId = String(creationPlanId).trim();
    if (!/^[0-9a-fA-F-]{8,64}$/.test(planId)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'cleanup-input', 'creationPlanId must be a repository creation plan id.');
    }
    if (!this.creationPlans) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-recovery', 'Recovery binding is unavailable in this deployment.');
    }
    const plan = this.creationPlans.view(planId, this.context);
    if (!RECOVERABLE_CREATION_STATUSES.has(plan.status)) {
      throw new SafeAbapError(
        'POLICY_DENIED', 'cleanup-recovery',
        `Creation plan is ${plan.status}; recovery binding requires a failed creation (FAILED/OUTCOME_UNKNOWN/COMPENSATION_FAILED).`
      );
    }
    const planParent = plan.target.parentName || '';
    if (plan.target.objectKind !== objectKind || plan.target.objectName !== objectName) {
      throw new SafeAbapError(
        'VALIDATION_FAILED', 'cleanup-recovery',
        'Cleanup target does not match the bound creation plan target.'
      );
    }
    // legacy 适配器（PROGRAM/FUNCTION_MODULE 等）把包名填进 target.parentName，
    // 与清理语义的 parentName（函数组父级）不同义——仅在清理请求显式提供且
    // 与计划不符时拒绝，避免误杀正常恢复绑定。
    if (parentName !== undefined && planParent !== parentName) {
      throw new SafeAbapError(
        'VALIDATION_FAILED', 'cleanup-recovery',
        'Cleanup parent does not match the bound creation plan parent.'
      );
    }
    return {
      creationPlanId: planId,
      creationPlanStatus: plan.status,
      ...(plan.primaryError?.code ? { primaryErrorCode: plan.primaryError.code } : {})
    };
  }

  status(cleanupPlanId: string): RepositoryCleanupPlanView {
    this.assertCleanupContext();
    return this.plans.view(cleanupPlanId, this.context);
  }

  async apply(cleanupPlanId: string): Promise<Record<string, unknown>> {
    this.assertCleanupContext();
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
        const disposition = await this.classifyTransportEvidence(resource, plan.transportRequest, Boolean(plan.recoveryOf));
        dispositions.push(disposition);
        this.record(
          plan,
          disposition === 'DELETION_ENTRY_VERIFIED'
            ? 'TRANSPORT_DELETION_ENTRY_VERIFIED'
            : disposition === 'NEUTRAL_ENTRIES_VERIFIED'
              ? 'TRANSPORT_NEUTRAL_ENTRY_VERIFIED'
              : 'TRANSPORT_NO_ENTRY_VERIFIED',
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
      };    } catch (error) {
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

  private assertCleanupContext(): void {
    if (this.context.systemRole !== 'DEV'
      || !['development', 'development-workbench'].includes(this.context.toolProfile)
      || !this.context.allowedNamespaces?.length
      || !this.context.realDevValidationTransport) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-policy', 'Repository cleanup requires a DEV workbench, an allowed namespace, and an open transport.');
    }
  }

  private assertValidationIdentity(objectKind: RepositoryObjectKind, objectName: string, parentName?: string): void {
    const normalizedParent = parentName ? parentName.toUpperCase() : '';
    const namespaceAllowed = (value: string) => (this.context.allowedNamespaces || []).some(namespace => value.startsWith(namespace));
    const namespaceName = objectKind === 'DDIC_LOCK_OBJECT' && objectName.startsWith('E')
      ? objectName.slice(1)
      : objectName;
    const nameMatches = objectKind === 'FUNCTION_GROUP_INCLUDE'
      ? Boolean(normalizedParent && namespaceAllowed(normalizedParent))
      : namespaceAllowed(namespaceName);
    if (!nameMatches) {
      throw new SafeAbapError('POLICY_DENIED', 'cleanup-policy', 'Cleanup is restricted to SAP_MCP_ALLOWED_NAMESPACES.');
    }
  }

  private async resolveResource(
    objectKind: RepositoryObjectKind,
    objectName: string,
    adtType: string,
    existing?: SearchResult,
    parentName?: string,
    resolution?: { allowInactiveFallback?: boolean; preferredVersion?: 'active' | 'inactive' }
  ): Promise<RepositoryCleanupResource> {
    const result = existing || await this.findExact(objectName, adtType);
    if (!result) {
      throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'cleanup-search', `${objectKind} ${objectName} does not exist.`);
    }
    let packageName = String(result['adtcore:packageName'] || '').toUpperCase();
    if (objectKind === 'PACKAGE') {
      const packageDocument = await this.client.readControlledPackage(objectName);
      if (packageDocument.name.toUpperCase() !== objectName) {
        throw new SafeAbapError('STATE_DRIFT', 'cleanup-package', 'SAP returned a different package identity.');
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
    }
    const objectUrl = result['adtcore:uri'];
    // 身份断言版本：恢复清理允许 active 缺失时回退 inactive（半成品通常从未激活）；
    // 常规清理维持 active-only 语义不放宽。
    const preferredVersion = resolution?.preferredVersion ?? 'active';
    let recoveryVersion: 'active' | 'inactive' | undefined;
    let structure: AbapObjectStructure;
    try {
      structure = await this.client.objectStructure(objectUrl, preferredVersion);
    } catch (error) {
      if (!(preferredVersion === 'active' && resolution?.allowInactiveFallback)) throw error;
      structure = await this.client.objectStructure(objectUrl, 'inactive');
      recoveryVersion = 'inactive';
    }
    const metadata = structure.metaData;
    if (String(metadata['adtcore:name'] || '').toUpperCase() !== objectName
      || String(metadata['adtcore:type'] || '').toUpperCase() !== adtType) {
      throw new SafeAbapError('STATE_DRIFT', 'cleanup-structure', 'SAP returned a different repository object identity.');
    }
    const transportPackage = packageName;
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
      ...(transportIdentityAliases ? { transportIdentityAliases } : {}),
      ...(recoveryVersion ? { recoveryVersion } : {})
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
    // 恢复清理冻结的 inactive 半成品按同一版本偏好重解析（防止 apply 间状态漂移）
    const current = await this.resolveResource(
      resource.objectKind,
      resource.objectName,
      resource.adtType,
      undefined,
      resource.parentName,
      resource.recoveryVersion === 'inactive'
        ? { preferredVersion: 'inactive' }
        : undefined
    );
    // 冻结时带 recoveryVersion 的资源，比较口径必须一致（重解析按同一版本偏好
    // 成功即视为同态；若对象在此期间被激活，inactive 读取会失败并安全终止）
    if (resource.recoveryVersion) current.recoveryVersion = resource.recoveryVersion;
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
      throw new SafeAbapError('LOCK_FAILED', 'cleanup-lock', `Failed to lock the SAP object: ${errorMessage(error)}`);
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
      throw new SafeAbapError('VERIFICATION_FAILED', 'cleanup-absence', 'The deleted SAP object is still present in SAP search.');
    }
  }

  private async classifyTransportEvidence(
    resource: RepositoryCleanupResource,
    transportRequest: string,
    allowNoEntryEvidence: boolean
  ): Promise<CleanupTransportDisposition> {
    const details = await this.client.transportDetails(transportRequest);
    assertTransportOpen(details);
    const entries = [...(details.objects || []), ...(details.tasks || []).flatMap(task => task.objects || [])];
    const keyGroups = buildCleanupTransportKeyGroups(resource, [{
      programId: resource.transportProgramId || 'R3TR',
      objectType: resource.transportObjectType || resource.adtType.split('/')[0],
      objectName: resource.transportObjectName
    }, ...(resource.transportCompanionKeys || [])]);
    const dispositions = keyGroups.map(keys => classifyTransportKeyGroup(entries, keys, allowNoEntryEvidence));
    if (dispositions.every(item => item === 'DELETION_ENTRY_VERIFIED')) return 'DELETION_ENTRY_VERIFIED';
    if (dispositions.every(item => item === 'NEUTRAL_ENTRIES_VERIFIED')) return 'NEUTRAL_ENTRIES_VERIFIED';
    if (dispositions.every(item => item === 'NO_TRANSPORT_ENTRY_VERIFIED')) return 'NO_TRANSPORT_ENTRY_VERIFIED';
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
  keys: Array<{ programId: string; objectType: string; objectName: string }>,
  allowNoEntryEvidence: boolean
): CleanupTransportDisposition {
  const matching = entries.filter(entry => (
    keys.some(key => transportKeyMatches(entry, key))
  ));
  // 零登记：半成品（从未激活的创建）删除后传输内容不变——仅恢复绑定计划接受
  // 该证据形态（absence 复核已独立证明删除生效），常规清理仍要求显式登记。
  if (matching.length === 0) {
    if (allowNoEntryEvidence) return 'NO_TRANSPORT_ENTRY_VERIFIED';
    throw new SafeAbapError(
      'VERIFICATION_FAILED',
      'cleanup-transport',
      'The validation transport must retain exactly one matching deletion entry or one neutral same-transport entry after cleanup.'
    );
  }
  const relevant = matching.filter(entry => {
    const operation = String(entry['tm:obj_func'] || '').toUpperCase();
    return operation === 'D' || operation === '';
  });
  const operationsByKey = new Map<string, string[]>();
  for (const entry of relevant) {
    const key = [entry['tm:pgmid'], entry['tm:type'], entry['tm:name']]
      .map(value => String(value || '').toUpperCase())
      .join('|');
    const operation = String(entry['tm:obj_func'] || '').toUpperCase() === 'D' ? 'D' : 'N';
    const operations = operationsByKey.get(key) || [];
    operations.push(operation);
    operationsByKey.set(key, operations);
  }
  const dispositions = [...operationsByKey.values()].map(operations => {
    const deletionCount = operations.filter(operation => operation === 'D').length;
    const neutralCount = operations.filter(operation => operation === 'N').length;
    if (deletionCount > 1 || (deletionCount === 0 && neutralCount > 1)) {
      throw new SafeAbapError(
        'VERIFICATION_FAILED',
        'cleanup-transport',
        'The validation transport contains duplicate matching entries for one repository key.'
      );
    }
    return operations.includes('D') ? 'D' : 'N';
  });
  if (dispositions.length > 0 && dispositions.every(item => item === 'D')) return 'DELETION_ENTRY_VERIFIED';
  if (dispositions.length > 0 && dispositions.every(item => item === 'N')) return 'NEUTRAL_ENTRIES_VERIFIED';
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
