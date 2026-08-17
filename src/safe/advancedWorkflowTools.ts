import { createHash } from 'crypto';
import type { TransportInfo, TransportRequest } from '../adt/index.js';
import type { AuditEvent } from './AuditLogger.js';
import type { AdvancedOperationPlan, AdvancedOperationStage, AdvancedPlanContext } from './advancedTypes.js';
import type { AdvancedOperationPlanStore } from './AdvancedOperationPlanStore.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { SafetyPolicy } from './SafetyPolicy.js';

export interface AdvancedAuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface AdvancedTransportClient {
  transportInfo(objectUrl: string, devClass?: string, operation?: string): Promise<TransportInfo>;
  transportDetails(transportNumber: string): Promise<TransportRequest>;
}

export function advancedContext(policy: SafetyPolicy): AdvancedPlanContext {
  return {
    systemHost: policy.systemHost,
    client: policy.client,
    systemRole: policy.systemRole,
    toolProfile: policy.toolProfile
  };
}

export function assertAdvancedMutationAllowed(policy: SafetyPolicy, objectName: string): void {
  if ((policy.toolProfile !== 'development' && policy.toolProfile !== 'development-workbench') || policy.systemRole !== 'DEV') {
    throw new SafeAbapError(
      'POLICY_DENIED',
      'POLICY',
      'Controlled advanced operations require the development or development-workbench profile on SAP_MCP_SYSTEM_ROLE=DEV.'
    );
  }
  policy.assertMutationAllowed(objectName);
}

export async function validateAdvancedTransport(
  client: AdvancedTransportClient,
  policy: SafetyPolicy,
  objectUrl: string,
  packageName: string | undefined,
  transportValue: string
): Promise<string> {
  const transport = policy.assertTransportFormat(transportValue);
  const transportPackage = policy.assertTransportablePackage(packageName);
  try {
    const info = await client.transportInfo(objectUrl, transportPackage, 'I');
    policy.assertTransportablePackage(info.DEVCLASS || transportPackage);
    if (!transportNumbers(info).has(transport)) {
      throw new SafeAbapError('TRANSPORT_INVALID', 'VALIDATE', `Transport ${transport} is not available for the target object.`);
    }
    const details = await client.transportDetails(transport);
    const status = String(details['tm:status'] || '').trim().toUpperCase();
    if (status === 'R' || status.includes('RELEASE')) {
      throw new SafeAbapError('TRANSPORT_INVALID', 'VALIDATE', `Transport ${transport} is already released.`);
    }
    return transport;
  } catch (error) {
    if (error instanceof SafeAbapError) throw error;
    throw new SafeAbapError('TRANSPORT_INVALID', 'VALIDATE', `Failed to validate transport ${transport}: ${errorMessage(error)}`);
  }
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function assertBoundedJson(value: unknown, label: string, maxBytes = 256 * 1024): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${label} must be JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${label} exceeds the ${maxBytes}-byte safety limit.`);
  }
}

export function assertAllowedKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${label} must be an object.`);
  }
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new SafeAbapError('VALIDATION_FAILED', 'VALIDATE', `${label} contains unsupported fields: ${unexpected.join(', ')}.`);
  }
}

export function changedFieldPaths(current: unknown, proposed: unknown, prefix = '', output: string[] = []): string[] {
  if (stableHash(current) === stableHash(proposed)) return output;
  if (!isPlainObject(current) || !isPlainObject(proposed)) {
    output.push(prefix || '$');
    return output;
  }
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  for (const key of [...keys].sort()) {
    if (output.length >= 100) break;
    changedFieldPaths(current[key], proposed[key], prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

export function errorForStage(error: unknown, fallbackCode: 'REMOTE_WRITE_FAILED' | 'VERIFICATION_FAILED', stage: string): SafeAbapError {
  if (error instanceof SafeAbapError) return error;
  return new SafeAbapError(fallbackCode, stage, errorMessage(error));
}

export function advancedAuditEvent(
  plan: AdvancedOperationPlan,
  eventType: string,
  success: boolean,
  policy: SafetyPolicy,
  extras: Partial<AuditEvent> = {}
): AuditEvent {
  return {
    correlationId: plan.operationPlanId,
    operationPlanId: plan.operationPlanId,
    eventType,
    systemHost: plan.context.systemHost,
    client: plan.context.client,
    systemRole: policy.systemRole,
    objectType: plan.target.objectType,
    objectName: plan.target.objectName,
    packageName: plan.target.packageName,
    transportRequest: plan.transport,
    advancedOperationKind: plan.operationKind,
    inputHash: plan.payloadFingerprint.inputHash,
    driftHash: plan.payloadFingerprint.driftHash,
    recoveryHash: plan.payloadFingerprint.recoveryHash,
    success,
    ...extras
  };
}

export async function appendStage(
  plan: AdvancedOperationPlan,
  stage: Omit<AdvancedOperationStage, 'timestamp'>,
  record: (stage: Omit<AdvancedOperationStage, 'timestamp'>) => void,
  audit: AdvancedAuditSink,
  policy: SafetyPolicy,
  fatal = true
): Promise<void> {
  record(stage);
  try {
    await audit.append(advancedAuditEvent(plan, stage.stage, stage.success, policy, {
      errorSummary: stage.success ? undefined : stage.message
    }));
  } catch (error) {
    if (fatal) throw error;
  }
}

export async function guardAdvancedApply<T>(
  plan: AdvancedOperationPlan,
  plans: AdvancedOperationPlanStore,
  audit: AdvancedAuditSink,
  policy: SafetyPolicy,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (plans.view(plan.operationPlanId).status !== 'APPLYING') throw error;

    // Once a remote write stage has started, an unexpected failure must be
    // treated as uncertain rather than making the frozen plan reusable.
    const writeMayHaveStarted = plan.stages.some(stage => (
      stage.stage === 'EXECUTE'
      || stage.stage === 'UNLOCK'
      || stage.stage === 'ACTIVATE'
      || stage.stage === 'VERIFY'
      || stage.stage === 'ROLLBACK'
    ));
    const safeError = error instanceof SafeAbapError
      ? error
      : new SafeAbapError(
        writeMayHaveStarted ? 'UNKNOWN_OUTCOME' : 'VALIDATION_FAILED',
        writeMayHaveStarted ? 'APPLY' : 'PRE_APPLY',
        errorMessage(error)
      );
    const status = writeMayHaveStarted || safeError.code === 'UNKNOWN_OUTCOME'
      ? 'UNKNOWN_OUTCOME'
      : 'FAILED';
    plans.recordResult(plan.operationPlanId, safeError.message, {
      code: safeError.code,
      stage: safeError.stage,
      message: safeError.message
    });
    plans.setStatus(plan.operationPlanId, status);
    try {
      await audit.append(advancedAuditEvent(plan, 'APPLY_COMPLETED_WITH_ERROR', false, policy, {
        errorCode: safeError.code,
        errorSummary: safeError.message,
        unknownOutcome: status === 'UNKNOWN_OUTCOME'
      }));
    } catch {
      // The original apply failure and terminal plan status remain authoritative.
    }
    throw new SafeAbapError(safeError.code, safeError.stage, safeError.message, {
      plan: plans.view(plan.operationPlanId, advancedContext(policy))
    });
  }
}

function transportNumbers(info: TransportInfo): Set<string> {
  return new Set([
    ...(info.TRANSPORTS || []).map(item => item.TRKORR),
    info.LOCKS?.HEADER?.TRKORR,
    ...(info.LOCKS?.TASKS || []).map(item => item.TRKORR)
  ].filter((value): value is string => Boolean(value)).map(value => value.toUpperCase()));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
