import type { RuntimeGuardrailValues } from '../config/RuntimeGuardrails.js';
import { ToolExecutionGate } from './ToolExecutionGate.js';
import { applyToolArgumentLimits, assertToolResponseSize } from './requestLimits.js';

export function adtClientOptions(guardrails: RuntimeGuardrailValues): { timeout: number; keepAlive: boolean } {
  return { timeout: guardrails.adtTimeoutMs, keepAlive: true };
}

export function usesSapExecutionGate(toolName: string): boolean {
  return toolName !== 'applyAbapChange'
    && toolName !== 'getAbapChangeStatus'
    && toolName !== 'applyAbapObjectCreation'
    && toolName !== 'getAbapObjectCreationStatus'
    && toolName !== 'applyDebugOperation'
    && toolName !== 'applyDebugVariableChange'
    && toolName !== 'authorizeDebugSession'
    && toolName !== 'getDebugOperationStatus'
    && toolName !== 'revokeDebugSession'
    && toolName !== 'applyDdicPropertyChange'
    && toolName !== 'applyPackageChange'
    && toolName !== 'applyRapOperation'
    && toolName !== 'applyRepositoryObjectCreation'
    && toolName !== 'getRepositoryObjectCreationStatus'
    && toolName !== 'applyRepositoryObjectCleanup'
    && toolName !== 'getRepositoryObjectCleanupStatus'
    && toolName !== 'runQualityCheck'
    && toolName !== 'getQualityCheckStatus'
    && toolName !== 'healthcheck';
}

export async function executeGuardedToolCall<T>(
  toolName: string,
  argumentsValue: Record<string, unknown> | undefined,
  guardrails: RuntimeGuardrailValues,
  gate: ToolExecutionGate,
  useSapGate: boolean,
  dispatch: (limitedArguments: Record<string, unknown>) => Promise<unknown>,
  serialize: (result: unknown) => T,
  serializeError: (error: unknown) => T
): Promise<T> {
  let finalResult: T;
  try {
    // Reject invalid request sizes before reserving a scarce SAP execution slot.
    const limitedArguments = applyToolArgumentLimits(toolName, argumentsValue, guardrails);
    const operation = () => dispatch(limitedArguments);
    const result = await (useSapGate ? gate.run(operation) : operation());
    finalResult = serialize(result);
  } catch (error) {
    finalResult = serializeError(error);
  }

  try {
    assertToolResponseSize(finalResult, guardrails.maxResponseBytes);
    return finalResult;
  } catch {
    return responseTooLargeResult() as T;
  }
}

function responseTooLargeResult(): Record<string, unknown> {
  return {
    content: [{
      type: 'text',
      text: '{"error":"Tool response exceeded the configured byte limit.","code":413}'
    }],
    isError: true
  };
}
