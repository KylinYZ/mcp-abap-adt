import type {
  ActivationResult,
  AdtLock,
  DataElementMetaData,
  DataElementProperties,
  DomainMetaData,
  DomainProperties,
  SearchResult,
  TextElement,
  TextElementCategory,
  TextElementsResult
} from '../adt/index.js';
import { textElementsUrl } from '../adt/index.js';
import type { AuditEvent } from './AuditLogger.js';
import { AdvancedOperationPlanStore } from './AdvancedOperationPlanStore.js';
import type {
  AdvancedOperationPayload,
  AdvancedOperationPlan,
  AdvancedOperationPreviewResult
} from './advancedTypes.js';
import {
  advancedAuditEvent,
  advancedContext,
  assertAdvancedMutationAllowed,
  appendStage,
  assertAllowedKeys,
  assertBoundedJson,
  changedFieldPaths,
  guardAdvancedApply,
  stableHash,
  validateAdvancedTransport,
  type AdvancedAuditSink,
  type AdvancedTransportClient
} from './advancedWorkflowTools.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { normalizeObjectName, SafetyPolicy } from './SafetyPolicy.js';

type DdicPayload = Extract<AdvancedOperationPayload, {
  kind: 'SET_DOMAIN_PROPERTIES' | 'SET_DATA_ELEMENT_PROPERTIES' | 'SET_TEXT_ELEMENTS';
}>;

interface DdicWorkflowClient extends AdvancedTransportClient {
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  getDomainProperties(url: string, version?: 'active' | 'inactive' | 'workingArea'): Promise<{ metaData: DomainMetaData; properties: DomainProperties }>;
  setDomainProperties(url: string, properties: DomainProperties, metaData: DomainMetaData, lockHandle: string, transport?: string): Promise<void>;
  getDataElementProperties(url: string, version?: 'active' | 'inactive' | 'workingArea'): Promise<{ metaData: DataElementMetaData; properties: DataElementProperties }>;
  setDataElementProperties(url: string, properties: DataElementProperties, metaData: DataElementMetaData, lockHandle: string, transport?: string): Promise<void>;
  getTextElements(url: string, category?: TextElementCategory): Promise<TextElementsResult>;
  setTextElements(url: string, category: TextElementCategory, elements: TextElement[], lockHandle: string, transport?: string): Promise<void>;
  lock(objectUrl: string, accessMode?: string): Promise<AdtLock>;
  unLock(objectUrl: string, lockHandle: string): Promise<string>;
  activate(objectName: string, objectUrl: string, mainInclude?: string, preauditRequested?: boolean): Promise<ActivationResult>;
}

interface DdicTarget {
  objectType: 'DOMAIN' | 'DATA_ELEMENT' | 'PROGRAM' | 'CLASS' | 'FUNCTION_GROUP';
  objectName: string;
  objectUrl: string;
  propertyUrl: string;
  packageName: string;
}

export class DdicPropertyChangeWorkflow {
  constructor(
    private readonly client: DdicWorkflowClient,
    private readonly policy: SafetyPolicy,
    private readonly plans: AdvancedOperationPlanStore,
    private readonly audit: AdvancedAuditSink
  ) {}

  async preview(args: Record<string, unknown>): Promise<AdvancedOperationPreviewResult> {
    const operation = parseOperation(args);
    const objectName = normalizeObjectName(String(operation.objectName || ''));
    assertAdvancedMutationAllowed(this.policy, objectName);
    const target = await this.resolveTarget(operation, objectName);
    const transport = await validateAdvancedTransport(
      this.client,
      this.policy,
      target.objectUrl,
      target.packageName,
      String(operation.transportRequest || '')
    );
    const current = await this.readCurrent(target, operation);
    const payload = this.createPayload(target, operation, current);
    const changedFields = changedFieldPaths(currentComparable(payload, true), currentComparable(payload, false));
    if (changedFields.length === 0) {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'The proposed DDIC state is identical to the current SAP state.');
    }

    const plan = this.plans.create({
      context: advancedContext(this.policy),
      target: { objectType: target.objectType, objectName, packageName: target.packageName },
      transport,
      inputSummary: {
        title: `Change ${target.objectType} ${objectName}`,
        changedFields,
        warning: 'This DEV operation writes DDIC metadata or text elements and activates the target.'
      },
      currentStateSummary: {
        stateHash: payload.drift.currentHash,
        description: `${changedFields.length} bounded field path(s) differ from the active SAP state.`
      },
      payload,
      rollbackSupported: true
    });
    try {
      await appendStage(plan, { stage: 'PREVIEW', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
    } catch (error) {
      this.plans.recordResult(plan.operationPlanId, 'Preview audit failed.', safeErrorRecord(error, 'AUDIT_FAILED', 'PREVIEW'));
      this.plans.setStatus(plan.operationPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)), confirmationRequired: true };
  }

  async apply(operationPlanId: string): Promise<Record<string, unknown>> {
    const context = advancedContext(this.policy);
    const previewed = this.plans.getForContext(operationPlanId, context);
    if (!isDdicKind(previewed.operationKind)) {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'This plan is not a DDIC property operation.');
    }
    assertAdvancedMutationAllowed(this.policy, previewed.target.objectName);
    const plan = this.plans.beginApply(operationPlanId, context);
    return guardAdvancedApply(plan, this.plans, this.audit, this.policy, async () => {
      plan.confirmationMode = 'elicitation';
      const payload = requireDdicPayload(plan);
      await appendStage(plan, { stage: 'CONFIRM', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);

      await validateAdvancedTransport(this.client, this.policy, payload.objectUrl, plan.target.packageName, plan.transport || '');
      const current = await this.readPayloadState(payload, 'active');
      if (stableHash(current) !== payload.drift.currentHash) {
        return this.fail(plan, new SafeAbapError('STATE_DRIFT', 'DRIFT_CHECK', 'The active DDIC state changed after preview.'), 'FAILED');
      }
      await appendStage(plan, { stage: 'DRIFT_CHECK', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);

      let lockHandle: string;
      try {
        lockHandle = (await this.client.lock(payload.objectUrl, 'MODIFY')).LOCK_HANDLE;
        payload.lockHandle = lockHandle;
        await appendStage(plan, { stage: 'LOCK', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
      } catch (error) {
        return this.fail(plan, new SafeAbapError('REMOTE_WRITE_FAILED', 'LOCK', `Failed to lock the DDIC target: ${errorMessage(error)}`), 'FAILED');
      }

      try {
        await this.writePayload(payload, lockHandle, plan.transport);
        await appendStage(plan, { stage: 'EXECUTE', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
      } catch (error) {
        const outcome = await this.classifyWriteFailure(payload);
        await this.bestEffortUnlock(plan, payload, lockHandle, false);
        const writeError = new SafeAbapError(
          outcome === 'UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'REMOTE_WRITE_FAILED',
          'EXECUTE',
          `The DDIC setter failed and was not retried: ${errorMessage(error)}`
        );
        return this.fail(plan, writeError, outcome === 'UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'FAILED');
      }

      const unlocked = await this.bestEffortUnlock(plan, payload, lockHandle, true);
      if (!unlocked) {
        return this.recover(plan, payload, new SafeAbapError('REMOTE_WRITE_FAILED', 'UNLOCK', 'The target was written but could not be unlocked before activation.'), lockHandle);
      }

      try {
        await this.activate(payload, plan.target.objectName);
        await appendStage(plan, { stage: 'ACTIVATE', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
      } catch (error) {
        return this.recover(plan, payload, new SafeAbapError('REMOTE_WRITE_FAILED', 'ACTIVATE', errorMessage(error)));
      }

      try {
        const verified = await this.readPayloadState(payload, 'active');
        const verificationHash = stableHash(verified);
        if (verificationHash !== payload.verification.expectedHash) {
          throw new SafeAbapError('VERIFICATION_FAILED', 'VERIFY', 'The activated DDIC state does not match the confirmed plan.');
        }
        await appendStage(plan, { stage: 'VERIFY', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
        this.plans.recordResult(operationPlanId, 'The DDIC change was activated and verified.');
        this.plans.setStatus(operationPlanId, 'APPLIED');
        await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED', true, this.policy, { verificationHash }));
        return { status: 'success', plan: this.plans.view(operationPlanId, context) };
      } catch (error) {
        return this.recover(plan, payload, error instanceof SafeAbapError
          ? error
          : new SafeAbapError('VERIFICATION_FAILED', 'VERIFY', errorMessage(error)));
      }
    });
  }

  status(operationPlanId: string) {
    return this.plans.view(operationPlanId, advancedContext(this.policy));
  }

  private async resolveTarget(operation: Record<string, unknown>, objectName: string): Promise<DdicTarget> {
    const kind = String(operation.kind || '');
    if (kind === 'SET_DOMAIN_PROPERTIES') {
      const current = await this.client.getDomainProperties(ddicUrl('domains', objectName), 'active');
      assertIdentity(current.metaData.name, objectName, 'domain');
      return { objectType: 'DOMAIN', objectName, objectUrl: ddicUrl('domains', objectName), propertyUrl: ddicUrl('domains', objectName), packageName: current.metaData.packageName };
    }
    if (kind === 'SET_DATA_ELEMENT_PROPERTIES') {
      const current = await this.client.getDataElementProperties(ddicUrl('dataelements', objectName), 'active');
      assertIdentity(current.metaData.name, objectName, 'data element');
      return { objectType: 'DATA_ELEMENT', objectName, objectUrl: ddicUrl('dataelements', objectName), propertyUrl: ddicUrl('dataelements', objectName), packageName: current.metaData.packageName };
    }
    if (kind !== 'SET_TEXT_ELEMENTS') {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'Unsupported DDIC operation kind.');
    }
    const objectType = String(operation.objectType || '').trim().toUpperCase();
    if (!['PROGRAM', 'CLASS', 'FUNCTION_GROUP'].includes(objectType)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'SET_TEXT_ELEMENTS requires objectType PROGRAM, CLASS, or FUNCTION_GROUP.');
    }
    const results = await this.client.searchObject(objectName, undefined, 50);
    const match = uniqueTextTarget(results, objectType, objectName);
    return {
      objectType: objectType as DdicTarget['objectType'],
      objectName,
      objectUrl: validateAdtUrl(match['adtcore:uri']),
      propertyUrl: textElementsUrl(match['adtcore:type'], objectName),
      packageName: String(match['adtcore:packageName'] || '')
    };
  }

  private async readCurrent(target: DdicTarget, operation: Record<string, unknown>): Promise<unknown> {
    if (target.objectType === 'DOMAIN') return this.client.getDomainProperties(target.propertyUrl, 'active');
    if (target.objectType === 'DATA_ELEMENT') return this.client.getDataElementProperties(target.propertyUrl, 'active');
    return this.client.getTextElements(target.propertyUrl, parseCategory(operation.category));
  }

  private createPayload(target: DdicTarget, operation: Record<string, unknown>, currentValue: unknown): DdicPayload {
    assertBoundedJson(operation, 'DDIC operation');
    if (target.objectType === 'DOMAIN') {
      validateDomainInput(operation);
      const current = currentValue as { metaData: DomainMetaData; properties: DomainProperties };
      const proposed = { properties: structuredClone(operation.properties as DomainProperties), metaData: structuredClone(operation.metaData as DomainMetaData) };
      assertMetadataIdentity(proposed.metaData, current.metaData, target.objectName);
      return {
        kind: 'SET_DOMAIN_PROPERTIES', objectUrl: target.objectUrl, activationUrl: target.objectUrl,
        input: proposed, drift: { currentHash: stableHash(current) }, recovery: structuredClone(current),
        verification: { expectedHash: stableHash(proposed) }
      };
    }
    if (target.objectType === 'DATA_ELEMENT') {
      validateDataElementInput(operation);
      const current = currentValue as { metaData: DataElementMetaData; properties: DataElementProperties };
      const proposed = { properties: structuredClone(operation.properties as DataElementProperties), metaData: structuredClone(operation.metaData as DataElementMetaData) };
      assertMetadataIdentity(proposed.metaData, current.metaData, target.objectName);
      return {
        kind: 'SET_DATA_ELEMENT_PROPERTIES', objectUrl: target.objectUrl, activationUrl: target.objectUrl,
        input: proposed, drift: { currentHash: stableHash(current) }, recovery: structuredClone(current),
        verification: { expectedHash: stableHash(proposed) }
      };
    }
    const category = parseCategory(operation.category);
    const elements = parseElements(operation.elements);
    const current = currentValue as TextElementsResult;
    return {
      kind: 'SET_TEXT_ELEMENTS', objectUrl: target.objectUrl, activationUrl: target.objectUrl,
      input: { category, elements }, drift: { currentHash: stableHash({ category, elements: current.textElements }) },
      recovery: { category, elements: structuredClone(current.textElements) },
      verification: { expectedHash: stableHash({ category, elements }) }
    };
  }

  private readPayloadState(payload: DdicPayload, version: 'active' | 'inactive'): Promise<unknown> {
    if (payload.kind === 'SET_DOMAIN_PROPERTIES') return this.client.getDomainProperties(payload.objectUrl, version);
    if (payload.kind === 'SET_DATA_ELEMENT_PROPERTIES') return this.client.getDataElementProperties(payload.objectUrl, version);
    return this.client.getTextElements(textElementsUrlForPayload(payload), payload.input.category)
      .then(result => ({ category: payload.input.category, elements: result.textElements }));
  }

  private writePayload(payload: DdicPayload, lockHandle: string, transport?: string): Promise<void> {
    if (payload.kind === 'SET_DOMAIN_PROPERTIES') {
      return this.client.setDomainProperties(payload.objectUrl, payload.input.properties, payload.input.metaData, lockHandle, transport);
    }
    if (payload.kind === 'SET_DATA_ELEMENT_PROPERTIES') {
      return this.client.setDataElementProperties(payload.objectUrl, payload.input.properties, payload.input.metaData, lockHandle, transport);
    }
    return this.client.setTextElements(textElementsUrlForPayload(payload), payload.input.category, payload.input.elements, lockHandle, transport);
  }

  private writeRecovery(payload: DdicPayload, lockHandle: string, transport?: string): Promise<void> {
    if (payload.kind === 'SET_DOMAIN_PROPERTIES') {
      return this.client.setDomainProperties(payload.objectUrl, payload.recovery.properties, payload.recovery.metaData, lockHandle, transport);
    }
    if (payload.kind === 'SET_DATA_ELEMENT_PROPERTIES') {
      return this.client.setDataElementProperties(payload.objectUrl, payload.recovery.properties, payload.recovery.metaData, lockHandle, transport);
    }
    return this.client.setTextElements(textElementsUrlForPayload(payload), payload.recovery.category, payload.recovery.elements, lockHandle, transport);
  }

  private async activate(payload: DdicPayload, objectName: string): Promise<void> {
    const result = await this.client.activate(objectName, payload.activationUrl, undefined, true);
    if (!result.success) {
      throw new SafeAbapError('REMOTE_WRITE_FAILED', 'ACTIVATE', result.messages.map(message => message.shortText).filter(Boolean).join('; ') || 'SAP activation failed.');
    }
  }

  private async classifyWriteFailure(payload: DdicPayload): Promise<'UNCHANGED' | 'UNKNOWN'> {
    if (payload.kind === 'SET_TEXT_ELEMENTS') return 'UNKNOWN';
    try {
      // A failed PUT may still have changed the inactive version while the active
      // version remains old. Only an unchanged inactive read proves no write.
      const inactive = await this.readPayloadState(payload, 'inactive');
      return stableHash(inactive) === payload.drift.currentHash ? 'UNCHANGED' : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  private async bestEffortUnlock(plan: AdvancedOperationPlan, payload: DdicPayload, lockHandle: string, auditFailureIsFatal: boolean): Promise<boolean> {
    try {
      await this.client.unLock(payload.objectUrl, lockHandle);
      payload.lockHandle = undefined;
      await appendStage(plan, { stage: 'UNLOCK', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy, auditFailureIsFatal);
      return true;
    } catch (error) {
      await appendStage(plan, { stage: 'UNLOCK', success: false, message: errorMessage(error) }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy, false);
      return false;
    }
  }

  private async recover(plan: AdvancedOperationPlan, payload: DdicPayload, primary: SafeAbapError, existingLockHandle?: string): Promise<never> {
    let rollbackError: string | undefined;
    try {
      const lockHandle = existingLockHandle || (await this.client.lock(payload.objectUrl, 'MODIFY')).LOCK_HANDLE;
      await this.writeRecovery(payload, lockHandle, plan.transport);
      const unlocked = await this.bestEffortUnlock(plan, payload, lockHandle, false);
      if (!unlocked) throw new Error('Failed to unlock restored DDIC state.');
      await this.activate(payload, plan.target.objectName);
      const restored = await this.readPayloadState(payload, 'active');
      if (stableHash(restored) !== stableHash(recoveryComparable(payload))) {
        throw new Error('Restored DDIC state could not be verified.');
      }
      await appendStage(plan, { stage: 'ROLLBACK', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy, false);
      this.plans.recordResult(plan.operationPlanId, 'The DDIC change failed and the original state was restored.', errorRecord(primary));
      this.plans.setStatus(plan.operationPlanId, 'ROLLED_BACK');
      await this.audit.append(advancedAuditEvent(plan, 'APPLY_ROLLED_BACK', false, this.policy, { errorCode: primary.code, errorSummary: primary.message, rollbackAttempted: true, rollbackSucceeded: true }));
      throw new SafeAbapError(primary.code, primary.stage, primary.message, { plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)) });
    } catch (error) {
      if (error instanceof SafeAbapError && this.plans.view(plan.operationPlanId).status === 'ROLLED_BACK') throw error;
      rollbackError = errorMessage(error);
    }
    const rollbackFailure = new SafeAbapError('ROLLBACK_FAILED', 'ROLLBACK', `DDIC recovery failed: ${rollbackError}`);
    this.plans.recordResult(plan.operationPlanId, rollbackFailure.message, errorRecord(primary));
    this.plans.setStatus(plan.operationPlanId, 'ROLLBACK_FAILED');
    await this.audit.append(advancedAuditEvent(plan, 'APPLY_ROLLBACK_FAILED', false, this.policy, { errorCode: primary.code, errorSummary: primary.message, rollbackAttempted: true, rollbackSucceeded: false }));
    throw new SafeAbapError('ROLLBACK_FAILED', 'ROLLBACK', rollbackFailure.message, {
      primaryError: errorRecord(primary),
      plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy))
    });
  }

  private async fail(plan: AdvancedOperationPlan, error: SafeAbapError, status: 'FAILED' | 'UNKNOWN_OUTCOME'): Promise<never> {
    this.plans.recordResult(plan.operationPlanId, error.message, errorRecord(error));
    this.plans.setStatus(plan.operationPlanId, status);
    await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED_WITH_ERROR', false, this.policy, {
      errorCode: error.code,
      errorSummary: error.message,
      unknownOutcome: status === 'UNKNOWN_OUTCOME'
    }));
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)) });
  }
}

function parseOperation(args: Record<string, unknown>): Record<string, unknown> {
  assertAllowedKeys(args, ['operation'], 'DDIC preview request');
  assertAllowedKeys(args.operation, ['kind', 'objectName', 'objectType', 'transportRequest', 'properties', 'metaData', 'category', 'elements'], 'DDIC operation');
  return args.operation;
}

function validateDomainInput(operation: Record<string, unknown>): void {
  assertAllowedKeys(operation.properties, ['typeInformation', 'outputInformation', 'valueInformation'], 'domain properties');
  assertAllowedKeys(operation.metaData, ['name', 'description', 'language', 'masterLanguage', 'masterSystem', 'responsible', 'packageName', 'packageDescription', 'packageUri'], 'domain metadata');
  if (!operation.properties.typeInformation || !operation.properties.outputInformation) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'Domain properties require typeInformation and outputInformation.');
  }
}

function validateDataElementInput(operation: Record<string, unknown>): void {
  assertAllowedKeys(operation.properties, ['typeName', 'dataType', 'dataTypeLength', 'dataTypeDecimals', 'fieldLabels', 'searchHelp', 'searchHelpParameter', 'setGetParameter', 'defaultComponentName', 'deactivateInputHistory', 'changeDocument', 'leftToRightDirection', 'deactivateBIDIFiltering'], 'data element properties');
  assertAllowedKeys(operation.metaData, ['name', 'description', 'language', 'masterLanguage', 'masterSystem', 'responsible', 'packageName', 'packageDescription', 'packageUri'], 'data element metadata');
  if (!operation.properties.fieldLabels) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'Data element properties require fieldLabels.');
  }
}

function assertMetadataIdentity(proposed: DomainMetaData | DataElementMetaData, current: DomainMetaData | DataElementMetaData, objectName: string): void {
  if (normalizeObjectName(proposed.name) !== objectName || normalizeObjectName(current.name) !== objectName) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'DDIC metadata name cannot change.');
  }
  if (normalizeObjectName(proposed.packageName) !== normalizeObjectName(current.packageName)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'DDIC property operations cannot change the package. Use the package workflow.');
  }
}

function parseCategory(value: unknown): TextElementCategory {
  const category = String(value || '').trim() as TextElementCategory;
  if (!['symbols', 'selections', 'headings'].includes(category)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'Text element category must be symbols, selections, or headings.');
  }
  return category;
}

function parseElements(value: unknown): TextElement[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'Text elements must be an array with at most 500 items.');
  }
  return value.map((entry, index) => {
    assertAllowedKeys(entry, ['id', 'text', 'maxLength', 'ddicReference'], `text element ${index}`);
    const id = String(entry.id || '');
    const text = String(entry.text ?? '');
    if (!id || id.length > 255 || text.length > 8192) {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `Text element ${index} exceeds its bounded field limits.`);
    }
    return { id, text, ...(entry.maxLength === undefined ? {} : { maxLength: Number(entry.maxLength) }), ...(entry.ddicReference === undefined ? {} : { ddicReference: String(entry.ddicReference) }) };
  });
}

function uniqueTextTarget(results: SearchResult[], objectType: string, objectName: string): SearchResult {
  const matches = results.filter(result => {
    const nameMatches = String(result['adtcore:name'] || '').toUpperCase() === objectName;
    const type = String(result['adtcore:type'] || '').toUpperCase();
    return nameMatches && (
      (objectType === 'PROGRAM' && type.startsWith('PROG/'))
      || (objectType === 'CLASS' && type.startsWith('CLAS/'))
      || (objectType === 'FUNCTION_GROUP' && type.startsWith('FUGR/'))
    );
  });
  if (matches.length !== 1) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'VALIDATE', `Expected exactly one ${objectType} ${objectName} for text elements.`);
  }
  return matches[0];
}

function currentComparable(payload: DdicPayload, recovery: boolean): unknown {
  if (payload.kind === 'SET_TEXT_ELEMENTS') {
    return recovery
      ? { category: payload.recovery.category, elements: payload.recovery.elements }
      : { category: payload.input.category, elements: payload.input.elements };
  }
  return recovery ? payload.recovery : payload.input;
}

function recoveryComparable(payload: DdicPayload): unknown {
  return payload.kind === 'SET_TEXT_ELEMENTS'
    ? { category: payload.recovery.category, elements: payload.recovery.elements }
    : payload.recovery;
}

function textElementsUrlForPayload(payload: Extract<DdicPayload, { kind: 'SET_TEXT_ELEMENTS' }>): string {
  const type = payload.activationUrl.includes('/oo/classes/') ? 'CLAS/OC'
    : payload.activationUrl.includes('/functions/groups/') ? 'FUGR/F'
      : 'PROG/P';
  const name = decodeURIComponent(payload.activationUrl.split('/').filter(Boolean).pop() || '');
  return textElementsUrl(type, name);
}

function requireDdicPayload(plan: AdvancedOperationPlan): DdicPayload {
  if (!plan.payload || !isDdicKind(plan.payload.kind)) {
    throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'The DDIC plan payload is unavailable.');
  }
  return plan.payload as DdicPayload;
}

function isDdicKind(kind: string): boolean {
  return ['SET_DOMAIN_PROPERTIES', 'SET_DATA_ELEMENT_PROPERTIES', 'SET_TEXT_ELEMENTS'].includes(kind);
}

function ddicUrl(segment: 'domains' | 'dataelements', objectName: string): string {
  return `/sap/bc/adt/ddic/${segment}/${encodeURIComponent(objectName.toLowerCase())}`;
}

function assertIdentity(actual: string, expected: string, label: string): void {
  if (String(actual || '').trim().toUpperCase() !== expected) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'VALIDATE', `SAP returned a different ${label} identity.`);
  }
}

function validateAdtUrl(value: string): string {
  const url = String(value || '').trim();
  if (!url.startsWith('/sap/bc/adt/')) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'VALIDATE', 'SAP returned an invalid ADT object URL.');
  }
  return url;
}

function errorRecord(error: SafeAbapError) {
  return { code: error.code, stage: error.stage, message: error.message };
}

function safeErrorRecord(error: unknown, code: AuditEvent['errorCode'], stage: string) {
  return { code: code || 'AUDIT_FAILED', stage, message: errorMessage(error) };
}
