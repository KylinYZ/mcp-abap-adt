import {
  parseServiceBinding,
  type AbapObjectStructure,
  type RapGeneratorContent,
  type RapGeneratorId,
  type RapGeneratorPreviewObject,
  type RapGeneratorValidationResult,
  type SearchResult
} from '../adt/index.js';
import { AdvancedOperationPlanStore } from './AdvancedOperationPlanStore.js';
import type { AdvancedOperationPlan, AdvancedOperationPreviewResult } from './advancedTypes.js';
import {
  advancedAuditEvent,
  advancedContext,
  assertAdvancedMutationAllowed,
  appendStage,
  guardAdvancedApply,
  assertAllowedKeys,
  assertBoundedJson,
  stableHash,
  validateAdvancedTransport,
  type AdvancedAuditSink,
  type AdvancedTransportClient
} from './advancedWorkflowTools.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { normalizeObjectName, SafetyPolicy } from './SafetyPolicy.js';

interface RapWorkflowClient extends AdvancedTransportClient {
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  objectStructure(objectUrl: string, version?: 'active' | 'inactive' | 'workingArea'): Promise<AbapObjectStructure>;
  getObjectSource(objectSourceUrl: string): Promise<string>;
  rapGenValidateInitial(genId: RapGeneratorId, refObjectUri: string, packageName: string, checks?: string[]): Promise<RapGeneratorValidationResult>;
  rapGenGetSchema(genId: RapGeneratorId, refObjectUri: string, packageName: string): Promise<string>;
  rapGenGetUiConfig(genId: RapGeneratorId, refObjectUri: string, packageName: string): Promise<string>;
  rapGenValidateContent(genId: RapGeneratorId, refObjectUri: string, content: RapGeneratorContent): Promise<RapGeneratorValidationResult>;
  rapGenPreview(genId: RapGeneratorId, refObjectUri: string, content: RapGeneratorContent): Promise<RapGeneratorPreviewObject[]>;
  rapGenGenerate(genId: RapGeneratorId, refObjectUri: string, transport: string, content: RapGeneratorContent): Promise<RapGeneratorPreviewObject[]>;
  rapGenIsAvailable(genId?: RapGeneratorId): Promise<boolean>;
  rapGenPublishService(serviceBindingName: string): Promise<RapGeneratorValidationResult>;
}

export class RapOperationWorkflow {
  constructor(
    private readonly client: RapWorkflowClient,
    private readonly policy: SafetyPolicy,
    private readonly plans: AdvancedOperationPlanStore,
    private readonly audit: AdvancedAuditSink
  ) {}

  async preview(args: Record<string, unknown>): Promise<AdvancedOperationPreviewResult> {
    assertAllowedKeys(args, ['operation'], 'RAP preview request');
    assertAllowedKeys(args.operation, ['kind', 'genId', 'referenceObjectName', 'packageName', 'transportRequest', 'serviceBindingName', 'content'], 'RAP operation');
    const kind = String(args.operation.kind || '');
    if (kind === 'RAP_GENERATE') return this.previewGenerate(args.operation);
    if (kind === 'RAP_PUBLISH_SERVICE') return this.previewPublish(args.operation);
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'RAP operation kind must be RAP_GENERATE or RAP_PUBLISH_SERVICE.');
  }

  async apply(operationPlanId: string): Promise<Record<string, unknown>> {
    const context = advancedContext(this.policy);
    const previewed = this.plans.getForContext(operationPlanId, context);
    if (previewed.operationKind !== 'RAP_GENERATE' && previewed.operationKind !== 'RAP_PUBLISH_SERVICE') {
      throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'This plan is not a RAP operation.');
    }
    assertAdvancedMutationAllowed(this.policy, previewed.target.objectName);
    const plan = this.plans.beginApply(operationPlanId, context);
    return guardAdvancedApply(plan, this.plans, this.audit, this.policy, async () => {
      plan.confirmationMode = 'elicitation';
      await appendStage(plan, { stage: 'CONFIRM', success: true }, stage => this.plans.recordStage(operationPlanId, stage), this.audit, this.policy);
      return plan.operationKind === 'RAP_GENERATE' ? this.applyGenerate(plan) : this.applyPublish(plan);
    });
  }

  status(operationPlanId: string) {
    return this.plans.view(operationPlanId, advancedContext(this.policy));
  }

  private async previewGenerate(operation: Record<string, unknown>): Promise<AdvancedOperationPreviewResult> {
    const genId = parseGenId(operation.genId);
    const referenceObjectName = normalizeObjectName(String(operation.referenceObjectName || ''));
    assertAdvancedMutationAllowed(this.policy, referenceObjectName);
    const reference = await resolveReference(this.client, referenceObjectName);
    const packageName = normalizePackage(operation.packageName);
    this.policy.assertTransportablePackage(packageName);
    const transport = await validateAdvancedTransport(this.client, this.policy, reference.uri, packageName, String(operation.transportRequest || ''));
    const content = parseContent(operation.content, packageName, referenceObjectName);
    await this.assertAvailable(genId);

    const initial = await this.client.rapGenValidateInitial(genId, reference.uri, packageName);
    assertValidation(initial, 'Initial RAP validation failed.');
    const [schema, uiConfig] = await Promise.all([
      this.client.rapGenGetSchema(genId, reference.uri, packageName),
      this.client.rapGenGetUiConfig(genId, reference.uri, packageName)
    ]);
    assertTextBound(schema, 'RAP schema');
    assertTextBound(uiConfig, 'RAP UI configuration');
    const contentValidation = await this.client.rapGenValidateContent(genId, reference.uri, content);
    assertValidation(contentValidation, 'RAP content validation failed.');
    const preview = normalizePreview(await this.client.rapGenPreview(genId, reference.uri, content));
    if (preview.length === 0) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'RAP preview returned no generated objects.');
    }
    for (const object of preview) assertAdvancedMutationAllowed(this.policy, object.name);
    const validationHash = stableHash({ initial: normalizeValidation(initial), content: normalizeValidation(contentValidation) });
    const previewHash = stableHash(preview);
    const plan = this.plans.create({
      context: advancedContext(this.policy),
      target: { objectType: 'RAP_GENERATION', objectName: referenceObjectName, packageName },
      transport,
      inputSummary: {
        title: `Generate RAP artifacts for ${referenceObjectName}`,
        affectedObjects: preview.map(object => ({ type: object.type, name: object.name })),
        messages: toSummaryMessages([...asValidationArray(initial), ...asValidationArray(contentValidation)]),
        warning: 'Generation runs once; created objects are never automatically deleted or regenerated.'
      },
      currentStateSummary: {
        stateHash: stableHash({ reference, validationHash, previewHash }),
        description: `SAP preview reports ${preview.length} generated object(s).`
      },
      payload: {
        kind: 'RAP_GENERATE',
        input: { genId, refObjectUri: reference.uri, packageName, transport, content: structuredClone(content) },
        drift: { validationHash, previewHash },
        verification: { expectedObjects: preview.map(object => ({ uri: object.uri, type: object.type, name: object.name })) }
      },
      rollbackSupported: false
    });
    return this.finishPreview(plan);
  }

  private async previewPublish(operation: Record<string, unknown>): Promise<AdvancedOperationPreviewResult> {
    const serviceBindingName = normalizeObjectName(String(operation.serviceBindingName || ''));
    assertAdvancedMutationAllowed(this.policy, serviceBindingName);
    await this.assertAvailable();
    const state = await readBindingState(this.client, serviceBindingName);
    if (state.observable && state.published) {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${serviceBindingName} is already published.`);
    }
    const plan = this.plans.create({
      context: advancedContext(this.policy),
      target: { objectType: 'SERVICE_BINDING', objectName: serviceBindingName, packageName: state.packageName },
      inputSummary: {
        title: `Publish service binding ${serviceBindingName}`,
        warning: 'Publication runs once and is never automatically unpublished or retried.'
      },
      currentStateSummary: {
        stateHash: state.hash || stableHash({ observable: false }),
        description: state.observable
          ? `Current published state: ${state.published ? 'published' : 'not published'}.`
          : 'The current publication state is not observable through this SAP endpoint.'
      },
      payload: {
        kind: 'RAP_PUBLISH_SERVICE',
        input: { serviceBindingName },
        drift: { observableStateHash: state.hash, stateObservable: state.observable },
        verification: { expectedPublished: true }
      },
      rollbackSupported: false
    });
    return this.finishPreview(plan);
  }

  private async finishPreview(plan: AdvancedOperationPlan): Promise<AdvancedOperationPreviewResult> {
    try {
      await appendStage(plan, { stage: 'PREVIEW', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
    } catch (error) {
      this.plans.recordResult(plan.operationPlanId, 'RAP preview audit failed.', { code: 'AUDIT_FAILED', stage: 'PREVIEW', message: errorMessage(error) });
      this.plans.setStatus(plan.operationPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)), confirmationRequired: true };
  }

  private async applyGenerate(plan: AdvancedOperationPlan): Promise<Record<string, unknown>> {
    const payload = plan.payload?.kind === 'RAP_GENERATE' ? plan.payload : undefined;
    if (!payload) throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'The RAP generation plan payload is unavailable.');
    assertAdvancedMutationAllowed(this.policy, payload.input.content.general.referenceObjectName || plan.target.objectName);
    this.policy.assertTransportablePackage(payload.input.packageName);
    for (const expected of payload.verification.expectedObjects) assertAdvancedMutationAllowed(this.policy, expected.name);
    await validateAdvancedTransport(this.client, this.policy, payload.input.refObjectUri, payload.input.packageName, payload.input.transport);
    await this.assertAvailable(payload.input.genId);
    const initial = await this.client.rapGenValidateInitial(payload.input.genId, payload.input.refObjectUri, payload.input.packageName);
    assertValidation(initial, 'Initial RAP validation failed during drift check.');
    const contentValidation = await this.client.rapGenValidateContent(payload.input.genId, payload.input.refObjectUri, payload.input.content);
    assertValidation(contentValidation, 'RAP content validation failed during drift check.');
    const preview = normalizePreview(await this.client.rapGenPreview(payload.input.genId, payload.input.refObjectUri, payload.input.content));
    const validationHash = stableHash({ initial: normalizeValidation(initial), content: normalizeValidation(contentValidation) });
    if (validationHash !== payload.drift.validationHash || stableHash(preview) !== payload.drift.previewHash) {
      return this.fail(plan, new SafeAbapError('STATE_DRIFT', 'DRIFT_CHECK', 'RAP validation or generated object preview changed after confirmation.'), 'FAILED');
    }
    await appendStage(plan, { stage: 'DRIFT_CHECK', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);

    let generateError: unknown;
    try {
      await this.client.rapGenGenerate(payload.input.genId, payload.input.refObjectUri, payload.input.transport, payload.input.content);
      await appendStage(plan, { stage: 'EXECUTE', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
    } catch (error) {
      generateError = error;
      await appendStage(plan, { stage: 'EXECUTE', success: false, message: errorMessage(error) }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy, false);
    }

    const verification = await verifyGeneratedObjects(this.client, payload.verification.expectedObjects);
    if (verification.verified === verification.total && verification.total > 0) {
      await appendStage(plan, { stage: 'VERIFY', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
      this.plans.recordResult(plan.operationPlanId, generateError
        ? 'The response was interrupted, but every expected RAP object was verified read-only.'
        : 'Every expected RAP object was generated and verified.');
      this.plans.setStatus(plan.operationPlanId, 'APPLIED');
      await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED', true, this.policy, { verificationHash: stableHash(verification.objects) }));
      return { status: 'success', plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)) };
    }
    if (verification.verified > 0) {
      return this.fail(plan, new SafeAbapError('VERIFICATION_FAILED', 'VERIFY', `${verification.verified} of ${verification.total} RAP objects were verified; automatic cleanup is disabled.`), 'PARTIAL_SUCCESS');
    }
    return this.fail(plan, new SafeAbapError(
      'UNKNOWN_OUTCOME',
      'VERIFY',
      generateError
        ? `RAP generation failed and no expected object could be verified: ${errorMessage(generateError)}`
        : 'RAP generation returned, but no expected object could be verified.'
    ), 'UNKNOWN_OUTCOME');
  }

  private async applyPublish(plan: AdvancedOperationPlan): Promise<Record<string, unknown>> {
    const payload = plan.payload?.kind === 'RAP_PUBLISH_SERVICE' ? plan.payload : undefined;
    if (!payload) throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'advanced-plan', 'The RAP publication plan payload is unavailable.');
    const name = payload.input.serviceBindingName;
    assertAdvancedMutationAllowed(this.policy, name);
    await this.assertAvailable();
    const current = await readBindingState(this.client, name);
    if (
      payload.drift.stateObservable
      && (!current.observable || current.hash !== payload.drift.observableStateHash)
    ) {
      return this.fail(plan, new SafeAbapError('STATE_DRIFT', 'DRIFT_CHECK', 'The service binding publication state changed after preview.'), 'FAILED');
    }
    if (current.observable && current.published) {
      return this.fail(plan, new SafeAbapError('STATE_DRIFT', 'DRIFT_CHECK', 'The service binding was already published after preview.'), 'FAILED');
    }
    await appendStage(plan, { stage: 'DRIFT_CHECK', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);

    let publishError: unknown;
    let validation: RapGeneratorValidationResult | undefined;
    try {
      validation = await this.client.rapGenPublishService(name);
      await appendStage(plan, { stage: 'EXECUTE', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
    } catch (error) {
      publishError = error;
      await appendStage(plan, { stage: 'EXECUTE', success: false, message: errorMessage(error) }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy, false);
    }
    const after = await readBindingState(this.client, name);
    if (after.observable && after.published) {
      await appendStage(plan, { stage: 'VERIFY', success: true }, stage => this.plans.recordStage(plan.operationPlanId, stage), this.audit, this.policy);
      this.plans.recordResult(plan.operationPlanId, publishError
        ? 'The response was interrupted, but the binding is now observably published.'
        : 'The service binding is observably published.');
      this.plans.setStatus(plan.operationPlanId, 'APPLIED');
      await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED', true, this.policy, { verificationHash: after.hash }));
      return { status: 'success', plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)) };
    }
    const validationErrors = validation ? validationMessages(validation).filter(message => message.severity === 'error') : [];
    if (!publishError && after.observable && validationErrors.length > 0) {
      return this.fail(plan, new SafeAbapError('REMOTE_WRITE_FAILED', 'EXECUTE', validationErrors.map(message => message.text).join('; ')), 'FAILED');
    }
    if (!publishError && after.observable) {
      return this.fail(plan, new SafeAbapError('VERIFICATION_FAILED', 'VERIFY', 'The publication call returned but the binding remains unpublished.'), 'FAILED');
    }
    return this.fail(plan, new SafeAbapError(
      'UNKNOWN_OUTCOME',
      'VERIFY',
      publishError
        ? `The publication response was uncertain and state is not observable: ${errorMessage(publishError)}`
        : 'The publication state is not observable after execution.'
    ), 'UNKNOWN_OUTCOME');
  }

  private async assertAvailable(genId?: RapGeneratorId): Promise<void> {
    if (!await this.client.rapGenIsAvailable(genId)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'The RAP generator endpoint is not available on this SAP system.');
    }
  }

  private async fail(
    plan: AdvancedOperationPlan,
    error: SafeAbapError,
    status: 'FAILED' | 'PARTIAL_SUCCESS' | 'UNKNOWN_OUTCOME'
  ): Promise<never> {
    this.plans.recordResult(plan.operationPlanId, error.message, { code: error.code, stage: error.stage, message: error.message });
    this.plans.setStatus(plan.operationPlanId, status);
    await this.audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED_WITH_ERROR', false, this.policy, {
      errorCode: error.code,
      errorSummary: error.message,
      partialSuccess: status === 'PARTIAL_SUCCESS',
      unknownOutcome: status === 'UNKNOWN_OUTCOME'
    }));
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.plans.view(plan.operationPlanId, advancedContext(this.policy)) });
  }
}

function parseGenId(value: unknown): RapGeneratorId {
  if (value !== 'uiservice' && value !== 'webapiservice') {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'genId must be uiservice or webapiservice.');
  }
  return value;
}

function normalizePackage(value: unknown): string {
  const packageName = String(value || '').trim().toUpperCase();
  if (!packageName || packageName.length > 255) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'packageName must be a bounded transportable package.');
  }
  return packageName;
}

function parseContent(value: unknown, packageName: string, referenceObjectName: string): RapGeneratorContent {
  assertAllowedKeys(value, ['metadata', 'general', 'businessObject', 'serviceProjection', 'businessService'], 'RAP content');
  assertBoundedJson(value, 'RAP content');
  const content = structuredClone(value) as unknown as RapGeneratorContent;
  if (!content.general || !content.businessObject || !content.serviceProjection || !content.businessService) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'RAP content is missing required sections.');
  }
  if (content.metadata?.package && content.metadata.package.toUpperCase() !== packageName) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'RAP content metadata.package must match packageName.');
  }
  if (content.general.referenceObjectName && normalizeObjectName(content.general.referenceObjectName) !== referenceObjectName) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', 'RAP content referenceObjectName must match the resolved reference object.');
  }
  content.metadata = { ...(content.metadata || { package: packageName }), package: packageName };
  content.general.referenceObjectName = referenceObjectName;
  return content;
}

async function resolveReference(client: RapWorkflowClient, objectName: string): Promise<{ uri: string; type: string; name: string }> {
  const matches = (await client.searchObject(objectName, undefined, 50)).filter(result => String(result['adtcore:name'] || '').toUpperCase() === objectName);
  if (matches.length !== 1) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'VALIDATE', `Expected exactly one reference object named ${objectName}.`);
  }
  const match = matches[0];
  const uri = String(match['adtcore:uri'] || '');
  if (!uri.startsWith('/sap/bc/adt/')) {
    throw new SafeAbapError('OBJECT_RESOLUTION_FAILED', 'VALIDATE', 'SAP returned an invalid RAP reference URI.');
  }
  return { uri, type: String(match['adtcore:type'] || ''), name: objectName };
}

function assertValidation(result: RapGeneratorValidationResult, message: string): void {
  const errors = validationMessages(result).filter(item => item.severity === 'error');
  if (errors.length > 0) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${message} ${errors.map(item => item.text).join('; ')}`);
  }
}

function normalizeValidation(result: RapGeneratorValidationResult): Array<{ severity: string; text: string }> {
  return validationMessages(result).sort((left, right) => `${left.severity}:${left.text}`.localeCompare(`${right.severity}:${right.text}`));
}

function validationMessages(result: RapGeneratorValidationResult): Array<{ severity: 'info' | 'warning' | 'error'; text: string }> {
  return asValidationArray(result).map(item => ({
    severity: item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'info',
    text: String(item.shortText || item.longText || '').slice(0, 2000)
  }));
}

function asValidationArray(result: RapGeneratorValidationResult): RapGeneratorValidationResult[] {
  return Array.isArray(result) ? result : [result];
}

function toSummaryMessages(results: RapGeneratorValidationResult[]) {
  return results.slice(0, 100).map(item => ({
    severity: item.severity === 'error' ? 'error' as const : item.severity === 'warning' ? 'warning' as const : 'info' as const,
    text: String(item.shortText || item.longText || '').slice(0, 2000)
  }));
}

function normalizePreview(value: RapGeneratorPreviewObject[]): RapGeneratorPreviewObject[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'RAP preview must contain at most 500 objects.');
  }
  return value.map(item => {
    const uri = String(item.uri || '');
    const name = normalizeObjectName(String(item.name || ''));
    if (!uri.startsWith('/sap/bc/adt/')) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'RAP preview returned an invalid object URI.');
    }
    return { uri, type: String(item.type || ''), name, description: String(item.description || '').slice(0, 2000) };
  }).sort((left, right) => `${left.type}:${left.name}:${left.uri}`.localeCompare(`${right.type}:${right.name}:${right.uri}`));
}

async function verifyGeneratedObjects(
  client: RapWorkflowClient,
  expected: Array<{ uri: string; type: string; name: string }>
): Promise<{ verified: number; total: number; objects: Array<{ uri: string; verified: boolean }> }> {
  const objects = await Promise.all(expected.map(async object => {
    try {
      const structure = await client.objectStructure(object.uri, 'active');
      const nameMatches = String(structure.metaData['adtcore:name'] || '').toUpperCase() === object.name;
      const typeMatches = !object.type || String(structure.metaData['adtcore:type'] || '').toUpperCase() === object.type.toUpperCase();
      return { uri: object.uri, verified: nameMatches && typeMatches };
    } catch {
      return { uri: object.uri, verified: false };
    }
  }));
  return { verified: objects.filter(item => item.verified).length, total: objects.length, objects };
}

interface BindingState {
  observable: boolean;
  published?: boolean;
  hash?: string;
  packageName?: string;
}

async function readBindingState(client: RapWorkflowClient, name: string): Promise<BindingState> {
  const url = `/sap/bc/adt/businessservices/bindings/${encodeURIComponent(name.toLowerCase())}`;
  try {
    const binding = parseServiceBinding(await client.getObjectSource(url));
    const snapshot = {
      name: binding.name,
      published: binding.published,
      bindingCreated: binding.bindingCreated,
      packageName: binding.packageRef?.name,
      services: binding.services?.map(service => ({ name: service.name, version: service.version, releaseState: service.releaseState })) || []
    };
    return { observable: true, published: binding.published, hash: stableHash(snapshot), packageName: binding.packageRef?.name };
  } catch {
    return { observable: false };
  }
}

function assertTextBound(value: string, label: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 512 * 1024) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${label} exceeds the 524288-byte safety limit.`);
  }
}
