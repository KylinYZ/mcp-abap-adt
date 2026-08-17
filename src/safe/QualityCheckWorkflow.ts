import { createHash } from 'crypto';
import type { AtcCustomizing, AtcRunResult, UnitTestClass, UnitTestRunFlags } from '../adt/index.js';
import type { AbapObjectResolver } from './AbapObjectResolver.js';
import type { AuditEvent } from './AuditLogger.js';
import { SafeAbapError } from './errors.js';
import { QualityCheckPlanStore } from './QualityCheckPlanStore.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import type {
  AtcResultSummary,
  QualityCheckContext,
  QualityCheckPlan,
  QualityCheckPlanView,
  QualityCheckPreviewResult,
  QualityCheckResultSummary,
  QualityObjectSnapshot,
  QualityVariantRequiredResult,
  UnitTestResultSummary
} from './qualityTypes.js';

interface QualityCheckClient {
  getObjectSource(objectSourceUrl: string, options?: { version?: 'active' }): Promise<string>;
  atcCustomizing(): Promise<AtcCustomizing>;
  unitTestRun(url: string | string[], flags: UnitTestRunFlags, timeoutMs?: number): Promise<UnitTestClass[]>;
  createAtcRun(variant: string, mainUrl: string | string[], maxResults?: number, timeoutMs?: number): Promise<AtcRunResult>;
}

interface QualityAuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface PreviewQualityCheckInput {
  kind: 'ABAP_UNIT' | 'ATC';
  objects: Array<{ objectType: string; objectName: string }>;
  variant?: string;
  riskLevel?: 'HARMLESS' | 'DANGEROUS' | 'CRITICAL';
  duration?: 'SHORT' | 'MEDIUM' | 'LONG';
  timeoutSeconds?: number;
}

export class QualityCheckWorkflow {
  constructor(
    private readonly client: QualityCheckClient,
    private readonly resolver: Pick<AbapObjectResolver, 'resolve'>,
    private readonly policy: SafetyPolicy,
    private readonly plans: QualityCheckPlanStore,
    private readonly audit: QualityAuditSink
  ) {}

  async preview(input: PreviewQualityCheckInput): Promise<QualityCheckPreviewResult | QualityVariantRequiredResult> {
    assertAllowedKeys(input, ['kind', 'objects', 'variant', 'riskLevel', 'duration', 'timeoutSeconds'], 'quality preview');
    const kind = parseKind(input?.kind);
    const objectInputs = parseObjects(input?.objects);
    const riskLevel = parseRiskLevel(input?.riskLevel);
    const duration = parseDuration(input?.duration);
    const timeoutSeconds = parseTimeout(input?.timeoutSeconds);
    const variant = kind === 'ATC' ? parseVariant(input?.variant) : undefined;
    if (kind === 'ABAP_UNIT' && input?.variant !== undefined) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'variant is only valid for ATC quality checks.');
    }
    if (kind === 'ATC' && !variant) {
      const customizing = await this.client.atcCustomizing();
      return {
        status: 'variant_required',
        kind: 'ATC',
        configuredSystemVariant: systemVariant(customizing),
        message: 'Choose an explicit ATC variant and create a new preview; the server will not select one automatically.',
        confirmationRequired: false
      };
    }

    const snapshots: QualityObjectSnapshot[] = [];
    for (const objectInput of objectInputs) {
      this.policy.assertQualityCheckAllowed(objectInput.objectName);
      const object = await this.resolver.resolve(objectInput.objectType, objectInput.objectName);
      const source = await this.client.getObjectSource(object.sourceUrl, { version: 'active' });
      snapshots.push({ object, sourceHash: hash(source) });
    }
    const plan = this.plans.create({
      context: qualityContext(this.policy),
      kind,
      objects: snapshots,
      variant,
      riskLevel,
      duration,
      timeoutSeconds,
      flags: unitFlags(riskLevel, duration)
    });
    try {
      this.plans.recordStage(plan.qualityPlanId, { stage: 'PREVIEW', success: true });
      await this.audit.append(qualityAuditEvent(plan, this.policy, 'QUALITY_PREVIEW_CREATED', true));
    } catch (error) {
      this.plans.recordResult(plan.qualityPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'PREVIEW', message: 'Quality preview audit failed.'
      });
      this.plans.setStatus(plan.qualityPlanId, 'FAILED');
      throw error;
    }
    return { status: 'preview', plan: this.status(plan.qualityPlanId), confirmationRequired: true };
  }

  status(qualityPlanId: string): QualityCheckPlanView {
    return this.plans.view(qualityPlanId, qualityContext(this.policy));
  }

  async run(qualityPlanId: string): Promise<Record<string, unknown>> {
    const context = qualityContext(this.policy);
    const previewed = this.plans.getForContext(qualityPlanId, context);
    if (previewed.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'quality-plan', `Quality check plan is already ${previewed.status.toLowerCase()}.`);
    }
    const payload = previewed.payload;
    if (!payload) throw new SafeAbapError('PLAN_NOT_EXECUTABLE', 'quality-plan', 'Quality check plan payload is unavailable.');

    const currentSnapshots: QualityObjectSnapshot[] = [];
    for (const snapshot of payload.objects) {
      this.policy.assertQualityCheckAllowed(snapshot.object.objectName);
      const resolved = await this.resolver.resolve(snapshot.object.objectType, snapshot.object.objectName);
      const source = await this.client.getObjectSource(resolved.sourceUrl, { version: 'active' });
      currentSnapshots.push({ object: resolved, sourceHash: hash(source) });
    }
    if (!sameSnapshots(payload.objects, currentSnapshots)) {
      return this.failBeforeExecution(previewed, new SafeAbapError(
        'STATE_DRIFT', 'DRIFT_CHECK', 'One or more quality-check objects changed after preview.'
      ));
    }
    this.plans.recordStage(qualityPlanId, { stage: 'DRIFT_CHECK', success: true });
    const plan = this.plans.beginRun(qualityPlanId, context);
    try {
      await this.audit.append(qualityAuditEvent(plan, this.policy, 'QUALITY_RUN_CONFIRMED', true));
    } catch (error) {
      this.plans.recordResult(qualityPlanId, undefined, {
        code: 'AUDIT_FAILED', stage: 'CONFIRM', message: 'Quality confirmation audit failed.'
      });
      this.plans.setStatus(qualityPlanId, 'FAILED');
      throw error;
    }

    let summary: QualityCheckResultSummary;
    try {
      const urls = payload.objects.map(snapshot => snapshot.object.objectUrl);
      const rawResult = payload.kind === 'ABAP_UNIT'
        ? await this.client.unitTestRun(urls, payload.flags, payload.timeoutMs)
        : await this.client.createAtcRun(payload.variant as string, urls, 100, payload.timeoutMs);
      summary = payload.kind === 'ABAP_UNIT'
        ? summarizeUnitTests(rawResult as UnitTestClass[])
        : summarizeAtc(rawResult as AtcRunResult);
    } catch {
      const error = new SafeAbapError(
        'UNKNOWN_OUTCOME',
        'EXECUTE',
        'The quality-check request outcome is unknown. Do not create or run a replacement plan until read-only evidence is reviewed.'
      );
      this.plans.recordStage(qualityPlanId, { stage: 'EXECUTE', success: false, message: 'Remote outcome unknown.' });
      this.plans.recordResult(qualityPlanId, undefined, { code: error.code, stage: error.stage, message: error.message });
      this.plans.setStatus(qualityPlanId, 'UNKNOWN_OUTCOME');
      try {
        await this.audit.append(qualityAuditEvent(plan, this.policy, 'QUALITY_RUN_UNKNOWN', false, undefined, true));
      } catch {
        // The preserved UNKNOWN_OUTCOME state remains the primary replay-safety signal.
      }
      throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.status(qualityPlanId) });
    }
    this.plans.recordStage(qualityPlanId, { stage: 'EXECUTE', success: true });
    this.plans.recordResult(qualityPlanId, summary);
    this.plans.setStatus(qualityPlanId, 'SUCCEEDED');
    await this.audit.append(qualityAuditEvent(plan, this.policy, 'QUALITY_RUN_COMPLETED', true, summary));
    return { status: 'success', plan: this.status(qualityPlanId) };
  }

  private async failBeforeExecution(plan: QualityCheckPlan, error: SafeAbapError): Promise<never> {
    this.plans.recordStage(plan.qualityPlanId, { stage: error.stage, success: false, message: error.message });
    this.plans.recordResult(plan.qualityPlanId, undefined, { code: error.code, stage: error.stage, message: error.message });
    this.plans.setStatus(plan.qualityPlanId, 'FAILED');
    await this.audit.append(qualityAuditEvent(plan, this.policy, 'QUALITY_RUN_REJECTED', false));
    throw new SafeAbapError(error.code, error.stage, error.message, { plan: this.status(plan.qualityPlanId) });
  }
}

function parseKind(value: unknown): PreviewQualityCheckInput['kind'] {
  if (value !== 'ABAP_UNIT' && value !== 'ATC') {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'kind must be ABAP_UNIT or ATC.');
  }
  return value;
}

function parseObjects(value: unknown): PreviewQualityCheckInput['objects'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'objects must contain between one and twenty exact object identities.');
  }
  const result = value.map(item => {
    assertAllowedKeys(item, ['objectType', 'objectName'], 'quality object');
    const record = asRecord(item);
    const objectType = String(record.objectType || '').trim().toUpperCase();
    const objectName = String(record.objectName || '').trim().toUpperCase();
    if (!objectType || !objectName || objectType.length > 64 || objectName.length > 128) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Each quality object requires bounded objectType and objectName values.');
    }
    return { objectType, objectName };
  });
  const identities = result.map(item => `${item.objectType}:${item.objectName}`);
  if (new Set(identities).size !== identities.length) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Quality-check objects must be unique.');
  }
  return result;
}

function parseRiskLevel(value: unknown): NonNullable<PreviewQualityCheckInput['riskLevel']> {
  const normalized = String(value || 'HARMLESS').toUpperCase();
  if (normalized === 'HARMLESS' || normalized === 'DANGEROUS' || normalized === 'CRITICAL') return normalized;
  throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'riskLevel must be HARMLESS, DANGEROUS, or CRITICAL.');
}

function parseDuration(value: unknown): NonNullable<PreviewQualityCheckInput['duration']> {
  const normalized = String(value || 'SHORT').toUpperCase();
  if (normalized === 'SHORT' || normalized === 'MEDIUM' || normalized === 'LONG') return normalized;
  throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'duration must be SHORT, MEDIUM, or LONG.');
}

function parseTimeout(value: unknown): number {
  const candidate = value === undefined ? 60 : value;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 5 || candidate > 600) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'timeoutSeconds must be an integer between 5 and 600.');
  }
  return candidate;
}

function parseVariant(value: unknown): string | undefined {
  if (value === undefined || String(value).trim() === '') return undefined;
  const variant = String(value).trim().toUpperCase();
  if (variant.length > 64 || !/^[A-Z0-9_/$.-]+$/.test(variant)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'variant contains unsupported characters or exceeds 64 characters.');
  }
  return variant;
}

function unitFlags(
  riskLevel: QualityCheckPlan['riskLevel'],
  duration: QualityCheckPlan['duration']
): UnitTestRunFlags {
  return {
    harmless: riskLevel === 'HARMLESS',
    dangerous: riskLevel === 'DANGEROUS',
    critical: riskLevel === 'CRITICAL',
    short: duration === 'SHORT',
    medium: duration === 'MEDIUM',
    long: duration === 'LONG'
  };
}

function systemVariant(customizing: AtcCustomizing): string | undefined {
  const variant = customizing.properties.find(property => property.name === 'systemCheckVariant')?.value;
  return typeof variant === 'string' && variant.trim() ? variant.trim() : undefined;
}

function sameSnapshots(expected: QualityObjectSnapshot[], actual: QualityObjectSnapshot[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((snapshot, index) => {
    const current = actual[index];
    return snapshot.object.objectType === current.object.objectType
      && snapshot.object.objectName === current.object.objectName
      && snapshot.object.adtType === current.object.adtType
      && snapshot.object.objectUrl === current.object.objectUrl
      && snapshot.object.sourceUrl === current.object.sourceUrl
      && snapshot.sourceHash === current.sourceHash;
  });
}

function summarizeUnitTests(classes: UnitTestClass[]): UnitTestResultSummary {
  if (!Array.isArray(classes)) throw new Error('Invalid ABAP Unit response.');
  const classCount = classes.length;
  const methodCount = classes.reduce((count, item) => count + (Array.isArray(item.testmethods) ? item.testmethods.length : 0), 0);
  const alertCount = classes.reduce((count, item) => (
    count + (Array.isArray(item.alerts) ? item.alerts.length : 0)
      + (Array.isArray(item.testmethods)
        ? item.testmethods.reduce((methodAlerts, method) => methodAlerts + (Array.isArray(method.alerts) ? method.alerts.length : 0), 0)
        : 0)
  ), 0);
  let remainingMethods = 500;
  let truncated = classes.length > 100;
  const summaries = classes.slice(0, 100).map(item => {
    const methods = Array.isArray(item.testmethods) ? item.testmethods : [];
    const selected = methods.slice(0, remainingMethods);
    if (selected.length < methods.length) truncated = true;
    remainingMethods -= selected.length;
    return {
      name: String(item['adtcore:name'] || '').slice(0, 128),
      type: String(item['adtcore:type'] || '').slice(0, 64),
      riskLevel: String(item.riskLevel || '').slice(0, 32),
      durationCategory: String(item.durationCategory || '').slice(0, 32),
      alertCount: Array.isArray(item.alerts) ? item.alerts.length : 0,
      methods: selected.map(method => ({
        name: String(method['adtcore:name'] || '').slice(0, 128),
        executionTime: Number(method.executionTime) || 0,
        unit: String(method.unit || '').slice(0, 32),
        alerts: (Array.isArray(method.alerts) ? method.alerts : []).slice(0, 20).map(alert => ({
          kind: String(alert.kind || '').slice(0, 64),
          severity: String(alert.severity || '').slice(0, 64),
          title: String(alert.title || '').slice(0, 500)
        }))
      }))
    };
  });
  return { kind: 'ABAP_UNIT', classCount, methodCount, alertCount, truncated, classes: summaries };
}

function summarizeAtc(result: AtcRunResult): AtcResultSummary {
  const id = String(result?.id || '').trim();
  const timestamp = Number(result?.timestamp);
  if (!id || !Number.isFinite(timestamp) || !Array.isArray(result?.infos)) throw new Error('Invalid ATC response.');
  return {
    kind: 'ATC',
    runResultId: id.slice(0, 256),
    timestamp,
    infos: result.infos.slice(0, 100).map(info => ({
      type: String(info.type || '').slice(0, 64),
      description: String(info.description || '').slice(0, 500)
    })),
    truncated: result.infos.length > 100
  };
}

function qualityContext(policy: SafetyPolicy): QualityCheckContext {
  return {
    systemHost: policy.systemHost,
    client: policy.client,
    sapUser: policy.sapUser,
    systemRole: policy.systemRole,
    toolProfile: policy.toolProfile
  };
}

function qualityAuditEvent(
  plan: QualityCheckPlan,
  policy: SafetyPolicy,
  eventType: string,
  success: boolean,
  result?: QualityCheckResultSummary,
  unknownOutcome = false
): AuditEvent {
  return {
    correlationId: plan.qualityPlanId,
    qualityPlanId: plan.qualityPlanId,
    eventType,
    systemHost: policy.systemHost,
    client: policy.client,
    systemRole: policy.systemRole,
    qualityCheckKind: plan.kind,
    qualityObjectCount: plan.objects.length,
    qualityVariantHash: plan.variant ? hash(plan.variant) : undefined,
    resultSummary: result
      ? result.kind === 'ABAP_UNIT'
        ? `${result.classCount} classes, ${result.methodCount} methods, ${result.alertCount} alerts`
        : `ATC run ${result.runResultId}`
      : undefined,
    unknownOutcome,
    success
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertAllowedKeys(value: unknown, keys: string[], label: string): void {
  const record = asRecord(value);
  const unexpected = Object.keys(record).filter(key => !keys.includes(key));
  if (unexpected.length > 0) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `${label} does not accept fields: ${unexpected.join(', ')}.`);
  }
}

function asRecord(value: unknown): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'Quality check input must be an object.');
  }
  return value as Record<string, any>;
}
