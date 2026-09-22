import type { RuntimeGuardrailValues } from '../config/RuntimeGuardrails.js';
import { ToolExecutionGate } from './ToolExecutionGate.js';
import { applyToolArgumentLimits, assertToolResponseSize } from './requestLimits.js';

export function adtClientOptions(guardrails: RuntimeGuardrailValues): { timeout: number; keepAlive: boolean } {
  return { timeout: guardrails.adtTimeoutMs, keepAlive: true };
}

export function usesSapExecutionGate(toolName: string): boolean {
  return toolName !== 'sap'
    && toolName !== 'sapDoctor'
    && toolName !== 'applyAbapChange'
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
    // 受控激活：apply 在确认层内部会再次经过 executionGate（applyConfirmed），
    // 若外层 dispatch 已占用唯一槽位会自我死锁（maxConcurrentTools=1 时必现），
    // 因此与 applyRepositoryObjectCreation 等确认型工具同样豁免外层 gate；
    // getObjectActivationStatus 是纯本地 plan 读取，与同构 status 工具一并豁免。
    && toolName !== 'applyObjectActivation'
    && toolName !== 'getObjectActivationStatus'
    // 受控克隆：apply 在原生确认后委托受控创建链（其确认层内部自持 executionGate），
    // 外层 dispatch 若先占唯一槽位同样会自我死锁，与受控激活同豁免；
    // getCloneObjectStatus 是纯本地 plan 读取，与同构 status 工具一并豁免。
    && toolName !== 'applyCloneObject'
    && toolName !== 'getCloneObjectStatus'
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
