import type { NewObjectOptions, SyntaxCheckResult, TransportInfo, ValidateOptions } from '../adt/index.js';
import { AbapCreationResolver } from './AbapCreationResolver.js';
import type { AuditEvent } from './AuditLogger.js';
import { CreationPlanStore } from './CreationPlanStore.js';
import type {
  ApplyCreationInput,
  CreatedObjectRecord,
  CreationAdtClient,
  CreationPlan,
  CreationPlanView,
  PreviewCreationInput,
  ResolvedCreationObject
} from './creationTypes.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import { compareFunctionModuleSources, compareSources, safeSourceMismatchSummary } from './sourceTools.js';
import type { TransportAttempt, TransportObjectEntry, TransportRegistrationOutcome, TransportValidationSummary } from './TransportRegistration.js';
import {
  cellText,
  classifyTransportError,
  e070HeaderQuery,
  e070TaskQuery,
  e071EntriesQuery,
  flattenAdtTransportObjects,
  isReleasedStatus,
  matchTransportRegistration
} from './TransportRegistration.js';

export interface CreationAuditSink {
  append(event: AuditEvent): Promise<void>;
}

export class AbapObjectCreationWorkflow {
  constructor(
    private readonly client: CreationAdtClient,
    private readonly resolver: AbapCreationResolver,
    private readonly policy: SafetyPolicy,
    private readonly plans: CreationPlanStore,
    private readonly audit: CreationAuditSink
  ) {}

  async preview(input: PreviewCreationInput): Promise<Record<string, unknown>> {
    const transportRequest = this.policy.assertTransportFormat(input.transportRequest);
    const objects = await this.resolver.resolve(input.objects);
    const transportValidation = await this.validateTransport(objects, transportRequest);
    const newFunctionGroup = objects.find(object => object.objectType === 'FUNCTION_GROUP');
    const deferredObjectValidation: string[] = [];
    for (const object of objects) {
      if (object.objectType === 'FUNCTION_MODULE' && object.parentFunctionGroup === newFunctionGroup?.objectName) {
        // SAP cannot validate a function module against a parent group that has not been created yet.
        deferredObjectValidation.push(object.objectName);
      } else {
        await this.validateNewObject(object);
      }
    }

    const plan = this.plans.create({
      systemHost: this.policy.systemHost,
      client: this.policy.client,
      transportRequest,
      objects,
      transportValidation
    });
    try {
      await this.recordStage(plan, 'CREATION_PREVIEW_CREATED', true);
    } catch (error) {
      this.plans.setStatus(plan.creationPlanId, 'FAILED');
      throw error;
    }

    return {
      status: 'preview',
      plan: this.plans.view(plan.creationPlanId),
      transportValidation,
      sources: objects
        .filter(object => object.source !== undefined)
        .map(object => ({
          objectType: object.objectType,
          objectName: object.objectName,
          source: object.source,
          sourceHash: object.sourceHash
        })),
      syntaxValidation: 'deferred_until_creation',
      deferredObjectValidation,
      compensationWarning: 'SAP ADT object creation is not a database transaction. Compensation is best effort.',
      confirmationRequired: true,
      confirmationInstruction: `Review the complete object graph and source, then explicitly confirm creation plan ${plan.creationPlanId}.`
    };
  }

  async apply(input: ApplyCreationInput): Promise<Record<string, unknown>> {
    if (input.confirmedByUser !== true) {
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'Explicit user confirmation is required.');
    }

    const plan = this.plans.beginApply(String(input.creationPlanId || ''));
    plan.confirmationMode = input.confirmationMode;
    let heldLock: { objectUrl: string; lockHandle: string } | undefined;

    try {
      for (const object of plan.objects) this.policy.assertMutationAllowed(mutationPolicyName(object));
      plan.transportValidation = await this.validateTransport(plan.objects, plan.transportRequest);
      await this.resolver.assertTargetsAbsent(plan.objects);
      await this.recordStage(plan, 'CREATION_PRECONDITIONS_REVALIDATED', true);

      for (const expected of plan.objects) {
        // Revalidate immediately before creation; for a new function group this is the first
        // point where SAP can authoritatively validate its child function module.
        await this.validateNewObject(expected);
        let actual: ResolvedCreationObject;
        let createAcknowledged = false;
        try {
          await this.client.createObject(newObjectOptions(expected, plan.transportRequest));
          createAcknowledged = true;
          actual = await this.resolver.resolveCreated(expected);
        } catch (error) {
          if (createAcknowledged) {
            await this.recordAcknowledgedButUnresolvedCreation(plan, expected, errorMessage(error));
          } else {
            await this.recordUncertainCreation(plan, expected);
          }
          throw new SafeAbapError(
            'OBJECT_CREATION_FAILED',
            'create',
            `Failed to create ${expected.objectName}: ${errorMessage(error)}`
          );
        }

        const created: CreatedObjectRecord = {
          ...actual,
          actualObjectUrl: actual.objectUrl,
          actualSourceUrl: actual.sourceUrl,
          ownershipProven: true
        };
        plan.createdObjects.push(created);
        await this.recordStage(plan, `OBJECT_CREATED:${created.objectName}`, true, undefined, true, created);

        if (created.objectType !== 'FUNCTION_GROUP') {
          const lock = await this.acquireLock(created.actualObjectUrl, 'write');
          heldLock = { objectUrl: created.actualObjectUrl, lockHandle: lock };
          try {
            await this.client.setObjectSource(
              created.actualSourceUrl as string,
              created.source as string,
              lock,
              plan.transportRequest
            );
          } catch (error) {
            // A3 交接修复：写源失败通常伴随服务端语法校验拒绝（如 "UP" is not allowed here），
            // 但该错误文本不含行号。补一次与变更链同源的 syntax check，把结构化明细
            // （line/offset/severity/text）随错误透出，agent 可直接按行修复而非盲目重建。
            let syntaxMessages: SyntaxCheckResult[] | undefined;
            try {
              const syntax = await this.client.syntaxCheck(
                created.actualSourceUrl as string,
                created.actualObjectUrl,
                created.source as string,
                undefined,
                'inactive'
              );
              const errors = syntax.filter(message => isErrorSeverity(message.severity));
              if (errors.length > 0) syntaxMessages = errors;
            } catch {
              // 语法检查本身失败不掩盖原始写源错误
            }
            throw new SafeAbapError(
              'SOURCE_WRITE_FAILED',
              'write',
              `Failed to write source for ${created.objectName}: ${errorMessage(error)}`,
              syntaxMessages ? { syntaxMessages } : undefined
            );
          }
          await this.recordStage(plan, `SOURCE_WRITTEN:${created.objectName}`, true, undefined, true, created);

          const syntax = await this.client.syntaxCheck(
            created.actualSourceUrl as string,
            created.actualObjectUrl,
            created.source as string,
            undefined,
            'active'
          );
          assertSyntaxSuccess(syntax, created.objectName);
          await this.recordStage(plan, `SYNTAX_CHECKED:${created.objectName}`, true, undefined, true, created);

          try {
            await this.client.unLock(created.actualObjectUrl, lock);
            heldLock = undefined;
            created.unlockSucceeded = true;
          } catch (error) {
            created.unlockSucceeded = false;
            throw new SafeAbapError(
              'UNLOCK_FAILED',
              'unlock',
              `Failed to unlock ${created.objectName} before activation: ${errorMessage(error)}`
            );
          }
          await this.recordStage(plan, `OBJECT_UNLOCKED:${created.objectName}`, true, undefined, true, created);
        }

        if (created.objectType === 'FUNCTION_GROUP') {
          // Eclipse leaves the new group inactive until its first function module is activated.
          continue;
        }

        await this.activate(created);
        await this.recordStage(plan, `OBJECT_ACTIVATED:${created.objectName}`, true, undefined, true, created);

        const verificationVersion = sourceVerificationVersion(created);
        await this.resolver.resolveCreated(created, verificationVersion);
        const actualSource = created.objectType === 'FUNCTION_GROUP_INCLUDE'
          ? await this.client.getObjectSource(created.actualSourceUrl as string, { version: verificationVersion })
          : await this.client.getObjectSource(created.actualSourceUrl as string);
        const comparison = created.objectType === 'FUNCTION_MODULE'
          ? compareFunctionModuleSources(created.source as string, actualSource)
          : compareSources(created.source as string, actualSource);
        created.verifiedSourceHash = comparison.actualHash;
        created.sourceMatchType = comparison.matchType;
        if (!comparison.matches) {
          throw new SafeAbapError(
            'SOURCE_VERIFY_FAILED',
            'verify',
            `Post-activation source for ${created.objectName} does not match the confirmed creation plan.`,
            {
              expectedHash: comparison.expectedHash,
              actualHash: comparison.actualHash,
              sourceMatchType: comparison.matchType,
              mismatch: safeSourceMismatchSummary(created.source as string, actualSource)
            }
          );
        }

        const createdParent = plan.createdObjects.find(candidate =>
          candidate.objectType === 'FUNCTION_GROUP'
          && candidate.objectName === created.parentFunctionGroup
        );
        if (createdParent) {
          await this.resolver.resolveCreated(createdParent, 'active');
          await this.recordStage(
            plan,
            `OBJECT_VERIFIED:${createdParent.objectName}`,
            true,
            undefined,
            true,
            createdParent
          );
        }
        await this.recordStage(plan, `OBJECT_VERIFIED:${created.objectName}`, true, undefined, true, created);
      }

      // 创建后归属证明：对象存在且源码已核验，仍须证明其登记进指定请求；
      // 证明不了按失败终止并禁止自动补偿（见 proveTransportRegistration）。
      await this.proveTransportRegistration(plan);
      this.plans.setStatus(plan.creationPlanId, 'APPLIED');
      await this.recordStage(plan, 'CREATION_APPLIED', true, undefined, false);
      return { status: 'success', plan: this.plans.view(plan.creationPlanId) };
    } catch (error) {
      const primary = asCreationError(error);
      plan.primaryError = {
        code: primary.code,
        stage: primary.stage,
        message: primary.message,
        details: primary.details
      };

      if (heldLock) {
        try {
          await this.client.unLock(heldLock.objectUrl, heldLock.lockHandle);
          heldLock = undefined;
        } catch (unlockError) {
          await this.recordStage(plan, 'UNLOCK_FAILED_DURING_RECOVERY', false, errorMessage(unlockError), false);
        }
      }

      const compensation = await this.compensate(plan);
      if (compensation === 'none') this.plans.setStatus(plan.creationPlanId, 'FAILED');
      if (compensation === 'success') this.plans.setStatus(plan.creationPlanId, 'COMPENSATED');
      if (compensation === 'failed') this.plans.setStatus(plan.creationPlanId, 'COMPENSATION_FAILED');
      await this.recordStage(plan, 'CREATION_COMPLETED_WITH_ERROR', false, primary.message, false);
      throw new SafeAbapError(primary.code, primary.stage, primary.message, {
        ...primary.details,
        plan: this.plans.view(plan.creationPlanId)
      });
    }
  }

  status(creationPlanId: string): CreationPlanView {
    return this.plans.view(creationPlanId);
  }

  private async validateNewObject(object: ResolvedCreationObject): Promise<void> {
    try {
      const result = await this.client.validateNewObject(validateOptions(object));
      if (!result.success || String(result.SEVERITY || '').toUpperCase() === 'ERROR') {
        throw new SafeAbapError(
          'OBJECT_VALIDATION_FAILED',
          'validate-object',
          result.SHORT_TEXT || `SAP rejected ${object.objectName}.`
        );
      }
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      throw new SafeAbapError(
        'OBJECT_VALIDATION_FAILED',
        'validate-object',
        `Failed to validate ${object.objectName}: ${errorMessage(error)}`
      );
    }
  }

  /**
   * 传输门禁（7.51 兼容改造，2026-09-29 排查定论）：
   * - 包/父组的 transportchecks 降为软检查：成功时给出兼容性判定，失败只记录
   *   诊断；候选清单不含请求也不再拒绝——创建 POST（corrNr）由 SAP 服务端做
   *   权威传输登记，检查失败不是拒绝写入的理由（VSP 同语义）。
   * - 请求门禁双通道：ADT transportDetails → E070 只读 SQL；"已释放"是权威
   *   判定，任一通道给出即拒绝；两路都失败才整体拒绝。
   * 返回摘要写入预览响应与计划（apply 重验后刷新），供读取方标注降级状态。
   */
  private async validateTransport(objects: ResolvedCreationObject[], transportRequest: string): Promise<TransportValidationSummary> {
    const attempts: TransportAttempt[] = [];
    const notes: string[] = [];
    const packages = new Set(objects.map(object => this.policy.assertTransportablePackage(object.packageName)));
    // 兼容性聚合取最差结论：CHECK_UNAVAILABLE > NOT_CONFIRMED_BY_SAP > SAP_CONFIRMED
    let packageCompatibility: TransportValidationSummary['packageCompatibility'] = 'SAP_CONFIRMED';
    const degrade = (level: TransportValidationSummary['packageCompatibility']) => {
      if (level === 'CHECK_UNAVAILABLE' || packageCompatibility === 'SAP_CONFIRMED') packageCompatibility = level;
    };
    for (const packageName of packages) {
      const representative = objects.find(object => object.packageName === packageName) as ResolvedCreationObject;
      // 软检查 URI 优先用搜索返回的 parentUri（SAP 实际可映射形态），回退自拼 parentPath。
      const checkUri = representative.parentUri || representative.parentPath;
      let info: TransportInfo | undefined;
      try {
        info = await this.client.transportInfo(checkUri, packageName, 'I');
      } catch (error) {
        attempts.push({
          endpoint: '/sap/bc/adt/cts/transportchecks',
          uri: checkUri,
          classification: classifyTransportError(error),
          message: errorMessage(error)
        });
        degrade('CHECK_UNAVAILABLE');
        notes.push(`Transport check for package ${packageName} is unavailable on this system (${classifyTransportError(error)}); package/request compatibility has not been confirmed by SAP.`);
      }
      if (info) {
        this.policy.assertTransportablePackage(info.DEVCLASS || packageName);
        if (!transportNumbers(info).has(transportRequest)) {
          degrade('NOT_CONFIRMED_BY_SAP');
          notes.push(`SAP transport check did not list ${transportRequest} among the open requests for ${packageName}; the creation POST with corrNr remains authoritative.`);
        }
      }
    }
    const requestCheck = await this.ensureModifiableRequest(transportRequest, attempts);
    return { requestCheck, packageCompatibility, notes, attempts };
  }

  /**
   * 请求门禁双通道。通道一 ADT transportDetails（7.52+ 主通道）；其"已释放"
   * 判定是权威结论，直接拒绝；其余失败（含 7.51 的 URI 映射缺失）记录诊断后
   * 降级通道二 E070 只读 SQL；SQL 通道缺失或也失败时才整体拒绝。
   */
  private async ensureModifiableRequest(
    transportRequest: string,
    attempts: TransportAttempt[]
  ): Promise<TransportValidationSummary['requestCheck']> {
    try {
      const details = await this.client.transportDetails(transportRequest);
      const status = String(details['tm:status'] || '').trim();
      if (isReleasedStatus(status)) {
        throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} is already released.`);
      }
      return { transportRequest, channel: 'ADT_TRANSPORT_DETAILS', modifiable: true, status: status || undefined };
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      attempts.push({
        endpoint: `/sap/bc/adt/cts/transportrequests/${transportRequest}`,
        classification: classifyTransportError(error),
        message: errorMessage(error)
      });
    }
    // bind 必须显式：runQuery 是 AdtClient 原型方法（内部依赖 this.h），裸引用
    // 提取会丢 this 并在调用时抛 TypeError（真机实证：reading 'h'）。
    const runner = this.client.runQuery?.bind(this.client);
    if (!runner) {
      throw new SafeAbapError(
        'TRANSPORT_INVALID',
        'transport',
        `Failed to validate transport ${transportRequest}: neither the ADT transport-details resource nor the E070 SQL channel is available.`,
        { transportAttempts: [...attempts] }
      );
    }
    try {
      const rows = (await runner(e070HeaderQuery(transportRequest), 5, true)).values ?? [];
      if (rows.length === 0) {
        throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} was not found in E070.`);
      }
      const status = cellText(rows[0], 'TRSTATUS');
      if (status === 'R') {
        throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} is already released (E070 TRSTATUS=R).`);
      }
      return { transportRequest, channel: 'E070_SQL', modifiable: true, status: status || undefined };
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      attempts.push({
        endpoint: 'E070 (datapreview SQL)',
        classification: classifyTransportError(error),
        message: errorMessage(error)
      });
      throw new SafeAbapError(
        'TRANSPORT_INVALID',
        'transport',
        `Failed to validate transport ${transportRequest}: both the ADT transport-details resource and the E070 SQL channel failed.`,
        { transportAttempts: [...attempts] }
      );
    }
  }

  /**
   * 创建后归属证明：对象存在且源码已核验，仍须在指定请求（含其全部任务）的
   * 对象登记里找到证明条目，否则 apply 按失败终止。UNPROVEN（读取成功但无
   * 该对象的登记）与 UNKNOWN（证明通道全部不可用）都禁止自动重试与补偿删除。
   */
  private async proveTransportRegistration(plan: CreationPlan): Promise<void> {
    if (plan.createdObjects.length === 0) return;
    const attempts: TransportAttempt[] = [];
    const entries = await this.readTransportObjectEntries(plan.transportRequest, attempts);
    for (const created of plan.createdObjects) {
      const outcome: TransportRegistrationOutcome = entries
        ? matchTransportRegistration(entries, created.objectType, created.objectName, created.parentFunctionGroup)
        : 'UNKNOWN';
      created.transportRegistration = outcome;
      if (outcome === 'PROVEN' || outcome === 'PROVEN_VIA_GROUP') {
        await this.recordStage(
          plan,
          `TRANSPORT_REGISTRATION_PROVEN:${created.objectName}`,
          true,
          outcome === 'PROVEN_VIA_GROUP'
            ? `proven via parent function group ${created.parentFunctionGroup} registration`
            : undefined,
          false
        );
        continue;
      }
      throw new SafeAbapError(
        outcome === 'UNPROVEN' ? 'TRANSPORT_REGISTRATION_UNPROVEN' : 'TRANSPORT_REGISTRATION_UNKNOWN',
        'transport-registration',
        outcome === 'UNPROVEN'
          ? `Transport ${plan.transportRequest} does not contain a registration entry for created ${created.objectType} ${created.objectName}; the object exists but its transport ownership is unproven.`
          : `Transport registration for created ${created.objectType} ${created.objectName} could not be verified; the object exists but its transport ownership is unknown.`,
        {
          transportRequest: plan.transportRequest,
          objectName: created.objectName,
          objectType: created.objectType,
          foundEntries: entries ?? undefined,
          transportAttempts: attempts
        }
      );
    }
  }

  /**
   * 读取指定请求（含任务）的对象登记条目。E071 只读 SQL 优先（与
   * TransportHistoryApi 同通道）；SQL 通道缺失或失败时降级 ADT
   * transportDetails 的对象清单。两路都失败返回 undefined（→ UNKNOWN），
   * 与"读取成功但为空"（→ UNPROVEN）严格区分。
   */
  private async readTransportObjectEntries(
    transportRequest: string,
    attempts: TransportAttempt[]
  ): Promise<TransportObjectEntry[] | undefined> {
    // bind 必须显式：同 ensureModifiableRequest，裸引用提取会丢 this（reading 'h'），
    // 使 E071 主通道静默失效并总是退化到 ADT 回退通道。
    const runner = this.client.runQuery?.bind(this.client);
    if (runner) {
      try {
        const request = transportRequest.toUpperCase();
        const taskRows = (await runner(e070TaskQuery(request), 100, true)).values ?? [];
        const trkorrList = [request];
        for (const row of taskRows) {
          const task = cellText(row, 'TRKORR').toUpperCase();
          if (task && task !== request && !trkorrList.includes(task) && trkorrList.length < 50) {
            trkorrList.push(task);
          }
        }
        const rows = (await runner(e071EntriesQuery(trkorrList), 500, true)).values ?? [];
        const entries: TransportObjectEntry[] = [];
        for (const row of rows) {
          const name = cellText(row, 'OBJ_NAME').toUpperCase();
          if (!name) continue;
          entries.push({
            pgmid: cellText(row, 'PGMID').toUpperCase(),
            object: cellText(row, 'OBJECT').toUpperCase(),
            name
          });
        }
        return entries;
      } catch (error) {
        attempts.push({
          endpoint: 'E071 (datapreview SQL)',
          classification: classifyTransportError(error),
          message: errorMessage(error)
        });
      }
    }
    try {
      const details = await this.client.transportDetails(transportRequest);
      return flattenAdtTransportObjects(details);
    } catch (error) {
      attempts.push({
        endpoint: `/sap/bc/adt/cts/transportrequests/${transportRequest}`,
        classification: classifyTransportError(error),
        message: errorMessage(error)
      });
      return undefined;
    }
  }

  private async acquireLock(objectUrl: string, stage: string): Promise<string> {
    try {
      const lock = await this.client.lock(objectUrl, 'MODIFY');
      return lock.LOCK_HANDLE;
    } catch (error) {
      throw new SafeAbapError('LOCK_FAILED', stage, `Failed to lock ${objectUrl}: ${errorMessage(error)}`);
    }
  }

  private async activate(object: CreatedObjectRecord): Promise<void> {
    try {
      const result = await this.client.activate(object.objectName, object.actualObjectUrl, undefined, true);
      if (!result.success) {
        const details = activationFailureDetails(result, object);
        // A3 交接修复：激活失败常见根因是语法错误，但激活结果消息只有 shortText 无行号；
        // 补一次结构化语法检查（line/offset/severity/text），agent 可按行修复而非删除重建。
        try {
          const syntax = await this.client.syntaxCheck(
            object.actualSourceUrl as string,
            object.actualObjectUrl,
            object.source as string,
            undefined,
            'inactive'
          );
          const errors = syntax.filter(message => isErrorSeverity(message.severity));
          if (errors.length > 0) details.syntaxMessages = errors;
        } catch {
          // 语法检查本身失败不掩盖原始激活错误
        }
        throw new SafeAbapError(
          'ACTIVATION_FAILED',
          'activate',
          details.messages.join('; ') || `Activation failed for ${object.objectName}.`,
          details
        );
      }
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;

      // A transport error after POST leaves the remote activation outcome unknown.
      // Prove the object state through read-only resolution before allowing recovery.
      try {
        await this.resolver.resolveCreated(object, 'active');
        return;
      } catch {
        // Continue with an explicit inactive-version check.
      }

      try {
        await this.resolver.resolveCreated(object, 'inactive');
      } catch {
        // Without an authoritative active or inactive version, deletion could remove
        // an object whose activation actually succeeded after the client disconnected.
        object.ownershipProven = false;
        throw new SafeAbapError(
          'ACTIVATION_FAILED',
          'activate',
          `Activation outcome is unknown for ${object.objectName}: ${errorMessage(error)}`,
          { activationOutcome: 'UNKNOWN' }
        );
      }

      throw new SafeAbapError(
        'ACTIVATION_FAILED',
        'activate',
        `Activation did not complete for ${object.objectName}.`,
        { activationOutcome: 'INACTIVE_CONFIRMED' }
      );
    }
  }

  private async recordUncertainCreation(plan: CreationPlan, expected: ResolvedCreationObject): Promise<void> {
    try {
      const actual = await this.resolver.resolveCreated(expected);
      plan.createdObjects.push({
        ...actual,
        actualObjectUrl: actual.objectUrl,
        actualSourceUrl: actual.sourceUrl,
        ownershipProven: false
      });
      await this.recordStage(
        plan,
        `OBJECT_CREATION_OUTCOME_UNCERTAIN:${expected.objectName}`,
        false,
        'The object exists after a failed create request, so automatic deletion is forbidden.',
        false,
        plan.createdObjects.at(-1)
      );
    } catch {
      // Absence after a failed create request is the normal, non-mutating failure case.
    }
  }

  private async recordAcknowledgedButUnresolvedCreation(
    plan: CreationPlan,
    expected: ResolvedCreationObject,
    resolutionError: string
  ): Promise<void> {
    const uncertain: CreatedObjectRecord = {
      ...expected,
      actualObjectUrl: expected.objectUrl,
      actualSourceUrl: expected.sourceUrl,
      ownershipProven: false
    };
    plan.createdObjects.push(uncertain);
    await this.recordStage(
      plan,
      `OBJECT_CREATION_OUTCOME_UNCERTAIN:${expected.objectName}`,
      false,
      `SAP acknowledged creation, but the new object could not be resolved: ${resolutionError}`,
      false,
      uncertain
    );
  }

  private async compensate(plan: CreationPlan): Promise<'none' | 'success' | 'failed'> {
    if (plan.createdObjects.length === 0) return 'none';
    plan.compensationAttempted = true;
    let failed = false;

    for (const object of [...plan.createdObjects].reverse()) {
      object.compensationAttempted = true;
      if (!object.ownershipProven) {
        object.compensationSucceeded = false;
        failed = true;
        continue;
      }
      // 归属证明未通过（UNPROVEN/UNKNOWN）的对象禁止自动删除：登记未知意味着
      // 对象可能落在别的请求里，删除必须由人工在 SE10/ADT 确认归属后执行。
      if (object.transportRegistration === 'UNPROVEN' || object.transportRegistration === 'UNKNOWN') {
        object.compensationSucceeded = false;
        failed = true;
        await this.recordStage(
          plan,
          `OBJECT_COMPENSATION_SKIPPED:${object.objectName}`,
          false,
          'transport registration is unproven; automatic deletion is forbidden',
          false,
          object
        );
        continue;
      }

      let lockHandle: string | undefined;
      try {
        lockHandle = await this.acquireLock(object.actualObjectUrl, 'compensate-lock');
        await this.client.deleteObject(object.actualObjectUrl, lockHandle, plan.transportRequest);
        await this.resolver.assertTargetsAbsent([object]);
        object.compensationSucceeded = true;
        await this.recordStage(plan, `OBJECT_COMPENSATED:${object.objectName}`, true, undefined, false, object);
      } catch (error) {
        object.compensationSucceeded = false;
        failed = true;
        await this.recordStage(plan, `OBJECT_COMPENSATION_FAILED:${object.objectName}`, false, errorMessage(error), false, object);
        if (lockHandle) {
          try {
            await this.client.unLock(object.actualObjectUrl, lockHandle);
          } catch (unlockError) {
            await this.recordStage(plan, `COMPENSATION_UNLOCK_FAILED:${object.objectName}`, false, errorMessage(unlockError), false, object);
          }
        }
      }
    }

    plan.compensationSucceeded = !failed;
    return failed ? 'failed' : 'success';
  }

  private async recordStage(
    plan: CreationPlan,
    stage: string,
    success: boolean,
    message?: string,
    auditFailureIsFatal = true,
    focusObject?: ResolvedCreationObject
  ): Promise<void> {
    plan.stages.push({ stage, success, timestamp: new Date().toISOString(), message });
    try {
      const focus = focusObject || plan.createdObjects.at(-1) || plan.objects.at(-1);
      await this.audit.append({
        correlationId: plan.creationPlanId,
        creationPlanId: plan.creationPlanId,
        eventType: stage,
        systemHost: plan.systemHost,
        client: plan.client,
        systemRole: this.policy.systemRole,
        objectType: focus?.objectType,
        objectName: focus?.objectName,
        parentObject: focus?.parentFunctionGroup,
        packageName: focus?.packageName,
        activationTarget: focus?.objectUrl,
        transportRequest: plan.transportRequest,
        targetHash: focus?.sourceHash,
        success,
        errorCode: success ? undefined : plan.primaryError?.code,
        errorSummary: message,
        compensationAttempted: plan.compensationAttempted,
        compensationSucceeded: plan.compensationSucceeded,
        confirmationMode: plan.confirmationMode,
        activationOutcome: stringDetail(plan.primaryError?.details, 'activationOutcome'),
        activationInactiveCount: numberDetail(plan.primaryError?.details, 'inactiveCount')
      });
    } catch (error) {
      if (auditFailureIsFatal) throw error;
    }
  }
}

function validateOptions(object: ResolvedCreationObject): ValidateOptions {
  if (object.objectType === 'FUNCTION_MODULE' || object.objectType === 'FUNCTION_GROUP_INCLUDE') {
    return {
      objtype: object.objectType === 'FUNCTION_GROUP_INCLUDE' ? 'FUGR/I' : 'FUGR/FF',
      objname: object.objectName,
      description: object.description,
      fugrname: object.parentName
    };
  }
  if (object.objectType === 'FUNCTION_GROUP') {
    return { objtype: 'FUGR/F', objname: object.objectName, description: object.description, packagename: object.packageName };
  }
  return { objtype: 'PROG/P', objname: object.objectName, description: object.description, packagename: object.packageName };
}

function newObjectOptions(object: ResolvedCreationObject, transport: string): NewObjectOptions {
  return {
    objtype: object.adtType,
    name: object.objectName,
    parentName: object.parentName,
    description: object.description,
    parentPath: object.parentPath,
    transport,
    contentType: object.adtType === 'FUGR/I' ? 'application/vnd.sap.adt.functions.fincludes.v2+xml' : undefined
  };
}

function mutationPolicyName(object: ResolvedCreationObject): string {
  return object.objectType === 'FUNCTION_GROUP_INCLUDE'
    ? object.parentFunctionGroup || object.parentName
    : object.objectName;
}

function sourceVerificationVersion(object: CreatedObjectRecord): 'active' | 'workingArea' {
  return object.objectType === 'FUNCTION_GROUP_INCLUDE' ? 'workingArea' : 'active';
}

function activationFailureDetails(
  result: Awaited<ReturnType<CreationAdtClient['activate']>>,
  object: CreatedObjectRecord
): Record<string, unknown> & { messages: string[] } {
  const messages = result.messages.map(message => message.shortText).filter(Boolean);
  const inactiveObjects = result.inactive
    .map(record => record.object)
    .filter((inactive): inactive is NonNullable<typeof inactive> => Boolean(inactive))
    .filter(inactive => {
      const nameMatches = String(inactive['adtcore:name'] || '').toUpperCase() === object.objectName;
      const typeMatches = String(inactive['adtcore:type'] || '').toUpperCase() === object.adtType;
      const uriMatches = String(inactive['adtcore:uri'] || '').toLowerCase() === object.actualObjectUrl.toLowerCase();
      return nameMatches || typeMatches && uriMatches;
    })
    .map(inactive => ({
      uri: inactive['adtcore:uri'],
      type: inactive['adtcore:type'],
      name: inactive['adtcore:name'],
      parentUri: inactive['adtcore:parentUri']
    }));
  return { inactiveCount: result.inactive.length, inactiveObjects, messages };
}

function assertSyntaxSuccess(messages: SyntaxCheckResult[], objectName: string): void {
  const errors = messages.filter(message => isErrorSeverity(message.severity));
  if (errors.length > 0) {
    throw new SafeAbapError(
      'SYNTAX_CHECK_FAILED',
      'syntax-check',
      `${objectName}: ${errors.map(error => `Line ${error.line}: ${error.text}`).join('; ')}`,
      { errors }
    );
  }
}

function isErrorSeverity(value: string): boolean {
  return ['E', 'A', 'X', 'ERROR', 'ABORT', 'EXIT'].includes(String(value || '').trim().toUpperCase());
}

function transportNumbers(info: TransportInfo): Set<string> {
  const values = [
    ...(info.TRANSPORTS || []).map(transport => transport.TRKORR),
    info.LOCKS?.HEADER?.TRKORR,
    ...(info.LOCKS?.TASKS || []).map(task => task.TRKORR)
  ];
  return new Set(values.filter((value): value is string => Boolean(value)).map(value => value.toUpperCase()));
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === 'number' ? value : undefined;
}

function asCreationError(error: unknown): SafeAbapError {
  return error instanceof SafeAbapError
    ? error
    : new SafeAbapError('OBJECT_CREATION_FAILED', 'apply', errorMessage(error));
}
