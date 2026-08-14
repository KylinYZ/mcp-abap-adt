import type { ChangePackageRefactoring } from '../adt/index.js';
import { AbapObjectResolver } from './AbapObjectResolver.js';
import { AdvancedOperationPlanStore } from './AdvancedOperationPlanStore.js';
import type { AdvancedOperationPlan, AdvancedOperationPreviewResult } from './advancedTypes.js';
import {
  advancedAuditEvent,
  advancedContext,
  assertAdvancedMutationAllowed,
  appendStage,
  guardAdvancedApply,
  assertAllowedKeys,
  stableHash,
  validateAdvancedTransport,
  type AdvancedAuditSink,
  type AdvancedTransportClient
} from './advancedWorkflowTools.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { normalizeObjectName, SafetyPolicy } from './SafetyPolicy.js';

interface PackageWorkflowClient extends AdvancedTransportClient {
  changePackagePreview(refactoring: ChangePackageRefactoring, transport?: string): Promise<ChangePackageRefactoring>;
  changePackageExecute(refactoring: ChangePackageRefactoring): Promise<ChangePackageRefactoring>;
}

export class PackageChangeWorkflow {
  constructor(
    private readonly client: PackageWorkflowClient,
    private readonly resolver: AbapObjectResolver,
    private readonly policy: SafetyPolicy,
    private readonly plans: AdvancedOperationPlanStore,
    private readonly audit: AdvancedAuditSink
  ) {}

  async preview(args: Record<string, unknown>): Promise<AdvancedOperationPreviewResult> {
    assertAllowedKeys(args, ['objectType', 'objectName', 'oldPackage', 'newPackage', 'transportRequest'], 'package preview request');
    const objectName = normalizeObjectName(String(args.objectName || ''));
    assertAdvancedMutationAllowed(this.policy, objectName);
    const object = await this.resolver.resolve(String(args.objectType || ''), objectName);
    const oldPackage = normalizePackage(args.oldPackage, 'oldPackage');
    const newPackage = normalizePackage(args.newPackage, 'newPackage');
    if (oldPackage === newPackage) {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'The old and new package must differ.');
    }
    if (String(object.packageName || '').trim().toUpperCase() !== oldPackage) {
      throw new SafeAbapError('STATE_DRIFT', 'VALIDATE', `${objectName} is not currently assigned to ${oldPackage}.`);
    }
    const transport = await validateAdvancedTransport(this.client, this.policy, object.objectUrl, oldPackage, String(args.transportRequest || ''));
    this.policy.assertTransportablePackage(newPackage);
    const request = initialRefactoring(object, oldPackage, newPackage, transport);
    const preview = await this.client.changePackagePreview(request, transport);
    assertPreviewIdentity(preview, object.objectUrl, oldPackage, newPackage, transport);
    const canonical = canonicalPreview(preview);
    const affected = canonicalAffected(preview);
    const plan = this.plans.create({
      context: advancedContext(this.policy),
      target: { objectType: object.objectType, objectName, packageName: newPackage },
      transport,
      inputSummary: {
        title: `Move ${object.objectType} ${objectName} from ${oldPackage} to ${newPackage}`,
        affectedObjects: affected.map(item => ({ type: item.type, name: item.name })),
        warning: 'Package migration is executed once and is never automatically reversed or retried.'
      },
      currentStateSummary: {
        stateHash: stableHash({ objectUrl: object.objectUrl, packageName: oldPackage }),
        description: `${objectName} currently belongs to ${oldPackage}; SAP preview reports ${affected.length} affected object(s).`
      },
      payload: {
        kind: 'CHANGE_PACKAGE',
        input: { refactoring: structuredClone(preview) },
        drift: { previewHash: stableHash(canonical), affectedObjectHash: stableHash(affected) },
        verification: { expectedPackage: newPackage }
      },
      rollbackSupported: false
    });
    try {
      await appendStage(plan, { stage: 'PREVIEW', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
    } catch (error) {
      this.plans.recordResult(plan.operationPlanId, 'Package preview audit failed.', { code: 'AUDIT_FAILED', stage: 'PREVIEW', message: errorMessage(error) });
      this.plans.setStatus(plan.operationPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)), confirmationRequired: true };
  }

  async apply(operationPlanId: string): Promise<Record<string, unknown>> {
    const context = advancedContext(this.policy);
    const previewed = this.plans.getForContext(operationPlanId, context);
    if (previewed.operationKind !== 'CHANGE_PACKAGE') {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'This plan is not a package migration.');
    }
    assertAdvancedMutationAllowed(this.policy, previewed.target.objectName);
    const plan = this.plans.beginApply(operationPlanId, context);
    return guardAdvancedApply(plan, this.plans, this.audit, this.policy, async () => {
      plan.confirmationMode = 'elicitation';
      const payload = plan.payload?.kind === 'CHANGE_PACKAGE' ? plan.payload : undefined;
      if (!payload) throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'The package plan payload is unavailable.');
      await appendStage(plan, { stage: 'CONFIRM', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);

      const refactoring = payload.input.refactoring;
      await validateAdvancedTransport(this.client, this.policy, String(refactoring.adtObjectUri), refactoring.oldPackage, plan.transport || '');
      this.policy.assertTransportablePackage(payload.verification.expectedPackage);
      const freshPreview = await this.client.changePackagePreview(refactoring, plan.transport || '');
      if (
        stableHash(canonicalPreview(freshPreview)) !== payload.drift.previewHash
        || stableHash(canonicalAffected(freshPreview)) !== payload.drift.affectedObjectHash
      ) {
        return this.fail(plan, new SafeAbapError('STATE_DRIFT', 'DRIFT_CHECK', 'The SAP package migration preview changed after confirmation.'), 'FAILED');
      }
      await appendStage(plan, { stage: 'DRIFT_CHECK', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);

      let executeError: unknown;
      try {
        await this.client.changePackageExecute(freshPreview);
        await appendStage(plan, { stage: 'EXECUTE', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
      } catch (error) {
        executeError = error;
        await appendStage(plan, { stage: 'EXECUTE', success: false, message: errorMessage(error) }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy, false);
      }

      const verified = await this.verifyPackage(plan).catch(() => false);
      if (!verified) {
        return this.fail(plan, new SafeAbapError(
          'UNKNOWN_OUTCOME',
          'VERIFY',
          executeError
            ? `Package execution failed and the final package could not be proven: ${errorMessage(executeError)}`
            : 'Package execution returned, but the target package could not be verified.'
        ), 'UNKNOWN_OUTCOME');
      }

      await appendStage(plan, { stage: 'VERIFY', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
      this.plans.recordResult(operationPlanId, executeError
        ? 'The response was interrupted, but a read-only check proved the object is in the target package.'
        : 'The package migration completed and the target package was verified.');
      this.plans.setStatus(operationPlanId, 'APPLIED');
      await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED', true, this.policy, {
        verificationHash: stableHash({ objectName: plan.target.objectName, packageName: payload.verification.expectedPackage })
      }));
      return { status: 'success', plan: this.plans.view(operationPlanId, context) };
    });
  }

  status(operationPlanId: string) {
    return this.plans.view(operationPlanId, advancedContext(this.policy));
  }

  private async verifyPackage(plan: AdvancedOperationPlan): Promise<boolean> {
    const object = await this.resolver.resolve(plan.target.objectType, plan.target.objectName);
    return String(object.packageName || '').trim().toUpperCase() === plan.target.packageName;
  }

  private async fail(plan: AdvancedOperationPlan, error: SafeAbapError, status: 'FAILED' | 'UNKNOWN_OUTCOME'): Promise<never> {
    this.plans.recordResult(plan.operationPlanId, error.message, { code: error.code, stage: error.stage, message: error.message });
    this.plans.setStatus(plan.operationPlanId, status);
    await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED_WITH_ERROR', false, this.policy, {
      errorCode: error.code,
      errorSummary: error.message,
      unknownOutcome: status === 'UNKNOWN_OUTCOME'
    }));
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)) });
  }
}

function normalizePackage(value: unknown, label: string): string {
  const packageName = String(value || '').trim().toUpperCase();
  if (!packageName || packageName.length > 255) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${label} must be a bounded package name.`);
  }
  return packageName;
}

function initialRefactoring(
  object: Awaited<ReturnType<AbapObjectResolver['resolve']>>,
  oldPackage: string,
  newPackage: string,
  transport: string
): ChangePackageRefactoring {
  return {
    oldPackage,
    newPackage,
    transport,
    ignoreSyntaxErrorsAllowed: false,
    ignoreSyntaxErrors: false,
    adtObjectUri: object.objectUrl,
    affectedObjects: {
      uri: object.objectUrl,
      type: object.adtType,
      name: object.objectName,
      oldPackage,
      newPackage,
      parentUri: ''
    },
    userContent: ''
  } as ChangePackageRefactoring;
}

function assertPreviewIdentity(preview: ChangePackageRefactoring, objectUrl: string, oldPackage: string, newPackage: string, transport: string): void {
  if (
    String(preview.adtObjectUri) !== objectUrl
    || preview.oldPackage.toUpperCase() !== oldPackage
    || preview.newPackage.toUpperCase() !== newPackage
    || preview.transport.toUpperCase() !== transport
  ) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'SAP returned a package preview for a different target, package, or transport.');
  }
}

function canonicalPreview(value: ChangePackageRefactoring): Record<string, unknown> {
  return {
    oldPackage: value.oldPackage,
    newPackage: value.newPackage,
    transport: value.transport,
    adtObjectUri: value.adtObjectUri,
    ignoreSyntaxErrorsAllowed: value.ignoreSyntaxErrorsAllowed,
    ignoreSyntaxErrors: value.ignoreSyntaxErrors,
    affectedObjects: canonicalAffected(value)
  };
}

function canonicalAffected(value: ChangePackageRefactoring): Array<{ uri: string; type: string; name: string; oldPackage: string; newPackage: string }> {
  const raw = value.affectedObjects as unknown;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.map(item => {
    const record = item as Record<string, unknown>;
    return {
      uri: String(record.uri || ''),
      type: String(record.type || ''),
      name: String(record.name || ''),
      oldPackage: String(record.oldPackage || value.oldPackage),
      newPackage: String(record.newPackage || value.newPackage)
    };
  }).sort((left, right) => `${left.type}:${left.name}:${left.uri}`.localeCompare(`${right.type}:${right.name}:${right.uri}`));
}
