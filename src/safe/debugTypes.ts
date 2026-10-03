import type {
  AmdpAwaitStopResult,
  AmdpBreakpointInput,
  AmdpDebugSession,
  AmdpScalar,
  DebugAttach,
  DebugBreakpoint,
  DebugBreakpointError,
  DebugChildVariablesInfo,
  DebugStackInfo,
  DebugStep,
  DebugVariable,
  DebuggingMode,
  DebuggerScope
} from '../adt/index.js';

export type DebugOperationKind =
  | 'CREATE_LISTENER'
  | 'DELETE_LISTENER'
  | 'SET_BREAKPOINTS'
  | 'DELETE_BREAKPOINT'
  | 'ATTACH'
  | 'SAVE_SETTINGS'
  | 'JUMP_TO_LINE'
  | 'TERMINATE_DEBUGGEE'
  | 'SET_VARIABLE'
  // AMDP 原生调试操作（矩阵行 debug.amdp-adt；对齐并超出 VSP 的 AMDP_ADT_* 面）
  | 'AMDP_START'
  | 'AMDP_SYNC_BREAKPOINTS'
  | 'AMDP_AWAIT_STOP'
  | 'AMDP_TERMINATE'
  | 'AMDP_STEP'
  | 'AMDP_READ_VARIABLE';

export type DebugOperationStatus = 'PREVIEWED' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'UNKNOWN' | 'EXPIRED';
export type DebugAuthorizationStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';
/** 调试确认来源：elicitation=人工表单；auto-config=SAP_MCP_CONFIRMATION_MODE=auto 配置预授权 */
export type DebugConfirmationMode = 'elicitation' | 'auto-config';

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
    }
  // ---------- AMDP 原生调试四操作 ----------
  // 协议要点：调试句柄（mainId）存于 ABAP 会话内存，四操作必须在同一 stateful
  // 会话上执行；mainId 由工作流内部持有，不接受调用方传入任意句柄。
  // 协议来源与陷阱清单见 src/adt/api/amdpDebugger.ts 头注。
  /** 启动 AMDP（HANA SQLScript）调试会话；stopExisting=true 清理同用户遗留会话。 */
  | { kind: 'AMDP_START'; targetUser: string; stopExisting?: boolean }
  /**
   * 全量替换会话断点集（对齐 VSP AMDP_ADT_BREAKPOINT）。断点以 class+line 描述，
   * URI 由协议层推导（/sap/bc/adt/oo/classes/<lower>/source/main#start=<line>）；
   * clientId 为内部常量，不暴露为调用方参数。SAP 的断点裁决在 awaitStop 的
   * 判定事件里回报（VALID=已接受≠已命中）。
   */
  | {
      kind: 'AMDP_SYNC_BREAKPOINTS';
      targetUser: string;
      breakpoints: AmdpBreakpointSpec[];
      syncMode?: 'FULL' | 'PROGRAM';
    }
  /**
   * 排空 AMDP 响应队列直到停止事件或预算耗尽（对齐 VSP AMDP_ADT_AWAIT）。
   * 队列空/预算耗尽是"还没等到"的观察结果而非硬失败，可再次轮询；
   * 每次事件都是快速 GET，不构成服务端长挂起。
   */
  | { kind: 'AMDP_AWAIT_STOP'; targetUser: string; maxEvents?: number }
  /** 结束 AMDP 调试会话（对齐 VSP AMDP_ADT_STOP）；只能终止本工作流 start 的会话。 */
  | { kind: 'AMDP_TERMINATE'; targetUser: string; hardStop?: boolean }
  /**
   * 步进已停止的 debuggee（over=语句步进；continue=放行到下一命中——SQLScript
   * 没有 into）。debuggeeId 由工作流从最近一次 await 命中内部登记，不接受
   * 调用方传入；步进后新停止位置经响应队列到达，apply 内随附 awaitStop 取明细。
   */
  | { kind: 'AMDP_STEP'; targetUser: string; stepType: 'over' | 'continue'; maxEvents?: number }
  /**
   * 读取已停止 debuggee 的一个标量变量值（GET_SCALAR_VALUES 异步命令：
   * Location 头 requestId → 排空响应队列等该应答）。窗口 8192 字符，
   * originalLength>length 表示截断。仅标量——表变量经 stop 事件的
   * tableHandle 只读元信息，值级读取无受控通路（VSP 亦未打通）。
   */
  | { kind: 'AMDP_READ_VARIABLE'; targetUser: string; variableName: string; maxEvents?: number };

/** AMDP 断点输入（受控面）：类名 + 源码行号。 */
export interface AmdpBreakpointSpec {
  /** AMDP 方法所在类名。 */
  class: string;
  /** AMDP 方法体内的 ADT 源码行号（正整数）。 */
  line: number;
}

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
  // ---------- AMDP 原生调试（协议层委托；必须同一 stateful 会话） ----------
  amdpDebuggerStart(options: { user: string; stopExisting?: boolean }): Promise<AmdpDebugSession>;
  amdpDebuggerSyncBreakpoints(
    mainId: string,
    breakpoints: AmdpBreakpointInput[],
    syncMode?: 'FULL' | 'PROGRAM'
  ): Promise<void>;
  amdpDebuggerAwaitStop(mainId: string, maxEvents?: number): Promise<AmdpAwaitStopResult>;
  amdpDebuggerTerminate(mainId: string, hardStop?: boolean): Promise<void>;
  amdpDebuggerStep(mainId: string, debuggeeId: string, kind: 'over' | 'continue'): Promise<void>;
  amdpDebuggerReadVariable(
    mainId: string,
    debuggeeId: string,
    name: string,
    maxEvents?: number
  ): Promise<AmdpScalar[]>;
}
