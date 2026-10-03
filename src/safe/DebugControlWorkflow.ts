import type {
  AmdpAwaitStopResult,
  AmdpBreakpointInput,
  AmdpDebugSession,
  DebugAttach,
  DebugBreakpoint,
  DebugStack,
  DebugStep,
  DebugVariable
} from '../adt/index.js';
import { createHash, randomBytes } from 'crypto';
import type { AuditEvent } from './AuditLogger.js';
import { DebugOperationPlanStore } from './DebugOperationPlanStore.js';
import {
  DebugSessionAuthorizationStore,
  type DebugAuthorizationContext
} from './DebugSessionAuthorizationStore.js';
import { SafeAbapError, errorMessage } from './errors.js';
import { SafetyPolicy } from './SafetyPolicy.js';
import type {
  DebugAttachContext,
  DebugOperation,
  DebugOperationPlan,
  DebugOperationPlanView,
  DebugSettingsInput,
  DebugStackSnapshot,
  SafeDebugClient,
  SafeDebugCommand
} from './debugTypes.js';

export interface DebugAuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface ApplyDebugOperationInput {
  debugOperationPlanId: string;
  confirmedByUser: boolean;
  /**
   * 确认方式（由确认层如实传入）：native 确认为 elicitation，
   * 部署级 auto 确认为 auto-config；缺省按 elicitation 兜底保持旧行为。
   */
  confirmationMode?: 'elicitation' | 'auto-config';
}

export class DebugControlWorkflow {
  private readonly attachContexts = new Map<string, DebugAttachContext>();
  /**
   * AMDP 调试会话登记（按规范化 targetUser 键控）。
   * mainId 存于 ABAP 会话内存（class-data），服务端状态跟随写域 stateful 主会话；
   * 这里只登记"本工作流自己 start 的会话"——SYNC/AWAIT/TERMINATE 只认这里的
   * mainId，不接受调用方传入任意句柄（对齐项目安全边界）。
   */
  private readonly amdpSessions = new Map<string, AmdpDebugSession>();

  constructor(
    private readonly client: SafeDebugClient,
    private readonly policy: SafetyPolicy,
    private readonly plans: DebugOperationPlanStore,
    private readonly authorizations: DebugSessionAuthorizationStore,
    private readonly audit: DebugAuditSink
  ) {}

  async previewOperation(input: { operation: unknown }): Promise<Record<string, unknown>> {
    const operation = parseDebugOperation(input.operation);
    const targetUser = this.policy.assertDebugControlAllowed(operationTargetUser(operation));
    normalizeOperationUser(operation, targetUser);
    if (operation.kind === 'JUMP_TO_LINE' || operation.kind === 'TERMINATE_DEBUGGEE') {
      this.assertAuthorized(operation.authorizationId, targetUser, operation.debuggeeId);
    }

    const plan = this.plans.create({
      systemHost: this.policy.systemHost,
      client: this.policy.client,
      targetUser,
      operation,
      ...operationDescription(operation)
    });
    try {
      await this.audit.append(this.auditEvent(plan, 'DEBUG_PREVIEW_CREATED', true));
    } catch (error) {
      this.plans.setStatus(plan.debugOperationPlanId, 'FAILED');
      throw error;
    }
    return {
      status: 'preview',
      plan: this.plans.view(plan.debugOperationPlanId),
      confirmationRequired: true,
      chatConfirmationRequired: false
    };
  }

  async applyOperation(input: ApplyDebugOperationInput): Promise<Record<string, unknown>> {
    if (input.confirmedByUser !== true) {
      throw new SafeAbapError('POLICY_DENIED', 'confirmation', 'Explicit user confirmation is required.');
    }

    const previewed = this.plans.get(String(input.debugOperationPlanId || ''));
    const targetUser = this.policy.assertDebugControlAllowed(previewed.targetUser);
    const plan = this.plans.beginApply(previewed.debugOperationPlanId, this.planContext(targetUser));
    // 确认方式如实记录：确认层 auto 短路时传 auto-config，与审计日志保持一致
    plan.confirmationMode = input.confirmationMode ?? 'elicitation';

    let result: unknown;
    try {
      result = await this.executeOperation(plan.operation);
    } catch (error) {
      if (isUncertainRemoteError(error)) {
        plan.primaryError = {
          code: 'REMOTE_RESULT_UNKNOWN',
          stage: 'debug-control',
          message: errorMessage(error)
        };
        this.plans.setStatus(plan.debugOperationPlanId, 'UNKNOWN');
        const recoveryState = await this.readRecoveryState(plan.operation);
        await this.audit.append(this.auditEvent(plan, 'DEBUG_OPERATION_RESULT_UNKNOWN', false));
        return {
          status: 'remote_result_unknown',
          plan: this.plans.view(plan.debugOperationPlanId),
          recoveryState,
          retryPerformed: false
        };
      }

      const safeError = error instanceof SafeAbapError
        ? error
        : new SafeAbapError('VERIFY_FAILED', 'debug-control', errorMessage(error));
      plan.primaryError = { code: safeError.code, stage: safeError.stage, message: safeError.message };
      this.plans.setStatus(plan.debugOperationPlanId, 'FAILED');
      await this.audit.append(this.auditEvent(plan, 'DEBUG_OPERATION_FAILED', false));
      throw safeError;
    }

    plan.resultSummary = summarizeResult(result);
    this.plans.setStatus(plan.debugOperationPlanId, 'APPLIED');
    // Keep the confirmed remote outcome even if the post-action audit sink later fails.
    await this.audit.append(this.auditEvent(plan, 'DEBUG_OPERATION_APPLIED', true));
    return {
      status: 'success',
      plan: this.plans.view(plan.debugOperationPlanId),
      result
    };
  }

  async authorizeConfirmed(targetUserValue: string, debuggeeId: string): Promise<Record<string, unknown>> {
    const targetUser = this.policy.assertDebugControlAllowed(targetUserValue);
    const attachContext = this.requireAttachContext(targetUser, debuggeeId);
    const stack = await this.client.debuggerStackTrace(true);
    const authorization = this.authorizations.create({
      ...this.planContext(targetUser),
      attachContext
    });
    try {
      await this.audit.append({
        ...this.baseAudit('DEBUG_SESSION_AUTHORIZED', true, targetUser),
        debuggeeId,
        debugAuthHash: hashIdentifier(authorization.authorizationId),
        resultSummary: `stackFrames=${stack.stack.length}`
      });
    } catch (error) {
      // Never leave an unaudited control authorization active.
      this.authorizations.revoke(authorization.authorizationId, 'AUDIT_FAILED');
      throw error;
    }
    return {
      status: 'authorized',
      authorization: this.authorizations.view(authorization.authorizationId),
      stack
    };
  }

  async executeCommand(input: {
    authorizationId: string;
    targetUser: string;
    command: SafeDebugCommand;
  }): Promise<Record<string, unknown>> {
    const targetUser = this.policy.assertDebugControlAllowed(input.targetUser);
    const attachContext = this.requireAttachContext(targetUser);
    const authorizationContext = { ...this.planContext(targetUser), attachContext };
    this.authorizations.getActive(input.authorizationId, authorizationContext);
    const command = parseSafeCommand(input.command);

    let stepResult: DebugStep | undefined;
    try {
      if (command.command === 'goToStack') {
        await this.client.debuggerGoToStack(command.urlOrPosition);
      } else if (command.command === 'stepRunToLine') {
        stepResult = await this.client.debuggerStep(command.command, command.url);
      } else {
        stepResult = await this.client.debuggerStep(command.command);
      }
      const stack = await this.client.debuggerStackTrace(true);
      const authorizationRevoked = this.revokeIfDebuggeeChanged(targetUser, input.authorizationId, stepResult);
      await this.audit.append({
        ...this.baseAudit('DEBUG_COMMAND_EXECUTED', true, targetUser),
        debuggeeId: attachContext.debuggeeId,
        debugAuthHash: hashIdentifier(input.authorizationId),
        debugOperationKind: command.command,
        resultSummary: `stackFrames=${stack.stack.length};authorizationRevoked=${authorizationRevoked}`
      });
      return { status: 'success', command, stepResult, stack, authorizationRevoked };
    } catch (error) {
      if (!isUncertainRemoteError(error)) throw error;
      const recoveryState = await this.safeStackRead();
      await this.audit.append({
        ...this.baseAudit('DEBUG_COMMAND_RESULT_UNKNOWN', false, targetUser),
        debuggeeId: attachContext.debuggeeId,
        debugAuthHash: hashIdentifier(input.authorizationId),
        debugOperationKind: command.command,
        errorCode: 'REMOTE_RESULT_UNKNOWN',
        errorSummary: errorMessage(error)
      });
      return { status: 'remote_result_unknown', command, recoveryState, retryPerformed: false };
    }
  }

  async previewVariableChange(input: {
    authorizationId: string;
    targetUser: string;
    variableName: string;
    newValue: string;
    parents?: string[];
  }): Promise<Record<string, unknown>> {
    const targetUser = this.policy.assertDebugControlAllowed(input.targetUser);
    const attachContext = this.requireAttachContext(targetUser);
    const authorizationContext = { ...this.planContext(targetUser), attachContext };
    this.authorizations.getActive(input.authorizationId, authorizationContext);
    const variableName = requiredString(input.variableName, 'variableName');
    if (typeof input.newValue !== 'string') {
      throw new SafeAbapError('VERIFY_FAILED', 'debug-variable', 'newValue must be a string.');
    }
    const parents = validateParents(input.parents);
    const stackInfo = await this.client.debuggerStackTrace(true);
    const stack = currentStack(stackInfo.stack, stackInfo.debugCursorStackIndex);
    const variables = await this.client.debuggerVariables(parents);
    const variable = findVariable(variables, variableName);
    if (isReadOnlyVariable(variable)) {
      throw new SafeAbapError('POLICY_DENIED', 'debug-variable', `Variable ${variableName} is read-only.`);
    }

    const operation: DebugOperation = {
      kind: 'SET_VARIABLE',
      targetUser,
      authorizationId: input.authorizationId,
      debuggeeId: attachContext.debuggeeId,
      variableName,
      oldValue: variable.VALUE,
      newValue: input.newValue,
      stack: stackSnapshot(stack),
      parents
    };
    const plan = this.plans.create({
      ...this.planContext(targetUser),
      operation,
      summary: `Modify ${variableName} in debuggee ${attachContext.debuggeeId}`,
      risk: 'Changes live runtime data and may alter the current transaction outcome.'
    });
    try {
      await this.audit.append(this.auditEvent(plan, 'DEBUG_VARIABLE_PREVIEW_CREATED', true));
    } catch (error) {
      this.plans.setStatus(plan.debugOperationPlanId, 'FAILED');
      throw error;
    }
    return {
      status: 'preview',
      plan: this.plans.view(plan.debugOperationPlanId),
      confirmationRequired: true,
      chatConfirmationRequired: false
    };
  }

  status(debugOperationPlanId: string): DebugOperationPlanView {
    return this.plans.view(debugOperationPlanId);
  }

  async revokeSession(authorizationId: string): Promise<Record<string, unknown>> {
    const view = this.authorizations.view(authorizationId);
    const targetUser = this.policy.assertDebugControlAllowed(view.targetUser);
    const authorization = this.authorizations.revoke(authorizationId);
    await this.audit.append({
      ...this.baseAudit('DEBUG_SESSION_REVOKED', true, targetUser),
      debuggeeId: authorization.attachContext.debuggeeId,
      debugAuthHash: hashIdentifier(authorizationId)
    });
    return { status: 'revoked', authorization: this.authorizations.view(authorizationId) };
  }

  currentAttach(targetUserValue: string, debuggeeId?: string): DebugAttachContext {
    const targetUser = this.policy.assertDebugControlAllowed(targetUserValue);
    return this.requireAttachContext(targetUser, debuggeeId);
  }

  private async executeOperation(operation: DebugOperation): Promise<unknown> {
    switch (operation.kind) {
      case 'CREATE_LISTENER':
        return this.client.debuggerListen(
          operation.listener.debuggingMode,
          operation.listener.terminalId,
          operation.listener.ideId,
          operation.listener.targetUser,
          operation.checkConflict,
          operation.isNotifiedOnConflict
        );
      case 'DELETE_LISTENER':
        return this.client.debuggerDeleteListener(
          operation.listener.debuggingMode,
          operation.listener.terminalId,
          operation.listener.ideId,
          operation.listener.targetUser
        );
      case 'SET_BREAKPOINTS':
        return this.client.debuggerSetBreakpoints(
          operation.listener.debuggingMode,
          operation.listener.terminalId,
          operation.listener.ideId,
          operation.clientId,
          operation.breakpoints,
          operation.listener.targetUser,
          operation.scope,
          operation.systemDebugging,
          operation.deactivated,
          operation.syncScopeUrl
        );
      case 'DELETE_BREAKPOINT':
        return this.client.debuggerDeleteBreakpoints(
          operation.breakpoint,
          operation.listener.debuggingMode,
          operation.listener.terminalId,
          operation.listener.ideId,
          operation.listener.targetUser,
          operation.scope
        );
      case 'ATTACH': {
        const result = await this.client.debuggerAttach(
          operation.debuggingMode,
          operation.debuggeeId,
          operation.targetUser,
          operation.dynproDebugging
        );
        const attachContext = attachContextFrom(operation.debuggeeId, result);
        this.authorizations.revokeForTarget(
          this.policy.systemHost,
          this.policy.client,
          operation.targetUser,
          'ATTACH_CONTEXT_CHANGED'
        );
        this.attachContexts.set(operation.targetUser, attachContext);
        return result;
      }
      case 'SAVE_SETTINGS':
        return this.client.debuggerSaveSettings(operation.settings);
      case 'JUMP_TO_LINE':
        this.assertAuthorized(operation.authorizationId, operation.targetUser, operation.debuggeeId);
        return this.executeHighRiskStep(operation.targetUser, operation.authorizationId, 'stepJumpToLine', operation.url);
      case 'TERMINATE_DEBUGGEE':
        this.assertAuthorized(operation.authorizationId, operation.targetUser, operation.debuggeeId);
        return this.executeHighRiskStep(operation.targetUser, operation.authorizationId, 'terminateDebuggee');
      case 'SET_VARIABLE':
        return this.applyVariableChange(operation);
      // ---------- AMDP 原生调试四操作（矩阵行 debug.amdp-adt） ----------
      // 全部走写槽 stateful 主会话：ADT 资源把调试句柄存在 ABAP class-data
      // 会话内存，同会话是正确性前提；apply 恒经 executionGate 串行，无并发。
      case 'AMDP_START': {
        const session = await this.client.amdpDebuggerStart({
          user: operation.targetUser,
          stopExisting: operation.stopExisting
        });
        // 登记后同用户后续 SYNC/AWAIT/TERMINATE 才可用；stopExisting 语义下
        // 重新 start 会替换旧登记（服务端旧会话已被 stopExisting 清理）。
        this.amdpSessions.set(operation.targetUser, session);
        return session;
      }
      case 'AMDP_SYNC_BREAKPOINTS': {
        const session = this.requireAmdpSession(operation.targetUser);
        const breakpoints: AmdpBreakpointInput[] = operation.breakpoints.map(spec => ({
          class: spec.class,
          line: spec.line
        }));
        await this.client.amdpDebuggerSyncBreakpoints(session.mainId, breakpoints, operation.syncMode);
        // 裁决不在这里：SAP 在下一个 awaitStop 的 ON_TOGGLE_BREAKPOINTS 里回报。
        return { synced: breakpoints.length, syncMode: operation.syncMode ?? 'FULL' };
      }
      case 'AMDP_AWAIT_STOP': {
        const session = this.requireAmdpSession(operation.targetUser);
        const awaitResult: AmdpAwaitStopResult = await this.client.amdpDebuggerAwaitStop(
          session.mainId,
          operation.maxEvents
        );
        // await 是观察操作：队列空/预算耗尽返回 stopped=false 的成功观察结果
        //（apply 侧 plan 置 APPLIED），agent 可据此再次轮询；硬故障走异常路径。
        return awaitResult;
      }
      case 'AMDP_TERMINATE': {
        const session = this.requireAmdpSession(operation.targetUser);
        await this.client.amdpDebuggerTerminate(session.mainId, operation.hardStop);
        // 只能终止自己 start 的会话：终态即注销登记，句柄不可复用。
        this.amdpSessions.delete(operation.targetUser);
        return { terminated: true, hardStop: operation.hardStop ?? true };
      }
    }
  }

  private async executeHighRiskStep(
    targetUser: string,
    authorizationId: string,
    stepType: 'stepJumpToLine' | 'terminateDebuggee',
    url?: string
  ): Promise<Record<string, unknown>> {
    const result = stepType === 'stepJumpToLine'
      ? await this.client.debuggerStep(stepType, requiredString(url, 'url'))
      : await this.client.debuggerStep(stepType);
    const stack = await this.client.debuggerStackTrace(true);
    const authorizationRevoked = this.revokeIfDebuggeeChanged(targetUser, authorizationId, result)
      || stepType === 'terminateDebuggee';
    if (stepType === 'terminateDebuggee') {
      this.authorizations.revoke(authorizationId, 'DEBUGGEE_TERMINATED');
      this.attachContexts.delete(targetUser);
    }
    return { result, stack, authorizationRevoked };
  }

  private async applyVariableChange(operation: Extract<DebugOperation, { kind: 'SET_VARIABLE' }>): Promise<Record<string, unknown>> {
    const authorization = this.assertAuthorized(operation.authorizationId, operation.targetUser, operation.debuggeeId);
    const stackInfo = await this.client.debuggerStackTrace(true);
    const stack = currentStack(stackInfo.stack, stackInfo.debugCursorStackIndex);
    if (!sameStack(operation.stack, stack)) {
      throw new SafeAbapError('DEBUG_STATE_DRIFT', 'debug-variable', 'The selected stack frame changed after preview.');
    }
    const variables = await this.client.debuggerVariables(operation.parents);
    const current = findVariable(variables, operation.variableName);
    if (current.VALUE !== operation.oldValue) {
      throw new SafeAbapError('DEBUG_STATE_DRIFT', 'debug-variable', `Variable ${operation.variableName} changed after preview.`);
    }

    const result = await this.client.debuggerSetVariableValue(operation.variableName, operation.newValue);
    const verifiedVariables = await this.client.debuggerVariables(operation.parents);
    const verified = findVariable(verifiedVariables, operation.variableName);
    const refreshedStack = await this.client.debuggerStackTrace(true);
    if (verified.VALUE !== operation.newValue) {
      throw new SafeAbapError('VERIFY_FAILED', 'debug-variable', `Variable ${operation.variableName} did not match the planned value after modification.`);
    }
    return {
      result,
      verifiedValueHash: hashIdentifier(verified.VALUE),
      stack: refreshedStack,
      authorization: this.authorizations.view(authorization.authorizationId)
    };
  }

  private assertAuthorized(authorizationId: string, targetUser: string, debuggeeId: string) {
    const attachContext = this.requireAttachContext(targetUser, debuggeeId);
    return this.authorizations.getActive(authorizationId, {
      ...this.planContext(targetUser),
      attachContext
    });
  }

  private requireAttachContext(targetUser: string, debuggeeId?: string): DebugAttachContext {
    const context = this.attachContexts.get(targetUser);
    if (!context || (debuggeeId && context.debuggeeId !== debuggeeId)) {
      throw new SafeAbapError('DEBUG_CONTEXT_MISSING', 'debug-context', 'No matching safe attach context exists for this SAP user and debuggee.');
    }
    return context;
  }

  /**
   * 取本工作流为该用户登记的 AMDP 会话；未 start 即拒止。
   * 安全语义：SYNC/AWAIT/TERMINATE 一律使用内部登记的 mainId——不接受调用方
   * 传入任意调试句柄；TERMINATE 因此天然只能终止自己 start 的会话。
   */
  private requireAmdpSession(targetUser: string): AmdpDebugSession {
    const session = this.amdpSessions.get(targetUser);
    if (!session) {
      throw new SafeAbapError('AMDP_SESSION_REQUIRED', 'debug-amdp', 'No AMDP debug session was started for this user; run AMDP_START first.');
    }
    return session;
  }

  private revokeIfDebuggeeChanged(targetUser: string, authorizationId: string, result?: DebugStep): boolean {
    if (!result?.isDebuggeeChanged) return false;
    this.authorizations.revoke(authorizationId, 'DEBUGGEE_CHANGED');
    this.attachContexts.delete(targetUser);
    return true;
  }

  private async readRecoveryState(operation: DebugOperation): Promise<Record<string, unknown>> {
    if ('listener' in operation) {
      try {
        const listenerState = await this.client.debuggerListeners(
          operation.listener.debuggingMode,
          operation.listener.terminalId,
          operation.listener.ideId,
          operation.listener.targetUser,
          false
        );
        return { listenerState, stack: await this.safeStackRead() };
      } catch (error) {
        return { listenerStateError: errorMessage(error), stack: await this.safeStackRead() };
      }
    }
    return { stack: await this.safeStackRead() };
  }

  private async safeStackRead(): Promise<unknown> {
    try {
      return await this.client.debuggerStackTrace(true);
    } catch (error) {
      return { status: 'unavailable', error: errorMessage(error) };
    }
  }

  private planContext(targetUser: string) {
    return { systemHost: this.policy.systemHost, client: this.policy.client, targetUser };
  }

  private auditEvent(plan: DebugOperationPlan, eventType: string, success: boolean): AuditEvent {
    const operation = plan.operation;
    return {
      ...this.baseAudit(eventType, success, plan.targetUser),
      debugOperationPlanId: plan.debugOperationPlanId,
      debugOperationKind: operation.kind,
      debuggeeId: 'debuggeeId' in operation ? operation.debuggeeId : undefined,
      debugAuthHash: 'authorizationId' in operation ? hashIdentifier(operation.authorizationId) : undefined,
      operationHash: plan.operationHash,
      oldValueHash: plan.variableValueHashes?.oldValueHash,
      newValueHash: plan.variableValueHashes?.newValueHash,
      resultSummary: plan.resultSummary,
      errorCode: plan.primaryError?.code,
      errorSummary: plan.primaryError?.message,
      confirmationMode: plan.confirmationMode
    };
  }

  private baseAudit(eventType: string, success: boolean, targetUser: string): AuditEvent {
    return {
      correlationId: randomCorrelationId(),
      eventType,
      systemHost: this.policy.systemHost,
      client: this.policy.client,
      systemRole: this.policy.systemRole,
      targetUser,
      success
    };
  }
}

function parseDebugOperation(value: unknown): DebugOperation {
  const input = asRecord(value, 'operation');
  const kind = requiredString(input.kind, 'operation.kind').toUpperCase();
  switch (kind) {
    case 'CREATE_LISTENER':
      return {
        kind,
        listener: parseListener(input),
        checkConflict: optionalBoolean(input.checkConflict, 'checkConflict'),
        isNotifiedOnConflict: optionalBoolean(input.isNotifiedOnConflict, 'isNotifiedOnConflict')
      };
    case 'DELETE_LISTENER':
      return { kind, listener: parseListener(input) };
    case 'SET_BREAKPOINTS': {
      if (!Array.isArray(input.breakpoints) || input.breakpoints.length === 0) {
        throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', 'breakpoints must contain at least one breakpoint.');
      }
      return {
        kind,
        listener: parseListener(input),
        clientId: requiredString(input.clientId, 'clientId'),
        breakpoints: input.breakpoints as Array<string | DebugBreakpoint>,
        scope: optionalScope(input.scope),
        systemDebugging: optionalBoolean(input.systemDebugging, 'systemDebugging'),
        deactivated: optionalBoolean(input.deactivated, 'deactivated'),
        syncScopeUrl: optionalString(input.syncScopeUrl)
      } as DebugOperation;
    }
    case 'DELETE_BREAKPOINT':
      return {
        kind,
        listener: parseListener(input),
        breakpoint: asRecord(input.breakpoint, 'breakpoint') as unknown as DebugBreakpoint,
        scope: optionalScope(input.scope)
      } as DebugOperation;
    case 'ATTACH':
      return {
        kind,
        debuggingMode: debuggingMode(input.debuggingMode),
        debuggeeId: requiredString(input.debuggeeId, 'debuggeeId'),
        targetUser: requiredString(input.targetUser, 'targetUser'),
        dynproDebugging: optionalBoolean(input.dynproDebugging, 'dynproDebugging')
      };
    case 'SAVE_SETTINGS':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'targetUser'),
        settings: parseSettings(input.settings)
      };
    case 'JUMP_TO_LINE':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'targetUser'),
        authorizationId: requiredString(input.authorizationId, 'authorizationId'),
        debuggeeId: requiredString(input.debuggeeId, 'debuggeeId'),
        url: requiredString(input.url, 'url')
      };
    case 'TERMINATE_DEBUGGEE':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'targetUser'),
        authorizationId: requiredString(input.authorizationId, 'authorizationId'),
        debuggeeId: requiredString(input.debuggeeId, 'debuggeeId')
      };
    case 'SET_VARIABLE':
      throw new SafeAbapError('POLICY_DENIED', 'debug-preview', 'Use previewDebugVariableChange for variable modifications.');
    // ---------- AMDP 原生调试四操作 ----------
    case 'AMDP_START':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'operation.targetUser'),
        stopExisting: optionalBoolean(input.stopExisting, 'operation.stopExisting')
      };
    case 'AMDP_SYNC_BREAKPOINTS':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'operation.targetUser'),
        breakpoints: parseAmdpBreakpoints(input.breakpoints),
        syncMode: parseAmdpSyncMode(input.syncMode)
      };
    case 'AMDP_AWAIT_STOP':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'operation.targetUser'),
        maxEvents: optionalAmdpMaxEvents(input.maxEvents)
      };
    case 'AMDP_TERMINATE':
      return {
        kind,
        targetUser: requiredString(input.targetUser, 'operation.targetUser'),
        hardStop: optionalBoolean(input.hardStop, 'operation.hardStop')
      };
    default:
      throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', `Unsupported debug operation kind ${kind}.`);
  }
}

/** AMDP 断点输入校验：class 非空、line 为正整数；clientId 是内部常量不收调用方值。 */
function parseAmdpBreakpoints(value: unknown): Array<{ class: string; line: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', 'breakpoints must contain at least one {class, line} entry.');
  }
  return value.map((item, index) => {
    const record = asRecord(item, `breakpoints[${index}]`);
    const className = requiredString(record.class, `breakpoints[${index}].class`);
    const line = record.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
      throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', `breakpoints[${index}].line must be a positive integer.`);
    }
    return { class: className, line };
  });
}

/** AMDP 同步模式校验：资源类只认 FULL/PROGRAM（其他报 INVALID SYNCMODE）。 */
function parseAmdpSyncMode(value: unknown): 'FULL' | 'PROGRAM' | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, 'operation.syncMode').toUpperCase();
  if (normalized !== 'FULL' && normalized !== 'PROGRAM') {
    throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', 'syncMode must be FULL or PROGRAM.');
  }
  return normalized;
}

/** await 预算校验：每次事件是一次快速 GET，上限 50 防御性收敛。 */
function optionalAmdpMaxEvents(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 50) {
    throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', 'maxEvents must be an integer between 1 and 50.');
  }
  return value;
}

function parseListener(input: Record<string, unknown>) {
  return {
    debuggingMode: debuggingMode(input.debuggingMode),
    terminalId: requiredString(input.terminalId, 'terminalId'),
    ideId: requiredString(input.ideId, 'ideId'),
    targetUser: requiredString(input.targetUser, 'targetUser')
  };
}

function parseSettings(value: unknown): DebugSettingsInput {
  const settings = asRecord(value, 'settings');
  const allowed = new Set([
    'systemDebugging', 'createExceptionObject', 'backgroundRFC',
    'sharedObjectDebugging', 'showDataAging', 'updateDebugging'
  ]);
  for (const key of Object.keys(settings)) {
    if (!allowed.has(key)) {
      throw new SafeAbapError('VERIFY_FAILED', 'debug-preview', `Unsupported debugger setting ${key}.`);
    }
  }
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, optionalBoolean(value, `settings.${key}`)])
  ) as DebugSettingsInput;
}

function parseSafeCommand(value: SafeDebugCommand): SafeDebugCommand {
  const input = asRecord(value, 'command');
  const command = requiredString(input.command, 'command.command');
  if (command === 'stepInto' || command === 'stepOver' || command === 'stepReturn' || command === 'stepContinue') {
    return { command };
  }
  if (command === 'stepRunToLine') return { command, url: requiredString(input.url, 'command.url') };
  if (command === 'goToStack') {
    if (typeof input.urlOrPosition !== 'string' && typeof input.urlOrPosition !== 'number') {
      throw new SafeAbapError('VERIFY_FAILED', 'debug-command', 'command.urlOrPosition must be a stack URI or numeric position.');
    }
    return { command, urlOrPosition: input.urlOrPosition };
  }
  throw new SafeAbapError('POLICY_DENIED', 'debug-command', 'Jump-to-line, terminate, and variable changes require separate preview and confirmation tools.');
}

function operationDescription(operation: DebugOperation): { summary: string; risk: string } {
  switch (operation.kind) {
    case 'CREATE_LISTENER': return { summary: `Create debugger listener ${operation.listener.terminalId}`, risk: 'Changes debugger listener state.' };
    case 'DELETE_LISTENER': return { summary: `Delete debugger listener ${operation.listener.terminalId}`, risk: 'Removes an active debugger listener.' };
    case 'SET_BREAKPOINTS': return { summary: `Set ${operation.breakpoints.length} breakpoint(s)`, risk: 'Changes debugger breakpoints.' };
    case 'DELETE_BREAKPOINT': return { summary: 'Delete one debugger breakpoint', risk: 'Removes a debugger breakpoint.' };
    case 'ATTACH': return { summary: `Attach to debuggee ${operation.debuggeeId}`, risk: 'Takes control of a live DEV debuggee.' };
    case 'SAVE_SETTINGS': return { summary: 'Save debugger settings', risk: 'Changes persisted debugger behavior.' };
    case 'JUMP_TO_LINE': return { summary: `Jump debuggee ${operation.debuggeeId} to ${operation.url}`, risk: 'Changes program control flow and may skip business logic.' };
    case 'TERMINATE_DEBUGGEE': return { summary: `Terminate debuggee ${operation.debuggeeId}`, risk: 'Stops the debuggee and may interrupt the current transaction.' };
    case 'SET_VARIABLE': return { summary: `Modify variable ${operation.variableName}`, risk: 'Changes live runtime data.' };
    // ---------- AMDP 原生调试四操作 ----------
    case 'AMDP_START': return { summary: `Start AMDP (HANA) debug session for ${operation.targetUser}`, risk: 'Starts an ABAP↔HANA debug bridge; replaces any existing AMDP session for the user when stopExisting is set.' };
    case 'AMDP_SYNC_BREAKPOINTS': return { summary: `Sync ${operation.breakpoints.length} AMDP breakpoint(s)`, risk: 'Replaces the AMDP debug session breakpoint set.' };
    case 'AMDP_AWAIT_STOP': return { summary: `Await AMDP debug stop (up to ${operation.maxEvents ?? 12} answers)`, risk: 'Polls the AMDP debug queue; resumes past acknowledgements without continuing the debuggee.' };
    case 'AMDP_TERMINATE': return { summary: `Terminate AMDP debug session for ${operation.targetUser}`, risk: 'Ends the AMDP debug session (hard stop does not wait for the debuggee).' };
  }
}

function operationTargetUser(operation: DebugOperation): string {
  return 'listener' in operation ? operation.listener.targetUser : operation.targetUser;
}

function normalizeOperationUser(operation: DebugOperation, targetUser: string): void {
  if ('listener' in operation) operation.listener.targetUser = targetUser;
  else operation.targetUser = targetUser;
}

function attachContextFrom(debuggeeId: string, result: DebugAttach): DebugAttachContext {
  return {
    debuggeeId,
    debugSessionId: requiredString(result.debugSessionId, 'debugSessionId'),
    debuggeeSessionId: requiredString(result.debuggeeSessionId, 'debuggeeSessionId'),
    serverName: requiredString(result.serverName, 'serverName'),
    processId: result.processId
  };
}

function currentStack(stack: DebugStack[], cursor?: number): DebugStack {
  const selected = stack.find(frame => frame.stackPosition === cursor) ?? (cursor === undefined ? undefined : stack[cursor]) ?? stack[0];
  if (!selected) throw new SafeAbapError('DEBUG_CONTEXT_MISSING', 'debug-variable', 'The debugger stack is empty.');
  return selected;
}

function stackSnapshot(stack: DebugStack): DebugStackSnapshot {
  return {
    stackPosition: stack.stackPosition,
    stackUri: 'stackUri' in stack ? stack.stackUri : undefined,
    programName: stack.programName,
    includeName: String(stack.includeName),
    line: stack.line
  };
}

function sameStack(expected: DebugStackSnapshot, current: DebugStack): boolean {
  const actual = stackSnapshot(current);
  return expected.stackPosition === actual.stackPosition
    && expected.stackUri === actual.stackUri
    && expected.programName === actual.programName
    && expected.includeName === actual.includeName
    && expected.line === actual.line;
}

function findVariable(variables: DebugVariable[], variableName: string): DebugVariable {
  const normalized = variableName.trim().toUpperCase();
  const variable = variables.find(item => item.NAME.trim().toUpperCase() === normalized || item.ID === variableName);
  if (!variable) throw new SafeAbapError('DEBUG_CONTEXT_MISSING', 'debug-variable', `Variable ${variableName} was not found in the selected scope.`);
  return variable;
}

function isReadOnlyVariable(variable: DebugVariable): boolean {
  const value = String(variable.READ_ONLY || '').trim().toUpperCase();
  return value === 'X' || value === 'TRUE' || value === '1';
}

function validateParents(value?: string[]): string[] {
  if (value === undefined) return ['@ROOT'];
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new SafeAbapError('VERIFY_FAILED', 'debug-variable', 'parents must be a non-empty array of debugger variable scopes.');
  }
  return value.map(item => item.trim());
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeAbapError('VERIFY_FAILED', 'debug-input', `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new SafeAbapError('VERIFY_FAILED', 'debug-input', `${field} is required.`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, 'value');
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new SafeAbapError('VERIFY_FAILED', 'debug-input', `${field} must be boolean.`);
  return value;
}

function debuggingMode(value: unknown): 'user' | 'terminal' {
  if (value === 'user' || value === 'terminal') return value;
  throw new SafeAbapError('VERIFY_FAILED', 'debug-input', 'debuggingMode must be user or terminal.');
}

function optionalScope(value: unknown): 'external' | 'debugger' | undefined {
  if (value === undefined) return undefined;
  if (value === 'external' || value === 'debugger') return value;
  throw new SafeAbapError('VERIFY_FAILED', 'debug-input', 'scope must be external or debugger.');
}

function summarizeResult(result: unknown): string {
  if (result === undefined) return 'completed';
  if (Array.isArray(result)) return `items=${result.length}`;
  if (result && typeof result === 'object') return `fields=${Object.keys(result as Record<string, unknown>).length}`;
  return String(result).slice(0, 200);
}

function isUncertainRemoteError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return /timeout|timed out|econnreset|econnaborted|socket hang up|connection reset|network error|aborted/.test(message);
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomCorrelationId(): string {
  return randomBytes(12).toString('hex');
}
