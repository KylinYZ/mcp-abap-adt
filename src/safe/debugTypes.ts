import type {
  DebugAttach,
  DebugBreakpoint,
  DebugBreakpointError,
  DebugChildVariablesInfo,
  DebugStackInfo,
  DebugStep,
  DebugVariable,
  DebuggingMode,
  DebuggerScope
} from 'abap-adt-api';

export type DebugOperationKind =
  | 'CREATE_LISTENER'
  | 'DELETE_LISTENER'
  | 'SET_BREAKPOINTS'
  | 'DELETE_BREAKPOINT'
  | 'ATTACH'
  | 'SAVE_SETTINGS'
  | 'JUMP_TO_LINE'
  | 'TERMINATE_DEBUGGEE'
  | 'SET_VARIABLE';

export type DebugOperationStatus = 'PREVIEWED' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'UNKNOWN' | 'EXPIRED';
export type DebugAuthorizationStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';
export type DebugConfirmationMode = 'elicitation';

export interface DebugListenerIdentity {
  debuggingMode: DebuggingMode;
  terminalId: string;
  ideId: string;
  targetUser: string;
}

export interface DebugSettingsInput {
  systemDebugging?: boolean;
  createExceptionObject?: boolean;
  backgroundRFC?: boolean;
  sharedObjectDebugging?: boolean;
  showDataAging?: boolean;
  updateDebugging?: boolean;
}

export type DebugOperation =
  | { kind: 'CREATE_LISTENER'; listener: DebugListenerIdentity; checkConflict?: boolean; isNotifiedOnConflict?: boolean }
  | { kind: 'DELETE_LISTENER'; listener: DebugListenerIdentity }
  | {
      kind: 'SET_BREAKPOINTS';
      listener: DebugListenerIdentity;
      clientId: string;
      breakpoints: Array<string | DebugBreakpoint>;
      scope?: DebuggerScope;
      systemDebugging?: boolean;
      deactivated?: boolean;
      syncScopeUrl?: string;
    }
  | {
      kind: 'DELETE_BREAKPOINT';
      listener: DebugListenerIdentity;
      breakpoint: DebugBreakpoint;
      scope?: DebuggerScope;
    }
  | { kind: 'ATTACH'; debuggingMode: DebuggingMode; debuggeeId: string; targetUser: string; dynproDebugging?: boolean }
  | { kind: 'SAVE_SETTINGS'; targetUser: string; settings: DebugSettingsInput }
  | { kind: 'JUMP_TO_LINE'; targetUser: string; authorizationId: string; debuggeeId: string; url: string }
  | { kind: 'TERMINATE_DEBUGGEE'; targetUser: string; authorizationId: string; debuggeeId: string }
  | {
      kind: 'SET_VARIABLE';
      targetUser: string;
      authorizationId: string;
      debuggeeId: string;
      variableName: string;
      oldValue: string;
      newValue: string;
      stack: DebugStackSnapshot;
      parents: string[];
    };

export interface DebugStackSnapshot {
  stackPosition: number;
  stackUri?: string;
  programName?: string;
  includeName?: string;
  line?: number;
}

export interface DebugAttachContext {
  debuggeeId: string;
  debugSessionId: string;
  debuggeeSessionId: string;
  serverName: string;
  processId: number;
}

export interface DebugOperationError {
  code: string;
  stage: string;
  message: string;
}

export interface DebugOperationPlan {
  debugOperationPlanId: string;
  createdAt: number;
  expiresAt: number;
  status: DebugOperationStatus;
  terminalAt?: number;
  systemHost: string;
  client: string;
  targetUser: string;
  operation: DebugOperation;
  operationHash: string;
  summary: string;
  risk: string;
  confirmationMode?: DebugConfirmationMode;
  resultSummary?: string;
  primaryError?: DebugOperationError;
  variableValueHashes?: {
    oldValueHash: string;
    newValueHash: string;
    oldValueBytes: number;
    newValueBytes: number;
  };
}

export interface DebugOperationPlanView {
  debugOperationPlanId: string;
  createdAt: string;
  expiresAt: string;
  status: DebugOperationStatus;
  systemHost: string;
  client: string;
  targetUser: string;
  operation: Record<string, unknown>;
  operationHash: string;
  summary: string;
  risk: string;
  confirmationMode?: DebugConfirmationMode;
  resultSummary?: string;
  primaryError?: DebugOperationError;
}

export interface DebugSessionAuthorization {
  authorizationId: string;
  createdAt: number;
  expiresAt: number;
  status: DebugAuthorizationStatus;
  revokedAt?: number;
  revokeReason?: string;
  systemHost: string;
  client: string;
  targetUser: string;
  attachContext: DebugAttachContext;
}

export interface DebugSessionAuthorizationView {
  authorizationId: string;
  createdAt: string;
  expiresAt: string;
  status: DebugAuthorizationStatus;
  revokedAt?: string;
  revokeReason?: string;
  systemHost: string;
  client: string;
  targetUser: string;
  attachContext: DebugAttachContext;
}

export type SafeDebugCommand =
  | { command: 'stepInto' | 'stepOver' | 'stepReturn' | 'stepContinue' }
  | { command: 'stepRunToLine'; url: string }
  | { command: 'goToStack'; urlOrPosition: string | number };

export interface SafeDebugClient {
  debuggerListeners(
    debuggingMode: DebuggingMode,
    terminalId: string,
    ideId: string,
    user?: string,
    checkConflict?: boolean
  ): Promise<unknown>;
  debuggerListen(
    debuggingMode: DebuggingMode,
    terminalId: string,
    ideId: string,
    user?: string,
    checkConflict?: boolean,
    isNotifiedOnConflict?: boolean
  ): Promise<unknown>;
  debuggerDeleteListener(debuggingMode: DebuggingMode, terminalId: string, ideId: string, user?: string): Promise<void>;
  debuggerSetBreakpoints(
    debuggingMode: DebuggingMode,
    terminalId: string,
    ideId: string,
    clientId: string,
    breakpoints: Array<string | DebugBreakpoint>,
    user?: string,
    scope?: DebuggerScope,
    systemDebugging?: boolean,
    deactivated?: boolean,
    syncScopeUrl?: string
  ): Promise<Array<DebugBreakpoint | DebugBreakpointError>>;
  debuggerDeleteBreakpoints(
    breakpoint: DebugBreakpoint,
    debuggingMode: DebuggingMode,
    terminalId: string,
    ideId: string,
    requestUser?: string,
    scope?: DebuggerScope
  ): Promise<void>;
  debuggerAttach(debuggingMode: DebuggingMode, debuggeeId: string, user?: string, dynproDebugging?: boolean): Promise<DebugAttach>;
  debuggerSaveSettings(settings: DebugSettingsInput): Promise<DebugSettingsInput>;
  debuggerStackTrace(semanticUris?: boolean): Promise<DebugStackInfo>;
  debuggerVariables(parents: string[]): Promise<DebugVariable[]>;
  debuggerChildVariables(parent?: string[]): Promise<DebugChildVariablesInfo>;
  debuggerStep(stepType: 'stepRunToLine' | 'stepJumpToLine', url: string): Promise<DebugStep>;
  debuggerStep(stepType: 'stepInto' | 'stepOver' | 'stepReturn' | 'stepContinue' | 'terminateDebuggee'): Promise<DebugStep>;
  debuggerGoToStack(urlOrPosition: number | string): Promise<void>;
  debuggerSetVariableValue(variableName: string, value: string): Promise<string>;
}
