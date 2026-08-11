import { performance } from 'perf_hooks';
import type { SyntaxCheckResult, TransportInfo } from 'abap-adt-api';
import { AbapObjectResolver } from './AbapObjectResolver.js';
import type { AuditEvent } from './AuditLogger.js';
import { ChangePlanStore } from './ChangePlanStore.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import { createUnifiedDiff, sourceHash } from './sourceTools.js';
import type {
  ChangePlan,
  ChangePlanView,
  ConfirmationMode,
  ResolvedAbapObject,
  SafeAdtClient,
  SupportedObjectType
} from './types.js';

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface PreviewChangeInput {
  objectType: SupportedObjectType | string;
  objectName: string;
  newSource: string;
  transportRequest: string;
}

export interface ApplyChangeInput {
  changePlanId: string;
  confirmedByUser: boolean;
  confirmationMode: ConfirmationMode;
}

export class AbapChangeWorkflow {
  constructor(
    private readonly client: SafeAdtClient,
    private readonly resolver: AbapObjectResolver,
    private readonly policy: SafetyPolicy,
    private readonly plans: ChangePlanStore,
    private readonly audit: AuditSink
  ) {}

  async inspect(objectType: string, objectName: string): Promise<Record<string, unknown>> {
    this.policy.assertReadAllowed(objectName);
    const object = await this.resolver.resolve(objectType, objectName);
    const source = await this.client.getObjectSource(object.sourceUrl);
    return {
      status: 'success',
      object,
      source,
      sourceHash: sourceHash(source),
      totalLines: lineCount(source)
    };
  }

  async preview(input: PreviewChangeInput): Promise<Record<string, unknown>> {
    this.policy.assertMutationAllowed(input.objectName);
    const transportRequest = this.policy.assertTransportFormat(input.transportRequest);
    if (typeof input.newSource !== 'string' || input.newSource.trim().length === 0) {
      throw new SafeAbapError('VERIFY_FAILED', 'preview', 'newSource must contain the complete proposed ABAP source.');
    }

    const object = await this.resolver.resolve(input.objectType, input.objectName);
    await this.validateTransport(object, transportRequest);
    const originalSource = await this.client.getObjectSource(object.sourceUrl);
    const originalHash = sourceHash(originalSource);
    const targetHash = sourceHash(input.newSource);
    if (originalHash === targetHash) {
      throw new SafeAbapError('VERIFY_FAILED', 'preview', 'The proposed source is identical to the current SAP source.');
    }

    const syntaxMessages = await this.syntaxCheck(object, input.newSource);
    assertSyntaxSuccess(syntaxMessages, 'preview');
    const { diff, summary } = createUnifiedDiff(originalSource, input.newSource);
    const plan = this.plans.create({
      systemHost: this.policy.systemHost,
      client: this.policy.client,
      object,
      transportRequest,
      originalSource,
      targetSource: input.newSource,
      originalHash,
      targetHash,
      diff,
      diffSummary: summary,
      syntaxMessages
    });

    try {
      await this.audit.append(this.auditEvent(plan, 'PREVIEW_CREATED', true));
    } catch (error) {
      this.plans.setStatus(plan.changePlanId, 'FAILED');
      throw error;
    }

    return {
      status: 'preview',
      plan: this.plans.view(plan.changePlanId),
      diff,
      confirmationRequired: true,
      confirmationInstruction: `Review the complete diff and explicitly confirm change plan ${plan.changePlanId} before applying.`
    };
  }

  async apply(input: ApplyChangeInput): Promise<Record<string, unknown>> {
    if (input.confirmedByUser !== true) {
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'Explicit user confirmation is required.');
    }

    const previewedPlan = this.plans.get(String(input.changePlanId || ''));
    this.policy.assertMutationAllowed(previewedPlan.object.objectName);
    const plan = this.plans.beginApply(previewedPlan.changePlanId);
    plan.confirmationMode = input.confirmationMode;
    let lockHandle: string | undefined;
    let lockHeld = false;
    let sourceWritten = false;
    let primaryError: SafeAbapError | undefined;

    try {
      await this.recordStage(plan, 'APPLY_STARTED', true);
      await this.validateTransport(plan.object, plan.transportRequest);

      const currentSource = await this.client.getObjectSource(plan.object.sourceUrl);
      if (sourceHash(currentSource) !== plan.originalHash) {
        throw new SafeAbapError(
          'SOURCE_DRIFT',
          'source-drift',
          'The SAP source changed after preview. Create a new change plan.'
        );
      }
      await this.recordStage(plan, 'SOURCE_REVALIDATED', true);

      try {
        const lock = await this.client.lock(plan.object.lockUrl, 'MODIFY');
        lockHandle = lock.LOCK_HANDLE;
        lockHeld = true;
      } catch (error) {
        throw new SafeAbapError('LOCK_FAILED', 'lock', `Failed to lock the object: ${errorMessage(error)}`);
      }
      await this.recordStage(plan, 'OBJECT_LOCKED', true);

      try {
        await this.client.setObjectSource(
          plan.object.sourceUrl,
          plan.targetSource,
          lockHandle,
          plan.transportRequest
        );
        sourceWritten = true;
      } catch (error) {
        throw new SafeAbapError('WRITE_FAILED', 'write', `Failed to write the proposed source: ${errorMessage(error)}`);
      }
      await this.recordStage(plan, 'SOURCE_WRITTEN', true);

      const syntaxMessages = await this.syntaxCheck(plan.object, plan.targetSource);
      assertSyntaxSuccess(syntaxMessages, 'post-write-syntax');
      await this.recordStage(plan, 'POST_WRITE_SYNTAX_PASSED', true);

      // ADT activation must run after the stateful MODIFY lock is released.
      try {
        await this.client.unLock(plan.object.lockUrl, lockHandle);
        lockHeld = false;
        plan.unlockSucceeded = true;
      } catch (error) {
        plan.unlockSucceeded = false;
        throw new SafeAbapError('UNLOCK_FAILED', 'unlock', `Failed to unlock before activation: ${errorMessage(error)}`);
      }
      await this.recordStage(plan, 'OBJECT_UNLOCKED', true);

      await this.activateOrThrow(plan.object);
      await this.recordStage(plan, 'OBJECT_ACTIVATED', true);

      const verifiedSource = await this.client.getObjectSource(plan.object.sourceUrl);
      if (sourceHash(verifiedSource) !== plan.targetHash) {
        throw new SafeAbapError('VERIFY_FAILED', 'verify', 'The activated SAP source hash does not match the confirmed plan.');
      }
      await this.recordStage(plan, 'SOURCE_VERIFIED', true);
      this.plans.setStatus(plan.changePlanId, 'APPLIED');
    } catch (error) {
      primaryError = asSafeError(error);
      plan.primaryError = {
        code: primaryError.code,
        stage: primaryError.stage,
        message: primaryError.message
      };
      await this.recordStage(plan, 'APPLY_FAILED', false, primaryError.message, false);

      if (sourceWritten) {
        plan.rollbackAttempted = true;
        try {
          if (!lockHeld) {
            // Activation or verification happens after unlock, so recovery needs a fresh write lock.
            try {
              const recoveryLock = await this.client.lock(plan.object.lockUrl, 'MODIFY');
              lockHandle = recoveryLock.LOCK_HANDLE;
              lockHeld = true;
            } catch (error) {
              throw new Error(`Failed to acquire a recovery lock: ${errorMessage(error)}`);
            }
            await this.recordStage(plan, 'ROLLBACK_OBJECT_LOCKED', true, undefined, false);
          }

          await this.client.setObjectSource(
            plan.object.sourceUrl,
            plan.originalSource,
            lockHandle as string,
            plan.transportRequest
          );
          await this.recordStage(plan, 'ROLLBACK_SOURCE_RESTORED', true, undefined, false);

          try {
            await this.client.unLock(plan.object.lockUrl, lockHandle as string);
            lockHeld = false;
            plan.unlockSucceeded = true;
          } catch (error) {
            plan.unlockSucceeded = false;
            throw new Error(`Failed to unlock restored source: ${errorMessage(error)}`);
          }
          await this.recordStage(plan, 'ROLLBACK_OBJECT_UNLOCKED', true, undefined, false);

          await this.activateOrThrow(plan.object);
          await this.recordStage(plan, 'ROLLBACK_OBJECT_ACTIVATED', true, undefined, false);

          const restoredSource = await this.client.getObjectSource(plan.object.sourceUrl);
          if (sourceHash(restoredSource) !== plan.originalHash) {
            throw new Error('Restored source hash does not match the original preview source.');
          }
          await this.recordStage(plan, 'ROLLBACK_SOURCE_VERIFIED', true, undefined, false);
          plan.rollbackSucceeded = true;
          this.plans.setStatus(plan.changePlanId, 'ROLLED_BACK');
          await this.recordStage(plan, 'ROLLBACK_SUCCEEDED', true, undefined, false);
        } catch (rollbackError) {
          plan.rollbackSucceeded = false;
          this.plans.setStatus(plan.changePlanId, 'ROLLBACK_FAILED');
          await this.recordStage(plan, 'ROLLBACK_FAILED', false, errorMessage(rollbackError), false);
        }
      } else {
        this.plans.setStatus(plan.changePlanId, 'FAILED');
      }
    } finally {
      if (lockHeld && lockHandle) {
        try {
          await this.client.unLock(plan.object.lockUrl, lockHandle);
          lockHeld = false;
          plan.unlockSucceeded = true;
          await this.recordStage(plan, 'OBJECT_UNLOCKED', true, undefined, false);
        } catch (unlockError) {
          plan.unlockSucceeded = false;
          await this.recordStage(plan, 'UNLOCK_FAILED', false, errorMessage(unlockError), false);
          if (!primaryError) {
            primaryError = new SafeAbapError(
              'UNLOCK_FAILED',
              'unlock',
              `Source change completed but the object could not be unlocked: ${errorMessage(unlockError)}`
            );
            plan.primaryError = {
              code: primaryError.code,
              stage: primaryError.stage,
              message: primaryError.message
            };
          }
        }
      }
    }

    await this.audit.append(this.auditEvent(plan, primaryError ? 'APPLY_COMPLETED_WITH_ERROR' : 'APPLY_COMPLETED', !primaryError));
    if (primaryError) {
      throw new SafeAbapError(primaryError.code, primaryError.stage, primaryError.message, {
        plan: this.plans.view(plan.changePlanId)
      });
    }

    return {
      status: 'success',
      plan: this.plans.view(plan.changePlanId)
    };
  }

  status(changePlanId: string): ChangePlanView {
    return this.plans.view(changePlanId);
  }

  private async validateTransport(object: ResolvedAbapObject, transportRequest: string): Promise<void> {
    try {
      const info = await this.client.transportInfo(object.sourceUrl, object.packageName, 'I');
      // SAP transport metadata is authoritative for rejecting local, non-transportable objects.
      this.policy.assertTransportablePackage(info.DEVCLASS || object.packageName);
      const available = transportNumbers(info);
      if (!available.has(transportRequest)) {
        throw new SafeAbapError(
          'TRANSPORT_INVALID',
          'transport',
          `Transport ${transportRequest} is not available for ${object.objectName}.`,
          { availableTransports: [...available] }
        );
      }

      const details = await this.client.transportDetails(transportRequest);
      const status = String(details['tm:status'] || '').trim().toUpperCase();
      if (status === 'R' || status.includes('RELEASE')) {
        throw new SafeAbapError('TRANSPORT_INVALID', 'transport', `Transport ${transportRequest} is already released.`);
      }
    } catch (error) {
      if (error instanceof SafeAbapError) {
        throw error;
      }
      throw new SafeAbapError(
        'TRANSPORT_INVALID',
        'transport',
        `Failed to validate transport ${transportRequest}: ${errorMessage(error)}`
      );
    }
  }

  private syntaxCheck(object: ResolvedAbapObject, source: string): Promise<SyntaxCheckResult[]> {
    return this.client.syntaxCheck(
      object.sourceUrl,
      object.activationUrl,
      source,
      object.mainProgram,
      'active'
    );
  }

  private async activateOrThrow(object: ResolvedAbapObject): Promise<void> {
    try {
      const activation = await this.client.activate(
        object.activationName,
        object.activationUrl,
        object.mainProgram,
        true
      );
      if (!activation.success) {
        throw new SafeAbapError(
          'ACTIVATION_FAILED',
          'activate',
          activation.messages.map(message => message.shortText).filter(Boolean).join('; ') || 'SAP activation failed.',
          { inactiveCount: activation.inactive.length }
        );
      }
    } catch (error) {
      if (error instanceof SafeAbapError) {
        throw error;
      }
      throw new SafeAbapError(
        'ACTIVATION_FAILED',
        'activate',
        `Failed to activate ${object.objectName}: ${errorMessage(error)}`
      );
    }
  }

  private async recordStage(
    plan: ChangePlan,
    stage: string,
    success: boolean,
    message?: string,
    auditFailureIsFatal = true
  ): Promise<void> {
    plan.stages.push({ stage, success, timestamp: new Date().toISOString(), message });
    try {
      await this.audit.append(this.auditEvent(plan, stage, success, message));
    } catch (error) {
      if (auditFailureIsFatal) {
        throw error;
      }
    }
  }

  private auditEvent(plan: ChangePlan, eventType: string, success: boolean, errorSummary?: string): AuditEvent {
    return {
      correlationId: plan.changePlanId,
      changePlanId: plan.changePlanId,
      eventType,
      systemHost: plan.systemHost,
      client: plan.client,
      systemRole: this.policy.systemRole,
      objectType: plan.object.objectType,
      objectName: plan.object.objectName,
      parentObject: plan.object.parentObject,
      activationTarget: plan.object.activationUrl,
      transportRequest: plan.transportRequest,
      originalHash: plan.originalHash,
      targetHash: plan.targetHash,
      addedLines: plan.diffSummary.addedLines,
      removedLines: plan.diffSummary.removedLines,
      success,
      errorCode: success ? undefined : plan.primaryError?.code,
      errorSummary,
      rollbackAttempted: plan.rollbackAttempted,
      rollbackSucceeded: plan.rollbackSucceeded,
      unlockSucceeded: plan.unlockSucceeded,
      confirmationMode: plan.confirmationMode
    };
  }
}

function assertSyntaxSuccess(messages: SyntaxCheckResult[], stage: string): void {
  const errors = messages.filter(message => /[EAX]/i.test(String(message.severity || '')));
  if (errors.length > 0) {
    throw new SafeAbapError(
      'SYNTAX_CHECK_FAILED',
      stage,
      errors.map(error => `Line ${error.line}: ${error.text}`).join('; '),
      { errors }
    );
  }
}

function transportNumbers(info: TransportInfo): Set<string> {
  const values = [
    ...(info.TRANSPORTS || []).map(transport => transport.TRKORR),
    info.LOCKS?.HEADER?.TRKORR,
    ...(info.LOCKS?.TASKS || []).map(task => task.TRKORR)
  ];
  return new Set(values.filter((value): value is string => Boolean(value)).map(value => value.toUpperCase()));
}

function asSafeError(error: unknown): SafeAbapError {
  if (error instanceof SafeAbapError) {
    return error;
  }
  return new SafeAbapError('VERIFY_FAILED', 'apply', errorMessage(error));
}

function lineCount(source: string): number {
  return source.replace(/\r\n/g, '\n').split('\n').length;
}
