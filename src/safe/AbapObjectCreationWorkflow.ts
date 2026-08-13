import type { NewObjectOptions, SyntaxCheckResult, TransportInfo, ValidateOptions } from 'abap-adt-api';
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
import { compareSources } from './sourceTools.js';

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
    await this.validateTransport(objects, transportRequest);
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
      objects
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
      for (const object of plan.objects) this.policy.assertMutationAllowed(object.objectName);
      await this.validateTransport(plan.objects, plan.transportRequest);
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
            throw new SafeAbapError(
              'SOURCE_WRITE_FAILED',
              'write',
              `Failed to write source for ${created.objectName}: ${errorMessage(error)}`
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

        await this.activate(created);
        await this.recordStage(plan, `OBJECT_ACTIVATED:${created.objectName}`, true, undefined, true, created);

        if (created.objectType === 'FUNCTION_GROUP') {
          await this.resolver.resolveCreated(created, 'active');
        } else {
          const actualSource = await this.client.getObjectSource(created.actualSourceUrl as string);
          const comparison = compareSources(created.source as string, actualSource);
          created.verifiedSourceHash = comparison.actualHash;
          created.sourceMatchType = comparison.matchType;
          if (!comparison.matches) {
            throw new SafeAbapError(
              'SOURCE_VERIFY_FAILED',
              'verify',
              `Activated source for ${created.objectName} does not match the confirmed creation plan.`,
              { expectedHash: comparison.expectedHash, actualHash: comparison.actualHash, sourceMatchType: comparison.matchType }
            );
          }
        }
        await this.recordStage(plan, `OBJECT_VERIFIED:${created.objectName}`, true, undefined, true, created);
      }

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

  private async validateTransport(objects: ResolvedCreationObject[], transportRequest: string): Promise<void> {
    try {
      const packages = new Set(objects.map(object => this.policy.assertTransportablePackage(object.packageName)));
      for (const packageName of packages) {
        const representative = objects.find(object => object.packageName === packageName) as ResolvedCreationObject;
        // New target URLs do not exist yet; validate transport against the existing package or parent group.
        const info = await this.client.transportInfo(representative.parentPath, packageName, 'I');
        this.policy.assertTransportablePackage(info.DEVCLASS || packageName);
        if (!transportNumbers(info).has(transportRequest)) {
          throw new SafeAbapError(
            'TRANSPORT_INVALID',
            'transport',
            `Transport ${transportRequest} is not available for package ${packageName}.`
          );
        }
      }
      const details = await this.client.transportDetails(transportRequest);
      const status = String(details['tm:status'] || '').trim().toUpperCase();
      if (status === 'R' || status.includes('RELEASE')) {
        throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} is already released.`);
      }
    } catch (error) {
      if (error instanceof SafeAbapError) throw error;
      throw new SafeAbapError(
        'TRANSPORT_INVALID',
        'transport',
        `Failed to validate transport ${transportRequest}: ${errorMessage(error)}`
      );
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
      const result = object.objectType === 'PROGRAM'
        ? await this.client.activate(object.objectName, object.actualObjectUrl, undefined, true)
        : await this.client.activate(activationReference(object), object.objectType === 'FUNCTION_GROUP');
      if (!result.success) {
        const details = activationFailureDetails(result, object);
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
  if (object.objectType === 'FUNCTION_MODULE') {
    return { objtype: 'FUGR/FF', objname: object.objectName, description: object.description, fugrname: object.parentName };
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
    transport
  };
}

function activationReference(object: CreatedObjectRecord): {
  'adtcore:uri': string;
  'adtcore:type': string;
  'adtcore:name': string;
  'adtcore:parentUri': string;
} {
  return {
    'adtcore:uri': object.actualObjectUrl,
    'adtcore:type': object.adtType,
    'adtcore:name': object.objectName,
    'adtcore:parentUri': object.objectType === 'FUNCTION_GROUP'
      ? object.parentPath
      : object.activationParentUrl as string
  };
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
